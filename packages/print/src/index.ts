// @hc/print: framework-agnostic print and mockups core for HyCanvas (F35).
//
// Pure logic only: the print product catalog and vendor-adapter registry, print
// geometry (bleed/trim/safe-zone, design-to-product fit, quality badge),
// print-grade pre-flight (reusing @hc/export's DPI/gamut/bleed/font pass plus
// print-specific color-space/ICC/safe-zone/overprint checks) with an ordering
// gate, transparent cost quoting, mockup placement geometry, and the order
// lifecycle state machine. Rasterization, PDF/X encoding, network/vendor I/O,
// payment, persistence, and REST live in the runtime/worker layer.

export * from "./types";
export * from "./address";
export * from "./geometry";
export * from "./catalog";
export * from "./preflight";
export * from "./cost";
export * from "./mockup";
export * from "./order";
