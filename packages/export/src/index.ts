// @hc/export: framework-agnostic export engine core for HyCanvas.
// Pure logic only: page selection, raster dimension math, filename templating,
// presets, pre-flight, and editable SVG serialization. Binary encoding (PNG/JPG/
// PDF/GIF/APNG/Lottie), job execution, REST, realtime progress, and S3 storage
// are the runtime/worker layer (deferred); they reuse @hc/engine for parity.

export * from "./types";
export * from "./pages";
export * from "./dimensions";
export * from "./filename";
export * from "./preset";
export * from "./preflight";
export * from "./svg";
export * from "./apng";
export * from "./gif";
export * from "./lottie";
