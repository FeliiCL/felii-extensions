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

const BASE_URL = "https://zonatmo.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const info: SourceInfo = {
    version: '1.4.0',
    name: 'ZonaTMO',
    icon: 'icon.png',
    author: 'Felii',
    description: 'Extension for ZonaTMO',
    contentRating: ContentRating.MATURE,
    websiteBaseURL: BASE_URL,
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS
};

export class ZonaTMO extends Source {
    
    requestManager = createRequestManager({
        requestsPerSecond: 3,
        requestTimeout: 20000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    "Referer": `${BASE_URL}/`,
                    "Origin": BASE_URL,
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

    getCloudflareBypassRequest() {
        return createRequestObject({
            url: BASE_URL,
            method: 'GET',
            headers: {
                "referer": `${BASE_URL}/`,
                "user-agent": USER_AGENT
            }
        });
    }

    CloudFlareError(status: number, $?: cheerio.Root) {
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

    parseHomeSection($: cheerio.Root, baseUrl: string): MangaTile[] {
        const manga: MangaTile[] = [];
        $('div.row > div.element').each((i, elem) => {
            const a = $('a', elem).first();
            const title = $('h4.text-truncate', a).attr('title')?.trim() || '';
            const href = a.attr('href')?.trim() || '';
            const mangaId = href.replace(`${baseUrl}/library/`, '');
            const styleText = $('style', elem).text();
            const imageMatch = styleText.match(/url\('(.*)'\)/);
            const image = imageMatch ? imageMatch[1] : '';

            if (mangaId && title && image) {
                manga.push(createMangaTile({
                    id: mangaId,
                    title: createIconText({ text: title }),
                    image: image
                }));
            }
        });
        return manga;
    }

    NextPage($: cheerio.Root): boolean {
        return $('ul.pagination > li > a[rel="next"]').length > 0;
    }

    async getMangaDetails(mangaId: string): Promise<Manga> {
        const url = `${BASE_URL}/library/${mangaId}`;
        const request = createRequestObject({ url, method: "GET" });
        const response = await this.requestManager.schedule(request, 1);
        const $ = cheerio.load(response.data);
        this.CloudFlareError(response.status, $);

        const titleEl = $('h1.element-title').first();
        // Limpieza robusta del título
        const title = titleEl.contents().filter((i, el) => el.type === 'text').text().trim() || titleEl.text().trim();
        
        const image = $('img.book-thumbnail').attr('src') || "";
        const desc = $('p.element-description').text().trim() || "Sin descripción";

        let status = 0; // ONGOING
        const statusText = $('span.book-status').text().toLowerCase().trim();
        if (statusText.includes("finalizado")) status = 1;
        else if (statusText.includes("pausado")) status = 2;

        const tags: Tag[] = [];
        $('h6 a.badge.badge-primary').each((i, el) => {
            const label = $(el).text().trim();
            if (label) tags.push(createTag({ id: label, label, type: 'blue' }));
        });
        
        const typeLabel = $('h1.element-title small.badge').text().trim();
        if(typeLabel) tags.push(createTag({ id: typeLabel, label: typeLabel, type: 'default' }));

        const tagSections = [createTagSection({ id: '0', label: 'Géneros', tags })];

        return createManga({
            id: mangaId,
            titles: [title],
            image: image,
            rating: 0,
            status: status,
            author: "Desconocido",
            desc: desc,
            hentai: false,
            tags: tagSections
        });
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const url = `${BASE_URL}/library/${mangaId}`;
        const request = createRequestObject({ url, method: "GET" });
        const response = await this.requestManager.schedule(request, 1);
        const $ = cheerio.load(response.data);
        this.CloudFlareError(response.status, $);

        const chapters: Chapter[] = [];
        // Selector robusto: busca el contenedor de capítulos por ID
        const chapterContainer = $('div#chapters');
        
        // Iterar sobre cada bloque de capítulo colapsable
        chapterContainer.find('li.upload-link').each((i, element) => {
            const row = $(element);
            
            // Nombre del capítulo (ej: Capítulo 1.00) - Buscamos el texto dentro del botón de colapso
            const titleElement = row.find('.btn-collapse');
            let chapterNameFull = titleElement.text().trim();
            
            // Regex flexible para números (soporta "Capítulo 1", "Cap. 1", "1")
            const chapNumMatch = chapterNameFull.match(/(?:Cap[íi]tulo|Cap\.?)\s*([\d\.]+)/i);
            const chapNum = chapNumMatch ? parseFloat(chapNumMatch[1]) : 0;

            // Iterar sobre las subidas (scans) dentro de este capítulo
            const uploads = row.find('ul.chapter-list > li.list-group-item');

            uploads.each((j, upload) => {
                const up = $(upload);
                
                // 1. Grupo (Scan)
                // Usamos .text-truncate para encontrar la columna del nombre sin importar si es col-4 o col-12
                const groupContainer = up.find('div.text-truncate');
                const groupName = groupContainer.find('a').first().text().trim() || "Desconocido";
                
                // 2. Fecha
                const dateText = up.find('span.badge').text().trim();
                const dateMatch = dateText.match(/(\d{4}-\d{2}-\d{2})/);
                const time = dateMatch ? new Date(dateMatch[1]) : new Date();
                
                // 3. Enlace
                // Buscamos el botón "Play" o cualquier botón btn-default al final
                const linkBtn = up.find('a.btn-default').first();
                const href = linkBtn.attr('href') || '';
                const uploadId = href.split('/').pop() || '';

                if (uploadId) {
                    chapters.push(createChapter({
                        id: uploadId,
                        mangaId: mangaId,
                        // Aquí ponemos el emoji 🇪🇸 en el nombre del capítulo
                        name: `${chapterNameFull} [🇪🇸 ${groupName}]`,
                        chapNum: chapNum,
                        time: time,
                        langCode: "es", // Código interno (no visible en el título)
                        group: groupName
                    }));
                }
            });
        });

        return chapters;
    }

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const uploadUrl = `${BASE_URL}/view_uploads/${chapterId}`;
        const request = createRequestObject({ url: uploadUrl, method: "GET" });
        const response = await this.requestManager.schedule(request, 1);
        const $ = cheerio.load(response.data);
        this.CloudFlareError(response.status, $);

        let viewerUrl = '';
        
        // --- ESTRATEGIA 1: Redirección por JavaScript (window.location) ---
        // Buscamos en todo el HTML por si está en un script inline
        const htmlContent = response.data;
        // Regex mejorada basada en source.js de OnlyFadi
        const locationMatch = htmlContent.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
        if (locationMatch && locationMatch[1]) {
            viewerUrl = locationMatch[1];
        }
        
        // --- ESTRATEGIA 2: Redirección por Meta Tag ---
        if (!viewerUrl) {
            const metaRefresh = $('meta[http-equiv="refresh"]').attr('content');
            // content="0; url=https://..."
            if (metaRefresh) {
                const urlMatch = metaRefresh.match(/url=(.+)/i);
                if (urlMatch && urlMatch[1]) {
                    viewerUrl = urlMatch[1];
                }
            }
        }

        // --- ESTRATEGIA 3: Botón directo o copyToClipboard ---
        if (!viewerUrl) {
            // Intentar leer el onclick del botón social (método antiguo)
            const onclick = $('.flex-row button.btn-social').attr('onclick') || '';
            const match = onclick.match(/copyToClipboard\(['"`](.*)['"`]\)/i);
            if (match && match[1]) {
                viewerUrl = match[1];
            } else {
                // Intentar leer el href directo
                viewerUrl = $('.flex-row a.btn-social').attr('href') || '';
            }
        }

        if (!viewerUrl) {
            // Último recurso: comprobar si la página actual YA tiene las imágenes (a veces pasa)
            if ($('div.img-container img.viewer-img').length > 0) {
                 viewerUrl = uploadUrl; // La URL actual es la correcta
            } else {
                 throw new Error(`Failed to parse viewer URL for chapter ${chapterId}`);
            }
        }

        // Conversión a modo Cascada (Cascade) siempre
        if (viewerUrl.includes("paginated")) {
            viewerUrl = viewerUrl.replace("paginated", "cascade");
        }
        
        // Asegurar URL absoluta
        if (viewerUrl.startsWith('/')) {
            viewerUrl = `${BASE_URL}${viewerUrl}`;
        }

        // Si ya estamos en la página de imágenes, no hacemos request extra
        let viewer$: cheerio.Root;
        if (viewerUrl === uploadUrl) {
            viewer$ = $;
        } else {
            const viewerRequest = createRequestObject({ url: viewerUrl, method: "GET" });
            const viewerResponse = await this.requestManager.schedule(viewerRequest, 1);
            viewer$ = cheerio.load(viewerResponse.data);
            this.CloudFlareError(viewerResponse.status, viewer$);
        }
        
        const pages: string[] = [];
        viewer$('div.img-container > img.viewer-img').each((i, element) => {
            const el = viewer$(element);
            // Prioridad a data-src (lazy loading) luego src
            let imgUrl = el.attr('data-src') || el.attr('src') || '';
            if (imgUrl) {
                pages.push(imgUrl.trim());
            }
        });

        return createChapterDetails({
            id: chapterId,
            mangaId: mangaId,
            pages: pages,
        });
    }

    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        const page = metadata?.page ?? 1;
        const term = encodeURIComponent(query.title ?? "");
        const url = `${BASE_URL}/library?order_item=alfabetico&order_dir=asc&title=${term}&_pg=${page}&filter_by=title`;
        const request = createRequestObject({ url, method: "GET" });
        const response = await this.requestManager.schedule(request, 1);
        const $ = cheerio.load(response.data);
        this.CloudFlareError(response.status, $);

        const tiles = this.parseHomeSection($, BASE_URL);
        const nextPage = this.NextPage($) ? { page: page + 1 } : undefined;

        return createPagedResults({ results: tiles, metadata: nextPage });
    }

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        // Popular
        const popularUrl = `${BASE_URL}/library?order_item=likes_count&order_dir=desc&_pg=1&filter_by=title`;
        const popularRequest = createRequestObject({ url: popularUrl, method: "GET" });
        const popularResponse = await this.requestManager.schedule(popularRequest, 1);
        const popular$ = cheerio.load(popularResponse.data);
        this.CloudFlareError(popularResponse.status, popular$);

        const popularSection = createHomeSection({
            id: 'popular',
            title: 'Lo más popular',
            type: HomeSectionType.singleRowLarge,
            view_more: true
        });
        sectionCallback(popularSection);
        popularSection.items = this.parseHomeSection(popular$, BASE_URL).slice(0, 10);
        sectionCallback(popularSection);

        // Latest
        const latestUrl = `${BASE_URL}/library?order_item=creation&order_dir=desc&_pg=1&filter_by=title`;
        const latestRequest = createRequestObject({ url: latestUrl, method: "GET" });
        const latestResponse = await this.requestManager.schedule(latestRequest, 1);
        const latest$ = cheerio.load(latestResponse.data);
        this.CloudFlareError(latestResponse.status, latest$);

        const latestSection = createHomeSection({
            id: 'latest_added',
            title: 'Últimos añadidos',
            type: HomeSectionType.singleRowNormal,
            view_more: true
        });
        sectionCallback(latestSection);
        latestSection.items = this.parseHomeSection(latest$, BASE_URL).slice(0, 10);
        sectionCallback(latestSection);
    }

    async getViewMoreItems(homepageSectionId: string, metadata: any): Promise<PagedResults> {
        const page = metadata?.page ?? 1;
        let url = '';
        if (homepageSectionId === 'popular') url = `${BASE_URL}/library?order_item=likes_count&order_dir=desc&_pg=${page}&filter_by=title`;
        else if (homepageSectionId === 'latest_added') url = `${BASE_URL}/library?order_item=creation&order_dir=desc&_pg=${page}&filter_by=title`;
        else return createPagedResults({ results: [] });

        const request = createRequestObject({ url, method: "GET" });
        const response = await this.requestManager.schedule(request, 1);
        const $ = cheerio.load(response.data);
        this.CloudFlareError(response.status, $);

        const tiles = this.parseHomeSection($, BASE_URL);
        const nextPage = this.NextPage($) ? { page: page + 1 } : undefined;
        return createPagedResults({ results: tiles, metadata: nextPage });
    }
}