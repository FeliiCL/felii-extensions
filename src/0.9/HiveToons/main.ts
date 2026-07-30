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
    Form,
    MangaProviding,
    Metadata,
    PagedResults,
    PaperbackInterceptor,
    Request,
    Response,
    SearchQuery,
    SearchResultItem,
    SearchResultsProviding,
    Section,
    SettingsFormProviding,
    SourceManga,
    Tag,
    TagSection,
    ToggleRow,
} from "@paperback/types";

import * as cheerio from "cheerio";

// URLs base
const WEB_URL = "https://hivetoons.org";
const API_URL = "https://api.hivetoons.org";
const STORAGE_HOST = "storage.hivetoon.com";
const FALLBACK_COVER = "https://placehold.co/400x600.png?text=No+Cover";

// Caché del HTML de /series/{slug} (compartido por getMangaDetails y getChapters)
const SERIES_CACHE_TTL = 60_000; // 1 min
const SERIES_CACHE_MAX = 30;

// --- NSFW (+18) setting ---
// Series are flagged via genres (Adult / Mature / Ecchi...). Defaults to the
// app profile's adult-content preference; overridable in the extension settings.
const NSFW_STATE_KEY = "hivetoons.showNsfw";
const ADULT_GENRE_RE = /adult|mature|ecchi|smut|hentai|nsfw/i;

function getShowNsfw(): boolean {
    const v = Application.getState(NSFW_STATE_KEY);
    if (typeof v === "boolean") return v;
    try {
        return typeof Application.filterAdultTitles === "boolean" ? !Application.filterAdultTitles : true;
    } catch {
        return true;
    }
}

class HiveToonsSettingsForm extends Form {
    private showNsfw = getShowNsfw();

    async updateShowNsfw(value: boolean): Promise<void> {
        this.showNsfw = value;
        Application.setState(value, NSFW_STATE_KEY);
        this.reloadForm();
    }

    override getSections() {
        return [
            Section(
                {
                    id: "content",
                    footer: "Hides series tagged with adult genres (Adult, Mature, Ecchi...) from search and the discover sections.",
                },
                [
                    ToggleRow("show_nsfw", {
                        title: "Show NSFW content (18+)",
                        value: this.showNsfw,
                        onValueChange: Application.Selector<
                            HiveToonsSettingsForm,
                            (value: boolean) => Promise<void>
                        >(this, "updateShowNsfw"),
                    }),
                ],
            ),
        ];
    }
}

