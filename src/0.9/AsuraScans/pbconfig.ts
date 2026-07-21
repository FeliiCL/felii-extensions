import { ContentRating, ExtensionInfo, SourceIntents } from "@paperback/types";

export default {
    name: "AsuraScans",
    description: "Read manhwa from Asura Scans (asurascans.com)",
    version: "1.0.1",
    icon: "icon.png",
    language: "en",
    contentRating: ContentRating.MATURE,
    capabilities: [
        SourceIntents.DISCOVER_SECTION_PROVIDING,
        SourceIntents.SEARCH_RESULT_PROVIDING,
        SourceIntents.CHAPTER_PROVIDING,
    ],
    badges: [{ label: "Manhwa", textColor: "#ffffff", backgroundColor: "#7c3aed" }],
    developers: [{ name: "Felii", github: "https://github.com/FeliiCL" }],
} satisfies ExtensionInfo;
