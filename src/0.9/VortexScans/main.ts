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
const WEB_URL = "https://vortexscans.org";
const API_URL = "https://api.vortexscans.org";
const STORAGE_HOST = "storage.vortexscans.org";
const FALLBACK_COVER = "https://placehold.co/400x600.png?text=No+Cover";

const SERIES_CACHE_TTL = 60_000;
const SERIES_CACHE_MAX = 30;

// --- NSFW (+18) setting ---
// Series are flagged via genres (Adult / Mature / Ecchi...). Defaults to the
// app profile's adult-content preference; overridable in the extension settings.
const NSFW_STATE_KEY = "vortexscans.showNsfw";
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

class VortexScansSettingsForm extends Form {
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
                            VortexScansSettingsForm,
                            (value: boolean) => Promise<void>
                        >(this, "updateShowNsfw"),
                    }),
                ],
            ),
        ];
    }
}

class VortexScansInterceptor extends PaperbackInterceptor {
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

type VortexScansImplementation = Extension &
    SearchResultsProviding &
    MangaProviding &
    ChapterProviding &
    DiscoverSectionProviding &
    SettingsFormProviding;

export class VortexScansExtension implements VortexScansImplementation {
    requestManager = new VortexScansInterceptor("main");
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
        return new VortexScansSettingsForm();
    }

    // ---- fetch helpers ----

    private async fetchText(url: string): Promise<string> {
        const [, data] = await Application.scheduleRequest({ url, method: "GET" });
        return Application.arrayBufferToUTF8String(data);
    }

    private async fetchJson<T>(url: string): Promise<T> {
        return JSON.parse(await this.fetchText(url)) as T;
    }

    private async getSeriesHTML(mangaId: string): Promise<string> {
        const now = Date.now();
        const cached = this.seriesCache.get(mangaId);
        if (cached && cached.expiry > now) return cached.data;

        const data = await this.fetchText(`${WEB_URL}/series/${mangaId}`);
        if (this.seriesCache.size >= SERIES_CACHE_MAX) this.seriesCache.clear();
        this.seriesCache.set(mangaId, { data, expiry: now + SERIES_CACHE_TTL });
        return data;
    }

    // ---- utils ----

    private decodeEntities(text: string): string {
        return (text || "")
            .replace(/\\"/g, '"')
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

    private mapStatus(statusText: string): string {
        const s = (statusText || "").toUpperCase();
        if (s.includes("COMPLETED") || s.includes("ENDED") || s.includes("FINISHED")) return "Completed";
        if (s.includes("HIATUS") || s.includes("PAUSED")) return "Hiatus";
        if (s.includes("CANCEL") || s.includes("DROPPED")) return "Cancelled";
        return "Ongoing";
    }

    // Los IDs en 0.9 solo admiten alfanuméricos y `._-@()[]%?#+=/&:`. Algunos slugs
    // traen apóstrofes (barbarian's-adventure...) → se percent-encodean (%27). El
    // sitio acepta el slug encodeado en la URL, así que no hace falta decodificar.
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

    // ---- manga details ----

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const response = await this.fetchText(`${WEB_URL}/series/${mangaId}`);
        const $ = cheerio.load(response);

        const title = $('meta[property="og:title"]').attr("content")?.trim() || mangaId;
        let synopsis = ($('meta[property="og:description"]').attr("content") || "").replace(/<[^>]+>/g, "").trim();
        if (!synopsis) synopsis = "Sin descripción disponible.";

        // Datos serializados (Astro): desescapamos comillas para extraer con regex.
        const data = response.replace(/&quot;/g, '"');

        // Portada: primer featuredImage del storage tras "postContent" (ruta /upload/series/featured/...)
        let image = "";
        const postIdx = data.indexOf('"postContent"');
        const searchArea = postIdx !== -1 ? data.slice(postIdx) : data;
        const coverMatch = searchArea.match(
            new RegExp(`"featuredImage":\\[0,"(https://${STORAGE_HOST.replace(/\./g, "\\.")}/upload/[^"]+?\\.(?:webp|png|jpg|jpeg|gif))"\\]`),
        );
        const coverUrl = coverMatch?.[1];
        if (coverUrl) image = coverUrl;
        if (!image) image = $('meta[property="og:image"]').attr("content") || FALLBACK_COVER;

        const statusMatch = data.match(/"seriesStatus":\[0,"([^"]+)"\]/);
        const status = this.mapStatus(statusMatch?.[1] ?? "");

        const artistMatch = data.match(/"artist":\[0,"([^"]+)"\]/);
        const artist = artistMatch?.[1];
        const author = artist ? this.decodeEntities(artist) : undefined;

        const tags: Tag[] = [];
        const genresIdx = data.indexOf('"genres":[1,[');
        if (genresIdx !== -1) {
            const genresBlock = data.slice(genresIdx, genresIdx + 2000);
            const nameRe = /"name":\[0,"([^"]+)"\]/g;
            let m: RegExpExecArray | null;
            while ((m = nameRe.exec(genresBlock)) !== null) {
                const label = this.decodeEntities(m[1] ?? "").trim();
                if (label) tags.push({ id: label.toLowerCase().replace(/\s+/g, "-"), title: label });
                if (tags.length >= 20) break;
            }
        }
        const typeMatch = data.match(/"seriesType":\[0,"([^"]+)"\]/);
        if (typeMatch && typeMatch[1]) tags.push({ id: typeMatch[1].toLowerCase(), title: typeMatch[1] });

        const tagGroups: TagSection[] = [];
        if (tags.length > 0) tagGroups.push({ id: "genres", title: "Géneros", tags });

        const isAdult = tags.some((t) => ADULT_GENRE_RE.test(t.title));

        return {
            mangaId,
            mangaInfo: {
                primaryTitle: title,
                secondaryTitles: [],
                thumbnailUrl: image,
                synopsis,
                contentRating: isAdult ? ContentRating.ADULT : ContentRating.MATURE,
                status,
                author,
                tagGroups,
                shareUrl: `${WEB_URL}/series/${mangaId}`,
            },
        };
    }

