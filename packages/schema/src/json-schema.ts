// JSON Schema (draft 2020-12) generation from the zod schema (FR-1). Generated
// from the same source as the runtime validator and the TypeScript types, so
// the published schema cannot drift from them (AC-7).

import { z } from "zod";
import { DesignFileSchema } from "./schema";

/** Media type for the open design file format. */
export const DESIGN_MEDIA_TYPE = "application/vnd.hycanvas.design+json";

/** Stable `$id` for the published schema document. */
export const DESIGN_SCHEMA_ID =
  "https://hycanvas.dev/schema/design.schema.json";

/**
 * Build the JSON Schema for a `DesignFile` as draft 2020-12. Refinements that
 * have no JSON Schema representation (for example the UnknownNode "not a known
 * type" guard) are widened to `any` rather than throwing.
 */
export function getJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(DesignFileSchema, {
    target: "draft-2020-12",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return {
    $id: DESIGN_SCHEMA_ID,
    title: "HyCanvas Design File",
    ...schema,
  };
}
