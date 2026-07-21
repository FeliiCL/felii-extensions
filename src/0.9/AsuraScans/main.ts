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

// Asura Scans — Astro/"Toraka" platform. Series/browse pages embed serialized
// props ("key":[0,value] / [1,[array]]) inside HTML-escaped attributes.
const WEB_URL = "https://asurascans.com";
const FALLBACK_COVER = "https://placehold.co/400x600.png?text=No+Cover";

const SERIES_CACHE_TTL = 60_000;
const SERIES_CACHE_MAX = 30;

interface AsuraMetadata {
    page?: number;
}

class AsuraScansInterceptor extends PaperbackInterceptor {
    override async interceptRequest(request: Request): Promise<Request> {
        request.headers = {
            ...request.headers,
            referer: `${WEB_URL}/`,
            "user-agent": await Application.getDefaultUserAgent(),
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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

type AsuraScansImplementation = Extension &
    SearchResultsProviding &
    MangaProviding &
    ChapterProviding &
    DiscoverSectionProviding;

export class AsuraScansExtension implements AsuraScansImplementation {
    requestManager = new AsuraScansInterceptor("main");
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
            throw new Error(`Cloudflare blocked the request (${response.status}). Open ${WEB_URL} in the app to solve the challenge.`);
        }
        if (response.status === 404) throw new Error("Content not found (404)");
        // Desescapar comillas para poder extraer los props serializados con regex
        return Application.arrayBufferToUTF8String(data).replace(/&quot;/g, '"');
    }

    private async getSeriesHTML(mangaId: string): Promise<string> {
        const now = Date.now();
        const cached = this.seriesCache.get(mangaId);
        if (cached && cached.expiry > now) return cached.data;

        const data = await this.fetchText(`${WEB_URL}/comics/${mangaId}`);
        if (this.seriesCache.size >= SERIES_CACHE_MAX) this.seriesCache.clear();
        this.seriesCache.set(mangaId, { data, expiry: now + SERIES_CACHE_TTL });
        return data;
    }

    // ---- utils ----

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

    private stripHtml(text: string): string {
        return this.decodeEntities(text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }

    private toSafeId(id: string): string {
        return id.replace(/[^A-Za-z0-9._\-@()[\]%?#+=/&:]/g, (c) => {
            const enc = encodeURIComponent(c);
            if (enc !== c) return enc;
            return "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
        });
    }

    private mapStatus(statusText: string): string {
        const s = (statusText || "").toLowerCase();
        if (s.includes("completed") || s.includes("ended") || s.includes("finished")) return "Completed";
        if (s.includes("hiatus") || s.includes("paused")) return "Hiatus";
        if (s.includes("cancel") || s.includes("dropped")) return "Cancelled";
        return "Ongoing";
    }

    private extractString(data: string, key: string): string | undefined {
        const m = data.match(new RegExp(`"${key}":\\[0,"((?:\\\\.|[^"\\\\])*)"\\]`));
        return m ? m[1] : undefined;
    }

    // Parsea las cards serializadas de /browse (clave initialSeries).
    // Cada card: ..."title":[0,"X"]...(alt_titles/description)..."cover":[0,"url"]..."public_url":[0,"/comics/slug"]...
    private parseBrowseCards(data: string): { mangaId: string; title: string; imageUrl: string }[] {
        const out: { mangaId: string; title: string; imageUrl: string }[] = [];
        const seen = new Set<string>();

        // Delimitar por public_url y buscar título/cover hacia atrás dentro de la card
        const urlRe = /"public_url":\[0,"\/comics\/([^"]+)"\]/g;
        let prevEnd = 0;
        let m: RegExpExecArray | null;
        while ((m = urlRe.exec(data)) !== null) {
            const segment = data.slice(prevEnd, m.index);
            prevEnd = m.index;

            const titles = [...segment.matchAll(/"title":\[0,"((?:\\.|[^"\\])*)"\]/g)];
            const covers = [...segment.matchAll(/"cover":\[0,"(https:[^"]+)"\]/g)];
            const lastTitle = titles[titles.length - 1]?.[1];
            const lastCover = covers[covers.length - 1]?.[1];
            const title = lastTitle ? this.decodeEntities(lastTitle) : "";
            const cover = lastCover ? this.decodeEntities(lastCover) : FALLBACK_COVER;

            // Sin slug la card no identifica a ninguna serie: se descarta
            const slug = m[1];
            if (!slug) continue;
            const mangaId = this.toSafeId(slug);
            if (!mangaId || !title || seen.has(mangaId)) continue;
            seen.add(mangaId);
            out.push({ mangaId, title, imageUrl: cover });
        }
        return out;
    }

    // ---- manga details ----

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const data = await this.getSeriesHTML(mangaId);

        const ogTitle = data.match(/og:title" content="([^"|]+)/)?.[1];
        const title = this.decodeEntities((ogTitle ?? mangaId).trim());

        const descRaw = this.extractString(data, "description") || "";
        const synopsis = this.stripHtml(descRaw) || "No description available.";

        let image = this.decodeEntities(this.extractString(data, "cover") || "");
        if (!image) {
            const og = data.match(/og:image" content="([^"]+)"/)?.[1];
            image = og ?? FALLBACK_COVER;
        }

        const status = this.mapStatus(this.extractString(data, "status") || "");
        const author = this.decodeEntities(this.extractString(data, "author") || "").trim() || undefined;
        const artist = this.decodeEntities(this.extractString(data, "artist") || "").trim() || undefined;

        let rating: number | undefined;
        const rm = data.match(/"rating":\[0,([\d.]+)\]/)?.[1];
        if (rm) rating = (parseFloat(rm) || 0) / 2; // escala 0-10 → 0-5

        const tags: Tag[] = [];
        const gi = data.indexOf('"genres":[1,[');
        if (gi !== -1) {
            const gblock = data.slice(gi, gi + 3000);
            const nameRe = /"name":\[0,"([^"]+)"\]/g;
            let gm: RegExpExecArray | null;
            while ((gm = nameRe.exec(gblock)) !== null) {
                const label = this.decodeEntities(gm[1] ?? "").trim();
                if (label) tags.push({ id: label.toLowerCase().replace(/\s+/g, "-"), title: label });
                if (tags.length >= 25) break;
            }
        }
        const type = this.extractString(data, "type");
        if (type) tags.push({ id: type.toLowerCase(), title: type.toUpperCase() });

        const tagGroups: TagSection[] = [];
        if (tags.length > 0) tagGroups.push({ id: "genres", title: "Genres", tags });

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
                artist,
                rating,
                tagGroups,
                shareUrl: `${WEB_URL}/comics/${mangaId}`,
            },
        };
    }

    // ---- chapters ----

    async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
        const data = await this.getSeriesHTML(sourceManga.mangaId);

        // 1) Lista COMPLETA de números desde los enlaces SEO (<a href=".../chapter/N">);
        //    los props serializados solo traen los ~190 más recientes.
        const allNumbers = new Set<string>();
        const hrefRe = /href="[^"]*\/chapter\/([\d.]+)"/g;
        let hm: RegExpExecArray | null;
        while ((hm = hrefRe.exec(data)) !== null) {
            // El número es el id del capítulo: sin él el enlace no sirve
            const number = hm[1];
            if (number) allNumbers.add(number);
        }

        // 2) Metadatos (título, fecha, lock) desde los objetos serializados
        const meta = new Map<string, { title?: string; publishDate?: Date; locked: boolean }>();
        const chapRe = /"number":\[0,([\d.]+)\],"title":\[0,(?:"((?:\\.|[^"\\])*)"|null)\],"slug":\[0,"chapter-[A-Za-z0-9_.-]+"\]/g;
        const matches: { m: RegExpExecArray; index: number }[] = [];
        let m: RegExpExecArray | null;
        while ((m = chapRe.exec(data)) !== null) matches.push({ m, index: m.index });

        for (const [i, cur] of matches.entries()) {
            const numberStr = cur.m[1];
            if (!numberStr) continue;
            const next = matches[i + 1];
            const blockEnd = next ? next.index : Math.min(data.length, cur.index + 2000);
            const block = data.slice(cur.index, blockEnd);

            const locked = /"is_locked":\[0,true\]/.test(block) || /"is_premium":\[0,true\]/.test(block);
            const pd = block.match(/"published_at":\[0,"([^"]+)"\]/)?.[1];
            const rawTitle = this.decodeEntities(cur.m[2] || "").trim();

            if (!meta.has(numberStr)) {
                meta.set(numberStr, {
                    title: rawTitle || undefined,
                    publishDate: pd ? new Date(pd) : undefined,
                    locked,
                });
            }
            allNumbers.add(numberStr);
        }

        const chapters: Chapter[] = [];
        for (const numberStr of allNumbers) {
            const info = meta.get(numberStr);
            // Saltar bloqueados/premium (no se pueden leer sin cuenta)
            if (info?.locked) continue;
            chapters.push({
                // La ruta del lector usa el número: /comics/{slug}/chapter/{number}
                chapterId: numberStr,
                sourceManga,
                title: info?.title,
                chapNum: parseFloat(numberStr) || 0,
                publishDate: info?.publishDate,
                langCode: "en",
            });
        }

        chapters.sort((a, b) => b.chapNum - a.chapNum);
        return chapters;
    }

