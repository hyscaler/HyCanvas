// @hc/aistudio: F39 AI Creative Studio core. Framework-agnostic, pure functions.
// The model returns a validated AiDesignSpec (content + roles + layout intent);
// layoutDesign turns it into a positioned page; qualityCheck verifies the result.
// No React, no network, no DOM - safe in browser, worker, and on the server.

export * from "./spec";
export * from "./layout";
export * from "./quality";
export * from "./capacity";
export * from "./look";
export * from "./artwork";
export * from "./outline";
export * from "./promptRules";
export * from "./outlineEdit";
export * from "./imagePlan";
export * from "./layoutSchema";
export * from "./narrativeOps";
export * from "./chartData";
export * from "./theme";
export * from "./themeGen";
export * from "./themeCatalog";
export * from "./layoutExtract";
export * from "./mdoutline";
export * from "./compose";
export * from "./deckStyle";
export * from "./reflow";
export * from "./deck";
export * from "./recompose";
export * from "./designSystem";
export * from "./archetypes";
export * from "./measure";
export * from "./prompts";
export * from "./assistant";
export * from "./transform";
// The presentation kit (the signature templates' systems and forms as the
// composer the generation flow draws with), as a namespace: its slide
// vocabulary (text, rect, card) would collide with the layout module's names.
export * as kit from "./kit";
export { composeKitPage, kitFits, type KitContext } from "./kit/render";
export { resolveKitStyle, styleForMood, slotsFromThemeRecord, applyBrand, makeLook, type KitStyle, type KitLook, type KitPalette } from "./kit/look";
export { KIT_STYLES, kitStyleNames } from "./kit/looks";
export { kitVocabularyRule, kitStyleRule, kitVoiceRule, kitDrawingRule, kitSignatureRule, kitDrawingNames, kitSignatures } from "./kit/vocab";
