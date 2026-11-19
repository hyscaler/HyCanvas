// The deck composer, as one entry for a host to load on demand: laying a deck
// out from an outline and recomposing one slide. These pull in the archetype
// and kit composers (most of this package's code), so the editor loads them
// together with the artwork right before it composes (#77), while the rest of
// the package is imported module by module.

export { layoutDeck } from "./deck";
export { isComposedSlide, slideItemOf, slideTextDump, reviseSlideSystemPrompt, reviseSlideSchema, reviseSlideItem, recomposeSlide } from "./recompose";
export { slotsFromThemeRecord } from "./kit/look";
