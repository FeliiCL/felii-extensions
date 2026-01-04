(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.Sources = f()}})(function(){var define,module,exports;return (function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BadgeColor = void 0;
var BadgeColor;
(function (BadgeColor) {
    BadgeColor["BLUE"] = "default";
    BadgeColor["GREEN"] = "success";
    BadgeColor["GREY"] = "info";
    BadgeColor["YELLOW"] = "warning";
    BadgeColor["RED"] = "danger";
})(BadgeColor = exports.BadgeColor || (exports.BadgeColor = {}));

},{}],2:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],3:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HomeSectionType = void 0;
var HomeSectionType;
(function (HomeSectionType) {
    HomeSectionType["singleRowNormal"] = "singleRowNormal";
    HomeSectionType["singleRowLarge"] = "singleRowLarge";
    HomeSectionType["doubleRow"] = "doubleRow";
    HomeSectionType["featured"] = "featured";
})(HomeSectionType = exports.HomeSectionType || (exports.HomeSectionType = {}));

},{}],4:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],5:[function(require,module,exports){
"use strict";
/**
 * Request objects hold information for a particular source (see sources for example)
 * This allows us to to use a generic api to make the calls against any source
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.urlEncodeObject = exports.convertTime = exports.Source = void 0;
/**
* @deprecated Use {@link PaperbackExtensionBase}
*/
class Source {
    constructor(cheerio) {
        this.cheerio = cheerio;
    }
    /**
     * @deprecated use {@link Source.getSearchResults getSearchResults} instead
     */
    searchRequest(query, metadata) {
        return this.getSearchResults(query, metadata);
    }
    /**
     * @deprecated use {@link Source.getSearchTags} instead
     */
    async getTags() {
        // @ts-ignore
        return this.getSearchTags?.();
    }
}
exports.Source = Source;
// Many sites use '[x] time ago' - Figured it would be good to handle these cases in general
function convertTime(timeAgo) {
    let time;
    let trimmed = Number((/\d*/.exec(timeAgo) ?? [])[0]);
    trimmed = (trimmed == 0 && timeAgo.includes('a')) ? 1 : trimmed;
    if (timeAgo.includes('minutes')) {
        time = new Date(Date.now() - trimmed * 60000);
    }
    else if (timeAgo.includes('hours')) {
        time = new Date(Date.now() - trimmed * 3600000);
    }
    else if (timeAgo.includes('days')) {
        time = new Date(Date.now() - trimmed * 86400000);
    }
    else if (timeAgo.includes('year') || timeAgo.includes('years')) {
        time = new Date(Date.now() - trimmed * 31556952000);
    }
    else {
        time = new Date(Date.now());
    }
    return time;
}
exports.convertTime = convertTime;
/**
 * When a function requires a POST body, it always should be defined as a JsonObject
 * and then passed through this function to ensure that it's encoded properly.
 * @param obj
 */
function urlEncodeObject(obj) {
    let ret = {};
    for (const entry of Object.entries(obj)) {
        ret[encodeURIComponent(entry[0])] = encodeURIComponent(entry[1]);
    }
    return ret;
}
exports.urlEncodeObject = urlEncodeObject;

},{}],6:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContentRating = exports.SourceIntents = void 0;
var SourceIntents;
(function (SourceIntents) {
    SourceIntents[SourceIntents["MANGA_CHAPTERS"] = 1] = "MANGA_CHAPTERS";
    SourceIntents[SourceIntents["MANGA_TRACKING"] = 2] = "MANGA_TRACKING";
    SourceIntents[SourceIntents["HOMEPAGE_SECTIONS"] = 4] = "HOMEPAGE_SECTIONS";
    SourceIntents[SourceIntents["COLLECTION_MANAGEMENT"] = 8] = "COLLECTION_MANAGEMENT";
    SourceIntents[SourceIntents["CLOUDFLARE_BYPASS_REQUIRED"] = 16] = "CLOUDFLARE_BYPASS_REQUIRED";
    SourceIntents[SourceIntents["SETTINGS_UI"] = 32] = "SETTINGS_UI";
})(SourceIntents = exports.SourceIntents || (exports.SourceIntents = {}));
/**
 * A content rating to be attributed to each source.
 */
