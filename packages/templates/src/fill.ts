// Data merge / fill. Given a design (or
// template) that declares fillable fields, substitute a row of values into a
// COPY of the design: text fields set the text of their node's runs, image
// fields set the node's image source. The source design is never mutated.
//
// Bulk create (one design per dataset row) calls applyFill per row over a fresh
// deep copy; single-design autofill applies one row into a clone. The live-data
// binding, formula engine, and chart/table data sources are deferred (slice a /
// later); this module is the pure variable-data substitution core.

import { childrenOf, type DesignFile, type ImageSource, type Node } from "@hc/schema";
import type { FillableField } from "./types";

type AnyRec = Record<string, unknown>;

/** One field's value in a fill row. A text field uses `text`; an image field
 *  uses `imageUrl` (resolved to an ImageSource on the node). Absent/empty means
 *  "leave the node's existing default". */
export interface FillValue {
  text?: string;
  imageUrl?: string;
}

/** A fill row, keyed by fillable-field `nodeId`. */
export type FillValues = Record<string, FillValue>;

function findNode(file: DesignFile, id: string): Node | null {
  let found: Node | null = null;
  const visit = (n: Node) => {
    if (found) return;
    if (n.id === id) {
      found = n;
      return;
    }
    for (const c of childrenOf(n)) visit(c);
    const rec = n as unknown as AnyRec;
    if (n.type === "mask" && rec.child) visit(rec.child as Node);
    if (n.type === "boolean" && Array.isArray(rec.operands)) for (const op of rec.operands as Node[]) visit(op as Node);
  };
  for (const page of file.pages) for (const root of page.children) visit(root);
  return found;
}

/**
 * Set a text node's copy to `text` (FR-7). Handles two `content` shapes:
 *  - A TextNode's content is `Paragraph[]` (each paragraph has `runs`). The
 *    first run of the first paragraph carries the new text (preserving its
 *    style); further runs/paragraphs are collapsed to a single styled run.
 *  - A TableCell's content is `TextRun[]` directly (no `runs`). The first run
 *    carries the new text (preserving its style); further runs are dropped.
 * Non-text nodes are ignored. Mutates the passed (already-cloned) node.
 */
function fillTextNode(node: Node, text: string): boolean {
  const rec = node as unknown as AnyRec;
  const content = rec.content as AnyRec[] | undefined;
  if (!Array.isArray(content) || content.length === 0) return false;
  const first = content[0];
  // Paragraph shape: content[0] carries a `runs` array.
  if (Array.isArray(first?.runs)) {
    const runs = first.runs as AnyRec[];
    if (runs.length === 0) return false;
    const keepStyle = runs[0].style;
    first.runs = [{ ...runs[0], text, style: keepStyle }];
    // Drop trailing paragraphs so the field reads as a single value.
    rec.content = [first];
    return true;
  }
  // TextRun[] shape (table cell): content itself is the run array.
  if (first && typeof first === "object" && "text" in first) {
    rec.content = [{ ...first, text }];
    return true;
  }
  return false;
}

/**
 * Point an image node (or image-fill carrying node) at `imageUrl` (FR-11). The
 * URL is recorded as the source `assetId` (the engine resolves an assetId to a
 * blob; a URL is a degenerate-but-valid reference and self-hosters can resolve
 * it directly). Natural dimensions are unknown for a bare URL, so they reset to
 * 0 and the renderer falls back to the node's box. Mutates the cloned node.
 */
function fillImageNode(node: Node, imageUrl: string): boolean {
  const rec = node as unknown as AnyRec;
  const nextSource: ImageSource = { assetId: imageUrl, naturalWidth: 0, naturalHeight: 0 };
  if (node.type === "image") {
    rec.source = nextSource;
    delete rec.crop; // a new source invalidates the old normalized crop
    return true;
  }
  // A frame/shape with an image fill: replace the first image fill's source.
  const fills = rec.fills as AnyRec[] | undefined;
  if (Array.isArray(fills)) {
    for (const f of fills) {
      if (f?.type === "image") {
        f.source = nextSource;
        delete f.crop;
        return true;
      }
    }
  }
  return false;
}

export interface ApplyFillResult {
  /** The filled design (a deep clone; the input is never mutated). */
  file: DesignFile;
  /** Field node ids that received a value. */
  filled: string[];
  /** Field node ids whose value was provided but whose node was missing. */
  missing: string[];
}

/**
 * Substitute a row of values into a COPY of `file` (FR-8, FR-9). Each entry is
 * keyed by a fillable field's `nodeId`: a `text` value sets the node's text, an
 * `imageUrl` sets its image source. Fields with no value (or an empty string)
 * keep the design's existing default. The source design is never mutated; ids
 * are preserved (a single autofill stays the same design). Pure.
 *
 * Bulk create deep-copies (fresh ids) first, then applies a row's values to the
 * copy; pass the already-copied file here so this stays a focused substitution.
 */
export function applyFill(file: DesignFile, values: FillValues): ApplyFillResult {
  const clone: DesignFile = JSON.parse(JSON.stringify(file));
  const filled: string[] = [];
  const missing: string[] = [];

  for (const [nodeId, value] of Object.entries(values)) {
    if (!value) continue;
    const hasText = typeof value.text === "string" && value.text.length > 0;
    const hasImage = typeof value.imageUrl === "string" && value.imageUrl.length > 0;
    if (!hasText && !hasImage) continue; // no value: leave default

    const node = findNode(clone, nodeId);
    if (!node) {
      missing.push(nodeId);
      continue;
    }
    let applied = false;
    if (hasText) applied = fillTextNode(node, value.text!) || applied;
    if (hasImage) applied = fillImageNode(node, value.imageUrl!) || applied;
    if (applied) filled.push(nodeId);
    else missing.push(nodeId);
  }

  return { file: clone, filled, missing };
}

/**
 * Validate a whole fill row against the fields' constraints (FR-8 mapping
 * validation). Returns the first problem found, or ok. Image aspect/required
 * presence beyond a non-empty URL is not knowable here (dimensions are fetched
 * at ingest), so only text constraints and required-presence are enforced.
 */
export function validateFillRow(
  fields: FillableField[],
  values: FillValues,
): { ok: boolean; reason?: string } {
  for (const field of fields) {
    const v = values[field.nodeId];
    const c = field.constraints;
    const present =
      !!v && ((typeof v.text === "string" && v.text.length > 0) || (typeof v.imageUrl === "string" && v.imageUrl.length > 0));
    if (c?.required && !present) return { ok: false, reason: `${field.label} is required` };
    if (field.kind === "text" && c?.maxChars !== undefined && v?.text && v.text.length > c.maxChars) {
      return { ok: false, reason: `${field.label} exceeds ${c.maxChars} characters` };
    }
  }
  return { ok: true };
}
