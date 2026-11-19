// @hc/schema - the open design file format.
//
// The contract every feature extends. Adding a node type or property means
// extending the schema here and shipping a forward migration (see migrate.ts),
// so opening an older file always succeeds.
//

// Types and format constants. The zod schemas, validate() and the JSON Schema
// export are NOT part of this entry: they pull in zod (about 100 KB compressed),
// which most consumers never need. Import them from "@hc/schema/dist/validation"
// (see validation.ts).
export * from "./schema";

// Forward-only migration chain.
export * from "./migrate";

// Default-instance factory and blank-design helper.
export * from "./factory";

// Generic scene-graph traversal.
export * from "./visitor";

// Forward-compatibility helpers for unknown/newer node types.
export * from "./unknown-nodes";

// Version-independent repairs for what an earlier writer got wrong.
export * from "./repair";

// Yjs bridge (edit-time CRDT <-> serialized file).
export * from "./yjs";
export * from "./theme";
export * from "./a11y";
export * from "./sections";

/**
 * Back-compat alias for the schema version constant. Prefer
 * `currentSchemaVersion`.
 * @deprecated use currentSchemaVersion
 */
export { currentSchemaVersion as SCHEMA_VERSION } from "./schema";
