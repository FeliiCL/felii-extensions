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
    SelectRow,
    SettingsFormProviding,
    SourceManga,
    Tag,
    TagSection,
} from "@paperback/types";

import * as cheerio from "cheerio";

// Webtoons oficial. La web de escritorio (www) sirve páginas SSR estables y la
// móvil (m.) expone JSON de búsqueda y episodios. El idioma del catálogo es
// configurable (ES/EN) — cada idioma tiene sus propios titleNo.
const WWW_URL = "https://www.webtoons.com";
const MOBILE_URL = "https://m.webtoons.com";
const THUMB_HOST = "https://webtoon-phinf.pstatic.net";
const FALLBACK_COVER = "https://placehold.co/400x600.png?text=No+Cover";

const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";

// --- Ajuste de idioma ---
const LANG_STATE_KEY = "webtoons.language";
const LANGS = [
    { id: "es", title: "Español" },
    { id: "en", title: "English" },
];

function getLanguage(): string {
    const v = Application.getState(LANG_STATE_KEY);
    return v === "en" ? "en" : "es";
}

class WebtoonsSettingsForm extends Form {
    private lang = getLanguage();

    async updateLanguage(value: string[]): Promise<void> {
        this.lang = value[0] === "en" ? "en" : "es";
        Application.setState(this.lang, LANG_STATE_KEY);
        this.reloadForm();
    }

    override getSections() {
        return [
            Section(
                {
                    id: "idioma",
                    footer: "Idioma del catálogo (búsqueda y descubrimiento). Cada idioma tiene su propio catálogo de series.",
                },
                [
                    SelectRow("language", {
                        title: "Idioma / Language",
                        value: [this.lang],
                        minItemCount: 1,
                        maxItemCount: 1,
                        layout: "list",
                        items: LANGS,
                        onValueChange: Application.Selector<
                            WebtoonsSettingsForm,
                            (value: string[]) => Promise<void>
                        >(this, "updateLanguage"),
                    }),
                ],
            ),
        ];
    }
}

class WebtoonsInterceptor extends PaperbackInterceptor {
    override async interceptRequest(request: Request): Promise<Request> {
        const isMobileApi = request.url.startsWith(MOBILE_URL);
        request.headers = {
            ...request.headers,
            // Las imágenes de pstatic.net exigen referer de webtoons.com
            referer: `${WWW_URL}/`,
            "user-agent": isMobileApi ? MOBILE_UA : DESKTOP_UA,
            accept: isMobileApi ? "application/json, text/plain, */*" : "text/html,application/xhtml+xml,*/*;q=0.8",
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

type WebtoonsImplementation = Extension &
    SearchResultsProviding &
    MangaProviding &
    ChapterProviding &
    DiscoverSectionProviding &
    SettingsFormProviding;

export class WebtoonsExtension implements WebtoonsImplementation {
    requestManager = new WebtoonsInterceptor("main");
    globalRateLimiter = new BasicRateLimiter("rateLimiter", {
        numberOfRequests: 4,
        bufferInterval: 1,
        ignoreImages: true,
    });

    async initialise(): Promise<void> {
        this.requestManager.registerInterceptor();
        this.globalRateLimiter.registerInterceptor();
    }

    async getSettingsForm(): Promise<Form> {
        return new WebtoonsSettingsForm();
    }

    // ---- fetch helpers ----

    private async fetchText(url: string): Promise<string> {
        const [response, data] = await Application.scheduleRequest({ url, method: "GET" });
        if (response.status < 200 || response.status >= 400) {
            throw new Error(`La petición falló (${response.status}): ${url}`);
        }
        return Application.arrayBufferToUTF8String(data);
    }

    private async fetchJson<T = any>(url: string): Promise<T> {
        return JSON.parse(await this.fetchText(url)) as T;
    }

    private absThumb(path: string): string {
        const p = (path || "").trim();
        if (!p) return FALLBACK_COVER;
        return p.startsWith("http") ? p : `${THUMB_HOST}${p}`;
    }

    // ---- manga details ----
    // mangaId = titleNo. /episodeList?titleNo=N redirige a la página canónica de la serie.

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const html = await this.fetchText(`${WWW_URL}/episodeList?titleNo=${mangaId}`);
        const $ = cheerio.load(html);

        const title =
            $("h1.subj, h3.subj").first().text().trim() ||
            $('meta[property="og:title"]').attr("content")?.trim() ||
            mangaId;
        const image = $('meta[property="og:image"]').attr("content") || FALLBACK_COVER;
        const synopsis = $("p.summary").first().text().trim() || "Sin descripción disponible.";
        const author = $(".author_area, .author").first().text().replace(/información del autor/i, "").trim() || undefined;
        const genre = $("h2.genre, .genre").first().text().trim();

        const tags: Tag[] = [];
        if (genre) tags.push({ id: genre.toLowerCase().replace(/\s+/g, "-"), title: genre });
        const tagGroups: TagSection[] = [];
        if (tags.length > 0) tagGroups.push({ id: "genres", title: "Géneros", tags });

        // Los originals en emisión no exponen estado claro; "COMPLETADO" aparece como badge
        const pageText = $(".detail_header, #content").text();
        const status = /completad|completed/i.test(pageText) ? "Completed" : "Ongoing";

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
                tagGroups,
                shareUrl: `${WWW_URL}/episodeList?titleNo=${mangaId}`,
            },
        };
    }

