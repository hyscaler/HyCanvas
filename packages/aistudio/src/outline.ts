// F39 Phase 2 - multi-page generation (outline-first). The model returns an
// editable DesignOutline (per-page title + key points + a visual role); the user
// can edit it; then each OutlineItem expands deterministically into an
// AiDesignSpec laid out by the Phase 1 engine. No page positions come from the
// model - only content and intent - so a whole deck shares one visual system.

import { deckLooks, isDeckLook, type DeckLook } from "./look";
import type { AiDesignSpec, BlockRole, DesignBackground, DesignLayout } from "./spec";

/** What kind of multi-page artifact we are generating. Drives length + arc. */
export type DesignType = "deck" | "doc" | "social-set" | "poster";
export const designTypes: DesignType[] = ["deck", "doc", "social-set", "poster"];

/** The narrative/visual role of a page; maps to a layout + emphasis. */
export type VisualRole =
  | "cover"
  | "agenda"
  | "content"
  | "comparison"
  | "quote"
  | "data"
  | "closing";
export const visualRoles: VisualRole[] = ["cover", "agenda", "content", "comparison", "quote", "data", "closing"];

/** A slide's compositional form, chosen by the model while planning the story.
 *  Mirrors `archetypes` in backend/internal/aistudio/specs.go; change together. */
export type Archetype =
  | "cover"
  | "agenda"
  | "section"
  | "statement"
  | "bigNumber"
  | "bullets"
  | "twoColumn"
  | "threeUp"
  | "process"
  | "quote"
  | "imageCaption"
  | "chart"
  | "closing"
  | "kpiGrid"
  | "timeline"
  | "table"
  | "composition"
  | "team";
export const archetypes: Archetype[] = [
  "cover", "agenda", "section", "statement", "bigNumber", "bullets", "twoColumn",
  "threeUp", "process", "quote", "imageCaption", "chart", "closing",
  "kpiGrid", "timeline", "table", "team", "composition",
];

/** The default form for a page that named only a visual role: every page from
 *  a client or model that predates archetypes. */
export const archetypeForRole: Record<VisualRole, Archetype> = {
  cover: "cover", agenda: "agenda", content: "bullets", comparison: "twoColumn",
  quote: "quote", data: "bigNumber", closing: "closing",
};

/** Keeps visualRole populated for readers that still key on it (page
 *  treatment, older layout preference tables). */
export const roleForArchetype: Record<Archetype, VisualRole> = {
  cover: "cover", agenda: "agenda", section: "content", statement: "content",
  bigNumber: "data", bullets: "content", twoColumn: "comparison", threeUp: "content",
  process: "content", quote: "quote", imageCaption: "content", chart: "data", closing: "closing",
  kpiGrid: "data", timeline: "content", table: "data", team: "content", composition: "content",
};

/** `icon` is one English keyword naming a simple icon for the figure. */
export interface Stat { value: string; unit?: string; label: string; icon?: string }
export interface Quote { text: string; attribution?: string }
/** `when` is a short time marker ("2019", "Q3", "Week 2") for a timeline;
 *  `icon` one English keyword naming a simple icon for the step. */
export interface Step { label: string; detail?: string; when?: string; icon?: string }
/** `icon` is one English keyword naming a simple icon for the column
 *  ("shield", "clock"); the composer matches it against its icon set. */
export interface Column { heading: string; points: string[]; icon?: string }
/** One member of a team slide. Names and roles only: the composer sets a
 *  monogram, never a generated portrait of a named person. */
export interface Person { name: string; role?: string }
/** A small table with real values: a header row and up to a handful of
 *  rows, every row as long as the header. */
export interface TableData { columns: string[]; rows: string[][] }
export type ImageTreatment = "photo" | "illustration" | "abstract";
/** `illustration` is one English keyword naming a drawing from the deck's
 *  illustration set ("growth", "handshake", "security"); when the set knows
 *  it, the composer draws it in place of the picture and no image is
 *  generated for that region. */
export interface ImageIntent { subject: string; treatment: ImageTreatment; illustration?: string }
/** A cell of a bespoke page: content the model places on a 12-column by
 *  6-row grid when no catalog form fits (a diagram, a comparison built from
 *  shapes, a page that is one typographic gesture). The composer keeps the
 *  grid honest: a cell is clamped to it, a cell that overlaps an earlier one
 *  is dropped, and a link between two cells is drawn as an arrow. */
export type CompositionKind = "heading" | "body" | "list" | "figure" | "label" | "icon" | "picture";
export type CompositionTone = "plain" | "tint" | "accent" | "deep";
export interface CompositionCell { col: number; span: number; row: number; rows: number; kind: CompositionKind; text?: string; points?: string[]; value?: string; unit?: string; icon?: string; tone?: CompositionTone }
export interface Composition { cells: CompositionCell[]; links?: [number, number][] }
export const compositionKinds: CompositionKind[] = ["heading", "body", "list", "figure", "label", "icon", "picture"];
export const compositionTones: CompositionTone[] = ["plain", "tint", "accent", "deep"];
export type ChartKind = "bar" | "line" | "pie" | "donut";
export interface ChartData { kind: ChartKind; categories: string[]; series: { name: string; values: number[] }[] }