    async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
        const data = await this.fetchText(
            `${WEB_URL}/comics/${chapter.sourceManga.mangaId}/chapter/${chapter.chapterId}`,
        );

        const pages: string[] = [];
        const pi = data.indexOf('"pages":[1,[');
        if (pi !== -1) {
            // El array de páginas termina en "]]"; acotamos generosamente
            const seg = data.slice(pi, pi + 100_000);
            const urlRe = /"url":\[0,"(https:[^"]+)"\]/g;
            let m: RegExpExecArray | null;
            while ((m = urlRe.exec(seg)) !== null) {
                // Sin URL la página no se puede mostrar: se omite y se sigue leyendo el array
                const url = m[1];
                if (url) pages.push(this.decodeEntities(url));
                // Cortar al cerrar el array (heurística: el primer no-página rompe el patrón contiguo)
                if (seg.slice(m.index + m[0].length, m.index + m[0].length + 4).startsWith("]]")) break;
            }
        }

        return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages };
    }

    // ---- search ----

    async getSearchResults(
        query: SearchQuery<Metadata>,
        metadata: Metadata | undefined,
    ): Promise<PagedResults<SearchResultItem>> {
        const page = (metadata as AsuraMetadata | undefined)?.page ?? 1;
        const term = encodeURIComponent(query.title ?? "");
        const data = await this.fetchText(`${WEB_URL}/browse?q=${term}&page=${page}`);

        // Sin contentRating explícito la app trata el ítem como "Unknown" y
        // difumina la portada con una "U"; se declara siempre.
        const items: SearchResultItem[] = this.parseBrowseCards(data).map((t) => ({
            mangaId: t.mangaId,
            title: t.title,
            imageUrl: t.imageUrl,
            contentRating: ContentRating.MATURE,
        }));

        const hasNext = data.includes(`page=${page + 1}`);
        return { items, metadata: hasNext && items.length > 0 ? { page: page + 1 } : undefined };
    }

    // ---- discover ----

    async getDiscoverSections(): Promise<DiscoverSection[]> {
        return [
            { id: "popular", title: "Popular", type: DiscoverSectionType.featured },
            { id: "rating", title: "Top Rated", type: DiscoverSectionType.prominentCarousel },
            { id: "latest", title: "Latest", type: DiscoverSectionType.simpleCarousel },
        ];
    }

    async getDiscoverSectionItems(
        section: DiscoverSection,
        metadata: Metadata | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const page = (metadata as AsuraMetadata | undefined)?.page ?? 1;
        const sortParam = section.id === "popular" ? "&sort=popular" : section.id === "rating" ? "&sort=rating" : "";
        const data = await this.fetchText(`${WEB_URL}/browse?page=${page}${sortParam}`);

        const tiles = this.parseBrowseCards(data);
        const items: DiscoverSectionItem[] = tiles.map((t) => {
            const base = {
                mangaId: t.mangaId,
                imageUrl: t.imageUrl,
                title: t.title,
                contentRating: ContentRating.MATURE,
            };
            if (section.type === DiscoverSectionType.featured)
                return { type: "featuredCarouselItem", ...base };
            if (section.type === DiscoverSectionType.prominentCarousel)
                return { type: "prominentCarouselItem", ...base };
            return { type: "simpleCarouselItem", ...base };
        });

        const hasNext = data.includes(`page=${page + 1}`);
        return { items, metadata: hasNext && items.length > 0 ? { page: page + 1 } : undefined };
    }
}

export const AsuraScans = new AsuraScansExtension();
