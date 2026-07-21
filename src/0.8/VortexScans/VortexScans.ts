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
    TagSection,
    Tag
} from '@paperback/types';

import * as cheerio from 'cheerio';

// URLs Base
const WEB_URL = "https://vortexscans.org";
const API_URL = "https://api.vortexscans.org";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const VortexScansInfo: SourceInfo = {
    version: '1.0.0',
    name: 'VortexScans',
    icon: 'icon.png',
    author: 'Felii',
    authorWebsite: 'https://github.com/FeliiCL',
    description: 'Extension for VortexScans (vortexscans.org)',
    contentRating: ContentRating.MATURE,
    websiteBaseURL: WEB_URL,
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS
};

export class VortexScans extends Source {

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

    CloudFlareError(status: number) {
        if (status === 503 || status === 403) {
            throw new Error(`CLOUDFLARE BYPASS ERROR: Please go to the homepage of the source and press Cloudflare Bypass. Status code: ${status}`);
        }
    }

    // Mapea el estado textual de la web al enum numérico de Paperback
    mapStatus(statusText: string): number {
        const s = (statusText || "").toUpperCase();
        if (s.includes("COMPLETED") || s.includes("ENDED") || s.includes("FINISHED")) return 1; // COMPLETED
        if (s.includes("HIATUS") || s.includes("PAUSED")) return 2; // HIATUS
        if (s.includes("CANCEL") || s.includes("DROPPED")) return 3; // ABANDONED
        return 0; // ONGOING
    }

    // Decodifica entidades HTML comunes (los props vienen escapados en el HTML)
    decodeEntities(text: string): string {
        return (text || "")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#x27;/g, "'")
            .replace(/&apos;/g, "'")
            .replace(/&#x2F;/g, "/")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&");
    }

    // Convierte un "post" del API /api/query en un MangaTile
    tileFromPost(post: any): MangaTile | undefined {
        const id = post?.slug;
        const title = post?.postTitle;
        const image = post?.featuredImage || "https://placehold.co/400x600?text=No+Cover";
        if (!id || !title) return undefined;
        return createMangaTile({
            id: id,
            title: createIconText({ text: title }),
            image: image
        });
    }

    // 1. Detalles del manga (parsea el HTML de la página de la serie)
    async getMangaDetails(mangaId: string): Promise<Manga> {
        const request = createRequestObject({
            url: `${WEB_URL}/series/${mangaId}`,
            method: "GET"
        });

        const response = await this.requestManager.schedule(request, 1);
        this.CloudFlareError(response.status);
        const $ = cheerio.load(response.data);

        // Título y sinopsis desde meta tags Open Graph (robusto y único)
        const title = $('meta[property="og:title"]').attr('content')?.trim() || mangaId;
        const desc = $('meta[property="og:description"]').attr('content')?.trim() || "Sin descripción disponible.";

        // Los datos estructurados están serializados (Astro) dentro del HTML.
        // Desescapamos las comillas para poder extraerlos con regex.
        const data = response.data.replace(/&quot;/g, '"');

        // Portada real (primer featuredImage del storage con patrón de carpeta por fecha)
        let image = "";
        const coverMatch = data.match(/"featuredImage":\[0,"(https:\/\/storage\.vortexscans\.org\/upload\/\d{4}\/[^"]+?\.(?:webp|png|jpg|jpeg))"\]/);
        if (coverMatch) image = coverMatch[1];
        if (!image) image = $('meta[property="og:image"]').attr('content') || "https://placehold.co/400x600?text=No+Cover";

        // Estado
        const statusMatch = data.match(/"seriesStatus":\[0,"([^"]+)"\]/);
        const status = this.mapStatus(statusMatch ? statusMatch[1] : "");

        // Autor / Artista
        const artistMatch = data.match(/"artist":\[0,"([^"]+)"\]/);
        const author = artistMatch ? artistMatch[1] : "Desconocido";

        // Tags / Géneros (primer bloque de géneros = serie principal)
        const tags: Tag[] = [];
        const genresIdx = data.indexOf('"genres":[1,[');
        if (genresIdx !== -1) {
            const genresBlock = data.slice(genresIdx, genresIdx + 2000);
            const nameRe = /"name":\[0,"([^"]+)"\]/g;
            let m: RegExpExecArray | null;
            while ((m = nameRe.exec(genresBlock)) !== null) {
                const label = m[1].trim();
                if (label) tags.push(createTag({ id: label, label, type: 'blue' }));
                if (tags.length >= 20) break;
            }
        }
        // Tipo (MANHWA/MANGA/MANHUA) como tag adicional
        const typeMatch = data.match(/"seriesType":\[0,"([^"]+)"\]/);
        if (typeMatch && typeMatch[1]) tags.push(createTag({ id: typeMatch[1], label: typeMatch[1], type: 'green' }));

        const tagSections = [createTagSection({ id: '0', label: 'Géneros', tags })];

        return createManga({
            id: mangaId,
            titles: [title],
            image: image,
            rating: 0,
            status: status,
            author: author,
            desc: desc,
            hentai: false,
            tags: tagSections
        });
    }

