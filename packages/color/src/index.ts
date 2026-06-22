// @hc/color: framework-agnostic color system for HyCanvas.
// Space conversions, WCAG contrast, palette extraction, CVD simulation, and
// CMYK gamut checks. All functions are pure and operate on the canonical
// `Color` type from @hc/schema (sRGB-canonical, optional CMYK/spot).

export * from "./convert";
export * from "./contrast";
export * from "./palette";
export * from "./series";
export * from "./nearest";
export * from "./cvd";
export * from "./gamut";
