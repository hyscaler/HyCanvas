// Structural validation gate for the open file format (FR-13). Used by
// persistence, importers, and the public API. Returns the exact
// JSON pointer of the first violation so callers can report it precisely.

import { z } from "zod";
import {
  DesignFileSchema,
  PageSchema,
  GroupNodeSchema,
  FrameNodeSchema,
  GridNodeSchema,
  KNOWN_NODE_SCHEMAS,
  NodeBaseSchema,
  MAX_NESTING_DEPTH,
  type DesignFile,
  type Node,
  type NodeType,
} from "./schema";
import { walkNodes } from "./visitor";

export type ValidationResult =
  | { ok: true }
  | { ok: false; pointer: string; message: string };

/** RFC 6901 JSON-pointer encoding of a path; `~` and `/` are escaped. */
export function pathToPointer(path: Array<string | number>): string {
  if (path.length === 0) return "";
  return (
    "/" +
    path
      .map((seg) => String(seg).replace(/~/g, "~0").replace(/\//g, "~1"))
      .join("/")
  );
}

function firstIssuePointer(
  error: z.ZodError,
  prefix: Array<string | number>,
): { pointer: string; message: string } {
  const issue = error.issues[0];
  const issuePath: Array<string | number> = (issue?.path ?? []).map((seg) =>
    typeof seg === "number" ? seg : String(seg),
  );
  const pointer = pathToPointer([...prefix, ...issuePath]);
  return { pointer, message: issue?.message ?? "invalid value" };
}

// URL-scheme enforcement for untrusted, render-bound strings (Section 10).
// These are semantic checks beyond the structural JSON Schema, like the depth
// and duplicate-id guards: they block script/data-URI injection that would
// otherwise reach the renderer and exporters.

/** The scheme of a URL-like string ("https" from "https://x"), or null. */
function schemeOf(value: string): string | null {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
  return m ? m[1].toLowerCase() : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns an error message if a hyperlink target uses a disallowed scheme. */
function linkTargetError(link: { kind: string; target: unknown }): string | null {
  const { kind, target } = link;
  if (typeof target !== "string" || target.length === 0) {
    return "link target must be a non-empty string";
  }
  const scheme = schemeOf(target);
  switch (kind) {
    case "url":
      return scheme === "http" || scheme === "https"
        ? null
        : "url link must use the http or https scheme";
    case "email":
      if (scheme === null) return EMAIL_RE.test(target) ? null : "invalid email address";
      return scheme === "mailto" ? null : "email link must use the mailto scheme";
    case "page":
      return scheme === null || scheme === "page"
        ? null
        : "page link must be an internal reference";
    case "anchor":
      return scheme === null || scheme === "anchor"
        ? null
        : "anchor link must be an internal reference";
    default:
      return null;
  }
}

/** Returns an error message if an embed src uses a disallowed scheme. */
function embedSrcError(src: unknown): string | null {
  if (typeof src !== "string" || src.length === 0) return null; // unconfigured is fine
  const scheme = schemeOf(src);
  return scheme === null || scheme === "https"
    ? null
    : "embed src must use the https scheme";
}

// Container schemas with children validated shallowly; the recursive walk
// validates each child individually so error pointers stay precise (a malformed
// nested node would otherwise surface as an opaque union error).
const SHALLOW_NODE_SCHEMAS: Partial<Record<NodeType, z.ZodType>> = {
  ...KNOWN_NODE_SCHEMAS,
  group: GroupNodeSchema.extend({ children: z.array(z.unknown()) }),
  frame: FrameNodeSchema.extend({ children: z.array(z.unknown()) }),
  grid: GridNodeSchema.extend({ children: z.array(z.unknown()) }),
};

// File and page fields validated without descending into node children.
const DesignFileShallowSchema = DesignFileSchema.extend({
  pages: z.array(PageSchema.extend({ children: z.array(z.unknown()) })),
});

/**
 * Validate a value as a `DesignFile`. Returns `{ ok: true }` or the JSON pointer
 * and message of the first violation. Unknown (newer-client) node types are
 * accepted as long as their base fields are valid, never silently dropped (FR-3).
 */
export function validate(file: unknown): ValidationResult {
  // 1. File- and page-level shape.
  const shallow = DesignFileShallowSchema.safeParse(file);
  if (!shallow.success) {
    const { pointer, message } = firstIssuePointer(shallow.error, []);
    return { ok: false, pointer, message };
  }

  const design = file as DesignFile;
  const seenIds = new Set<string>();

  // 2. Per-node validation, depth limit, and id uniqueness across all pages.
  for (let p = 0; p < design.pages.length; p++) {
    const base: Array<string | number> = ["pages", p, "children"];
    let failure: ValidationResult | null = null;

    walkNodes(
      design.pages[p].children,
      (node: Node, info) => {
        if (failure) return;

        if (info.depth >= MAX_NESTING_DEPTH) {
          failure = {
            ok: false,
            pointer: pathToPointer(info.path),
            message: `nesting depth exceeds limit of ${MAX_NESTING_DEPTH}`,
          };
          return;
        }

        if (typeof node.id !== "string" || node.id.length === 0) {
          failure = {
            ok: false,
            pointer: pathToPointer([...info.path, "id"]),
            message: "node id must be a non-empty string",
          };
          return;
        }
        if (seenIds.has(node.id)) {
          failure = {
            ok: false,
            pointer: pathToPointer([...info.path, "id"]),
            message: `duplicate node id "${node.id}"`,
          };
          return;
        }
        seenIds.add(node.id);

        // Known-with-schema types use their precise schema; reserved (`model3d`)
        // and newer/unknown types are accepted on their base fields alone (FR-3).
        const schema = SHALLOW_NODE_SCHEMAS[node.type as NodeType] ?? NodeBaseSchema;
        const result = schema.safeParse(node);
        if (!result.success) {
          const { pointer, message } = firstIssuePointer(result.error, info.path);
          failure = { ok: false, pointer, message };
          return;
        }

        // Semantic URL-scheme guards for render-bound, untrusted strings.
        if (node.link) {
          const linkError = linkTargetError(node.link);
          if (linkError) {
            failure = {
              ok: false,
              pointer: pathToPointer([...info.path, "link", "target"]),
              message: linkError,
            };
            return;
          }
        }
        // An interaction's open-link action reuses the ElementLink shape; guard
        // its URL scheme the same way as a node-level hyperlink.
        const action = (node as { interaction?: { action?: { kind?: string; link?: { kind: string; target: unknown } } } }).interaction?.action;
        if (action?.kind === "open-link" && action.link) {
          const linkError = linkTargetError(action.link);
          if (linkError) {
            failure = {
              ok: false,
              pointer: pathToPointer([...info.path, "interaction", "action", "link", "target"]),
              message: linkError,
            };
            return;
          }
        }
        if (node.type === "embed") {
          const srcError = embedSrcError((node as { src?: unknown }).src);
          if (srcError) {
            failure = {
              ok: false,
              pointer: pathToPointer([...info.path, "src"]),
              message: srcError,
            };
          }
        }
      },
      base,
    );

    if (failure) return failure;
  }

  return { ok: true };
}

/** Throwing variant for call sites that prefer exceptions. */
export function assertValid(file: unknown): asserts file is DesignFile {
  const result = validate(file);
  if (!result.ok) {
    throw new Error(`Invalid DesignFile at ${result.pointer || "/"}: ${result.message}`);
  }
}
