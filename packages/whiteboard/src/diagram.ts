// Diagram spec + Mermaid round-trip (doc 30 Phase 3). One normalized shape -
// `DiagramSpec` - connects three surfaces: AI diagram-from-prompt (the model
// emits spec JSON, normalized defensively here), Mermaid IMPORT (paste
// `graph TD; A[Ship] --> B{Test}` into the assistant and it lands as native
// board nodes), and Mermaid EXPORT (a laid-out board flowchart serializes back
// to text for the team's git repo). Pure and dependency-free; the editor
// store materializes a spec into stickies + connectors via layoutFlowchart /
// layoutMindMap.

export interface DiagramNode {
  id: string;
  label: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export interface DiagramSpec {
  kind: "flowchart" | "mindmap";
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  direction?: "down" | "right";
}

const MAX_NODES = 60;
const MAX_EDGES = 120;
const MAX_LABEL = 120;

/**
 * Validate and clamp an untrusted spec (an AI reply or user paste) into a safe
 * DiagramSpec: unique non-empty ids, labels capped, edges only between known
 * distinct nodes, node/edge counts bounded. Null when unusable.
 */
export function normalizeDiagramSpec(raw: unknown): DiagramSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { kind?: unknown; nodes?: unknown; edges?: unknown; direction?: unknown };
  const kind = r.kind === "mindmap" ? "mindmap" : "flowchart";
  if (!Array.isArray(r.nodes) || r.nodes.length === 0) return null;

  const nodes: DiagramNode[] = [];
  const seen = new Set<string>();
  for (const n of r.nodes.slice(0, MAX_NODES)) {
    const o = n as { id?: unknown; label?: unknown };
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = (typeof o.label === "string" && o.label.trim() ? o.label.trim() : id).slice(0, MAX_LABEL);
    nodes.push({ id, label });
  }
  if (!nodes.length) return null;

  const edges: DiagramEdge[] = [];
  if (Array.isArray(r.edges)) {
    for (const e of r.edges.slice(0, MAX_EDGES)) {
      const o = e as { from?: unknown; to?: unknown; label?: unknown };
      const from = typeof o.from === "string" ? o.from.trim() : "";
      const to = typeof o.to === "string" ? o.to.trim() : "";
      if (!from || !to || from === to || !seen.has(from) || !seen.has(to)) continue;
      const label = typeof o.label === "string" && o.label.trim() ? o.label.trim().slice(0, MAX_LABEL) : undefined;
      edges.push({ from, to, ...(label ? { label } : {}) });
    }
  }
  const direction = r.direction === "right" ? "right" : "down";
  return { kind, nodes, edges, direction };
}

// --- Mermaid export ---------------------------------------------------------

/** Mermaid-safe node id (mermaid ids are word-ish tokens). */
function mermaidId(id: string, taken: Map<string, string>): string {
  const cached = taken.get(id);
  if (cached) return cached;
  let m = id.replace(/[^A-Za-z0-9_]/g, "_");
  if (!/^[A-Za-z_]/.test(m)) m = `n_${m}`;
  // De-collide sanitized ids ("a-b" and "a b" both map to a_b).
  let candidate = m;
  let i = 2;
  const used = new Set(taken.values());
  while (used.has(candidate)) candidate = `${m}_${i++}`;
  taken.set(id, candidate);
  return candidate;
}

