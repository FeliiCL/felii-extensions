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

// URLs Base
const WEB_URL = "https://hivetoons.org";
const API_URL = "https://api.hivetoons.org";
const STORAGE_HOST = "storage.hivetoon.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const FALLBACK_COVER = "https://placehold.co/400x600?text=No+Cover";

// Caché de la página de serie (la comparten getMangaDetails y getChapters)
const SERIES_CACHE_TTL = 60_000; // 1 min
const SERIES_CACHE_MAX = 30;

export const HiveToonsInfo: SourceInfo = {
    version: '1.0.0',
    name: 'HiveToons',
    icon: 'icon.png',
    author: 'Felii',
    authorWebsite: 'https://github.com/FeliiCL',
    description: 'Lectura desde HiveToons (hivetoons.org)',
    contentRating: ContentRating.MATURE,
    websiteBaseURL: WEB_URL,
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS
};

export class HiveToons extends Source {

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
                    "Accept": "*/*"
                };
                return request;
            },
            interceptResponse: async (response: Response): Promise<Response> => {
                return response;
            },
        },
    });

    // Caché del HTML de /series/{slug} (evita pedir la página dos veces al abrir un manga)
    private seriesCache = new Map<string, { data: string; expiry: number }>();

    CloudFlareError(status: number) {
        if (status === 503 || status === 403) {
            throw new Error(`CLOUDFLARE BYPASS ERROR: Please go to the homepage of the source and press Cloudflare Bypass. Status code: ${status}`);
        }
    }

    // Descarga (con caché) el HTML de la serie con las comillas ya desescapadas.
    // Los datos de la serie vienen serializados (Astro) dentro de atributos props="{...}"
    // HTML-escapados; al reemplazar &quot; por " quedan extraíbles con regex.
    private async getSeriesHTML(mangaId: string): Promise<string> {
        const now = Date.now();
        const cached = this.seriesCache.get(mangaId);
        if (cached && cached.expiry > now) return cached.data;

        const request = createRequestObject({
            url: `${WEB_URL}/series/${mangaId}`,
            method: "GET"
        });
        const response = await this.requestManager.schedule(request, 1);
        this.CloudFlareError(response.status);

        const data = (response.data || "").replace(/&quot;/g, '"');

        if (this.seriesCache.size >= SERIES_CACHE_MAX) this.seriesCache.clear();
        this.seriesCache.set(mangaId, { data, expiry: now + SERIES_CACHE_TTL });
        return data;
    }

    // Decodifica entidades HTML comunes (sinopsis/títulos vienen escapados)
    decodeEntities(text: string): string {
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

    // Mapea el estado textual de la web al enum numérico de Paperback
    mapStatus(statusText: string): number {
        const s = (statusText || "").toUpperCase();
        if (s.includes("COMPLETED") || s.includes("ENDED") || s.includes("FINISHED")) return 1; // COMPLETED
        if (s.includes("HIATUS") || s.includes("PAUSED")) return 2; // HIATUS
        if (s.includes("CANCEL") || s.includes("DROPPED")) return 3; // ABANDONED
        return 0; // ONGOING
    }

    // Extrae un campo string del bloque serializado: "key":[0,"valor"]
    private extractString(data: string, key: string): string | undefined {
        const m = data.match(new RegExp(`"${key}":\\[0,"((?:\\\\.|[^"\\\\])*)"\\]`));
        return m ? m[1] : undefined;
    }

    // Convierte un "post" del API /api/query en un MangaTile
    tileFromPost(post: any): MangaTile | undefined {
        const id = post?.slug;
        const title = post?.postTitle;
        const image = post?.featuredImage || FALLBACK_COVER;
        if (!id || !title) return undefined;
        return createMangaTile({
            id: id,
            title: createIconText({ text: title }),
            image: image
        });
    }

    // 1. Detalles del manga (parsea los props serializados embebidos en el HTML de la serie)
    async getMangaDetails(mangaId: string): Promise<Manga> {
        const data = await this.getSeriesHTML(mangaId);

        const title = this.decodeEntities(this.extractString(data, "postTitle") || mangaId);

        // Sinopsis: postContent va seguido siempre de "isNovel"
        let desc = "Sin descripción disponible.";
        const descMatch = data.match(/"postContent":\[0,"([\s\S]*?)"\],"isNovel"/);
        if (descMatch && descMatch[1]) desc = this.decodeEntities(descMatch[1]).trim();

        // Portada: primer featuredImage del storage tras "postContent"
        let image = FALLBACK_COVER;
        const postIdx = data.indexOf('"postContent"');
        if (postIdx !== -1) {
            const coverMatch = data.slice(postIdx).match(
                new RegExp(`"featuredImage":\\[0,"(https://${STORAGE_HOST.replace(/\./g, "\\.")}/[^"]+)"\\]`)
            );
            if (coverMatch) image = coverMatch[1];
        }
        if (image === FALLBACK_COVER) {
            const og = data.match(/og:image"\s+content="([^"]+)"/);
            if (og) image = og[1];
        }

        const status = this.mapStatus(this.extractString(data, "seriesStatus") || "");

        // Autor (no está en los props; se lee del DOM renderizado)
        let author = "Desconocido";
        const authorMatch = data.match(/Author<\/h1>\s*<div[^>]*>\s*<p[^>]*>([^<]+)<\/p>/);
        if (authorMatch && authorMatch[1].trim()) author = this.decodeEntities(authorMatch[1].trim());

        // Rating medio (escala 0-10 → 0-5 estrellas)
        let rating = 0;
        const ratingMatch = data.match(/"averageRating":\[0,([\d.]+)\]/);
        if (ratingMatch) rating = (parseFloat(ratingMatch[1]) || 0) / 2;

        // Géneros: bloque "genres":[1,[ ... ]] tras "postContent"
        const tags: Tag[] = [];
        const genresIdx = data.indexOf('"genres":[1,[', postIdx === -1 ? 0 : postIdx);
        if (genresIdx !== -1) {
            const genresBlock = data.slice(genresIdx, genresIdx + 3000);
            const nameRe = /"name":\[0,"([^"]+)"\]/g;
            let gm: RegExpExecArray | null;
            while ((gm = nameRe.exec(genresBlock)) !== null) {
                const label = this.decodeEntities(gm[1]).trim();
                if (label) tags.push(createTag({ id: label, label, type: 'blue' }));
                if (tags.length >= 25) break;
            }
        }
        // Tipo (MANHWA/MANGA/MANHUA) como tag adicional
        const seriesType = this.extractString(data, "seriesType");
        if (seriesType) tags.push(createTag({ id: seriesType, label: seriesType, type: 'green' }));

        return createManga({
            id: mangaId,
            titles: [title],
            image: image,
            rating: rating,
            status: status,
            author: author,
            desc: desc,
            hentai: false,
            tags: [createTagSection({ id: '0', label: 'Géneros', tags })]
        });
    }

    // 2. Capítulos (parsea los objetos serializados embebidos en el HTML de la serie)
    async getChapters(mangaId: string): Promise<Chapter[]> {
        const data = await this.getSeriesHTML(mangaId);

        const chapters: Chapter[] = [];
        const seen = new Set<string>();

        // Cada capítulo: {"id":[0,N],"number":[0,N],"slug":[0,"chapter-N"],"title":[0,"..."|null],"createdAt":[0,"ISO"]...}
        // El slug puede contener punto (capítulos decimales: chapter-510.1).
        const chapRe = /"id":\[0,(\d+)\],"number":\[0,([\d.]+)\],"slug":\[0,"(chapter-[A-Za-z0-9_.-]+)"\],"title":\[0,(?:"((?:\\.|[^"\\])*)"|null)\],"createdAt":\[0,"([^"]+)"\]/g;
        let m: RegExpExecArray | null;
        while ((m = chapRe.exec(data)) !== null) {
            const chapNum = parseFloat(m[2]) || 0;
            const slug = m[3];
            const rawTitle = this.decodeEntities(m[4] || "").trim();
            const createdAt = m[5];

            if (seen.has(slug)) continue;
            seen.add(slug);

            const name = rawTitle ? `Chapter ${m[2]} - ${rawTitle}` : `Chapter ${m[2]}`;

            chapters.push(createChapter({
                id: slug,
                mangaId: mangaId,
                name: name,
                chapNum: chapNum,
                time: createdAt ? new Date(createdAt) : new Date(),
                langCode: "en"
            }));
        }

        // Más reciente primero
        chapters.sort((a, b) => b.chapNum - a.chapNum);
        return chapters;
    }

    // 3. Páginas del capítulo (imágenes en el HTML del lector)
    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const request = createRequestObject({
            url: `${WEB_URL}/series/${mangaId}/${chapterId}`,
            method: "GET"
        });

        const response = await this.requestManager.schedule(request, 1);
        this.CloudFlareError(response.status);
        const $ = cheerio.load(response.data);

        const pages: string[] = [];
        $('img[data-reader-page-image]').each((i, el) => {
            const src = ($(el).attr('src') || $(el).attr('data-src') || '').trim();
            if (src) pages.push(src);
        });

        return createChapterDetails({
            id: chapterId,
            mangaId: mangaId,
            pages: pages
        });
    }

    // 4. Búsqueda (API JSON)
    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        const term = encodeURIComponent(query.title ?? "");
        const request = createRequestObject({
            url: `${API_URL}/api/query?searchTerm=${term}&perPage=30`,
            method: "GET"
        });

        const response = await this.requestManager.schedule(request, 1);
        this.CloudFlareError(response.status);

        let json: any;
        try {
            json = JSON.parse(response.data);
        } catch (e) {
            throw new Error(`Error parsing JSON for search: ${e}`);
        }

        const tiles: MangaTile[] = [];
        for (const post of (json?.posts ?? [])) {
            const tile = this.tileFromPost(post);
            if (tile) tiles.push(tile);
        }

        return createPagedResults({
            results: tiles
        });
    }

    // Extrae los tiles de una sección de posts embebida en el HTML del home.
    // Cada post serializado empieza por: {"id":[0,N],"slug":[0,"..."],"postTitle":[0,"..."],"featuredImage":[0,"..."]
    parseHomeSection(data: string, key: string, allKeys: string[]): MangaTile[] {
        const start = data.indexOf(`"${key}":[1,[`);
        if (start === -1) return [];

        // El final de la sección es el inicio de la siguiente clave conocida (o el fin del documento)
        let end = data.length;
        for (const other of allKeys) {
            if (other === key) continue;
            const oi = data.indexOf(`"${other}":[1,[`);
            if (oi > start && oi < end) end = oi;
        }

        const seg = data.slice(start, end);
        const tiles: MangaTile[] = [];
        const seen = new Set<string>();
        const postRe = /"id":\[0,\d+\],"slug":\[0,"([^"]+)"\],"postTitle":\[0,"((?:\\.|[^"\\])*)"\],"featuredImage":\[0,"([^"]*)"\]/g;
        let m: RegExpExecArray | null;
        while ((m = postRe.exec(seg)) !== null) {
            const slug = this.decodeEntities(m[1]);
            const title = this.decodeEntities(m[2]);
            const image = this.decodeEntities(m[3]) || FALLBACK_COVER;
            if (!slug || seen.has(slug)) continue;
            seen.add(slug);
            tiles.push(createMangaTile({
                id: slug,
                title: createIconText({ text: title }),
                image: image
            }));
        }
        return tiles;
    }

    // 5. Secciones de la página principal (parseadas del HTML del home, datos reales)
    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const request = createRequestObject({
            url: `${WEB_URL}/`,
            method: "GET"
        });
        const response = await this.requestManager.schedule(request, 1);
        this.CloudFlareError(response.status);
        const data = (response.data || "").replace(/&quot;/g, '"');

        // Claves de las secciones embebidas en el home (orden del documento)
        const sectionKeys = ["sliderPosts", "initalPosts", "novels"];

        // Destacados (carrusel)
        const featuredSection = createHomeSection({
            id: 'featured',
            title: 'Featured',
            type: HomeSectionType.singleRowLarge,
            view_more: false
        });
        sectionCallback(featuredSection);
        featuredSection.items = this.parseHomeSection(data, "sliderPosts", sectionKeys);
        sectionCallback(featuredSection);

        // Últimos lanzamientos
        const latestSection = createHomeSection({
            id: 'latest',
            title: 'Latest Releases',
            type: HomeSectionType.singleRowNormal,
            view_more: false
        });
        sectionCallback(latestSection);
        latestSection.items = this.parseHomeSection(data, "initalPosts", sectionKeys);
        sectionCallback(latestSection);
    }
}
