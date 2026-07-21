import {
    BasicRateLimiter,
    Chapter,
    ChapterDetails,
    ChapterProviding,
    ContentRating,
    DiscoverSection,
    DiscoverSectionItem,
    DiscoverSectionProviding,
    DiscoverSectionType,
    Extension,
    MangaProviding,
    Metadata,
    PagedResults,
    PaperbackInterceptor,
    Request,
    Response,
    SearchQuery,
    SearchResultItem,
    SearchResultsProviding,
    SourceManga,
    Tag,
    TagSection,
} from "@paperback/types";

import * as cheerio from "cheerio";

// URLs base — zonatmo.org (renacimiento del ZonaTMO/TMO original, misma estructura Laravel)
const WEB_URL = "https://zonatmo.org";
const FALLBACK_COVER = "https://placehold.co/400x600.png?text=No+Cover";

// Caché del HTML de /library/{id} (compartido por getMangaDetails y getChapters)
const SERIES_CACHE_TTL = 60_000;
const SERIES_CACHE_MAX = 30;

interface ZonaMetadata {
    page?: number;
}

class ZonaTMOInterceptor extends PaperbackInterceptor {
    override async interceptRequest(request: Request): Promise<Request> {
        request.headers = {
            ...request.headers,
            referer: `${WEB_URL}/`,
            "user-agent": await Application.getDefaultUserAgent(),
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        };
        return request;
    }

    override async interceptResponse(
        _request: Request,
        _response: Response,
        data: ArrayBuffer,
    ): Promise<ArrayBuffer> {
        return data;
    }
}

type ZonaTMOImplementation = Extension &
    SearchResultsProviding &
    MangaProviding &
    ChapterProviding &
    DiscoverSectionProviding;

export class ZonaTMOExtension implements ZonaTMOImplementation {
    requestManager = new ZonaTMOInterceptor("main");
    globalRateLimiter = new BasicRateLimiter("rateLimiter", {
        numberOfRequests: 3,
        bufferInterval: 1,
        ignoreImages: true,
    });

    private seriesCache = new Map<string, { data: string; expiry: number }>();

    async initialise(): Promise<void> {
        this.requestManager.registerInterceptor();
        this.globalRateLimiter.registerInterceptor();
    }

    // ---- fetch helpers ----

    private async fetchText(url: string): Promise<string> {
        const [response, data] = await Application.scheduleRequest({ url, method: "GET" });
        if (response.status === 503 || response.status === 403) {
            throw new Error(`Cloudflare bloqueó la petición (${response.status}). Abre ${WEB_URL} en la app y resuelve el desafío.`);
        }
        return Application.arrayBufferToUTF8String(data);
    }

    private async getSeriesHTML(mangaId: string): Promise<string> {
        const now = Date.now();
        const cached = this.seriesCache.get(mangaId);
        if (cached && cached.expiry > now) return cached.data;

        const data = await this.fetchText(`${WEB_URL}/library/${mangaId}`);
        if (this.seriesCache.size >= SERIES_CACHE_MAX) this.seriesCache.clear();
        this.seriesCache.set(mangaId, { data, expiry: now + SERIES_CACHE_TTL });
        return data;
    }

    // ---- utils ----

    // IDs 0.9: solo alfanuméricos y `._-@()[]%?#+=/&:` (la barra `/` está permitida,
    // así que "manhwa/6426/solo-leveling" es un ID válido tal cual).
    private toSafeId(id: string): string {
        return id.replace(/[^A-Za-z0-9._\-@()[\]%?#+=/&:]/g, (c) => {
            const enc = encodeURIComponent(c);
            if (enc !== c) return enc;
            return "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
        });
    }

    private mapStatus(statusText: string): string {
        const s = (statusText || "").toLowerCase();
        if (s.includes("finalizado") || s.includes("completado")) return "Completed";
        if (s.includes("pausa")) return "Hiatus";
        if (s.includes("cancelado")) return "Cancelled";
        return "Ongoing";
    }