    // ---- chapters ----

    async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
        const json = await this.fetchJson<any>(
            `${MOBILE_URL}/api/v1/webtoon/${sourceManga.mangaId}/episodes?pageSize=99999`,
        );
        const eps: any[] = json?.result?.episodeList ?? [];

        const chapters: Chapter[] = [];
        const seen = new Set<string>();
        for (const ep of eps) {
            // chapterId = viewerLink (path relativo con title_no y episode_no incluidos)
            const link = (ep?.viewerLink ?? "").trim();
            const epNo = ep?.episodeNo;
            if (!link || epNo == null || seen.has(link)) continue;
            seen.add(link);

            chapters.push({
                chapterId: link,
                sourceManga,
                title: (ep?.episodeTitle ?? "").trim() || undefined,
                chapNum: parseFloat(String(epNo)) || 0,
                publishDate: ep?.exposureDateMillis ? new Date(ep.exposureDateMillis) : undefined,
                langCode: getLanguage(),
            });
        }

        chapters.sort((a, b) => b.chapNum - a.chapNum);
        return chapters;
    }

    async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
        const html = await this.fetchText(`${WWW_URL}${chapter.chapterId}`);
        const $ = cheerio.load(html);

        const pages: string[] = [];
        $("img._images").each((_i, el) => {
            const src = ($(el).attr("data-url") || $(el).attr("src") || "").trim();
            if (src) pages.push(src);
        });

        return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages };
    }

    // ---- search ----

    async getSearchResults(
        query: SearchQuery<Metadata>,
        _metadata: Metadata | undefined,
    ): Promise<PagedResults<SearchResultItem>> {
        const lang = getLanguage();
        const term = encodeURIComponent(query.title ?? "");
        const json = await this.fetchJson<any>(`${MOBILE_URL}/${lang}/search/result?keyword=${term}`);

        const items: SearchResultItem[] = [];
        const seen = new Set<string>();
        for (const t of json?.result?.webtoonResult?.titleList ?? []) {
            const id = String(t?.titleNo ?? "");
            if (!id || seen.has(id)) continue;
            seen.add(id);
            items.push({
                mangaId: id,
                title: (t?.title ?? "").trim(),
                subtitle: (t?.writingAuthorName ?? "").trim() || undefined,
                imageUrl: this.absThumb(t?.thumbnailMobile),
                // Sin contentRating explícito la app trata el ítem como "Unknown"
                // y difumina la portada con una "U"; se declara siempre.
                contentRating: t?.unsuitableForChildren ? ContentRating.ADULT : ContentRating.MATURE,
            });
        }

        return { items, metadata: undefined };
    }

    // ---- discover ----

    async getDiscoverSections(): Promise<DiscoverSection[]> {
        return [
            { id: "trending", title: "Trending", type: DiscoverSectionType.featured },
            { id: "originals", title: "Originals", type: DiscoverSectionType.simpleCarousel },
        ];
    }

    async getDiscoverSectionItems(
        section: DiscoverSection,
        _metadata: Metadata | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        const lang = getLanguage();
        const url = section.id === "trending" ? `${WWW_URL}/${lang}/ranking/trending` : `${WWW_URL}/${lang}/originals`;
        const html = await this.fetchText(url);
        const $ = cheerio.load(html);

        const items: DiscoverSectionItem[] = [];
        const seen = new Set<string>();

        $('a[href*="title_no="]').each((_i, el) => {
            const a = $(el);
            const href = a.attr("href") || "";
            const idMatch = href.match(/title_no=(\d+)/);
            if (!idMatch) return;
            const mangaId = idMatch[1];
            if (!mangaId || seen.has(mangaId)) return;

            const img = a.find("img").first();
            const image = (img.attr("src") || img.attr("data-src") || "").trim();
            // El alt de la portada es el título; los rankings meten el nº de puesto en strong
            const title =
                img.attr("alt")?.trim() ||
                a.find(".subj, .title").first().text().trim() ||
                "";
            if (!title || !image) return;

            seen.add(mangaId);
            const adult = a.closest("[data-title-unsuitable-for-children]").attr("data-title-unsuitable-for-children") === "true" ||
                a.find('[data-title-unsuitable-for-children="true"]').length > 0;

            const rating = adult ? ContentRating.ADULT : ContentRating.MATURE;
            if (section.type === DiscoverSectionType.featured) {
                items.push({
                    type: "featuredCarouselItem",
                    mangaId,
                    imageUrl: this.absThumb(image),
                    title,
                    contentRating: rating,
                });
            } else {
                items.push({
                    type: "simpleCarouselItem",
                    mangaId,
                    imageUrl: this.absThumb(image),
                    title,
                    contentRating: rating,
                });
            }
        });

        return { items, metadata: undefined };
    }
}

export const Webtoons = new WebtoonsExtension();
