// @hc/geometry - pure, framework-agnostic path geometry for HyCanvas:
// parametric shape -> path, flattening, bounds, point-in-path hit-testing,
// boolean operations, and connector routing. Used by the editor and the headless
// export path so clips and booleans render identically everywhere.

export * from "./types";
export * from "./shapes";
export * from "./flatten";
export * from "./query";
export * from "./boolean";
export * from "./connector";
export * from "./simplify";
export * from "./stroke";
