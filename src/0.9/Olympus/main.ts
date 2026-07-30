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

// URLs base — frontend Nuxt + backend Laravel (panel)
const WEB_URL = "https://olympusxyz.com";
const API_URL = `${WEB_URL}/api`;
const PANEL_API = "https://panel.olympusxyz.com/api";
const FALLBACK_COVER = "https://placehold.co/400x600.png?text=No+Cover";

// Caché del catálogo completo (/api/series/list, ~850 items) para búsqueda client-side
const LIST_CACHE_TTL = 300_000; // 5 min
// Tope de páginas de capítulos (40/página → 2000 capítulos)
const MAX_CHAPTER_PAGES = 50;

interface OlympusMetadata {
    page?: number;
}

class OlympusInterceptor extends PaperbackInterceptor {
    override async interceptRequest(request: Request): Promise<Request> {
        request.headers = {
            ...request.headers,
            referer: `${WEB_URL}/`,
            origin: WEB_URL,
            "user-agent": await Application.getDefaultUserAgent(),
            accept: "application/json, text/plain, */*",
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

type OlympusImplementation = Extension &
    SearchResultsProviding &
    MangaProviding &
    ChapterProviding &
    DiscoverSectionProviding;

export class OlympusExtension implements OlympusImplementation {
    requestManager = new OlympusInterceptor("main");
    globalRateLimiter = new BasicRateLimiter("rateLimiter", {
        numberOfRequests: 3,
        bufferInterval: 1,
        ignoreImages: true,
    });

    private listCache: { data: any[]; expiry: number } | undefined;

    async initialise(): Promise<void> {
        this.requestManager.registerInterceptor();
        this.globalRateLimiter.registerInterceptor();
    }

    // ---- fetch helpers ----

    private async fetchJson<T = any>(url: string): Promise<T> {
        const [response, data] = await Application.scheduleRequest({ url, method: "GET" });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`La petición falló (${response.status}): ${url}`);
        }
        return JSON.parse(Application.arrayBufferToUTF8String(data)) as T;
    }

    // Catálogo completo (con caché): [{id, name, slug, cover, type}]
    private async getFullList(): Promise<any[]> {
        const now = Date.now();
        if (this.listCache && this.listCache.expiry > now) return this.listCache.data;

        const json = await this.fetchJson<any>(`${API_URL}/series/list`);
        const arr: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
        this.listCache = { data: arr, expiry: now + LIST_CACHE_TTL };
        return arr;
    }

    // ---- utils ----

    // Normaliza para búsqueda sin acentos ni mayúsculas
    private normalize(text: string): string {
        return (text || "")
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "");
    }

    private toSafeId(id: string): string {
        return id.replace(/[^A-Za-z0-9._\-@()[\]%?#+=/&:]/g, (c) => {
            const enc = encodeURIComponent(c);
            if (enc !== c) return enc;
            return "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
        });
    }

    private mapStatus(statusName: string): string {
        const s = this.normalize(statusName);
        if (s.includes("finalizado") || s.includes("completado")) return "Completed";
        if (s.includes("pausado") || s.includes("pausa")) return "Hiatus";
        if (s.includes("cancelado") || s.includes("abandonado") || s.includes("dropeado")) return "Cancelled";
        return "Ongoing"; // "Activo"
    }

    // ---- manga details ----

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const json = await this.fetchJson<any>(`${API_URL}/series/${mangaId}`);
        const d = json?.data ?? json;

        const tags: Tag[] = [];
        for (const g of d?.genres ?? []) {
            const label = (g?.name ?? "").trim();
            if (label) tags.push({ id: this.normalize(label).replace(/\s+/g, "-"), title: label });
        }
        const tagGroups: TagSection[] = [];
        if (tags.length > 0) tagGroups.push({ id: "genres", title: "Géneros", tags });

        let rating: number | undefined;
        const rawRating = parseFloat(String(d?.rating ?? ""));
        if (!isNaN(rawRating) && rawRating > 0) rating = rawRating > 5 ? rawRating / 2 : rawRating;

