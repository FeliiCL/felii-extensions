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

// manga-oni.com — sitio Laravel en español; las imágenes viven en oni.ntr-files.online
const WEB_URL = "https://manga-oni.com";
const FALLBACK_COVER = "https://placehold.co/400x600.png?text=No+Cover";

// Caché del HTML de la ficha (compartido por getMangaDetails y getChapters)
const SERIES_CACHE_TTL = 60_000;
const SERIES_CACHE_MAX = 30;

// Prefijos de tipo válidos en las URLs de serie: /<tipo>/<slug>/
const TYPE_PREFIXES = ["manga", "manhwa", "manhua", "oneshot", "novela"];

interface OniMetadata {
    page?: number;
}

class MangaOniInterceptor extends PaperbackInterceptor {
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

type MangaOniImplementation = Extension &
    SearchResultsProviding &
    MangaProviding &
    ChapterProviding &
    DiscoverSectionProviding;

export class MangaOniExtension implements MangaOniImplementation {
    requestManager = new MangaOniInterceptor("main");
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

        const data = await this.fetchText(`${WEB_URL}/${mangaId}/`);
        if (this.seriesCache.size >= SERIES_CACHE_MAX) this.seriesCache.clear();
        this.seriesCache.set(mangaId, { data, expiry: now + SERIES_CACHE_TTL });
        return data;
    }

    // ---- utils ----

    // IDs 0.9: solo alfanuméricos y `._-@()[]%?#+=/&:` (la barra `/` está permitida,
    // así que "manga/dragon-ball-super" es un ID válido tal cual).
    private toSafeId(id: string): string {
        return id.replace(/[^A-Za-z0-9._\-@()[\]%?#+=/&:]/g, (c) => {
            const enc = encodeURIComponent(c);
            if (enc !== c) return enc;
            return "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
        });
    }

    private mapStatus(statusText: string): string {
        const s = (statusText || "").toLowerCase();
        if (s.includes("completo") || s.includes("finalizado")) return "Completed";
        if (s.includes("pausa")) return "Hiatus";
        if (s.includes("cancelado")) return "Cancelled";
        return "Ongoing";
    }

    // El lector entrega las páginas en un base64 inline (`var unicap = '...'`);
    // JavaScriptCore no expone atob, así que se decodifica a mano (contenido ASCII).
    private decodeBase64(input: string): string {
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        const clean = input.replace(/[^A-Za-z0-9+/]/g, "");
        let out = "";
        for (let i = 0; i < clean.length; i += 4) {
            const e1 = alphabet.indexOf(clean.charAt(i));
            const e2 = alphabet.indexOf(clean.charAt(i + 1));
            const e3 = alphabet.indexOf(clean.charAt(i + 2));
            const e4 = alphabet.indexOf(clean.charAt(i + 3));
            if (e1 < 0 || e2 < 0) break;
            out += String.fromCharCode((e1 << 2) | (e2 >> 4));
            if (e3 >= 0) out += String.fromCharCode(((e2 & 15) << 4) | (e3 >> 2));
            if (e3 >= 0 && e4 >= 0) out += String.fromCharCode(((e3 & 3) << 6) | e4);
        }
        return out;
    }

