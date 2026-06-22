// @hc/editor - the framework-agnostic editor controller for object manipulation
//: selection, transforms, snapping, align/distribute, grouping, layer
// state, and reversible edit commands. It consumes @hc/schema (the scene graph)
// and @hc/engine (hit-testing, matrices), with no React/UI dependency. The web
// editor (gizmo, gestures, layer panel, Zustand bindings) binds to this core;
// that UI plus Playwright/visual/perf tests land with the editor app.

export * from "./tree";
export * from "./transform";
export * from "./commands";
export * from "./expression";
export * from "./selection";
export * from "./snapping";
export * from "./arrange";
export * from "./grouping";
export * from "./layers";
export * from "./image";
export * from "./resize";
export * from "./history";
export * from "./registry";
export * from "./clipboard";
