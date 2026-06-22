// @hc/sheets - framework-agnostic sheet model for HyCanvas Sheets
// (FR-1/5/6/7). A sheet lives in a Design's `meta.kind === "sheet"`; cells are
// NOT scene nodes. This package provides the cell model, formula recompute
// (via @hc/formula), number/conditional formatting, data tables, and the
// chart-binding resolver that feeds a chart scene node (F27).

export * from "./model";
export * from "./recompute";
export * from "./format";
export * from "./table";
export * from "./binding";
export * from "./structure";