// Mermaid takes the label inside shape brackets, so a label containing one of
// its closing delimiters (or the edge-label pipe) terminates the token early
// and the line no longer parses - including by our own mermaidToDiagram.
const escLabel = (s: string): string =>
  s
    .replace(/"/g, "'")
    .replace(/\n/g, " ")
    .replace(/[[\]{}()|]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

/** Serialize a spec to Mermaid source (flowchart TD/LR, or a mindmap). */
export function diagramToMermaid(spec: DiagramSpec): string {
  if (spec.kind === "mindmap") {
    // Mermaid mindmap: indentation encodes the tree; the first node is the
    // root and children follow edges (best-effort for non-tree graphs).
    const children = new Map<string, string[]>();
    const hasParent = new Set<string>();
    for (const e of spec.edges) {
      children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
      hasParent.add(e.to);
    }
    const root = spec.nodes.find((n) => !hasParent.has(n.id)) ?? spec.nodes[0];
    const label = new Map(spec.nodes.map((n) => [n.id, n.label]));
    const lines: string[] = ["mindmap"];
    const emit = (id: string, depth: number, seen: Set<string>) => {
      if (seen.has(id)) return; // cycle guard
      seen.add(id);
      // A label that escapes to nothing (e.g. "()") would emit a
      // whitespace-only line, and indentation IS the tree here: everything
      // below it would hang off nothing. Fall back to the node id.
      lines.push(`${"  ".repeat(depth + 1)}${escLabel(label.get(id) ?? id) || id}`);
      for (const c of children.get(id) ?? []) emit(c, depth + 1, seen);
    };
    emit(root.id, 0, new Set());
    return lines.join("\n");
  }

  const dir = spec.direction === "right" ? "LR" : "TD";
  const taken = new Map<string, string>();
  const lines = [`flowchart ${dir}`];
  for (const n of spec.nodes) {
    lines.push(`  ${mermaidId(n.id, taken)}["${escLabel(n.label) || n.id}"]`);
  }
  for (const e of spec.edges) {
    const arrow = e.label ? `-->|${escLabel(e.label)}|` : "-->";
    lines.push(`  ${mermaidId(e.from, taken)} ${arrow} ${mermaidId(e.to, taken)}`);
  }
  return lines.join("\n");
}

// --- Mermaid import ---------------------------------------------------------

// One mermaid flowchart statement edge: A --> B, A -->|label| B, with optional
// inline node labels A[Text] / A(Text) / A{Text} / A((Text)) on either side.
const NODE_RE = String.raw`([A-Za-z0-9_.-]+)\s*(?:[\[({]+\s*"?([^\])}"]*)"?\s*[\])}]+)?`;
const EDGE_RE = new RegExp(String.raw`^\s*${NODE_RE}\s*[-=.]{2,}>\s*(?:\|([^|]*)\|\s*)?${NODE_RE}\s*;?\s*$`);
const LONE_NODE_RE = new RegExp(String.raw`^\s*${NODE_RE}\s*;?\s*$`);

/**
 * Parse basic Mermaid flowchart source (`graph`/`flowchart` with `TD`/`LR`
 * etc., `A[Label] --> B`, edge labels via `-->|label|`) into a DiagramSpec.
 * Null when nothing parseable - the caller falls back to treating the text as
 * a plain AI prompt. Subgraphs/styles/classes are skipped, not fatal.
 */
export function mermaidToDiagram(source: string): DiagramSpec | null {
  const lines = source.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const head = lines[0].match(/^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)?/i);
  if (!head) return null;
  const direction = (head[1] ?? "TD").toUpperCase() === "LR" ? "right" : "down";

  const labels = new Map<string, string>();
  const order: string[] = [];
  const edges: DiagramEdge[] = [];
  const note = (id: string, label?: string) => {
    if (!labels.has(id)) {
      labels.set(id, label?.trim() || id);
      order.push(id);
    } else if (label?.trim()) {
      labels.set(id, label.trim());
    }
  };
  for (const line of lines.slice(1)) {
    if (/^(subgraph|end$|style|classDef|class |linkStyle|click )/i.test(line)) continue;
    const em = line.match(EDGE_RE);
    if (em) {
      const [, aId, aLabel, edgeLabel, bId, bLabel] = em;
      note(aId, aLabel);
      note(bId, bLabel);
      if (aId !== bId) edges.push({ from: aId, to: bId, ...(edgeLabel?.trim() ? { label: edgeLabel.trim() } : {}) });
      continue;
    }
    const nm = line.match(LONE_NODE_RE);
    if (nm && nm[1]) note(nm[1], nm[2]);
  }
  if (!order.length) return null;
  return normalizeDiagramSpec({
    kind: "flowchart",
    direction,
    nodes: order.map((id) => ({ id, label: labels.get(id) ?? id })),
    edges,
  });
}
