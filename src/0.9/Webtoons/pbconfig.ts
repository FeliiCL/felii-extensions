import { ContentRating, ExtensionInfo, SourceIntents } from "@paperback/types";

export default {
    name: "Webtoons",
    description: "Webtoons oficial (webtoons.com) — ES/EN configurable en ajustes",
    version: "1.0.1",
    icon: "icon.png",
    language: "multi",
    contentRating: ContentRating.MATURE,
    capabilities: [
        SourceIntents.DISCOVER_SECTION_PROVIDING,
        SourceIntents.SEARCH_RESULT_PROVIDING,
        SourceIntents.CHAPTER_PROVIDING,
        SourceIntents.SETTINGS_FORM_PROVIDING,
    ],
    badges: [{ label: "Oficial", textColor: "#ffffff", backgroundColor: "#00d564" }],
    developers: [{ name: "Felii", github: "https://github.com/feliivk" }],
} satisfies ExtensionInfo;