    // 2. Capítulos (parsea los objetos serializados embebidos en el HTML)
    async getChapters(mangaId: string): Promise<Chapter[]> {
        const request = createRequestObject({
            url: `${WEB_URL}/series/${mangaId}`,
            method: "GET"
        });

        const response = await this.requestManager.schedule(request, 1);
        this.CloudFlareError(response.status);

        const data = response.data.replace(/&quot;/g, '"');

        const chapters: Chapter[] = [];
        const seen = new Set<string>();

        // Cada capítulo viene como: {"id":[0,N],"number":[0,N],"slug":[0,"chapter-N"],"title":[0,"..."],"createdAt":[0,"ISO"]...}
        const chapRe = /"id":\[0,(\d+)\],"number":\[0,([\d.]+)\],"slug":\[0,"(chapter-[A-Za-z0-9_-]+)"\],"title":\[0,(?:"((?:\\.|[^"\\])*)"|null)\],"createdAt":\[0,"([^"]+)"\]/g;
        let m: RegExpExecArray | null;
        while ((m = chapRe.exec(data)) !== null) {
            const chapNum = parseFloat(m[2]) || 0;
            const slug = m[3];
            const rawTitle = (m[4] || "").replace(/\\"/g, '"').trim();
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
            url: `${API_URL}/api/query?searchTerm=${term}&perPage=50`,
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
        const postRe = /"id":\[0,\d+\],"slug":\[0,"([^"]+)"\],"postTitle":\[0,"([^"]+)"\],"featuredImage":\[0,"([^"]*)"\]/g;
        let m: RegExpExecArray | null;
        while ((m = postRe.exec(seg)) !== null) {
            const slug = this.decodeEntities(m[1]);
            const title = this.decodeEntities(m[2]);
            const image = this.decodeEntities(m[3]) || "https://placehold.co/400x600?text=No+Cover";
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
        const data = response.data.replace(/&quot;/g, '"');

        // Claves de las secciones embebidas en el home
        const sectionKeys = ["sliderPosts", "posts", "initalPosts"];

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

        // Popular Today
        const popularSection = createHomeSection({
            id: 'popular',
            title: 'Popular Today',
            type: HomeSectionType.singleRowNormal,
            view_more: false
        });
        sectionCallback(popularSection);
        popularSection.items = this.parseHomeSection(data, "posts", sectionKeys);
        sectionCallback(popularSection);

        // Últimas (grid principal)
        const latestSection = createHomeSection({
            id: 'latest',
            title: 'Latest',
            type: HomeSectionType.singleRowNormal,
            view_more: false
        });
        sectionCallback(latestSection);
        latestSection.items = this.parseHomeSection(data, "initalPosts", sectionKeys);
        sectionCallback(latestSection);
    }
}