    // Parsea las cards de /directorio y /buscar (comparten markup: a[itemprop=url])
    private parseCards(html: string): { mangaId: string; title: string; imageUrl: string }[] {
        const $ = cheerio.load(html);
        const out: { mangaId: string; title: string; imageUrl: string }[] = [];
        const seen = new Set<string>();

        $('a[itemprop="url"]').each((_i, el) => {
            const card = $(el);
            const href = card.attr("href") || "";
            const m = href.match(/manga-oni\.com\/([a-z]+)\/([^/]+)\/?$/);
            if (!m) return;
            const tipo = m[1];
            const slug = m[2];
            if (!tipo || !slug || !TYPE_PREFIXES.includes(tipo)) return;
            const mangaId = this.toSafeId(`${tipo}/${slug}`);
            if (!mangaId || seen.has(mangaId)) return;

            const img = card.find("img").first();
            const title = img.attr("alt")?.trim() || card.find("span").first().text().trim();
            // Portada: data-src (lazyload lozad) tiene prioridad sobre src (default.gif)
            let image = img.attr("data-src") || img.attr("src") || FALLBACK_COVER;
            if (image.includes("default.gif")) image = FALLBACK_COVER;

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

        const title = $("h1.post-title").first().text().trim() || mangaId;

        const image =
            $("a.portada img").first().attr("src") ||
            $('meta[property="og:image"]').attr("content") ||
            FALLBACK_COVER;

        // Sinopsis: #sinopsis trae un <h3>Sinopsis</h3> por delante
        const sinopsisEl = $("#sinopsis");
        sinopsisEl.find("h3").remove();
        const synopsis = sinopsisEl.text().trim() || "Sin descripción disponible.";

        // #info-i: "Alterno: ... / Autor: ... / Estado: ..."
        const infoHtml = $("#info-i").html() || "";
        const alterno = infoHtml.match(/<strong>Alterno:<\/strong>([^<]*)/)?.[1];
        const secondaryTitles = (alterno || "")
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t.length > 0);
        const author = infoHtml.match(/<strong>Autor:<\/strong>([^<]*)/)?.[1]?.trim() || undefined;

        const status = this.mapStatus($("#desarrollo").text() || $("#info-i .estado").last().text());

        // Tipo (manga/manhwa/...) desde el propio ID
        const tags: Tag[] = [];
        const type = mangaId.match(/^([a-z_]+)\//)?.[1];
        if (type) tags.push({ id: type, title: type.toUpperCase() });

        const tagGroups: TagSection[] = [];
        if (tags.length > 0) tagGroups.push({ id: "tipo", title: "Tipo", tags });

        return {
            mangaId,
            mangaInfo: {
                primaryTitle: title,
                secondaryTitles,
                thumbnailUrl: image,
                synopsis,
                contentRating: ContentRating.MATURE,
                status,
                author,
                tagGroups,
                shareUrl: `${WEB_URL}/${mangaId}/`,
            },
        };
    }

    // ---- chapters ----

    async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
        const html = await this.getSeriesHTML(sourceManga.mangaId);
        const $ = cheerio.load(html);

        const chapters: Chapter[] = [];
        const seen = new Set<string>();

        $('#c_list a[href*="/lector/"]').each((_i, el) => {
            const row = $(el);

            // /lector/<slug>/<id>/ (a veces con /cascada/ al final)
            const href = row.attr("href") || "";
            const uploadId = href.match(/\/lector\/[^/]+\/(\d+)/)?.[1] || "";
            if (!uploadId || seen.has(uploadId)) return;

            const timeEl = row.find("span.timeago").first();
            const nameText = row.find("h3.entry-title-h2").first().text().replace(/\s+/g, " ").trim();

            // Número de capítulo (attr data-num del timeago, fallback al texto)
            let chapNum = parseFloat(timeEl.attr("data-num") || "");
            if (isNaN(chapNum)) {
                const numText = nameText.match(/cap[íi]tulo\s*([\d.]+)/i)?.[1];
                chapNum = numText ? parseFloat(numText) : 0;
            }

            // Fecha absoluta: datetime="2026-07-13 20:31:32" (UTC)
            let publishDate: Date | undefined;
            const dt = timeEl.attr("datetime");
            if (dt) {
                const parsed = new Date(dt.replace(" ", "T") + "Z");
                if (!isNaN(parsed.getTime())) publishDate = parsed;
            }

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
        // El slug de la serie es la segunda parte del ID ("manga/dragon-ball-super")
        const slug = chapter.sourceManga.mangaId.split("/")[1];
        if (!slug) throw new Error(`ID de manga inválido: ${chapter.sourceManga.mangaId}`);

        const html = await this.fetchText(`${WEB_URL}/lector/${slug}/${chapter.chapterId}/`);

        // Las páginas van en un base64: atob(unicap) = "<dirCDN>||[\"001.webp?up=...\",...]||..."
        const encoded = html.match(/var\s+unicap\s*=\s*'([^']+)'/)?.[1];
        if (!encoded) throw new Error(`No se encontró el contenido del capítulo ${chapter.chapterId}`);

        const parts = this.decodeBase64(encoded).split("||");
        const dir = parts[0];
        const listRaw = parts[1];
        if (!dir || !listRaw) throw new Error(`Contenido del capítulo ${chapter.chapterId} con formato inesperado`);

        let names: unknown;
        try {
            names = JSON.parse(listRaw.replace(/&quot;/g, '"'));
        } catch {
            names = [];
        }

        const pages: string[] = [];
        if (Array.isArray(names)) {
            for (const name of names) {
                if (typeof name === "string" && name.length > 0) pages.push(dir + name);
            }
        }

        return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages };
    }

    // ---- search ----

    async getSearchResults(
        query: SearchQuery<Metadata>,
        metadata: Metadata | undefined,
    ): Promise<PagedResults<SearchResultItem>> {
        const page = (metadata as OniMetadata | undefined)?.page ?? 1;
        const term = encodeURIComponent(query.title ?? "");
        // Ojo: el formulario del sitio usa name="s", pero el backend espera "q"
        const html = await this.fetchText(`${WEB_URL}/buscar?q=${term}&p=${page}`);

        // Sin contentRating explícito la app difumina la portada con una "U"
        const items: SearchResultItem[] = this.parseCards(html).map((t) => ({
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
            { id: "populares", title: "Lo más visto", type: DiscoverSectionType.featured },
            { id: "recientes", title: "Últimos añadidos", type: DiscoverSectionType.simpleCarousel },
        ];
    }

    async getDiscoverSectionItems(
        section: DiscoverSection,
        metadata: Metadata | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const page = (metadata as OniMetadata | undefined)?.page ?? 1;
        const filtro = section.id === "populares" ? "visitas" : "id";
        const html = await this.fetchText(`${WEB_URL}/directorio?filtro=${filtro}&orden=desc&p=${page}`);

        const isFeatured = section.type === DiscoverSectionType.featured;
        const items: DiscoverSectionItem[] = this.parseCards(html).map((t) =>
            isFeatured
                ? { type: "featuredCarouselItem", mangaId: t.mangaId, imageUrl: t.imageUrl, title: t.title, contentRating: ContentRating.MATURE }
                : { type: "simpleCarouselItem", mangaId: t.mangaId, imageUrl: t.imageUrl, title: t.title, contentRating: ContentRating.MATURE },
        );

        return { items, metadata: this.hasNextPage(html) ? { page: page + 1 } : undefined };
    }
}

export const MangaOni = new MangaOniExtension();
