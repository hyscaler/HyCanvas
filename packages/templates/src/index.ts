// @hc/templates: framework-agnostic template-system core for HyCanvas
//. Pure logic only: deep-copy/apply, style extraction + swap-styles,
// fillable-field extraction + validation, attribution merge, and search. The
// catalog persistence, marketplace review workflow, AI matching, remix
// generation, and headless preview rendering are the backend/runtime layer
// (deferred); marketplace ranking + faceting is pure and lives here.

export * from "./types";
export * from "./deepcopy";
export * from "./style";
export * from "./fillable";
export * from "./fill";
export * from "./attribution";
export * from "./search";
export * from "./apply";
export * from "./lockedregions";
export * from "./marketplace";