/** Content budgets in characters. The composer sizes type from slot geometry
 *  and steps down a ladder when copy runs long; these caps are where "runs
 *  long" stops being the composer's problem and becomes the writer's. Mirrored
 *  as constants in specs.go. */
export const archetypeBudgets = {
  title: 60, subhead: 120, statement: 90, point: 90, points: 5,
  statValue: 12, statUnit: 8, statLabel: 60, quote: 200, attribution: 60,
  steps: 5, stepLabel: 30, stepDetail: 90, columns: 3, columnHeading: 40, columnPoints: 4,
  imageSubject: 140, chartCategories: 12, chartSeries: 4,
  stats: 4, tableColumns: 5, tableRows: 8, tableCell: 60, people: 4, personName: 40, personRole: 40, stepWhen: 20, columnIcon: 30,
  eyebrow: 24,
  // The kit's voice and vocabulary fields (kit/): the deck's style, kicker
  // and farewell, a page's aside, drawing, signature form and pairs.
  style: 24, organization: 60, kicker: 40, farewell: 32, aside: 60, drawing: 30, signature: 20, pairs: 8, pairLabel: 40, pairValue: 24,
  compositionCells: 8, compositionText: 140, compositionPoints: 4, compositionPoint: 70, compositionLinks: 8,
} as const;

/** A label and its value, for the kit's signature forms (a ledger line, a
 *  poll bar, a health tile) and for a kpiGrid's deltas. */
export interface Pair { label: string; value: string }

/** The kit's signature forms a page may name; at most one page per deck
 *  gets its form. Mirrored in specs.go and in kit/signature.ts. */
export const outlineSignatures = ["scoreboard", "beforeAfter", "funnel", "ledger", "stickyWall", "matrix", "runOfShow", "poll", "definition", "healthGrid"] as const;

export interface OutlineItem {
  id: string;
  title: string;
  points: string[];
  visualRole: VisualRole;
  /** Speaker note for the page: 1-3 spoken-style sentences, plain text (no
   *  markup), adding presenter context and delivery cues - never a restatement
   *  of the slide text. Optional so older replies still normalize. */
  note?: string;
  /** The compositional form. Always set after normalizeOutline; optional on
   *  the type so literals from older code still compile. */
  archetype?: Archetype;
  subhead?: string;
  stat?: Stat;
  quote?: Quote;
  steps?: Step[];
  columns?: Column[];
  image?: ImageIntent;
  chart?: ChartData;
  /** Phase 7 forms (additive): several figures that belong together, a
   *  small data table, and the people on a team; a dated sequence reuses
   *  `steps` with `when` set. */
  stats?: Stat[];
  table?: TableData;
  people?: Person[];
  /** A bespoke page: cells on a grid with optional arrows; only for the
   *  composition form. */
  composition?: Composition;
  /** One English keyword naming a simple icon for the page: bullets and
   *  statements show it beside the title, a big number above the figure,
   *  covers, sections and closings inside their decor. */
  icon?: string;
  /** Two or three words saying what the page is about ("The problem",
   *  "Traction", "The ask"), set small and tracked above the title. */
  eyebrow?: string;
  /** A hand-written remark in the presenter's voice, set in the deck's
   *  accent face beside the content; never a restatement of the slide. */
  aside?: string;
  /** One keyword naming a full-colour drawing from the kit's pack, placed
   *  in a halo beside the page's copy. */
  drawing?: string;
  /** The kit's signature form for this page, when the deck gives it one. */
  signature?: string;
  /** Labels and values for the signature forms and for kpiGrid deltas. */
  pairs?: Pair[];
}

/** Hard cap on a speaker note; the prompt asks for 100..500 chars and the
 *  normalizer truncates defensively rather than failing the outline. */
export const maxNoteChars = 500;

export interface DesignOutline {
  title: string;
  /** A short theme phrase (mood/topic) used to ground per-page styling. */
  theme: string;
  pages: OutlineItem[];
  /** The house style the model named for the whole deck; a dial or an API
   *  field overrides it, and a catalog style stands in when absent. */
  look?: DeckLook;
  /** The kit style the deck is set in (kit/looks.ts); unknown or absent
   *  names fall back to one chosen by the title. */
  style?: string;
  /** The deck's voice: where it comes from, the line that opens the cover
   *  and the statements, and the closing's first line. */
  organization?: string;
  kicker?: string;
  farewell?: string;
}

/** A coherent visual system shared by every page in one generated design. */
export interface DeckTheme {
  background: DesignBackground;
  /** Optional eyebrow/kicker shown on content pages (e.g. the deck title). */
  kicker?: string;
  /** Brand fonts applied to every page (FR-17). */
  fontHeading?: string;
  fontBody?: string;
}

export interface GenerationRequest {
  designType: DesignType;
  prompt: string;
  /** Brand palette hexes to ground styling (optional). */
  brandPalette?: string[];
  /** How many pages to aim for; the model may adjust within reason. */
  pageCount?: number;
}

// --- Validation ------------------------------------------------------------

export class OutlineError extends Error {}

let idSeq = 0;
/** Deterministic id (no Math.random, which is unavailable in some sandboxes and
 *  breaks reproducibility); unique within a normalize pass. */
