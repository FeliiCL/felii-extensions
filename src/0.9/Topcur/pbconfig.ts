import { ContentRating, ExtensionInfo, SourceIntents } from "@paperback/types";

export default {
    name: "Topcur Traducciones",
    description: "Novelas ligeras en español de Topcur (animerikosuper.blogspot.com)",
    version: "1.0.3",
    icon: "icon.png",
    language: "es",
    contentRating: ContentRating.MATURE,
    capabilities: [
        SourceIntents.DISCOVER_SECTION_PROVIDING,
        SourceIntents.SEARCH_RESULT_PROVIDING,
        SourceIntents.CHAPTER_PROVIDING,
    ],
    badges: [
        { label: "Novelas", textColor: "#ffffff", backgroundColor: "#7c3aed" },
        { label: "Español", textColor: "#ffffff", backgroundColor: "#2563eb" },
    ],
    developers: [{ name: "Felii", github: "https://github.com/feliivk" }],
} satisfies ExtensionInfo;
