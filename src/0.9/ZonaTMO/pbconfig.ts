import { ContentRating, ExtensionInfo, SourceIntents } from "@paperback/types";

export default {
    name: "ZonaTMO",
    description: "Lectura desde ZonaTMO (zonatmo.org)",
    version: "1.0.1",
    icon: "icon.png",
    language: "es",
    contentRating: ContentRating.MATURE,
    capabilities: [
        SourceIntents.DISCOVER_SECTION_PROVIDING,
        SourceIntents.SEARCH_RESULT_PROVIDING,
        SourceIntents.CHAPTER_PROVIDING,
    ],
    badges: [{ label: "Español", textColor: "#ffffff", backgroundColor: "#2563eb" }],
    developers: [{ name: "Felii", github: "https://github.com/feliivk" }],
} satisfies ExtensionInfo;
