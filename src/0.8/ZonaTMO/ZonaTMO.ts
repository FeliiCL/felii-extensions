import {
    Source,
    Manga,
    Chapter,
    ChapterDetails,
    HomeSection,
    SearchRequest,
    PagedResults,
    SourceInfo,
    ContentRating,
    Request,
    Response,
    SourceIntents,
    HomeSectionType,
    MangaTile,
    Tag
} from '@paperback/types';

import * as cheerio from 'cheerio';

// URLs base — zonatmo.org (renacimiento del ZonaTMO/TMO original, misma estructura Laravel)
const WEB_URL = "https://zonatmo.org";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
// placehold.co sin .png devuelve SVG, que iOS no renderiza
const FALLBACK_COVER = "https://placehold.co/400x600.png?text=No+Cover";

// Caché del HTML de /library/{id} (compartido por getMangaDetails y getChapters)
const SERIES_CACHE_TTL = 60_000; // 1 min
const SERIES_CACHE_MAX = 30;

export const ZonaTMOInfo: SourceInfo = {
    version: '1.5.0',
    name: 'ZonaTMO',
    icon: 'icon.png',
    author: 'Felii',
    authorWebsite: 'https://github.com/feliivk',
    description: 'Lectura desde ZonaTMO (zonatmo.org)',
    contentRating: ContentRating.MATURE,
    websiteBaseURL: WEB_URL,
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
};

export class ZonaTMO extends Source {

