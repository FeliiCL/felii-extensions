import { ContentRating, ExtensionInfo, SourceIntents } from "@paperback/types";

export default {
    name: "MangaOni",
    description: "Lectura desde MangaOni (manga-oni.com)",
    version: "1.0.0",
    icon: "icon.png",
    language: "es",
    contentRating: ContentRating.MATURE,
    capabilities: [
        SourceIntents.DISCOVER_SECTION_PROVIDING,
        SourceIntents.SEARCH_RESULT_PROVIDING,
        SourceIntents.CHAPTER_PROVIDING,
    ],
    badges: [{ label: "Español", textColor: "#ffffff", backgroundColor: "#2563eb" }],
    developers: [{ name: "Felii", github: "https://github.com/FeliiCL" }],
} satisfies ExtensionInfo;
