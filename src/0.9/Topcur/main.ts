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
} from "@paperback/types";
import * as cheerio from "cheerio";

const WEB_URL = "https://animerikosuper.blogspot.com";
const FALLBACK_COVER = "https://placehold.co/400x600.png?text=Sin+Portada";

// El feed de páginas omite ~10 entradas (SSS-Class entre ellas): sólo son
// alcanzables por URL directa. El catálogo real son estas dos páginas índice
// del menú, que además traen portada de cada novela.
const CATALOG_PAGES = [
    { slug: "lista-de-novelas-ligeras", group: "coreanas" },
    { slug: "novelas-japonesas", group: "japonesas" },
];
const CATALOG_SLUGS = CATALOG_PAGES.map((p) => p.slug);

const CATALOG_TTL = 900_000; // 15 min
const PAGE_TTL = 300_000; // 5 min — el índice de SSS-Class pesa ~150 KB
const PAGE_CACHE_MAX = 8;
const DISCOVER_PER_PAGE = 24;

// Palabras que se mantienen en minúscula al normalizar títulos EN MAYÚSCULAS
const LOWERCASE_WORDS = new Set([
    "a", "al", "ante", "con", "contra", "de", "del", "e", "el", "en", "entre",
    "hasta", "la", "las", "lo", "los", "mi", "o", "para", "por", "que", "se",
    "si", "sin", "sobre", "su", "sus", "tras", "un", "una", "y",
]);

interface CatalogEntry {
    mangaId: string;
    title: string;
    cover: string;
    group: string;
}

interface BlogEntry {
    title: string;
    content: string;
    thumbnail?: string;
    published?: string;
}

interface TopcurMetadata {
    page?: number;
}

class TopcurInterceptor extends PaperbackInterceptor {
    override async interceptRequest(request: Request): Promise<Request> {
        request.headers = {
            ...request.headers,
            referer: `${WEB_URL}/`,
            "user-agent": await Application.getDefaultUserAgent(),
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

type TopcurImplementation = Extension &
    SearchResultsProviding &
    MangaProviding &
    ChapterProviding &
    DiscoverSectionProviding;

export class TopcurExtension implements TopcurImplementation {
    requestManager = new TopcurInterceptor("main");
    globalRateLimiter = new BasicRateLimiter("rateLimiter", {
        numberOfRequests: 3,
        bufferInterval: 1,
        ignoreImages: true,
    });

    private catalogCache: { data: CatalogEntry[]; expiry: number } | undefined;
    private pageCache = new Map<string, { entry: BlogEntry; expiry: number }>();

    // Las cuatro secciones de discover arrancan a la vez y ninguna encuentra
    // caché todavía, así que sin esto cada una descarga el catálogo entero.
    private catalogRequest: Promise<CatalogEntry[]> | undefined;
    private pageRequests = new Map<string, Promise<BlogEntry>>();

    async initialise(): Promise<void> {
        this.requestManager.registerInterceptor();
        this.globalRateLimiter.registerInterceptor();
    }

    // ---- fetch helpers ----

    // Blogger expone cada página/entrada como JSON consultable por ruta, lo que
    // evita parsear la plantilla completa del blog.
    private async fetchEntry(
        kind: "pages" | "posts",
        path: string,
    ): Promise<BlogEntry | undefined> {
        const url = `${WEB_URL}/feeds/${kind}/default?alt=json&max-results=1&path=${path}`;
        const [response, data] = await Application.scheduleRequest({ url, method: "GET" });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`La petición falló (${response.status}): ${path}`);
        }

        const json = JSON.parse(Application.arrayBufferToUTF8String(data));
        const entry = json?.feed?.entry?.[0];
        if (!entry) return undefined;

        return {
            title: (entry.title?.$t ?? "").trim(),
            content: entry.content?.$t ?? "",
            thumbnail: entry["media$thumbnail"]?.url,
            published: entry.published?.$t,
        };
    }

    private async getNovelPage(mangaId: string): Promise<BlogEntry> {
        const cached = this.pageCache.get(mangaId);
        if (cached && cached.expiry > Date.now()) return cached.entry;

        // El índice de una novela puede pesar 200 KB; conviene no descargarlo
        // dos veces si detalles y capítulos se piden a la vez.
        const inFlight = this.pageRequests.get(mangaId);
        if (inFlight) return inFlight;

        const request = this.fetchNovelPage(mangaId).finally(() => {
            this.pageRequests.delete(mangaId);
        });
        this.pageRequests.set(mangaId, request);
        return request;
    }

    private async fetchNovelPage(mangaId: string): Promise<BlogEntry> {
        const entry = await this.fetchEntry("pages", `/p/${mangaId}.html`);
        if (!entry) throw new Error(`No se encontró la novela: ${mangaId}`);

        if (this.pageCache.size >= PAGE_CACHE_MAX) {
            const oldest = this.pageCache.keys().next().value;
            if (oldest !== undefined) this.pageCache.delete(oldest);
        }
        this.pageCache.set(mangaId, { entry, expiry: Date.now() + PAGE_TTL });
        return entry;
    }

    // ---- utils ----

    private normalize(text: string): string {
        return (text || "")
            .toLowerCase()
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "");
    }