    // ---- chapters ----

    async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
        const data = (await this.getSeriesHTML(sourceManga.mangaId)).replace(/&quot;/g, '"');

        const chapters: Chapter[] = [];
        const seen = new Set<string>();

        const chapRe = /"id":\[0,(\d+)\],"number":\[0,([\d.]+)\],"slug":\[0,"(chapter-[A-Za-z0-9_.-]+)"\],"title":\[0,(?:"((?:\\.|[^"\\])*)"|null)\],"createdAt":\[0,"([^"]+)"\]/g;
        let m: RegExpExecArray | null;
        while ((m = chapRe.exec(data)) !== null) {
            // Sin slug no hay chapterId: el capítulo es inservible, se descarta
            // sin abortar el resto del listado.
            const slug = m[3];
            if (!slug) continue;

            const chapNum = parseFloat(m[2] ?? "") || 0;
            const rawTitle = this.decodeEntities(m[4] || "").trim();
            const createdAt = m[5];

            if (seen.has(slug)) continue;
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
        const $ = cheerio.load(await this.fetchText(url));

        const pages: string[] = [];
        $("img[data-reader-page-image]").each((_i, el) => {
            const src = ($(el).attr("src") || $(el).attr("data-src") || "").trim();
            if (src) pages.push(src);
        });

        return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages };
    }

    // ---- search ----

    async getSearchResults(
        query: SearchQuery<Metadata>,
        _metadata: Metadata | undefined,
    ): Promise<PagedResults<SearchResultItem>> {
        const term = encodeURIComponent(query.title ?? "");
        const json = await this.fetchJson<{ posts?: any[] }>(`${API_URL}/api/query?searchTerm=${term}&perPage=50`);

        const showNsfw = getShowNsfw();
        const items: SearchResultItem[] = [];
        for (const post of json?.posts ?? []) {
            if (!showNsfw && this.postIsAdult(post)) continue;
            const item = this.searchItemFromPost(post);
            if (item) items.push(item);
        }
        return { items, metadata: undefined };
    }

    // ---- discover ----

    async getDiscoverSections(): Promise<DiscoverSection[]> {
        return [
            { id: "sliderPosts", title: "Featured", type: DiscoverSectionType.featured },
            { id: "posts", title: "Popular Today", type: DiscoverSectionType.prominentCarousel },
            { id: "initalPosts", title: "Latest", type: DiscoverSectionType.simpleCarousel },
        ];
    }

    async getDiscoverSectionItems(
        section: DiscoverSection,
        _metadata: Metadata | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const data = (await this.fetchText(`${WEB_URL}/`)).replace(/&quot;/g, '"');
        const sectionKeys = ["sliderPosts", "posts", "initalPosts"];
        const showNsfw = getShowNsfw();
        const tiles = this.parseHomeSection(data, section.id, sectionKeys).filter((t) => showNsfw || !t.isAdult);

        const items: DiscoverSectionItem[] = tiles.map((t) => {
            const base = {
                mangaId: t.mangaId,
                imageUrl: t.imageUrl,
                title: t.title,
                contentRating: t.isAdult ? ContentRating.ADULT : ContentRating.MATURE,
            };
            if (section.type === DiscoverSectionType.featured)
                return { type: "featuredCarouselItem", ...base };
            if (section.type === DiscoverSectionType.prominentCarousel)
                return { type: "prominentCarouselItem", ...base };
            return { type: "simpleCarouselItem", ...base };
        });

        return { items, metadata: undefined };
    }

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
            // Sin slug no hay mangaId: el `if (!slug)` de abajo descarta el post.
            const slug = this.toSafeId(this.decodeEntities(cur[1] ?? ""));
            const title = this.decodeEntities(cur[2] ?? "");
            const image = this.decodeEntities(cur[3] ?? "") || FALLBACK_COVER;
            if (!slug || seen.has(slug)) continue;
            seen.add(slug);

            // Bloque del post actual: desde este match hasta el siguiente (o el fin)
            const blockEnd = matches[i + 1]?.index ?? seg.length;
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

export const VortexScans = new VortexScansExtension();