var ContentRating;
(function (ContentRating) {
    ContentRating["EVERYONE"] = "EVERYONE";
    ContentRating["MATURE"] = "MATURE";
    ContentRating["ADULT"] = "ADULT";
})(ContentRating = exports.ContentRating || (exports.ContentRating = {}));

},{}],7:[function(require,module,exports){
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./Source"), exports);
__exportStar(require("./ByteArray"), exports);
__exportStar(require("./Badge"), exports);
__exportStar(require("./interfaces"), exports);
__exportStar(require("./SourceInfo"), exports);
__exportStar(require("./HomeSectionType"), exports);
__exportStar(require("./PaperbackExtensionBase"), exports);

},{"./Badge":1,"./ByteArray":2,"./HomeSectionType":3,"./PaperbackExtensionBase":4,"./Source":5,"./SourceInfo":6,"./interfaces":15}],8:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],9:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],10:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],11:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],12:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],13:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],14:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],15:[function(require,module,exports){
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./ChapterProviding"), exports);
__exportStar(require("./CloudflareBypassRequestProviding"), exports);
__exportStar(require("./HomePageSectionsProviding"), exports);
__exportStar(require("./MangaProgressProviding"), exports);
__exportStar(require("./MangaProviding"), exports);
__exportStar(require("./RequestManagerProviding"), exports);
__exportStar(require("./SearchResultsProviding"), exports);

},{"./ChapterProviding":8,"./CloudflareBypassRequestProviding":9,"./HomePageSectionsProviding":10,"./MangaProgressProviding":11,"./MangaProviding":12,"./RequestManagerProviding":13,"./SearchResultsProviding":14}],16:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],17:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],18:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],19:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],20:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],21:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],22:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],23:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],24:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],25:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],26:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],27:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],28:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],29:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],30:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],31:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],32:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],33:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],34:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],35:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],36:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],37:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],38:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],39:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],40:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],41:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],42:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],43:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],44:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],45:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],46:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],47:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],48:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],49:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],50:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],51:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],52:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],53:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],54:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],55:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],56:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],57:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],58:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],59:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],60:[function(require,module,exports){
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./DynamicUI/Exports/DUIBinding"), exports);
__exportStar(require("./DynamicUI/Exports/DUIForm"), exports);
__exportStar(require("./DynamicUI/Exports/DUIFormRow"), exports);
__exportStar(require("./DynamicUI/Exports/DUISection"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUIButton"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUIHeader"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUIInputField"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUILabel"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUILink"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUIMultilineLabel"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUINavigationButton"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUIOAuthButton"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUISecureInputField"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUISelect"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUIStepper"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUISwitch"), exports);
__exportStar(require("./Exports/ChapterDetails"), exports);
__exportStar(require("./Exports/Chapter"), exports);
__exportStar(require("./Exports/Cookie"), exports);
__exportStar(require("./Exports/HomeSection"), exports);
__exportStar(require("./Exports/IconText"), exports);
__exportStar(require("./Exports/MangaInfo"), exports);
__exportStar(require("./Exports/MangaProgress"), exports);
__exportStar(require("./Exports/PartialSourceManga"), exports);
__exportStar(require("./Exports/MangaUpdates"), exports);
__exportStar(require("./Exports/PBCanvas"), exports);
__exportStar(require("./Exports/PBImage"), exports);
__exportStar(require("./Exports/PagedResults"), exports);
__exportStar(require("./Exports/RawData"), exports);
__exportStar(require("./Exports/Request"), exports);
__exportStar(require("./Exports/SourceInterceptor"), exports);
__exportStar(require("./Exports/RequestManager"), exports);
__exportStar(require("./Exports/Response"), exports);
__exportStar(require("./Exports/SearchField"), exports);
__exportStar(require("./Exports/SearchRequest"), exports);
__exportStar(require("./Exports/SourceCookieStore"), exports);
__exportStar(require("./Exports/SourceManga"), exports);
__exportStar(require("./Exports/SecureStateManager"), exports);
__exportStar(require("./Exports/SourceStateManager"), exports);
__exportStar(require("./Exports/Tag"), exports);
__exportStar(require("./Exports/TagSection"), exports);
__exportStar(require("./Exports/TrackedMangaChapterReadAction"), exports);
__exportStar(require("./Exports/TrackerActionQueue"), exports);

},{"./DynamicUI/Exports/DUIBinding":17,"./DynamicUI/Exports/DUIForm":18,"./DynamicUI/Exports/DUIFormRow":19,"./DynamicUI/Exports/DUISection":20,"./DynamicUI/Rows/Exports/DUIButton":21,"./DynamicUI/Rows/Exports/DUIHeader":22,"./DynamicUI/Rows/Exports/DUIInputField":23,"./DynamicUI/Rows/Exports/DUILabel":24,"./DynamicUI/Rows/Exports/DUILink":25,"./DynamicUI/Rows/Exports/DUIMultilineLabel":26,"./DynamicUI/Rows/Exports/DUINavigationButton":27,"./DynamicUI/Rows/Exports/DUIOAuthButton":28,"./DynamicUI/Rows/Exports/DUISecureInputField":29,"./DynamicUI/Rows/Exports/DUISelect":30,"./DynamicUI/Rows/Exports/DUIStepper":31,"./DynamicUI/Rows/Exports/DUISwitch":32,"./Exports/Chapter":33,"./Exports/ChapterDetails":34,"./Exports/Cookie":35,"./Exports/HomeSection":36,"./Exports/IconText":37,"./Exports/MangaInfo":38,"./Exports/MangaProgress":39,"./Exports/MangaUpdates":40,"./Exports/PBCanvas":41,"./Exports/PBImage":42,"./Exports/PagedResults":43,"./Exports/PartialSourceManga":44,"./Exports/RawData":45,"./Exports/Request":46,"./Exports/RequestManager":47,"./Exports/Response":48,"./Exports/SearchField":49,"./Exports/SearchRequest":50,"./Exports/SecureStateManager":51,"./Exports/SourceCookieStore":52,"./Exports/SourceInterceptor":53,"./Exports/SourceManga":54,"./Exports/SourceStateManager":55,"./Exports/Tag":56,"./Exports/TagSection":57,"./Exports/TrackedMangaChapterReadAction":58,"./Exports/TrackerActionQueue":59}],61:[function(require,module,exports){
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./generated/_exports"), exports);
__exportStar(require("./base/index"), exports);
__exportStar(require("./compat/DyamicUI"), exports);

},{"./base/index":7,"./compat/DyamicUI":16,"./generated/_exports":60}],62:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ManhwaWeb = void 0;
const types_1 = require("@paperback/types");
// URLs Base
const API_URL = "https://manhwawebbackend-production.up.railway.app";
const WEB_URL = "https://manhwaweb.com";
class ManhwaWeb extends types_1.Source {
    constructor() {
        super(...arguments);
        this.baseUrl = WEB_URL;
        this.requestManager = (0, types_1.createRequestManager)({
            requestsPerSecond: 3,
            requestTimeout: 15000,
            interceptor: {
                interceptRequest: async (request) => {
                    request.headers = {
                        ...request.headers,
                        "Origin": WEB_URL,
                        "Referer": `${WEB_URL}/`,
                        "Accept": "application/json, text/plain, */*",
                        "User-Agent": "Paperback"
                    };
                    return request;
                },
                interceptResponse: async (response) => {
                    return response;
                },
            },
        });
    }
    // --- Metadata de Source ---
    getSourceInfo() {
        return (0, types_1.createSourceInfo)({
            version: '1.0.0',
            name: 'ManhwaWeb',
            icon: 'icon.png',
            author: 'TuNombre',
            authorWebsite: 'https://github.com/tuusuario',
            description: 'Extensión para leer manhwas desde ManhwaWeb',
            contentRating: types_1.ContentRating.MATURE,
            websiteBaseURL: WEB_URL,
            sourceTags: [],
            intents: types_1.SourceIntents.MANGA_CHAPTERS | types_1.SourceIntents.HOMEPAGE_SECTIONS
        });
    }
    // --- HELPER: Obtener el ID correcto ---
    getIdFromItem(item) {
        // 1. Intentamos sacar el slug del enlace (es lo más seguro)
        if (item.link && typeof item.link === 'string') {
            const parts = item.link.split('/').filter(p => p.length > 0);
            const slug = parts[parts.length - 1];
            if (slug)
                return slug;
        }
        // 2. Si no hay link, usamos real_id (suele ser el slug)
        if (item.real_id)
            return item.real_id;
        // 3. Último recurso: el ID interno
        if (item._id)
            return item._id;
        throw new Error('No se pudo determinar ID del manga');
    }
    // --- HELPER: Parsear respuesta JSON ---
    parseJSON(data, context) {
        try {
            return JSON.parse(data);
        }
        catch (e) {
            throw new Error(`Error parseando JSON en ${context}: ${e}`);
        }
    }
    // --- 1. Detalles del Manga ---
    async getMangaDetails(mangaId) {
        const request = (0, types_1.createRequestObject)({
            url: `${API_URL}/manhwa/see/${mangaId}`,
            method: "GET",
        });
        let data;
        try {
            const response = await this.requestManager.schedule(request, 1);
            data = this.parseJSON(response.data, 'getMangaDetails');
        }
        catch (e) {
            throw new Error(`Fallo al cargar detalles para ID: ${mangaId}. Error: ${e}`);
        }
        // Validación de datos mínimos
        if (!data) {
            throw new Error(`No se encontraron datos para el manga: ${mangaId}`);
        }
        const title = data.the_real_name || data._name || data.name_esp || "Sin título";
        const image = data._imagen || "https://placehold.co/400x600?text=No+Cover";
        const desc = data._sinopsis || "Sin descripción disponible.";
        // Determinar status
        let status = types_1.MangaStatus.ONGOING;
        const statusText = (data._status || "").toLowerCase();
        if (statusText.includes("finalizado") || statusText.includes("completado")) {
            status = types_1.MangaStatus.COMPLETED;
        }
        else if (statusText.includes("cancelado")) {
            status = types_1.MangaStatus.ABANDONED;
        }
        // Determinar si es contenido adulto basándose en datos reales
        const isAdult = data.erotico === true ||
            statusText.includes("erotico") ||
            desc.toLowerCase().includes("+18");
        return (0, types_1.createManga)({
            id: mangaId,
            titles: [title],
            image: image,
            rating: 0,
            status: status,
            author: "Desconocido",
            desc: desc,
            hentai: isAdult,
            lastUpdate: new Date()
        });
    }
    // --- 2. Capítulos ---
    async getChapters(mangaId) {
        const request = (0, types_1.createRequestObject)({
            url: `${API_URL}/manhwa/see/${mangaId}`,
            method: "GET",
        });
        let data;
        try {
            const response = await this.requestManager.schedule(request, 1);
            data = this.parseJSON(response.data, 'getChapters');
        }
        catch (e) {
            throw new Error(`Error cargando capítulos para ${mangaId}: ${e}`);
        }
        const rawChapters = data.chapters || data._chapters || [];
        if (rawChapters.length === 0) {
            console.warn(`No se encontraron capítulos para: ${mangaId}`);
            return [];
        }
        const chapters = [];
        for (const ch of rawChapters) {
            let chId = "";
            // Lógica robusta para ID de capítulo
            if (ch.link) {
                const parts = ch.link.split('/').filter(p => p.length > 0);
                chId = parts[parts.length - 1];
            }
            else {
                chId = `${mangaId}-${ch.chapter}`;
            }
            // Validación del número de capítulo
            const chapNum = Number(ch.chapter);
            if (isNaN(chapNum)) {
                console.warn(`Capítulo con número inválido: ${ch.chapter}`);
                continue;
            }
            chapters.push((0, types_1.createChapter)({
                id: chId,
                mangaId: mangaId,
                name: `Capítulo ${ch.chapter}`,
                chapNum: chapNum,
                time: ch.create ? new Date(ch.create) : new Date(),
                langCode: "es",
            }));
        }
        return chapters;
    }
    // --- 3. Imágenes del Capítulo ---
    async getChapterDetails(mangaId, chapterId) {
        const request = (0, types_1.createRequestObject)({
            url: `${API_URL}/chapters/see/${chapterId}`,
            method: "GET",
        });
        let data;
        try {
            const response = await this.requestManager.schedule(request, 1);
            data = this.parseJSON(response.data, 'getChapterDetails');
        }
        catch (e) {
            throw new Error(`Error cargando imágenes del capítulo ${chapterId}: ${e}`);
        }
        const pages = [];
        // Extraer imágenes de diferentes estructuras posibles
        if (data.chapter?.img && Array.isArray(data.chapter.img)) {
            pages.push(...data.chapter.img);
        }
        else if (data.images && Array.isArray(data.images)) {
            pages.push(...data.images);
        }
        // Validación: debe haber al menos una imagen
        if (pages.length === 0) {
            throw new Error(`No se encontraron imágenes para el capítulo: ${chapterId}`);
        }
        return (0, types_1.createChapterDetails)({
            id: chapterId,
            mangaId: mangaId,
            pages: pages,
        });
    }
    // --- 4. Búsqueda ---
    async getSearchResults(query, metadata) {
        const term = encodeURIComponent(query.title || "");
        const request = (0, types_1.createRequestObject)({
            url: `${API_URL}/manhwa/library?buscar=${term}&estado=&tipo=&erotico=&demografia=&order_item=alfabetico&order_dir=desc&page=0&generes=`,
            method: "GET"
        });
        let data;
        try {
            const response = await this.requestManager.schedule(request, 1);
            data = this.parseJSON(response.data, 'getSearchResults');
        }
        catch (e) {
            throw new Error(`Error en búsqueda: ${e}`);
        }
        const results = data.data || [];
        const tiles = [];
        for (const item of results) {
            try {
                const id = this.getIdFromItem(item);
                const title = item.the_real_name || item.name_esp || item._name || "Sin título";
                const image = item._imagen || "https://placehold.co/200x300?text=No+Cover";
                tiles.push((0, types_1.createMangaTile)({
                    id: id,
                    title: (0, types_1.createIconText)({ text: title }),
                    image: image
                }));
            }
            catch (e) {
                console.warn(`Error procesando resultado de búsqueda: ${e}`);
                continue;
            }
        }
        return (0, types_1.createPagedResults)({
            results: tiles
        });
    }
    // --- 5. Página de Inicio ---
    async getHomePageSections(sectionCallback) {
        const sections = [
            {
                id: 'new_mangas',
                title: 'Últimos Agregados',
                url: `${API_URL}/manhwa/library?buscar=&estado=&tipo=&erotico=&demografia=&order_item=creacion&order_dir=desc&page=0&generes=`
            },
            {
                id: 'popular_mangas',
                title: 'Populares',
                url: `${API_URL}/manhwa/library?buscar=&estado=&tipo=&erotico=&demografia=&order_item=vistas&order_dir=desc&page=0&generes=`
            }
        ];
        for (const sectionConfig of sections) {
            try {
                const request = (0, types_1.createRequestObject)({
                    url: sectionConfig.url,
                    method: "GET"
                });
                const response = await this.requestManager.schedule(request, 1);
                const data = this.parseJSON(response.data, 'getHomePageSections');
                const items = data.data || [];
                const tiles = [];
                for (const item of items) {
                    try {
                        const id = this.getIdFromItem(item);
                        const title = item.the_real_name || item.name_esp || "Sin título";
                        const image = item._imagen || "https://placehold.co/200x300?text=No+Cover";
                        tiles.push((0, types_1.createMangaTile)({
                            id: id,
                            title: (0, types_1.createIconText)({ text: title }),
                            image: image
                        }));
                    }
                    catch (e) {
                        console.warn(`Error procesando item de home: ${e}`);
                        continue;
                    }
                }
                const section = (0, types_1.createHomeSection)({
                    id: sectionConfig.id,
                    title: sectionConfig.title,
                    view_more: true,
                });
                section.items = tiles;
                sectionCallback(section);
            }
            catch (e) {
                console.error(`Error cargando sección ${sectionConfig.id}: ${e}`);
            }
        }
    }
    // --- 6. View More (Opcional pero recomendado) ---
    async getViewMoreItems(homepageSectionId, metadata) {
        const page = metadata?.page || 0;
        let orderItem = 'creacion';
        if (homepageSectionId === 'popular_mangas') {
            orderItem = 'vistas';
        }
        const request = (0, types_1.createRequestObject)({
            url: `${API_URL}/manhwa/library?buscar=&estado=&tipo=&erotico=&demografia=&order_item=${orderItem}&order_dir=desc&page=${page}&generes=`,
            method: "GET"
        });
        const response = await this.requestManager.schedule(request, 1);
        const data = this.parseJSON(response.data, 'getViewMoreItems');
        const results = data.data || [];
        const tiles = [];
        for (const item of results) {
            try {
                tiles.push((0, types_1.createMangaTile)({
                    id: this.getIdFromItem(item),
                    title: (0, types_1.createIconText)({ text: item.the_real_name || item.name_esp || "Sin título" }),
                    image: item._imagen || ""
                }));
            }
            catch (e) {
                continue;
            }
        }
        return (0, types_1.createPagedResults)({
            results: tiles,
            metadata: { page: page + 1 }
        });
    }
}
exports.ManhwaWeb = ManhwaWeb;

},{"@paperback/types":61}]},{},[62])(62)
});