        return {
            mangaId,
            mangaInfo: {
                primaryTitle: (d?.name ?? mangaId).trim(),
                secondaryTitles: [],
                thumbnailUrl: d?.cover || FALLBACK_COVER,
                synopsis: (d?.summary ?? "").trim() || "Sin descripción disponible.",
                contentRating: ContentRating.MATURE,
                status: this.mapStatus(d?.status?.name ?? ""),
                author: d?.team?.name?.trim() || undefined,
                rating,
                tagGroups,
                shareUrl: `${WEB_URL}/series/comic-${mangaId}`,
            },
        };
    }

    // ---- chapters ----

    async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
        const chapters: Chapter[] = [];
        const seen = new Set<string>();
        let page = 1;
        let lastPage = 1;

        do {
            const json = await this.fetchJson<any>(
                `${PANEL_API}/series/${sourceManga.mangaId}/chapters?page=${page}&direction=desc`,
            );
            lastPage = Math.min(json?.meta?.last_page ?? 1, MAX_CHAPTER_PAGES);

            for (const ch of json?.data ?? []) {
                const chapterId = String(ch?.id ?? "");
                if (!chapterId || seen.has(chapterId)) continue;
                seen.add(chapterId);

                chapters.push({
                    chapterId,
                    sourceManga,
                    title: ch?.title ? String(ch.title).trim() : undefined,
                    chapNum: parseFloat(String(ch?.name)) || 0,
                    publishDate: ch?.published_at ? new Date(ch.published_at) : undefined,
                    langCode: "es",
                });
            }
            page++;
        } while (page <= lastPage);

        chapters.sort((a, b) => b.chapNum - a.chapNum);
        return chapters;
    }

    async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
        const json = await this.fetchJson<any>(
            `${API_URL}/capitulo/${chapter.sourceManga.mangaId}/${chapter.chapterId}`,
        );
        const raw: string[] = json?.chapter?.pages ?? json?.data?.chapter?.pages ?? [];
        // Los nombres de archivo traen espacios y acentos → encodeURI;
        // solo se aceptan URLs https tal cual las sirve la API
        const pages = raw
            .filter((p) => typeof p === "string" && p.startsWith("https://"))
            .map((p) => encodeURI(p));

        return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages };
    }

    // ---- search (client-side sobre el catálogo completo) ----

    async getSearchResults(
        query: SearchQuery<Metadata>,
        _metadata: Metadata | undefined,
    ): Promise<PagedResults<SearchResultItem>> {
        const term = this.normalize(query.title ?? "");
        const list = await this.getFullList();

        const items: SearchResultItem[] = [];
        const seen = new Set<string>();
        for (const s of list) {
            if (s?.type !== "comic") continue; // las novelas no son leíbles como imágenes
            if (term && !this.normalize(s?.name ?? "").includes(term)) continue;
            const mangaId = this.toSafeId(s?.slug ?? "");
            if (!mangaId || seen.has(mangaId)) continue;
            seen.add(mangaId);
            items.push({
                mangaId,
                title: (s?.name ?? "").trim(),
                imageUrl: s?.cover || FALLBACK_COVER,
                // Sin contentRating explícito la app trata el ítem como "Unknown"
                // y difumina la portada con una "U"; se declara siempre.
                contentRating: ContentRating.MATURE,
            });
            if (items.length >= 100) break;
        }

        return { items, metadata: undefined };
    }

    // ---- discover ----

    async getDiscoverSections(): Promise<DiscoverSection[]> {
        return [
            { id: "populares", title: "Populares", type: DiscoverSectionType.featured },
            { id: "nuevos_caps", title: "Nuevos capítulos", type: DiscoverSectionType.simpleCarousel },
            { id: "series", title: "Todas las series", type: DiscoverSectionType.simpleCarousel },
        ];
    }

    async getDiscoverSectionItems(
        section: DiscoverSection,
        metadata: Metadata | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        if (section.id === "series") {
            // Listado paginado del catálogo (15/página)
            const page = (metadata as OlympusMetadata | undefined)?.page ?? 1;
            const json = await this.fetchJson<any>(`${API_URL}/series?page=${page}`);
            const s = json?.data?.series;
            const items: DiscoverSectionItem[] = (s?.data ?? [])
                .filter((x: any) => x?.type === "comic")
                .map((x: any) => ({
                    type: "simpleCarouselItem" as const,
                    mangaId: this.toSafeId(x?.slug ?? ""),
                    imageUrl: x?.cover || FALLBACK_COVER,
                    title: (x?.name ?? "").trim(),
                    contentRating: ContentRating.MATURE,
                }))
                .filter((x: DiscoverSectionItem & { mangaId: string }) => x.mangaId);
            const hasNext = (s?.current_page ?? 1) < (s?.last_page ?? 1);
            return { items, metadata: hasNext ? { page: page + 1 } : undefined };
        }

        // Secciones del homepage
        const json = await this.fetchJson<any>(`${API_URL}/homepage`);
        const d = json?.data ?? json ?? {};

        if (section.id === "populares") {
            // popular_comics puede venir serializado como string JSON
            let pop: any = d.popular_comics;
            if (typeof pop === "string") {
                try { pop = JSON.parse(pop); } catch { pop = []; }
            }
            const items: DiscoverSectionItem[] = (Array.isArray(pop) ? pop : [])
                .filter((x: any) => x?.type === "comic" && x?.slug)
                .map((x: any) => ({
                    type: "featuredCarouselItem" as const,
                    mangaId: this.toSafeId(x.slug),
                    imageUrl: x?.cover || FALLBACK_COVER,
                    title: (x?.name ?? "").trim(),
                    contentRating: ContentRating.MATURE,
                }));
            return { items, metadata: undefined };
        }

        // nuevos_caps
        const items: DiscoverSectionItem[] = (Array.isArray(d.new_chapters) ? d.new_chapters : [])
            .filter((x: any) => x?.slug)
            .map((x: any) => {
                const lastCh = x?.last_chapters?.[0];
                return {
                    type: "simpleCarouselItem" as const,
                    mangaId: this.toSafeId(x.slug),
                    imageUrl: x?.cover || FALLBACK_COVER,
                    title: (x?.name ?? "").trim(),
                    subtitle: lastCh?.name ? `Cap. ${lastCh.name}` : undefined,
                    contentRating: ContentRating.MATURE,
                };
            });
        return { items, metadata: undefined };
    }
}

export const Olympus = new OlympusExtension();
