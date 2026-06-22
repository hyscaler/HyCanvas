// @hc/stock: framework-agnostic stock/elements catalog core for HyCanvas
//. Pure logic only: catalog search/filter, SVG-to-editable-vector
// conversion, stock-to-node insertion mapping with provenance, attribution
// compilation, mini-app scope enforcement, embed provider classification, and
// the QR node model. The REST catalog, CDN, pgvector similarity, sandboxed
// mini-app runtime, and server QR/map/oEmbed rendering are deferred.

export * from "./types";
export * from "./search";
export * from "./pathdata";
export * from "./svg";
export * from "./insert";
export * from "./attribution";
export * from "./apphost";
export * from "./embed";
export * from "./qr";
export * from "./qrmatrix";
