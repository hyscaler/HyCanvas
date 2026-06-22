// @hc/schema - the open design file format.
//
// The contract every feature extends. Adding a node type or property means
// extending the schema here and shipping a forward migration (see migrate.ts),
// so opening an older file always succeeds.
//

// Types, zod schemas, and format constants.
export * from "./schema";

// Validation gate (JSON-pointer errors), used by persistence/import/API.
export * from "./validate";

// Forward-only migration chain.
export * from "./migrate";

// Default-instance factory and blank-design helper.
export * from "./factory";

// Generic scene-graph traversal.
export * from "./visitor";

// Forward-compatibility helpers for unknown/newer node types.
export * from "./unknown-nodes";

// Published JSON Schema (draft 2020-12) generation.
export * from "./json-schema";

// Yjs bridge (edit-time CRDT <-> serialized file).
export * from "./yjs";

/**
 * Back-compat alias for the schema version constant. Prefer
 * `CURRENT_SCHEMA_VERSION`.
 * @deprecated use CURRENT_SCHEMA_VERSION
 */
export { CURRENT_SCHEMA_VERSION as SCHEMA_VERSION } from "./schema";