class HiveToonsInterceptor extends PaperbackInterceptor {
    override async interceptRequest(request: Request): Promise<Request> {
        request.headers = {
            ...request.headers,
            referer: `${WEB_URL}/`,
            origin: WEB_URL,
            "user-agent": await Application.getDefaultUserAgent(),
            accept: "*/*",
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

type HiveToonsImplementation = Extension &
    SearchResultsProviding &
    MangaProviding &
    ChapterProviding &
    DiscoverSectionProviding &
    SettingsFormProviding;

export class HiveToonsExtension implements HiveToonsImplementation {
    requestManager = new HiveToonsInterceptor("main");
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

    async getSettingsForm(): Promise<Form> {
        return new HiveToonsSettingsForm();
    }

    // ----------------------------------------------------------------
    // Fetch helpers
    // ----------------------------------------------------------------

    private async fetchText(url: string): Promise<string> {
        const [, data] = await Application.scheduleRequest({ url, method: "GET" });
        return Application.arrayBufferToUTF8String(data);
    }

    private async fetchJson<T>(url: string): Promise<T> {
        const str = await this.fetchText(url);
        return JSON.parse(str) as T;
    }

    // HTML de la serie con las comillas desescapadas (los props Astro vienen HTML-escapados).
    private async getSeriesHTML(mangaId: string): Promise<string> {
        const now = Date.now();
        const cached = this.seriesCache.get(mangaId);
        if (cached && cached.expiry > now) return cached.data;

        const raw = await this.fetchText(`${WEB_URL}/series/${mangaId}`);
        const data = raw.replace(/&quot;/g, '"');

        if (this.seriesCache.size >= SERIES_CACHE_MAX) this.seriesCache.clear();
        this.seriesCache.set(mangaId, { data, expiry: now + SERIES_CACHE_TTL });
        return data;
    }

    // ----------------------------------------------------------------
    // Utils
    // ----------------------------------------------------------------

    private decodeEntities(text: string): string {
        return (text || "")
            .replace(/\\"/g, '"')
            .replace(/\\n/g, "\n")
            .replace(/\\\//g, "/")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#x27;/g, "'")
            .replace(/&apos;/g, "'")
            .replace(/&#x2F;/g, "/")
            .replace(/&nbsp;/g, " ")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&");
    }

    // postContent es HTML enriquecido (varía por serie: <p> por párrafo, <br><br>,
    // o un único <p> envolvente); se aplana a texto conservando los saltos.
    private htmlToText(html: string): string {
        return html
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p\s*>/gi, "\n\n")
            .replace(/<\/?[a-z][^>]*>/gi, "")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    // seriesStatus textual → estado string de Paperback 0.9
    private mapStatus(statusText: string): string {
        const s = (statusText || "").toUpperCase();
        if (s.includes("COMPLETED") || s.includes("ENDED") || s.includes("FINISHED")) return "Completed";
        if (s.includes("HIATUS") || s.includes("PAUSED")) return "Hiatus";
        if (s.includes("CANCEL") || s.includes("DROPPED")) return "Cancelled";
        return "Ongoing";
    }

    // Extrae un campo string del bloque serializado: "key":[0,"valor"]
    private extractString(data: string, key: string): string | undefined {
        const m = data.match(new RegExp(`"${key}":\\[0,"((?:\\\\.|[^"\\\\])*)"\\]`));
        return m ? m[1] : undefined;
    }

    // Los IDs en 0.9 solo admiten alfanuméricos y `._-@()[]%?#+=/&:`. Algunos slugs
    // traen apóstrofes (the-villain's-profiler) → se percent-encodean (%27). Los
    // sitios aceptan el slug encodeado en la URL, así que no hace falta decodificar.
    private toSafeId(id: string): string {
        return id.replace(/[^A-Za-z0-9._\-@()[\]%?#+=/&:]/g, (c) => {
            const enc = encodeURIComponent(c);
            if (enc !== c) return enc;
            return "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
        });
    }

    private postIsAdult(post: any): boolean {
        return Array.isArray(post?.genres) && post.genres.some((g: any) => ADULT_GENRE_RE.test(g?.name || ""));
    }

    private searchItemFromPost(post: any): SearchResultItem | undefined {
        const id = post?.slug;
        const title = post?.postTitle;
        const image = post?.featuredImage || FALLBACK_COVER;
        if (!id || !title) return undefined;
        return {
            mangaId: this.toSafeId(id),
            title,
            imageUrl: image,
            // Sin contentRating explícito la app trata el ítem como "Unknown" y
            // difumina la portada con una "U"; se declara siempre.
            contentRating: this.postIsAdult(post) ? ContentRating.ADULT : ContentRating.MATURE,
        };
    }

    // ----------------------------------------------------------------
    // Manga details
    // ----------------------------------------------------------------

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const data = await this.getSeriesHTML(mangaId);

        const title = this.decodeEntities(this.extractString(data, "postTitle") || mangaId);

        // Sinopsis: postContent va seguido siempre de "isNovel"
        let synopsis = "";
        const descMatch = data.match(/"postContent":\[0,"([\s\S]*?)"\],"isNovel"/);
        if (descMatch && descMatch[1]) synopsis = this.htmlToText(this.decodeEntities(descMatch[1]));

        // Portada: primer featuredImage del storage tras "postContent"
        let image = FALLBACK_COVER;
        const postIdx = data.indexOf('"postContent"');
        if (postIdx !== -1) {
            const coverMatch = data.slice(postIdx).match(
                new RegExp(`"featuredImage":\\[0,"(https://${STORAGE_HOST.replace(/\./g, "\\.")}/[^"]+)"\\]`),
            );
            const cover = coverMatch?.[1];
            if (cover) image = cover;
        }
        if (image === FALLBACK_COVER) {
            const og = data.match(/og:image"\s+content="([^"]+)"/);
            const ogImage = og?.[1];
            if (ogImage) image = ogImage;
        }

        const status = this.mapStatus(this.extractString(data, "seriesStatus") || "");

        // Autor (no está en los props; se lee del DOM renderizado)
        let author = "";
        const authorMatch = data.match(/Author<\/h1>\s*<div[^>]*>\s*<p[^>]*>([^<]+)<\/p>/);
        const authorName = authorMatch?.[1]?.trim();
        if (authorName) author = this.decodeEntities(authorName);

        // Rating medio (escala 0-10 → 0-5)
        let rating: number | undefined;
        const ratingMatch = data.match(/"averageRating":\[0,([\d.]+)\]/);
        const ratingRaw = ratingMatch?.[1];
        if (ratingRaw) rating = (parseFloat(ratingRaw) || 0) / 2;

        // Géneros: bloque "genres":[1,[ ... ]] tras "postContent"
        const tags: Tag[] = [];
        const genresIdx = data.indexOf('"genres":[1,[', postIdx === -1 ? 0 : postIdx);
        if (genresIdx !== -1) {
            const genresBlock = data.slice(genresIdx, genresIdx + 3000);
            const nameRe = /"name":\[0,"([^"]+)"\]/g;
            let gm: RegExpExecArray | null;
            while ((gm = nameRe.exec(genresBlock)) !== null) {
                const label = this.decodeEntities(gm[1] ?? "").trim();
                if (label) tags.push({ id: label.toLowerCase().replace(/\s+/g, "-"), title: label });
                if (tags.length >= 25) break;
            }
        }
        const seriesType = this.extractString(data, "seriesType");
        if (seriesType) tags.push({ id: seriesType.toLowerCase(), title: seriesType });

        const tagGroups: TagSection[] = [];
        if (tags.length > 0) tagGroups.push({ id: "genres", title: "Géneros", tags });

        const isAdult = tags.some((t) => ADULT_GENRE_RE.test(t.title));

        return {
            mangaId,
            mangaInfo: {
                primaryTitle: title,
                secondaryTitles: [],
                thumbnailUrl: image,
                synopsis: synopsis || "No description available.",
                contentRating: isAdult ? ContentRating.ADULT : ContentRating.MATURE,
                status,
                author: author || undefined,
                rating,
                tagGroups,
                shareUrl: `${WEB_URL}/series/${mangaId}`,
            },
        };
    }

    // ----------------------------------------------------------------
    // Chapters
    // ----------------------------------------------------------------

    async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
        const data = await this.getSeriesHTML(sourceManga.mangaId);

        const chapters: Chapter[] = [];
        const seen = new Set<string>();

        // {"id":[0,N],"number":[0,N],"slug":[0,"chapter-N"],"title":[0,"..."|null],"createdAt":[0,"ISO"]...}
        // El slug puede contener punto (capítulos decimales: chapter-510.1).
        const chapRe = /"id":\[0,(\d+)\],"number":\[0,([\d.]+)\],"slug":\[0,"(chapter-[A-Za-z0-9_.-]+)"\],"title":\[0,(?:"((?:\\.|[^"\\])*)"|null)\],"createdAt":\[0,"([^"]+)"\]/g;
        let m: RegExpExecArray | null;
        while ((m = chapRe.exec(data)) !== null) {
            const chapNum = parseFloat(m[2] ?? "") || 0;
            const slug = m[3];
            const rawTitle = this.decodeEntities(m[4] || "").trim();
            const createdAt = m[5];

            // Sin slug no hay chapterId: se descarta ese capítulo y se sigue.
            if (!slug || seen.has(slug)) continue;
            seen.add(slug);

            chapters.push({
                chapterId: slug,
                sourceManga,
                title: rawTitle || undefined,
                chapNum,
                publishDate: createdAt ? new Date(createdAt) : undefined,
                langCode: "en",
            });
        }

        chapters.sort((a, b) => b.chapNum - a.chapNum);
        return chapters;
    }

    async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
        const url = `${WEB_URL}/series/${chapter.sourceManga.mangaId}/${chapter.chapterId}`;
        const html = await this.fetchText(url);
        const $ = cheerio.load(html);

        const pages: string[] = [];
        $("img[data-reader-page-image]").each((_i, el) => {
            const src = ($(el).attr("src") || $(el).attr("data-src") || "").trim();
            if (src.startsWith("https://")) pages.push(src);
        });

        return {
            id: chapter.chapterId,
            mangaId: chapter.sourceManga.mangaId,
            pages,
        };
    }

    // ----------------------------------------------------------------
    // Search
    // ----------------------------------------------------------------

    async getSearchResults(
        query: SearchQuery<Metadata>,
        _metadata: Metadata | undefined,
    ): Promise<PagedResults<SearchResultItem>> {
        const term = encodeURIComponent(query.title ?? "");
        const json = await this.fetchJson<{ posts?: any[] }>(
            `${API_URL}/api/query?searchTerm=${term}&perPage=30`,
        );

        const showNsfw = getShowNsfw();
        const items: SearchResultItem[] = [];
        for (const post of json?.posts ?? []) {
            if (!showNsfw && this.postIsAdult(post)) continue;
            const item = this.searchItemFromPost(post);
            if (item) items.push(item);
        }

        return { items, metadata: undefined };
    }

    // ----------------------------------------------------------------
    // Discover
    // ----------------------------------------------------------------

    async getDiscoverSections(): Promise<DiscoverSection[]> {
        return [
            { id: "sliderPosts", title: "Featured", type: DiscoverSectionType.featured },
            { id: "initalPosts", title: "Latest Releases", type: DiscoverSectionType.simpleCarousel },
        ];
    }

    async getDiscoverSectionItems(
        section: DiscoverSection,
        _metadata: Metadata | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const raw = await this.fetchText(`${WEB_URL}/`);
        const data = raw.replace(/&quot;/g, '"');

        const sectionKeys = ["sliderPosts", "initalPosts", "novels"];
        const showNsfw = getShowNsfw();
        const tiles = this.parseHomeSection(data, section.id, sectionKeys).filter((t) => showNsfw || !t.isAdult);

        const isFeatured = section.type === DiscoverSectionType.featured;
        const items: DiscoverSectionItem[] = tiles.map((t) => {
            const rating = t.isAdult ? ContentRating.ADULT : ContentRating.MATURE;
            return isFeatured
                ? { type: "featuredCarouselItem", mangaId: t.mangaId, imageUrl: t.imageUrl, title: t.title, contentRating: rating }
                : { type: "simpleCarouselItem", mangaId: t.mangaId, imageUrl: t.imageUrl, title: t.title, contentRating: rating };
        });

        return { items, metadata: undefined };
    }

    // Extrae los posts de una sección embebida en el HTML del home.
    private parseHomeSection(
        data: string,
        key: string,
        allKeys: string[],
    ): { mangaId: string; title: string; imageUrl: string; isAdult: boolean }[] {
        const start = data.indexOf(`"${key}":[1,[`);
        if (start === -1) return [];

        let end = data.length;
        for (const other of allKeys) {
            if (other === key) continue;
            const oi = data.indexOf(`"${other}":[1,[`);
            if (oi > start && oi < end) end = oi;
        }

        const seg = data.slice(start, end);
        const out: { mangaId: string; title: string; imageUrl: string; isAdult: boolean }[] = [];
        const seen = new Set<string>();
        const postRe = /"id":\[0,\d+\],"slug":\[0,"([^"]+)"\],"postTitle":\[0,"((?:\\.|[^"\\])*)"\],"featuredImage":\[0,"([^"]*)"\]/g;

        // Primero recogemos los matches con su posición para poder delimitar
        // el bloque de cada post (los géneros van entre un post y el siguiente).
        const matches: { m: RegExpExecArray; index: number }[] = [];
        let m: RegExpExecArray | null;
        while ((m = postRe.exec(seg)) !== null) matches.push({ m, index: m.index });

        for (const [i, entry] of matches.entries()) {
            const cur = entry.m;
            // Sin slug el ítem no tiene mangaId: cae en el `!slug` de abajo y se descarta.
            const slug = this.toSafeId(this.decodeEntities(cur[1] ?? ""));
            const title = this.decodeEntities(cur[2] ?? "");
            const image = this.decodeEntities(cur[3] ?? "") || FALLBACK_COVER;
            if (!slug || seen.has(slug)) continue;
            seen.add(slug);

            // Bloque del post actual: desde este match hasta el siguiente (o el fin)
            const next = matches[i + 1];
            const blockEnd = next ? next.index : seg.length;
            const block = seg.slice(entry.index, blockEnd);
            let isAdult = false;
            const genresIdx = block.indexOf('"genres":[1,[');
            if (genresIdx !== -1) {
                const genresBlock = block.slice(genresIdx, genresIdx + 1500);
                const nameRe = /"name":\[0,"([^"]+)"\]/g;
                let gm: RegExpExecArray | null;
                while ((gm = nameRe.exec(genresBlock)) !== null) {
                    if (ADULT_GENRE_RE.test(gm[1] ?? "")) { isAdult = true; break; }
                }
            }

            out.push({ mangaId: slug, title, imageUrl: image, isAdult });
        }
        return out;
    }
}

export const HiveToons = new HiveToonsExtension();