    // Blogger sirve las imágenes con el tamaño incrustado en la ruta (/s72-c/,
    // /w320-h480/) o como sufijo (=s220); las miniaturas del feed llegan a 72 px.
    private resizeImage(url: string | undefined, size = 400): string {
        if (!url) return FALLBACK_COVER;
        return url
            .replace(/\/s\d+(?:-c)?\//, `/s${size}/`)
            .replace(/\/w\d+-h\d+(?:-[a-z-]+)?\//, `/s${size}/`)
            .replace(/=s\d+(?:-c)?$/, `=s${size}`);
    }

    private capitalizeWord(word: string): string {
        return word
            .split("-")
            .map((part) => {
                if (!part) return part;
                // Los acrónimos (SSS, TV…) se respetan: en mayúsculas y sin vocales.
                const isAcronym =
                    part.length <= 4 &&
                    part === part.toUpperCase() &&
                    /\p{L}/u.test(part) &&
                    !/[AEIOUÁÉÍÓÚÜ]/i.test(part);
                if (isAcronym) return part;

                return part
                    .toLowerCase()
                    .replace(/^(\P{L}*)(\p{L})/u, (_, prefix, letter) => prefix + letter.toUpperCase());
            })
            .join("-");
    }

    private toTitleCase(text: string): string {
        return text
            .split(" ")
            .map((word, index) => {
                const lower = word.toLowerCase();
                if (index > 0 && LOWERCASE_WORDS.has(lower)) return lower;
                return this.capitalizeWord(word);
            })
            .join(" ");
    }

    // Los títulos del blog arrastran "NOVELA ESPAÑOL"/"NOVELA TOPCUR" y el año.
    private stripSuffix(raw: string): string {
        let title = (raw || "").replace(/\s+/g, " ").trim();
        title = title.replace(/\bnovela\s+(?:ligera|espa(?:ñ|n)ol(?:a)?|topcur)\b/gi, " ");
        title = title.replace(/\bnovela\b\s*$/i, " ");
        title = title.replace(/\b20\d{2}\b\s*$/, " ");
        title = title.replace(/\s*[-–—|]\s*$/, " ");
        return title.replace(/\s{2,}/g, " ").trim();
    }

    private cleanTitle(raw: string): string {
        let title = this.stripSuffix(raw);
        if (!title) return raw.trim();
        // Casi todo el catálogo está EN MAYÚSCULAS; se normaliza para la biblioteca.
        if (title === title.toUpperCase()) title = this.toTitleCase(title);
        return title;
    }

    private pageIdFromUrl(href: string): string | undefined {
        const match = (href || "").match(/animerikosuper\.blogspot\.com\/p\/([^/?#]+?)\.html/);
        return match?.[1];
    }

    private postIdFromUrl(href: string): string | undefined {
        const match = (href || "").match(
            /animerikosuper\.blogspot\.com\/(\d{4}\/\d{2}\/[^/?#]+?)\.html/,
        );
        return match?.[1];
    }

    // ---- catálogo ----

    private parseCatalogPage(html: string, group: string): CatalogEntry[] {
        const $ = cheerio.load(html);
        const order: string[] = [];
        const titles = new Map<string, string>();
        const covers = new Map<string, string>();

        // El maquetado es [enlace con el título][portada], pero la portada unas
        // veces enlaza a la página y otras a la propia imagen. Se recorre el
        // documento en orden y se asigna a cada novela la primera imagen que la
        // sigue, lo que cubre ambos casos.
        const seen = new Set<string>();
        let current: string | undefined;

        $("a[href], img").each((_, element) => {
            const tag = (element as { tagName?: string }).tagName?.toLowerCase();

            if (tag === "a") {
                const mangaId = this.pageIdFromUrl($(element).attr("href") ?? "");
                // Los enlaces a imágenes u otros destinos no cambian la novela activa.
                if (!mangaId || CATALOG_SLUGS.includes(mangaId)) return;

                current = mangaId;
                if (!seen.has(mangaId)) {
                    seen.add(mangaId);
                    order.push(mangaId);
                }

                const text = $(element).text().replace(/\s+/g, " ").trim();
                if (text && !titles.has(mangaId)) titles.set(mangaId, text);
                return;
            }

            if (!current || covers.has(current)) return;
            const source = $(element).attr("src");
            if (source) covers.set(current, this.resizeImage(source));
        });

        return order.map((mangaId) => ({
            mangaId,
            title: this.cleanTitle(titles.get(mangaId) ?? mangaId.replace(/-/g, " ")),
            cover: covers.get(mangaId) ?? FALLBACK_COVER,
            group,
        }));
    }

    private async getCatalog(): Promise<CatalogEntry[]> {
        if (this.catalogCache && this.catalogCache.expiry > Date.now()) {
            return this.catalogCache.data;
        }

        const inFlight = this.catalogRequest;
        if (inFlight) return inFlight;

        const request = this.fetchCatalog().finally(() => {
            this.catalogRequest = undefined;
        });
        this.catalogRequest = request;
        return request;
    }

    private async fetchCatalog(): Promise<CatalogEntry[]> {
        const items: CatalogEntry[] = [];
        const seen = new Set<string>();
        for (const { slug, group } of CATALOG_PAGES) {
            const entry = await this.fetchEntry("pages", `/p/${slug}.html`);
            if (!entry) continue;
            for (const item of this.parseCatalogPage(entry.content, group)) {
                if (seen.has(item.mangaId)) continue;
                seen.add(item.mangaId);
                items.push(item);
            }
        }

        this.catalogCache = { data: items, expiry: Date.now() + CATALOG_TTL };
        return items;
    }

    // ---- detalles ----

    // La cabecera de la página (todo lo anterior al primer enlace de capítulo)
    // trae portada, títulos alternativos y sinopsis.
    private headerHtml(content: string): string {
        const firstChapter = content.search(/href=["'][^"']*animerikosuper\.blogspot\.com\/\d{4}\//);
        return firstChapter > 0 ? content.slice(0, firstChapter) : content.slice(0, 6000);
    }

    private headerText(html: string): string {
        const withBreaks = html
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/(p|div|h[1-6]|li)>/gi, "\n");
        return cheerio
            .load(withBreaks)
            .root()
            .text()
            .replace(/ /g, " ")
            .replace(/[ \t]+/g, " ")
            .replace(/\n{2,}/g, "\n")
            .trim();
    }

    private parseHeader(content: string): { synopsis: string; secondaryTitles: string[] } {
        const text = this.headerText(this.headerHtml(content));

        const altMatch = text.match(/t[ií]tulos?\s+alternativos?\s*:?/i);
        const synMatch = text.match(/sinopsis\s*:?/i);

        let secondaryTitles: string[] = [];
        if (altMatch?.index !== undefined) {
            const start = altMatch.index + altMatch[0].length;
            const end = synMatch?.index !== undefined && synMatch.index > start
                ? synMatch.index
                : text.length;
            secondaryTitles = text
                .slice(start, end)
                .split("\n")
                .map((line) => line.replace(/^[\s-–—*•]+/, "").trim())
                // Las cabeceras de sección ("VOLUMEN 4", "TODOS LOS VOLÚMENES")
                // cierran el bloque de títulos alternativos.
                .filter((line) => !/^(?:volumen|vol\.?|todos\s+los|cap[ií]tulos?|parte)\b/i.test(line))
                .map((line) => this.stripSuffix(line))
                .filter((line) => line.length > 2 && line.length < 120);
        }

        let synopsis = "";
        if (synMatch?.index !== undefined) {
            synopsis = text.slice(synMatch.index + synMatch[0].length).trim();
        } else if (altMatch?.index === undefined) {
            synopsis = text;
        }
        synopsis = synopsis.replace(/\n{2,}/g, "\n\n").trim();

        return { synopsis, secondaryTitles };
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const entry = await this.getNovelPage(mangaId);
        const { synopsis, secondaryTitles } = this.parseHeader(entry.content);

        // La portada es la primera imagen de la página; la miniatura del feed
        // sólo existe a 72 px recortados.
        const headerImage = cheerio.load(this.headerHtml(entry.content))("img").first().attr("src");
        const thumbnailUrl = this.resizeImage(headerImage ?? entry.thumbnail);

        return {
            mangaId,
            mangaInfo: {
                primaryTitle: this.cleanTitle(entry.title),
                secondaryTitles,
                thumbnailUrl,
                synopsis: synopsis || "Sin descripción disponible.",
                contentRating: ContentRating.MATURE,
                contentType: "novel",
                shareUrl: `${WEB_URL}/p/${mangaId}.html`,
            },
        };
    }

    // ---- capítulos ----

    // El número va en el texto del enlace ("... Capitulo 400"); la URL no sirve,
    // las entradas recientes acaban en sufijos de Blogger (…_58.html).
    private chapterNumber(text: string, chapterId: string, fallback: number): number {
        const fromText = text.match(/cap[ií]tulos?\s*[:#-]?\s*(\d+(?:[.,]\d+)?)/i);
        if (fromText) return parseFloat(fromText[1]!.replace(",", "."));

        const fromUrl = chapterId.match(/-(\d+(?:\.\d+)?)$/);
        if (fromUrl) return parseFloat(fromUrl[1]!);

        return fallback;
    }

    async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
        const entry = await this.getNovelPage(sourceManga.mangaId);

        const chapters: Chapter[] = [];
        const seen = new Set<string>();

        // Algunas novelas se ordenan por volúmenes y reinician la numeración en
        // cada uno. Se recorren enlaces y cabeceras "VOLUMEN N" en un solo paso
        // para saber a qué volumen pertenece cada capítulo. La alternativa del
        // anchor se prueba primero, así un "volumen" dentro del texto de un
        // enlace no se confunde con una cabecera.
        const token = /<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>|volumen\s*(?:<[^>]+>\s*)*(\d+)/gi;

        let volume: number | undefined;
        let match: RegExpExecArray | null;

        while ((match = token.exec(entry.content)) !== null) {
            if (match[3] !== undefined) {
                volume = parseInt(match[3], 10);
                continue;
            }

            const chapterId = this.postIdFromUrl(match[1] ?? "");
            if (!chapterId || seen.has(chapterId)) continue;
            seen.add(chapterId);

            const text = (match[2] ?? "")
                .replace(/<[^>]+>/g, " ")
                .replace(/ /g, " ")
                .replace(/\s+/g, " ")
                .trim();
            const chapNum = this.chapterNumber(text, chapterId, chapters.length + 1);

            // Prólogos, epílogos y extras no llevan número: etiquetarlos como
            // "Capítulo N" con un número inventado sería engañoso.
            const special = `${text} ${chapterId}`.match(/(pr[óo]logo|ep[íi]logo|extra)/i)?.[1];
            const label = special
                ? special.charAt(0).toUpperCase() + special.slice(1).toLowerCase()
                : `Capítulo ${chapNum}`;

            chapters.push({
                chapterId,
                sourceManga,
                title: volume === undefined ? label : `Vol. ${volume} · ${label}`,
                chapNum,
                volume,
                langCode: "es",
            });
        }

        if (chapters.length === 0) {
            throw new Error(`No se encontraron capítulos para ${sourceManga.mangaId}`);
        }

        chapters.sort((a, b) => b.chapNum - a.chapNum);
        return chapters;
    }

    // ---- lector de novela ----

    // Sólo se conservan las etiquetas de texto y las imágenes. Se descartan los
    // atributos: el blog trae estilos en línea (color negro, fondos fijos,
    // residuos de Dark Reader) que resultan ilegibles en el tema oscuro.
    private readonly allowedTags = new Set([
        "p", "br", "b", "strong", "i", "em", "u", "s", "blockquote", "hr",
        "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "img", "figure",
    ]);

    // Contenedores que marcan fin de párrafo: al desenvolverlos hay que dejar un
    // salto, o los párrafos consecutivos quedarían pegados.
    private readonly blockTags = new Set([
        "div", "section", "article", "center", "header", "footer", "main",
        "aside", "table", "tbody", "tr", "td", "pre",
    ]);

    private escapeXml(text: string): string {
        return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // El lector de novelas parsea el capítulo como XML estricto, no como HTML:
    // se queja con "Extra content at the end of the document" ante varias raíces
    // y aborta con etiquetas vacías sin cerrar o entidades no predefinidas.
    private toXmlSafe(html: string): string {
        return html
            // XML sólo predefine amp/lt/gt/quot/apos; &nbsp; rompe el parseo.
            .replace(/&nbsp;/g, "&#160;")
            .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")
            .replace(/<(br|hr)\s*\/?>/gi, "<$1/>")
            .replace(/<img\b([^>]*?)\/?>/gi, "<img$1/>");
    }

    private sanitizeChapterHtml(html: string): string {
        const $ = cheerio.load(html);

        $("script, style, noscript, iframe, ins, form, button, svg").remove();

        // Los enlaces de navegación (anterior/siguiente/índice) no sirven dentro
        // del lector; el resto se desenvuelve para conservar el texto.
        $("a").each((_, element) => {
            const node = $(element);
            const text = node.text().replace(/\s+/g, " ").trim();
            const isNav =
                node.find("img").length === 0 &&
                /^(cap[ií]tulo\s*)?(anterior|siguiente|previo|next|prev|[«»<>|\s-]*)$/i.test(text);
            if (isNav) node.remove();
            else node.replaceWith(node.contents());
        });

        $("body *").each((_, element) => {
            const node = $(element);
            const tag = (element as { tagName?: string }).tagName?.toLowerCase() ?? "";

            if (tag === "img") {
                const src = node.attr("src");
                if (!src) {
                    node.remove();
                    return;
                }
                const alt = node.attr("alt");
                for (const name of Object.keys(node.attr() ?? {})) node.removeAttr(name);
                node.attr("src", src);
                if (alt) node.attr("alt", alt);
                return;
            }

            for (const name of Object.keys(node.attr() ?? {})) node.removeAttr(name);

            // div/span/font sólo aportan estilo: se sustituyen por su contenido.
            if (!this.allowedTags.has(tag)) {
                if (this.blockTags.has(tag)) node.after("<br>");
                node.replaceWith(node.contents());
            }
        });

        return this.buildParagraphs($);
    }

    // Etiquetas que ya forman bloque y no deben acabar dentro de un <p>.
    private readonly standaloneTags = new Set([
        "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "hr", "ul", "ol", "figure", "p", "img",
    ]);

    // El lector ignora los <br/>: sin <p> reales el capítulo se muestra como un
    // muro de texto con las frases pegadas ("nueva.Pensé en Fox"). Se agrupan los
    // nodos entre saltos en párrafos de verdad. Se mueven nodos enteros, así que
    // nunca se parte una etiqueta en línea por la mitad.
    private buildParagraphs($: cheerio.CheerioAPI): string {
        const blocks: string[] = [];
        let buffer: string[] = [];

        const flush = () => {
            const inner = buffer.join("").trim();
            buffer = [];
            if (!inner) return;
            // Descarta párrafos que sólo traen espacios o &nbsp;
            const bare = inner.replace(/<[^>]+>/g, "").replace(/&nbsp;|&#160;|\s/g, "");
            if (bare) blocks.push(`<p>${inner}</p>`);
        };

        for (const node of $("body").contents().toArray()) {
            const tag = (node as { tagName?: string }).tagName?.toLowerCase() ?? "";

            if (tag === "br") {
                flush();
                continue;
            }
            if (this.standaloneTags.has(tag)) {
                flush();
                blocks.push($.html(node));
                continue;
            }
            buffer.push($.html(node));
        }
        flush();

        // El salto de línea entre bloques es inocuo al maquetar (el espacio en
        // blanco se colapsa), pero separa las frases si el lector, en vez de
        // maquetar, extrae el texto plano.
        return blocks.join("\n");
    }

    async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
        const entry = await this.fetchEntry("posts", `/${chapter.chapterId}.html`);
        if (!entry) throw new Error(`No se encontró el capítulo: ${chapter.chapterId}`);

        const body = this.sanitizeChapterHtml(entry.content);
        const heading = entry.title ? `<h2>${this.escapeXml(entry.title)}</h2>` : "";

        return {
            id: chapter.chapterId,
            mangaId: chapter.sourceManga.mangaId,
            type: "html",
            // El <div> envolvente es obligatorio: XML admite una única raíz.
            // Y el xmlns no es decorativo: el lector parsea esto como XML, y sin
            // declarar XHTML no aplica la hoja de estilos de HTML, así que <p>
            // computa display:inline y el capítulo sale como un muro de texto.
            html: this.toXmlSafe(
                `<div xmlns="http://www.w3.org/1999/xhtml">${heading}\n${body}</div>`,
            ),
        };
    }

    // ---- búsqueda ----

    async getSearchResults(
        query: SearchQuery<Metadata>,
        _metadata: Metadata | undefined,
    ): Promise<PagedResults<SearchResultItem>> {
        const term = this.normalize(query.title ?? "");
        const catalog = await this.getCatalog();

        const items: SearchResultItem[] = catalog
            .filter((entry) => !term || this.normalize(entry.title).includes(term) ||
                this.normalize(entry.mangaId.replace(/-/g, " ")).includes(term))
            .map((entry) => ({
                mangaId: entry.mangaId,
                title: entry.title,
                imageUrl: entry.cover,
                // Sin contentRating explícito la app marca el ítem como "Unknown"
                // y difumina la portada.
                contentRating: ContentRating.MATURE,
            }));

        return { items, metadata: undefined };
    }

    // ---- discover ----

    async getDiscoverSections(): Promise<DiscoverSection[]> {
        return [
            { id: "destacadas", title: "Destacadas", type: DiscoverSectionType.featured },
            { id: "coreanas", title: "Novelas coreanas", type: DiscoverSectionType.simpleCarousel },
            { id: "japonesas", title: "Novelas japonesas", type: DiscoverSectionType.simpleCarousel },
            { id: "todas", title: "Todas las novelas", type: DiscoverSectionType.simpleCarousel },
        ];
    }

    async getDiscoverSectionItems(
        section: DiscoverSection,
        metadata: Metadata | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const catalog = await this.getCatalog();
        const page = (metadata as TopcurMetadata | undefined)?.page ?? 1;

        if (section.id === "destacadas") {
            const items: DiscoverSectionItem[] = catalog.slice(0, 12).map((entry) => ({
                type: "featuredCarouselItem" as const,
                mangaId: entry.mangaId,
                imageUrl: entry.cover,
                title: entry.title,
                contentRating: ContentRating.MATURE,
            }));
            return { items, metadata: undefined };
        }

        const pool =
            section.id === "todas"
                ? catalog
                : catalog.filter((entry) => entry.group === section.id);

        const start = (page - 1) * DISCOVER_PER_PAGE;
        const slice = pool.slice(start, start + DISCOVER_PER_PAGE);
        const items: DiscoverSectionItem[] = slice.map((entry) => ({
            type: "simpleCarouselItem" as const,
            mangaId: entry.mangaId,
            imageUrl: entry.cover,
            title: entry.title,
            contentRating: ContentRating.MATURE,
        }));

        const hasNext = start + DISCOVER_PER_PAGE < pool.length;
        return { items, metadata: hasNext ? { page: page + 1 } : undefined };
    }
}

export const Topcur = new TopcurExtension();