    // Fechas relativas del listado de capítulos: "1 month ago" / "hace 2 días"
    private parseRelativeDate(text: string): Date | undefined {
        const t = (text || "").toLowerCase().trim();
        const m = t.match(/(\d+)\s*(second|segundo|minute|minuto|hour|hora|day|d[ií]a|week|semana|month|mes|year|año|anio)/);
        if (!m) return undefined;
        const amount = m[1];
        const unit = m[2];
        // Grupos opcionales sólo en el tipo: sin ellos la fecha no es interpretable.
        if (!amount || !unit) return undefined;
        const n = parseInt(amount, 10) || 0;
        const MS: Record<string, number> = {
            second: 1e3, segundo: 1e3,
            minute: 6e4, minuto: 6e4,
            hour: 36e5, hora: 36e5,
            day: 864e5, "día": 864e5, "dia": 864e5,
            week: 6048e5, semana: 6048e5,
            month: 26298e5, mes: 26298e5,
            year: 315576e5, "año": 315576e5, anio: 315576e5,
        };
        const ms = MS[unit] ?? MS[unit.replace(/s$/, "")] ?? 0;
        return ms ? new Date(Date.now() - n * ms) : undefined;
    }

    // Parsea las cards de /biblioteca (búsqueda y discover comparten markup)
    private parseLibraryCards(html: string): { mangaId: string; title: string; imageUrl: string }[] {
        const $ = cheerio.load(html);
        const out: { mangaId: string; title: string; imageUrl: string }[] = [];
        const seen = new Set<string>();

        $("div.element").each((_i, el) => {
            const card = $(el);
            const a = card.find("a").first();
            const href = a.attr("href") || "";
            const idMatch = href.match(/\/library\/(.+)$/);
            if (!idMatch) return;
            const idPath = idMatch[1];
            if (!idPath) return;
            const mangaId = this.toSafeId(idPath);
            if (!mangaId || seen.has(mangaId)) return;

            const title =
                card.find("h4.text-truncate").attr("title")?.trim() ||
                card.find("h4.text-truncate").text().trim();
            const image =
                card.find("img.cover-bg-img").attr("src") ||
                card.find("[data-bg]").attr("data-bg") ||
                FALLBACK_COVER;

            if (!title) return;
            seen.add(mangaId);
            out.push({ mangaId, title, imageUrl: image });
        });
        return out;
    }

    private hasNextPage(html: string): boolean {
        return /rel="next"/.test(html);
    }

    // ---- manga details ----

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const html = await this.getSeriesHTML(mangaId);
        const $ = cheerio.load(html);

        const titleEl = $("h1.element-title").first();
        const title =
            titleEl.contents().filter((_i, el) => el.type === "text").text().trim() ||
            titleEl.text().trim() ||
            mangaId;

        const image = $("img.book-thumbnail").attr("src") || FALLBACK_COVER;
        const synopsis = $("p.element-description").text().trim() || "Sin descripción disponible.";
        const status = this.mapStatus($("span.book-status").text());

        // Autor: enlace con filter_by=author
        const author = $('a[href*="filter_by=author"]').first().text().trim() || undefined;

        // Géneros: badges (enlaces a genders[])
        const tags: Tag[] = [];
        $("h6 a.badge.badge-primary").each((_i, el) => {
            const label = $(el).text().trim();
            if (label) tags.push({ id: label.toLowerCase().replace(/\s+/g, "-"), title: label });
        });
        // Tipo (manga/manhwa/...) desde el propio ID
        const type = mangaId.match(/^([a-z_]+)\//)?.[1];
        if (type) tags.push({ id: type, title: type.toUpperCase() });

        const tagGroups: TagSection[] = [];
        if (tags.length > 0) tagGroups.push({ id: "genres", title: "Géneros", tags });

        return {
            mangaId,
            mangaInfo: {
                primaryTitle: title,
                secondaryTitles: [],
                thumbnailUrl: image,
                synopsis,
                contentRating: ContentRating.MATURE,
                status,
                author,
                tagGroups,
                shareUrl: `${WEB_URL}/library/${mangaId}`,
            },
        };
    }

    // ---- chapters ----

    async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
        const html = await this.getSeriesHTML(sourceManga.mangaId);
        const $ = cheerio.load(html);

        const chapters: Chapter[] = [];
        const seen = new Set<string>();

