// @hc/text - the framework-agnostic text engine for HyCanvas: the
// rich-text document model helpers, the style cascade, Unicode segmentation,
// find/replace, line-breaking layout, and auto-fit. Consumed by the editor and
// the headless export path so on-screen and exported text agree.
//
// Implemented now: model + cascade + segmentation + rich-text ops + a pluggable
// line-break layout + auto-fit. Deferred (need a browser/native runtime or heavy
// deps): HarfBuzz shaping, bidi + complex-script (Arabic/Indic/Thai/CJK)
// correctness, real font metrics/loading, spell/grammar, text effects rendering,
// the inline editing UI + IME, and golden-image export parity.

export * from "./defaults";
export * from "./fonts";
export * from "./cascade";
export * from "./segment";
export * from "./richtext";
export * from "./layout";
export * from "./autofit";
