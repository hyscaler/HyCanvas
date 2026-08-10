// The graph payload and the evaluator's vocabulary (F40 FR-4).
//
// These mirror the data model in docs/roadmap/40-procedural-node-graph.md. They
// live here rather than in `@hc/schema` for now: F40 Phase 1 is explicitly
// allowed to prototype the shape before promoting it to a typed optional field
// on `NodeBase` with a version bump, and keeping it here means the shape can
// move without touching the file format or the Go mirror.

/** Values a parameter can hold before resolution. */
export type ParamValue =
  | { kind: "literal"; value: unknown }
  | { kind: "param"; name: string }
  | { kind: "expr"; source: string };

export interface GraphOp {
  id: string;
  /** Stable, never-localized catalog id, e.g. "effect.blur". */
  op: string;
  /** Catalog version this op was authored against; part of the cache key. */
  opVersion: number;
  params: Record<string, ParamValue>;
  disabled?: boolean;
  /** User-visible label. The evaluator dispatches on `op`, never on this. */
  label?: string;
  /**
   * Forward compatibility inside the graph, mirroring `UnknownNode.raw`. An op
   * this client does not know is preserved verbatim and passed through on save.
   */
  raw?: Record<string, unknown>;
}

export interface GraphEdge {
  from: { op: string; socket: string };
  to: { op: string; socket: string };
}

export interface ExposedParam {
  name: string;
  label?: string;
  type: "number" | "integer" | "boolean" | "string" | "color" | "enum" | "length";
  default: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  targets: { op: string; param: string }[];
}

export interface GraphLimits {
  maxOps?: number;
  maxInstances?: number;
  maxOutputNodes?: number;
  maxPixels?: number;
  maxMillis?: number;
}

export interface NodeGraph {
  /** Payload format version, independent of CURRENT_SCHEMA_VERSION. */
  version: number;
  ops: GraphOp[];
  edges: GraphEdge[];
  /** Op id whose result is the owning node's rendered content. */
  output: string;
  exposed?: ExposedParam[];
  seed?: number;
  bake?: { hash: string; opCatalogVersion: number; at: string; quality: Quality };
  limits?: GraphLimits;
}

export type Quality = "preview" | "final";

/**
 * Everything outside the graph that a result legitimately depends on, and
 * therefore everything that has to be in the cache key (FR-8). Quality is here
 * because FR-11 requires that a preview result can never be served to an
 * export.
 */
export interface EvalEnv {
  quality: Quality;
  /** Working colour space id, e.g. "srgb". */
  colorSpace: string;
  /** Output resolution class, not exact pixels, so minor zoom changes still hit. */
  resolutionClass: number;
}

export type DiagnosticCode =
  | "cycle"
  | "unknown-op"
  | "missing-input"
  | "unknown-output"
  | "limit-ops"
  | "limit-instances"
  | "limit-output-nodes"
  | "limit-pixels"
  | "limit-time"
  | "op-failed";

/** A problem attached to a specific op, never thrown (FR-9). */
export interface Diagnostic {
  code: DiagnosticCode;
  /** Op the problem belongs to, or undefined when it is graph-wide. */
  opId?: string;
  message: string;
}

/** What an op receives. Deliberately narrow: see the note in catalog.ts. */
export interface OpContext {
  /** Resolved, plain parameter values. */
  params: Record<string, unknown>;
  /** Results of connected inputs, by socket name. */
  inputs: Record<string, unknown>;
  env: EvalEnv;
  /** A deterministic stream for this op; see prng.ts. */
  random(channel?: string, instanceIndex?: number): number;
  /** Report work done, so instance and node bounds can be enforced (FR-10). */
  count(kind: "instances" | "outputNodes" | "pixels", n: number): void;
}

export interface OpDefinition {
  /** Catalog id. */
  op: string;
  /** Bumped when the op's OUTPUT changes for the same inputs; part of the key. */
  version: number;
  /** Input socket names. An unconnected socket is absent from `inputs`. */
  inputs: string[];
  /** Parameter names this op reads. Used to resolve and to hash. */
  params?: string[];
  run(ctx: OpContext): unknown;
}

export interface EvalResult {
  /** Result of the graph's designated output op, or undefined if unevaluable. */
  output: unknown;
  /** Per-op results for the ops that ran or were served from cache. */
  results: Map<string, unknown>;
  diagnostics: Diagnostic[];
  /** Ops that could not be evaluated, and everything downstream of them. */
  unevaluable: Set<string>;
  stats: { evaluated: number; cached: number; skipped: number };
}
