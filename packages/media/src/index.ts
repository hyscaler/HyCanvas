// @hc/media: framework-agnostic media-management core for HyCanvas.
// Pure logic only: magic-byte type sniffing, perceptual hashing + duplicate
// classification, storage-quota accounting, asset status transitions, folder
// trees, source-import fidelity reports, SSRF URL validation, and asset search.
// The ingest pipeline, importers, REST/realtime surface, persistence, OAuth
// connectors, and recorders are the backend/worker/runtime layer (deferred).

export * from "./types";
export * from "./sniff";
export * from "./phash";
export * from "./dedupe";
export * from "./quota";
export * from "./status";
export * from "./folders";
export * from "./fidelity";
export * from "./ssrf";
export * from "./search";
export * from "./matte";
export * from "./ingest";
export * from "./similar";