function nextId(): string {
  idSeq += 1;
  return `ol-${idSeq}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Normalize a speaker note to plain single-paragraph text: collapse whitespace
 *  runs (the note is spoken, not formatted) and cap the length at a sentence
 *  boundary where one exists, mid-word truncation only as a last resort. */
export function normalizeNote(v: unknown): string {
  // Whitespace class: JS \s plus U+0085 NEL, i.e. the union of JS \s and Go's
  // unicode.IsSpace - the Go mirror collapses the same union (IsSpace plus
  // U+FEFF), so both sides flatten identically.
  const flat = str(v).replace(/[\s\u0085]+/g, " ").trim(); // trim AFTER collapsing: an edge NEL leaves an ASCII space str() could not see
  // Fast path: UTF-16 length is >= the code-point count, so an under-cap
  // UTF-16 length can never hide an over-cap note.
  if (flat.length <= maxNoteChars) return flat;
  // Measure and cut in CODE POINTS (never splitting a surrogate pair), exactly
  // like the Go mirror's rune handling, so server- and client-normalized notes
  // agree on multibyte text. Slicing at sentenceEnd+1 is still safe because the
  // sentence separators are ASCII.
  const chars = Array.from(flat);
  if (chars.length <= maxNoteChars) return flat;
  const cut = chars.slice(0, maxNoteChars).join("");
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return sentenceEnd >= 0 && Array.from(cut.slice(0, sentenceEnd)).length > maxNoteChars / 2 ? cut.slice(0, sentenceEnd + 1) : cut;
}

/** Clip to a budget on a word boundary where one falls in the back 40%, so a
 *  long field becomes a phrase rather than a syllable. Counts code points, as
 *  the Go mirror does. */
/** Words a clipped phrase must not end on: a cut that leaves "What is
 *  working vs." reads as a mistake where "What is working" reads as a label.
 *  Mirrored in specs.go. */
const danglingWords = new Set(["and", "or", "of", "to", "with", "for", "the", "a", "an", "in", "on", "at", "by", "from", "than", "vs", "vs.", "&", "but", "as", "into", "over", "per", "via"]);

export function clipToBudget(v: unknown, max: number): string {
  const t = str(v);
  const chars = Array.from(t);
  if (chars.length <= max) return t;
  let cut = chars.slice(0, max).join("");
  const space = cut.lastIndexOf(" ");
  if (space > max * 0.6) cut = cut.slice(0, space);
  cut = cut.replace(/[\s,;:-]+$/u, "");
  // Drop a trailing connective, and the punctuation it leaves behind, until
  // the phrase ends on a word that can end a phrase.
  for (;;) {
    const at = cut.lastIndexOf(" ");
    const last = (at >= 0 ? cut.slice(at + 1) : cut).toLowerCase();
    if (at < 0 || !danglingWords.has(last)) break;
    cut = cut.slice(0, at).replace(/[\s,;:-]+$/u, "");
  }
  return cut;
}

function strList(v: unknown, maxItems: number, maxChars: number): string[] {
  return (Array.isArray(v) ? v : []).map((x) => clipToBudget(x, maxChars)).filter(Boolean).slice(0, maxItems);
}

/** Read and clip the typed archetype payloads, dropping any that arrive empty,
 *  then downgrade an archetype whose payload did not survive to a form its
 *  content can support: no stat means no big number. Mirrors
 *  normalizeArchetypeFields in specs.go. */
/** A stat value as the bare figure: a model sometimes writes the direction
 *  into it ("↓67%", "▲ 3.2M"); the label carries direction, and an arrow set
 *  at display scale rises into the rule above the figure. Mirrored in
 *  specs.go. */
export function bareFigure(v: unknown): string {
  // The trailing run may only start where no arrow or space precedes it, so a
  // long run is scanned once, not once per character (CodeQL
  // js/polynomial-redos).
  return clipToBudget(v, archetypeBudgets.statValue).replace(/^[\s\u2190-\u21FF\u25B2-\u25BF\u2B05-\u2B0D]+|(?<![\s\u2190-\u21FF\u25B2-\u25BF\u2B05-\u2B0D])[\s\u2190-\u21FF\u25B2-\u25BF\u2B05-\u2B0D]+$/g, "").trim();
}

/** A figure is one token, so it can never wrap inside the numeral. A word
 *  the model left in the value ("48 hrs", "$1.8 million", "310k /mo") moves
 *  to the unit, and a unit the model also gave wins over that word ("48 hrs"
 *  plus "hours" is "48 hours", not "48 hrs hours"). Only a value whose first
 *  token carries a digit is split, so "Top 10" stays whole. Mirrored in
 *  specs.go. */
export function splitFigure(value: unknown, unit: unknown): { value: string; unit: string } {
  // Every run of whitespace becomes one plain space first, so the Go mirror
  // (whose \s is ASCII only) and this one split the same values.
  const v = bareFigure(value).split(/\s+/u).join(" ");
  let u = clipToBudget(unit, archetypeBudgets.statUnit);
  const m = /^(\S*\d\S*)\s+(\S[^\d]*)$/u.exec(v);
  if (!m) return { value: v, unit: u };
  if (!u) u = clipToBudget(m[2], archetypeBudgets.statUnit);
  return { value: m[1], unit: u };
}

/** A headline never carries a dash as a separator; the house style has none,
 *  and a colon says the same thing. Mirrored in specs.go. */
export function undashTitle(title: string): string {
  // The space run before a dash may only start where no space precedes it,
  // so a run without a dash is scanned once (CodeQL js/polynomial-redos).
  return title.replace(/(?<!\s)\s+[\u2013\u2014-]\s+/g, ": ");
}

/** An icon keyword, lower-cased and clipped; empty when there is none. */
function iconKeyword(v: unknown): string {
  return clipToBudget(v, archetypeBudgets.columnIcon).toLowerCase();
}

function normalizeArchetypeFields(p: Record<string, unknown>, archetype: Archetype, points: string[]): Partial<OutlineItem> & { archetype: Archetype } {
  const b = archetypeBudgets;
  const out: Partial<OutlineItem> & { archetype: Archetype } = { archetype };
  const pageIcon = iconKeyword(p.icon);
  if (pageIcon) out.icon = pageIcon;
  const subhead = clipToBudget(p.subhead, b.subhead);
  if (subhead) out.subhead = subhead;
  const eyebrow = clipToBudget(p.eyebrow, b.eyebrow);
  if (eyebrow) out.eyebrow = eyebrow;

  const st = p.stat as Record<string, unknown> | undefined;
  if (st && typeof st === "object") {
    const { value, unit } = splitFigure(st.value, st.unit);
    if (value) {
      const icon = iconKeyword(st.icon);
      out.stat = { value, label: clipToBudget(st.label, b.statLabel), ...(unit ? { unit } : {}), ...(icon ? { icon } : {}) };
    }
  }
  const q = p.quote as Record<string, unknown> | undefined;
  if (q && typeof q === "object") {
    const text = clipToBudget(q.text, b.quote);
    if (text) {
      const attribution = clipToBudget(q.attribution, b.attribution);
      out.quote = { text, ...(attribution ? { attribution } : {}) };
    }
  }
  const steps = (Array.isArray(p.steps) ? p.steps : [])
    .map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const label = clipToBudget(r.label, b.stepLabel);
      const detail = clipToBudget(r.detail, b.stepDetail);
      const when = clipToBudget(r.when, b.stepWhen);
      const icon = iconKeyword(r.icon);
      return label ? { label, ...(detail ? { detail } : {}), ...(when ? { when } : {}), ...(icon ? { icon } : {}) } : null;
    })
    .filter((x): x is Step => !!x)
    .slice(0, b.steps);
  if (steps.length) out.steps = steps;
  const columns = (Array.isArray(p.columns) ? p.columns : [])
    .map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const heading = clipToBudget(r.heading, b.columnHeading);
      const pts = strList(r.points, b.columnPoints, b.point);
      const icon = iconKeyword(r.icon);
      return heading || pts.length ? { heading, points: pts, ...(icon ? { icon } : {}) } : null;
    })
    .filter((x): x is Column => !!x)
    .slice(0, b.columns);
  if (columns.length) out.columns = columns;
  const im = p.image as Record<string, unknown> | undefined;
  if (im && typeof im === "object") {
    const subject = clipToBudget(im.subject, b.imageSubject);
    if (subject) {
      const t = im.treatment;
      const illustration = iconKeyword(im.illustration);
      out.image = { subject, treatment: t === "illustration" || t === "abstract" ? t : "photo", ...(illustration ? { illustration } : {}) };
    }
  }
  const ch = p.chart as Record<string, unknown> | undefined;
  if (ch && typeof ch === "object") {
    const categories = strList(ch.categories, b.chartCategories, 40);
    const k = ch.kind;
    const kind: ChartKind = k === "line" || k === "pie" || k === "donut" ? k : "bar";
    const series = (Array.isArray(ch.series) ? ch.series : [])
      .map((x) => {
        const r = (x ?? {}) as Record<string, unknown>;
        const values = (Array.isArray(r.values) ? r.values : []).filter((n): n is number => typeof n === "number" && Number.isFinite(n)).slice(0, categories.length);
        return values.length ? { name: str(r.name), values } : null;
      })
      .filter((x): x is { name: string; values: number[] } => !!x)
      .slice(0, b.chartSeries);
    if (categories.length && series.length) out.chart = { kind, categories, series };
  }

  const stats = (Array.isArray(p.stats) ? p.stats : [])
    .map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const { value, unit } = splitFigure(r.value, r.unit);
      if (!value) return null;
      const icon = iconKeyword(r.icon);
      return { value, label: clipToBudget(r.label, b.statLabel), ...(unit ? { unit } : {}), ...(icon ? { icon } : {}) } as Stat;
    })
    .filter((x): x is Stat => !!x)
    .slice(0, b.stats);
  if (stats.length) out.stats = stats;
  const tb = p.table as Record<string, unknown> | undefined;
  if (tb && typeof tb === "object") {
    const columns = (Array.isArray(tb.columns) ? tb.columns : []).map((c) => clipToBudget(c, b.tableCell)).slice(0, b.tableColumns);
    // Every row is exactly as long as the header: extra cells are dropped,
    // missing ones are blank, an empty row is not a row.
    const rows = (Array.isArray(tb.rows) ? tb.rows : [])
      .map((r) => columns.map((_, i) => clipToBudget(Array.isArray(r) ? r[i] : undefined, b.tableCell)))
      .filter((r) => r.some((c) => c !== ""))
      .slice(0, b.tableRows);
    if (columns.length && rows.length) out.table = { columns, rows };
  }
  const people = (Array.isArray(p.people) ? p.people : [])
    .map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const name = clipToBudget(r.name, b.personName);
      const role = clipToBudget(r.role, b.personRole);
      return name ? ({ name, ...(role ? { role } : {}) } as Person) : null;
    })
    .filter((x): x is Person => !!x)
    .slice(0, b.people);
  if (people.length) out.people = people;
  const comp = p.composition as Record<string, unknown> | undefined;
  if (comp && typeof comp === "object") {
    const composition = normalizeComposition(comp, b);
    if (composition) out.composition = composition;
  }

  // Downgrade an archetype whose payload did not survive.
  switch (archetype) {
    case "bigNumber": if (!out.stat) out.archetype = "bullets"; break;
    case "kpiGrid":
      // One figure is a bigNumber; none is a list.
      if (!out.stats) out.archetype = "bullets";
      else if (out.stats.length === 1) { out.stat = out.stats[0]; out.archetype = "bigNumber"; }
      break;
    case "timeline": if ((out.steps?.length ?? 0) < 2) out.archetype = "bullets"; break;
    case "table": if (!out.table) out.archetype = "bullets"; break;
    case "team": if (!out.people) out.archetype = "bullets"; break;
    case "quote":
      if (!out.quote) {
        if (points[0]) out.quote = { text: clipToBudget(points[0], b.quote) };
        else out.archetype = "statement";
      }
      break;
    case "process": if ((out.steps?.length ?? 0) < 2) out.archetype = "bullets"; break;
    case "twoColumn":
    case "threeUp": if ((out.columns?.length ?? 0) < 2) out.archetype = "bullets"; break;
    case "imageCaption": if (!out.image) out.archetype = "statement"; break;
    case "chart": if (!out.chart) out.archetype = "bullets"; break;
    case "composition": if (!out.composition) out.archetype = "bullets"; break;
  }
  return out;
}

const GRID_COLS = 12;
const GRID_ROWS = 6;

/** Clamp every cell to the grid, drop what has no content for its kind or
 *  overlaps an earlier cell, and keep only links whose both ends survived.
 *  Mirrored in specs.go. */
export function normalizeComposition(raw: Record<string, unknown>, b: typeof archetypeBudgets): Composition | null {
  const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => {
    const n = typeof v === "number" ? Math.round(v) : typeof v === "string" ? Math.round(Number(v)) : NaN;
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const kept: CompositionCell[] = [];
  const keptIndex = new Map<number, number>();
  const rawCells = Array.isArray(raw.cells) ? raw.cells : [];
  rawCells.forEach((x, i) => {
    if (kept.length >= b.compositionCells) return;
    const r = (x ?? {}) as Record<string, unknown>;
    const kind = str(r.kind) as CompositionKind;
    if (!compositionKinds.includes(kind)) return;
    const col = clampInt(r.col, 0, GRID_COLS - 1, 0);
    const span = clampInt(r.span, 1, GRID_COLS - col, GRID_COLS - col);
    const row = clampInt(r.row, 0, GRID_ROWS - 1, 0);
    const rows = clampInt(r.rows, 1, GRID_ROWS - row, 1);
    const text = clipToBudget(r.text, b.compositionText);
    const points = strList(r.points, b.compositionPoints, b.compositionPoint);
    const fig = splitFigure(r.value, r.unit);
    const icon = iconKeyword(r.icon);
    const toneRaw = str(r.tone) as CompositionTone;
    const tone = compositionTones.includes(toneRaw) && toneRaw !== "plain" ? toneRaw : undefined;
    // A cell must carry what its kind shows.
    if ((kind === "heading" || kind === "body" || kind === "label") && !text) return;
    if (kind === "list" && !points.length) return;
    if (kind === "figure" && !fig.value) return;
    if (kind === "icon" && !icon) return;
    // A cell that overlaps one already placed is dropped; the grid stays honest.
    const clash = kept.some((k) => col < k.col + k.span && col + span > k.col && row < k.row + k.rows && row + rows > k.row);
    if (clash) return;
    keptIndex.set(i, kept.length);
    kept.push({
      col, span, row, rows, kind,
      ...(text ? { text } : {}),
      ...(points.length ? { points } : {}),
      ...(fig.value ? { value: fig.value } : {}),
      ...(fig.unit ? { unit: fig.unit } : {}),
      ...(icon ? { icon } : {}),
      ...(tone ? { tone } : {}),
    });
  });
  if (!kept.length) return null;
  const links: [number, number][] = [];
  for (const l of Array.isArray(raw.links) ? raw.links : []) {
    if (links.length >= b.compositionLinks) break;
    if (!Array.isArray(l) || l.length < 2) continue;
    const a = keptIndex.get(clampInt(l[0], 0, 1e6, -1));
    const c = keptIndex.get(clampInt(l[1], 0, 1e6, -1));
    if (a === undefined || c === undefined || a === c) continue;
    if (links.some(([x, y]) => x === a && y === c)) continue;
    links.push([a, c]);
  }
  return { cells: kept, ...(links.length ? { links } : {}) };
}

/** Validate + normalize a parsed model value into a DesignOutline. Drops empty
 *  pages, derives archetype and role from each other, clips every field to its
 *  budget, and throws when nothing usable remains. */
export function normalizeOutline(parsed: unknown): DesignOutline {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OutlineError("The AI response wasn't a valid outline.");
  }
  const root = parsed as Record<string, unknown>;
  const title = str(root.title) || "Untitled";
  const theme = str(root.theme);
  const look = isDeckLook(root.look) ? root.look : undefined;
  const style = iconKeyword(root.style).slice(0, archetypeBudgets.style);
  const organization = clipToBudget(root.organization, archetypeBudgets.organization);
  const kicker = clipToBudget(root.kicker, archetypeBudgets.kicker);
  const farewell = clipToBudget(root.farewell, archetypeBudgets.farewell);
  const rawPages = Array.isArray(root.pages) ? root.pages : [];
  const pages: OutlineItem[] = [];
  for (const item of rawPages) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const pTitle = str(p.title);
    const points = strList(p.points, archetypeBudgets.points, archetypeBudgets.point);
    // A page with a typed payload but no title or points is still a page: a
    // big number needs neither.
    const hasPayload = !!(p.stat || p.quote || p.steps || p.columns || p.image || p.chart);
    if (!pTitle && !points.length && !hasPayload) continue;
    // Archetype and role are two views of one decision; fill in whichever the
    // reply left out.
    const namedArch = archetypes.includes(p.archetype as Archetype) ? (p.archetype as Archetype) : undefined;
    const namedRole = visualRoles.includes(p.visualRole as VisualRole) ? (p.visualRole as VisualRole) : undefined;
    const archetype0: Archetype = namedArch ?? (namedRole ? archetypeForRole[namedRole] : "bullets");
    const typed = normalizeArchetypeFields(p, archetype0, points);
    // A downgrade changes the form, never a role the reply named: an old-style
    // comparison page keeps its role and the layout it always had.
    const visualRole = namedRole ?? roleForArchetype[typed.archetype];
    const note = normalizeNote(p.note);
    const titleMax = typed.archetype === "statement" ? archetypeBudgets.statement : archetypeBudgets.title;
    const aside = clipToBudget(p.aside, archetypeBudgets.aside);
    const drawing = iconKeyword(p.drawing);
    const signature = (outlineSignatures as readonly string[]).includes(str(p.signature)) ? str(p.signature) : "";
    const pairs = Array.isArray(p.pairs)
      ? (p.pairs as unknown[]).slice(0, archetypeBudgets.pairs).map((v) => {
          const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
          return { label: clipToBudget(o.label, archetypeBudgets.pairLabel), value: clipToBudget(o.value, archetypeBudgets.pairValue) };
        }).filter((pr) => pr.label && pr.value)
      : [];
    pages.push({
      id: nextId(),
      title: undashTitle(clipToBudget(pTitle, titleMax)) || "Untitled",
      points,
      visualRole,
      ...(note ? { note } : {}),
      ...typed,
      ...(aside ? { aside } : {}),
      ...(drawing ? { drawing } : {}),
      ...(signature ? { signature } : {}),
      ...(pairs.length ? { pairs } : {}),
    });
  }
  if (!pages.length) {
    throw new OutlineError("The AI didn't return any pages. Try a more specific prompt.");
  }
  return { title, theme, pages, ...(look ? { look } : {}), ...(style ? { style } : {}), ...(organization ? { organization } : {}), ...(kicker ? { kicker } : {}), ...(farewell ? { farewell } : {}) };
}

/** JSON Schema for a DesignOutline, embedded in the generation prompt. */
export const outlineJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "pages"],
  properties: {
    title: { type: "string" },
    theme: { type: "string", description: "short mood/topic phrase" },
    look: { type: "string", enum: deckLooks, description: "the deck's house style: editorial, bold, technical or classic" },
    style: { type: "string", maxLength: archetypeBudgets.style, description: "the deck's visual system, one of the named styles" },
    organization: { type: "string", maxLength: archetypeBudgets.organization, description: "the company, team or event the deck comes from, when the brief names it" },
    kicker: { type: "string", maxLength: archetypeBudgets.kicker, description: "a short line in the deck's own voice that opens the cover and the statement pages" },
    farewell: { type: "string", maxLength: archetypeBudgets.farewell, description: "the closing's first line" },
    pages: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "archetype", "note"],
        properties: {
          title: { type: "string", maxLength: archetypeBudgets.title, description: "the slide heading; for a statement slide, the whole statement (max 14 words)" },
          archetype: { type: "string", enum: archetypes, description: "the slide's compositional form" },
          visualRole: { type: "string", enum: visualRoles },
          subhead: { type: "string", maxLength: archetypeBudgets.subhead, description: "one supporting line under the title (cover, section, statement, closing, bigNumber context)" },
          eyebrow: { type: "string", maxLength: archetypeBudgets.eyebrow, description: "two or three words naming what the page is about, set small above the title, e.g. The problem, Traction, The ask; every reading page has one" },
          points: { type: "array", maxItems: archetypeBudgets.points, items: { type: "string", maxLength: archetypeBudgets.point }, description: "bullets or agenda items; only for bullets/agenda" },
          stat: { type: "object", additionalProperties: false, required: ["value", "label"], properties: { value: { type: "string", maxLength: archetypeBudgets.statValue, description: "the figure, e.g. 42% or 3.2M" }, unit: { type: "string", maxLength: archetypeBudgets.statUnit }, label: { type: "string", maxLength: archetypeBudgets.statLabel, description: "what the figure means" }, icon: { type: "string", maxLength: archetypeBudgets.columnIcon, description: "one English keyword naming a simple icon for the figure" } } },
          icon: { type: "string", maxLength: archetypeBudgets.columnIcon, description: "one English keyword naming a simple icon for the page (bullets, statement, bigNumber, cover, section, closing), e.g. shield, clock, users, chart, leaf, globe, bolt, heart, coin, truck, calendar" },
          quote: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", maxLength: archetypeBudgets.quote }, attribution: { type: "string", maxLength: archetypeBudgets.attribution } } },
          steps: { type: "array", minItems: 2, maxItems: archetypeBudgets.steps, items: { type: "object", additionalProperties: false, required: ["label"], properties: { label: { type: "string", maxLength: archetypeBudgets.stepLabel }, detail: { type: "string", maxLength: archetypeBudgets.stepDetail }, when: { type: "string", maxLength: archetypeBudgets.stepWhen, description: "a short time marker for a timeline step, e.g. 2019, Q3, Week 2" }, icon: { type: "string", maxLength: archetypeBudgets.columnIcon, description: "one English keyword naming a simple icon for the step" } } } },
          columns: { type: "array", minItems: 2, maxItems: archetypeBudgets.columns, items: { type: "object", additionalProperties: false, required: ["heading", "points"], properties: { heading: { type: "string", maxLength: archetypeBudgets.columnHeading }, points: { type: "array", maxItems: archetypeBudgets.columnPoints, items: { type: "string", maxLength: archetypeBudgets.point } }, icon: { type: "string", maxLength: archetypeBudgets.columnIcon, description: "one English keyword naming a simple icon for the column, e.g. shield, clock, users, chart" } } } },
          image: { type: "object", additionalProperties: false, required: ["subject"], properties: { subject: { type: "string", maxLength: archetypeBudgets.imageSubject, description: "what the picture shows, IN ENGLISH, concrete and specific; no text in the image" }, treatment: { type: "string", enum: ["photo", "illustration", "abstract"] }, illustration: { type: "string", maxLength: archetypeBudgets.columnIcon, description: "one English keyword naming a flat drawing for the page instead of a photo, e.g. growth, handshake, rocket, target, security, chart, analysis, team, idea, money, logistics; use on covers, sections and closings of an internal or product deck" } } },
          chart: { type: "object", additionalProperties: false, required: ["kind", "categories", "series"], properties: { kind: { type: "string", enum: ["bar", "line", "pie", "donut"] }, categories: { type: "array", maxItems: archetypeBudgets.chartCategories, items: { type: "string" } }, series: { type: "array", minItems: 1, maxItems: archetypeBudgets.chartSeries, items: { type: "object", additionalProperties: false, required: ["name", "values"], properties: { name: { type: "string" }, values: { type: "array", items: { type: "number" } } } } } } },
          stats: { type: "array", minItems: 2, maxItems: archetypeBudgets.stats, items: { type: "object", additionalProperties: false, required: ["value", "label"], properties: { value: { type: "string", maxLength: archetypeBudgets.statValue }, unit: { type: "string", maxLength: archetypeBudgets.statUnit }, label: { type: "string", maxLength: archetypeBudgets.statLabel }, icon: { type: "string", maxLength: archetypeBudgets.columnIcon, description: "one English keyword naming a simple icon for the figure" } } }, description: "2-4 figures that belong together; only for kpiGrid" },
          table: { type: "object", additionalProperties: false, required: ["columns", "rows"], properties: { columns: { type: "array", minItems: 1, maxItems: archetypeBudgets.tableColumns, items: { type: "string", maxLength: archetypeBudgets.tableCell } }, rows: { type: "array", minItems: 1, maxItems: archetypeBudgets.tableRows, items: { type: "array", items: { type: "string", maxLength: archetypeBudgets.tableCell } } } }, description: "a small table of real values from the brief or attached material; only for table" },
          composition: { type: "object", additionalProperties: false, required: ["cells"], properties: { cells: { type: "array", minItems: 1, maxItems: archetypeBudgets.compositionCells, items: { type: "object", additionalProperties: false, required: ["col", "span", "row", "rows", "kind"], properties: { col: { type: "integer", minimum: 0, maximum: 11 }, span: { type: "integer", minimum: 1, maximum: 12 }, row: { type: "integer", minimum: 0, maximum: 5 }, rows: { type: "integer", minimum: 1, maximum: 6 }, kind: { type: "string", enum: ["heading", "body", "list", "figure", "label", "icon", "picture"] }, text: { type: "string", maxLength: archetypeBudgets.compositionText }, points: { type: "array", maxItems: archetypeBudgets.compositionPoints, items: { type: "string", maxLength: archetypeBudgets.compositionPoint } }, value: { type: "string", maxLength: archetypeBudgets.statValue }, unit: { type: "string", maxLength: archetypeBudgets.statUnit }, icon: { type: "string", maxLength: archetypeBudgets.columnIcon }, tone: { type: "string", enum: ["plain", "tint", "accent", "deep"] } } } }, links: { type: "array", maxItems: archetypeBudgets.compositionLinks, items: { type: "array", minItems: 2, maxItems: 2, items: { type: "integer", minimum: 0 } } } }, description: "a bespoke page: up to 8 cells placed on a 12-column by 6-row grid (col 0-11, span, row 0-5, rows), each a heading, body, list, figure, label, icon or picture with an optional tone (tint, accent, deep) that paints a panel behind it; links are pairs of cell indexes drawn as arrows; cells never overlap; only for composition, and only when no catalog form fits" },
          aside: { type: "string", maxLength: archetypeBudgets.aside, description: "a hand-written remark in the presenter's voice beside the content; about one page in three; never restates the slide" },
          drawing: { type: "string", maxLength: archetypeBudgets.drawing, description: "one keyword naming a full-colour drawing for the page, from the named list" },
          signature: { type: "string", enum: outlineSignatures, description: "a form built for this page's content; at most one page per deck" },
          pairs: { type: "array", maxItems: archetypeBudgets.pairs, items: { type: "object", additionalProperties: false, required: ["label", "value"], properties: { label: { type: "string", maxLength: archetypeBudgets.pairLabel }, value: { type: "string", maxLength: archetypeBudgets.pairValue } } }, description: "labels and values for a signature form (ledger lines, poll bars, health statuses, funnel figures) or kpiGrid deltas" },
          people: { type: "array", minItems: 1, maxItems: archetypeBudgets.people, items: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", maxLength: archetypeBudgets.personName }, role: { type: "string", maxLength: archetypeBudgets.personRole } } }, description: "the people on a team slide; only for team" },
          note: {
            type: "string",
            minLength: 100,
            maxLength: maxNoteChars,
            description:
              "speaker note: 1-3 spoken-style sentences of plain text (no markdown) that add presenter context and delivery cues; never restate the slide's visible text",
          },
        },
      },
    },
  },
} as const;

/** JSON Schema for ONE outline item: what a per-slide revision returns. */
export const outlineItemJsonSchema = outlineJsonSchema.properties.pages.items;

// --- Outline -> per-page spec ---------------------------------------------

/** Map a visual role to a base layout intent. */
const ROLE_LAYOUT: Record<VisualRole, DesignLayout> = {
  cover: "centered",
  agenda: "title-top",
  content: "left",
  comparison: "title-top",
  quote: "centered",
  data: "title-top",
  closing: "centered",
};

/** Expand one outline item into a laid-out-ready AiDesignSpec, themed
 *  consistently with the rest of the deck. Pure + deterministic. `index` lets
 *  consecutive content pages alternate composition for visual rhythm (FR-3:
 *  template-grounded, well-formed structure, not one rigid layout). */
export function outlineItemToSpec(item: OutlineItem, theme: DeckTheme, opts?: { dir?: "ltr" | "rtl"; index?: number }): AiDesignSpec {
  const blocks: AiDesignSpec["blocks"] = [];
  const role = item.visualRole;
  const index = opts?.index ?? 0;

  // A kicker eyebrow on non-cover pages ties the deck together.
  if (theme.kicker && role !== "cover" && role !== "quote") {
    blocks.push({ role: "eyebrow", text: theme.kicker });
  }

  if (role === "quote") {
    // A quote page leads with the line itself as the heading.
    const quote = item.points[0] || item.title;
    blocks.push({ role: "heading", text: `"${quote}"` });
    if (item.points[1] || item.title !== quote) {
      blocks.push({ role: "subheading", text: item.points[1] || item.title });
    }
  } else {
    blocks.push({ role: "heading", text: item.title });
    // A subheading from the first point gives content/cover pages a deck.
    const [lead, ...rest] = item.points;
    if (role === "cover" && lead) {
      blocks.push({ role: "subheading", text: lead });
      // An accent divider + a trailing call-to-action/footer line make a poster
      // or title page read as a finished composition, not just a headline.
      blocks.push({ role: "accent" });
      if (rest.length) blocks.push({ role: "body", text: rest[rest.length - 1] });
    } else {
      if (lead) blocks.push({ role: "accent" });
      const bodyPoints = role === "cover" ? [] : item.points;
      for (const pt of bodyPoints) blocks.push({ role: "body", text: bullet(role, pt) });
      // (rest already covered by bodyPoints loop for non-cover)
      void rest;
    }
  }

  // Content pages alternate left/split so a long deck has rhythm rather than a
  // wall of identical slides (template-grounded variety, FR-3).
  let layout = ROLE_LAYOUT[role];
  if (role === "content" && index % 2 === 1) {
    layout = "split";
  }

  return {
    layout,
    background: theme.background,
    blocks,
    dir: opts?.dir ?? "ltr",
    fonts: { heading: theme.fontHeading, body: theme.fontBody },
  };
}

/** Prefix content/comparison points with a bullet glyph; leave others plain. */
function bullet(role: VisualRole, text: string): string {
  return role === "content" || role === "comparison" || role === "agenda" ? `•  ${text}` : text;
}