        $("li.upload-link").each((_i, el) => {
            const row = $(el);

            // Enlace de lectura → id del upload
            const href = row.find('a[href*="/view_uploads/"]').first().attr("href") || "";
            const uploadId = href.split("/").filter(Boolean).pop() || "";
            if (!uploadId || seen.has(uploadId)) return;

            // Número de capítulo (attr data-chapter-number, fallback al texto)
            let chapNum = parseFloat(row.attr("data-chapter-number") || "");
            const nameText = row.find(".chapter-number").first().text().trim();
            if (isNaN(chapNum)) {
                const numText = nameText.match(/(?:cap[íi]tulo|cap\.?)\s*([\d.]+)/i)?.[1];
                chapNum = numText ? parseFloat(numText) : 0;
            }

            // Fecha relativa ("1 month ago")
            const publishDate = this.parseRelativeDate(row.find(".chapter-row-date").first().text());

            seen.add(uploadId);
            chapters.push({
                chapterId: uploadId,
                sourceManga,
                title: nameText || undefined,
                chapNum: chapNum || 0,
                publishDate,
                langCode: "es",
            });
        });

        chapters.sort((a, b) => b.chapNum - a.chapNum);
        return chapters;
    }

    async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
        const html = await this.fetchText(`${WEB_URL}/view_uploads/${chapter.chapterId}`);
        const $ = cheerio.load(html);

        const pages: string[] = [];
        $("img.reader-image").each((_i, el) => {
            const src = ($(el).attr("data-src") || $(el).attr("src") || "").trim();
            if (src) pages.push(src);
        });
        // Fallback: contenedores del lector
        if (pages.length === 0) {
            $("div.reader-img-wrap img").each((_i, el) => {
                const src = ($(el).attr("data-src") || $(el).attr("src") || "").trim();
                if (src) pages.push(src);
            });
        }

        return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages };
    }

    // ---- search ----

    async getSearchResults(
        query: SearchQuery<Metadata>,
        metadata: Metadata | undefined,
    ): Promise<PagedResults<SearchResultItem>> {
        const page = (metadata as ZonaMetadata | undefined)?.page ?? 1;
        const term = encodeURIComponent(query.title ?? "");
        const html = await this.fetchText(`${WEB_URL}/biblioteca?title=${term}&filter_by=title&page=${page}`);

        // Sin contentRating explícito la app trata el ítem como "Unknown" y
        // difumina la portada con una "U"; se declara siempre.
        const items: SearchResultItem[] = this.parseLibraryCards(html).map((t) => ({
            mangaId: t.mangaId,
            title: t.title,
            imageUrl: t.imageUrl,
            contentRating: ContentRating.MATURE,
        }));

        return { items, metadata: this.hasNextPage(html) ? { page: page + 1 } : undefined };
    }

    // ---- discover ----

    async getDiscoverSections(): Promise<DiscoverSection[]> {
        return [
            { id: "populares", title: "Lo más popular", type: DiscoverSectionType.featured },
            { id: "nuevos", title: "Últimos añadidos", type: DiscoverSectionType.simpleCarousel },
        ];
    }

    async getDiscoverSectionItems(
        section: DiscoverSection,
        metadata: Metadata | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const page = (metadata as ZonaMetadata | undefined)?.page ?? 1;
        const orderItem = section.id === "populares" ? "likes_count" : "creation";
        const html = await this.fetchText(
            `${WEB_URL}/biblioteca?order_item=${orderItem}&order_dir=desc&filter_by=title&page=${page}`,
        );

        const isFeatured = section.type === DiscoverSectionType.featured;
        const items: DiscoverSectionItem[] = this.parseLibraryCards(html).map((t) =>
            isFeatured
                ? { type: "featuredCarouselItem", mangaId: t.mangaId, imageUrl: t.imageUrl, title: t.title, contentRating: ContentRating.MATURE }
                : { type: "simpleCarouselItem", mangaId: t.mangaId, imageUrl: t.imageUrl, title: t.title, contentRating: ContentRating.MATURE },
        );

        return { items, metadata: this.hasNextPage(html) ? { page: page + 1 } : undefined };
    }
}

export const ZonaTMO = new ZonaTMOExtension();