    requestManager = createRequestManager({
        requestsPerSecond: 3,
        requestTimeout: 20000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    "Referer": `${WEB_URL}/`,
                    "Origin": WEB_URL,
                    "User-Agent": USER_AGENT,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
                };
                return request;
            },
            interceptResponse: async (response: Response): Promise<Response> => {
                return response;
            },
        },
    });

    private seriesCache = new Map<string, { data: string; expiry: number }>();

    override getCloudflareBypassRequest(): Request {
        return createRequestObject({
            url: WEB_URL,
            method: 'GET',
            headers: {
                "referer": `${WEB_URL}/`,
                "user-agent": USER_AGENT
            }
        });
    }

    CloudFlareError(status: number, $?: cheerio.CheerioAPI): void {
        if (status === 503 || status === 403) {
            throw new Error(`CLOUDFLARE BYPASS ERROR: Please go to the homepage of the source and press Cloudflare Bypass. Status code: ${status}`);
        }
        if ($) {
            const title = $('title').text();
            if (title.includes("Just a moment") || title.includes("Cloudflare")) {
                throw new Error(`CLOUDFLARE BYPASS ERROR (JS Challenge detected). Please restart the app or use Cloudflare Bypass.`);
            }
        }
    }

    // ---- fetch helpers ----

    private async fetchHTML(url: string): Promise<{ html: string; $: cheerio.CheerioAPI }> {
        const request = createRequestObject({ url, method: "GET" });
        const response = await this.requestManager.schedule(request, 1);
        const $ = cheerio.load(response.data ?? "");
        this.CloudFlareError(response.status, $);
        return { html: response.data ?? "", $ };
    }

    private async getSeriesHTML(mangaId: string): Promise<string> {
        const now = Date.now();
        const cached = this.seriesCache.get(mangaId);
        if (cached && cached.expiry > now) return cached.data;

        const { html } = await this.fetchHTML(`${WEB_URL}/library/${mangaId}`);
        if (this.seriesCache.size >= SERIES_CACHE_MAX) this.seriesCache.clear();
        this.seriesCache.set(mangaId, { data: html, expiry: now + SERIES_CACHE_TTL });
        return html;
    }

    // ---- utils ----

    // Percent-encodea caracteres raros de los slugs (unicode, espacios…);
    // los backends aceptan el slug encodeado.
    private toSafeId(id: string): string {
        return id.replace(/[^A-Za-z0-9._\-@()[\]%?#+=/&:]/g, (c) => {
            const enc = encodeURIComponent(c);
            if (enc !== c) return enc;
            return "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
        });
    }

    // Mapea el estado textual de la web al enum numérico de Paperback
    mapStatus(statusText: string): number {
        const s = (statusText || "").toLowerCase();
        if (s.includes("finalizado") || s.includes("completado")) return 1; // COMPLETED
        if (s.includes("pausa")) return 2; // HIATUS
        if (s.includes("cancelado")) return 3; // ABANDONED
        return 0; // ONGOING
    }

    // Fechas relativas del listado de capítulos: "1 month ago" / "hace 2 días"
    parseRelativeDate(text: string): Date | undefined {
        const t = (text || "").toLowerCase().trim();
        const m = t.match(/(\d+)\s*(second|segundo|minute|minuto|hour|hora|day|d[ií]a|week|semana|month|mes|year|año|anio)/);
        if (!m) return undefined;
        const amount = m[1];
        const unit = m[2];
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

    // Parsea las cards de /biblioteca (búsqueda y home comparten markup)
    parseLibraryCards(html: string): MangaTile[] {
        const $ = cheerio.load(html);
        const tiles: MangaTile[] = [];
        const seen = new Set<string>();

        $("div.element").each((_i, el) => {
            const card = $(el);
            const href = card.find("a").first().attr("href") || "";
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
            tiles.push(createMangaTile({
                id: mangaId,
                title: createIconText({ text: title }),
                image: image
            }));
        });
        return tiles;
    }

    hasNextPage(html: string): boolean {
        return /rel="next"/.test(html);
    }

    // ---- manga details ----

    async getMangaDetails(mangaId: string): Promise<Manga> {
        const html = await this.getSeriesHTML(mangaId);
        const $ = cheerio.load(html);

        const titleEl = $("h1.element-title").first();
        const title =
            titleEl.contents().filter((_i, el) => el.type === "text").text().trim() ||
            titleEl.text().trim() ||
            mangaId;

        const image = $("img.book-thumbnail").attr("src") || FALLBACK_COVER;
        const desc = $("p.element-description").text().trim() || "Sin descripción disponible.";
        const status = this.mapStatus($("span.book-status").text());

        // Autor: enlace con filter_by=author
        const author = $('a[href*="filter_by=author"]').first().text().trim() || "Desconocido";

        // Géneros: badges (enlaces a genders[])
        const tags: Tag[] = [];
        $("h6 a.badge.badge-primary").each((_i, el) => {
            const label = $(el).text().trim();
            if (label) tags.push(createTag({ id: label.toLowerCase().replace(/\s+/g, "-"), label, type: 'blue' }));
        });
        // Tipo (manga/manhwa/...) desde el propio ID
        const type = mangaId.match(/^([a-z_]+)\//)?.[1];
        if (type) tags.push(createTag({ id: type, label: type.toUpperCase(), type: 'default' }));

        return createManga({
            id: mangaId,
            titles: [title],
            image: image,
            rating: 0,
            status: status,
            author: author,
            desc: desc,
            hentai: false,
            tags: [createTagSection({ id: '0', label: 'Géneros', tags })]
        });
    }

    // ---- chapters ----

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const html = await this.getSeriesHTML(mangaId);
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
            const time = this.parseRelativeDate(row.find(".chapter-row-date").first().text()) ?? new Date();

            seen.add(uploadId);
            chapters.push(createChapter({
                id: uploadId,
                mangaId: mangaId,
                name: nameText || `Capítulo ${chapNum || 0}`,
                chapNum: chapNum || 0,
                time: time,
                langCode: "es"
            }));
        });

        // Más reciente primero
        chapters.sort((a, b) => b.chapNum - a.chapNum);
        return chapters;
    }

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        // zonatmo.org sirve las imágenes directamente en /view_uploads/ (sin redirección al visor)
        const { $ } = await this.fetchHTML(`${WEB_URL}/view_uploads/${chapterId}`);

        const pages: string[] = [];
        const collect = (_i: number, el: cheerio.Element): void => {
            const src = ($(el).attr("data-src") || $(el).attr("src") || "").trim();
            if (src) pages.push(src);
        };

        $("img.reader-image").each(collect);
        // Fallback: contenedores del lector
        if (pages.length === 0) $("div.reader-img-wrap img").each(collect);
        // Fallback del visor antiguo (cascade)
        if (pages.length === 0) $("div.img-container img.viewer-img").each(collect);

        return createChapterDetails({
            id: chapterId,
            mangaId: mangaId,
            pages: pages,
        });
    }

    // ---- search ----

    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        const page = metadata?.page ?? 1;
        const term = encodeURIComponent(query.title ?? "");
        const { html } = await this.fetchHTML(`${WEB_URL}/biblioteca?title=${term}&filter_by=title&page=${page}`);

        const tiles = this.parseLibraryCards(html);
        const nextPage = this.hasNextPage(html) ? { page: page + 1 } : undefined;

        return createPagedResults({ results: tiles, metadata: nextPage });
    }

    // ---- home ----

    override async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        // Popular
        const popularSection = createHomeSection({
            id: 'popular',
            title: 'Lo más popular',
            type: HomeSectionType.singleRowLarge,
            view_more: true
        });
        sectionCallback(popularSection);
        const popular = await this.fetchHTML(`${WEB_URL}/biblioteca?order_item=likes_count&order_dir=desc&filter_by=title&page=1`);
        popularSection.items = this.parseLibraryCards(popular.html).slice(0, 10);
        sectionCallback(popularSection);

        // Últimos añadidos
        const latestSection = createHomeSection({
            id: 'latest_added',
            title: 'Últimos añadidos',
            type: HomeSectionType.singleRowNormal,
            view_more: true
        });
        sectionCallback(latestSection);
        const latest = await this.fetchHTML(`${WEB_URL}/biblioteca?order_item=creation&order_dir=desc&filter_by=title&page=1`);
        latestSection.items = this.parseLibraryCards(latest.html).slice(0, 10);
        sectionCallback(latestSection);
    }

    override async getViewMoreItems(homepageSectionId: string, metadata: any): Promise<PagedResults> {
        const page = metadata?.page ?? 1;
        let url = '';
        if (homepageSectionId === 'popular') url = `${WEB_URL}/biblioteca?order_item=likes_count&order_dir=desc&filter_by=title&page=${page}`;
        else if (homepageSectionId === 'latest_added') url = `${WEB_URL}/biblioteca?order_item=creation&order_dir=desc&filter_by=title&page=${page}`;
        else return createPagedResults({ results: [] });

        const { html } = await this.fetchHTML(url);
        const tiles = this.parseLibraryCards(html);
        const nextPage = this.hasNextPage(html) ? { page: page + 1 } : undefined;
        return createPagedResults({ results: tiles, metadata: nextPage });
    }
}
