// Fillable fields. A template author marks nodes as editable
// placeholders with hints and constraints; downstream consumers (and bulk
// create) fill them, validated against the constraints. A field whose
// node no longer exists is dropped with a warning (Section 9).

import { childrenOf, type DesignFile, type Node } from "@hc/schema";
import type { FillableField } from "./types";

type AnyRec = Record<string, unknown>;

function findNode(file: DesignFile, id: string): Node | null {
  let found: Node | null = null;
  const visit = (n: Node) => {
    if (found) return;
    if (n.id === id) { found = n; return; }
    for (const c of childrenOf(n)) visit(c);
    const rec = n as unknown as AnyRec;
    if (n.type === "mask" && rec.child) visit(rec.child as Node);
    if (n.type === "boolean" && Array.isArray(rec.operands)) for (const op of rec.operands as Node[]) visit(op);
  };
  for (const page of file.pages) for (const root of page.children) visit(root);
  return found;
}

export interface FieldSpec {
  nodeId: string;
  label: string;
  hint?: string;
  constraints?: FillableField["constraints"];
}

export interface ExtractFieldsResult {
  fields: FillableField[];
  /** node ids requested but not found (dropped). */
  dropped: string[];
}

const KIND_FOR: Record<string, FillableField["kind"]> = {
  text: "text",
  image: "image",
  shape: "color",
  frame: "image",
};

/** Build fillable-field definitions for the given node specs (FR-10). */
export function extractFillableFields(file: DesignFile, specs: FieldSpec[]): ExtractFieldsResult {
  const fields: FillableField[] = [];
  const dropped: string[] = [];
  for (const spec of specs) {
    const node = findNode(file, spec.nodeId);
    if (!node) {
      dropped.push(spec.nodeId);
      continue;
    }
    fields.push({
      nodeId: spec.nodeId,
      kind: KIND_FOR[node.type] ?? "text",
      label: spec.label,
      hint: spec.hint,
      constraints: spec.constraints,
    });
  }
  return { fields, dropped };
}

export interface FillValidation {
  ok: boolean;
  reason?: string;
}

/** Validate a value against a fillable field's constraints (fill time, FR-10). */
export function validateFill(field: FillableField, value: { text?: string; aspect?: number; present?: boolean }): FillValidation {
  const c = field.constraints;
  if (c?.required && value.present === false) return { ok: false, reason: `${field.label} is required` };
  if (field.kind === "text" && c?.maxChars !== undefined && value.text !== undefined && value.text.length > c.maxChars) {
    return { ok: false, reason: `${field.label} exceeds ${c.maxChars} characters` };
  }
  if (field.kind === "image" && c?.aspect !== undefined && value.aspect !== undefined) {
    const tol = 0.02;
    if (Math.abs(value.aspect - c.aspect) > tol) return { ok: false, reason: `${field.label} aspect must be ~${c.aspect}` };
  }
  return { ok: true };
}
