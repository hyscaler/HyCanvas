// F39 Phase 2 - multi-page generation (outline-first). The model returns an
// editable DesignOutline (per-page title + key points + a visual role); the user
// can edit it; then each OutlineItem expands deterministically into an
// AiDesignSpec laid out by the Phase 1 engine. No page positions come from the
// model - only content and intent - so a whole deck shares one visual system.

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
  | "closing";
export const archetypes: Archetype[] = [
  "cover", "agenda", "section", "statement", "bigNumber", "bullets", "twoColumn",
  "threeUp", "process", "quote", "imageCaption", "chart", "closing",
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
};

export interface Stat { value: string; unit?: string; label: string }
export interface Quote { text: string; attribution?: string }
export interface Step { label: string; detail?: string }
export interface Column { heading: string; points: string[] }
export type ImageTreatment = "photo" | "illustration" | "abstract";
export interface ImageIntent { subject: string; treatment: ImageTreatment }
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
  imageSubject: 140, chartCategories: 8, chartSeries: 3,
} as const;

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
}

/** Hard cap on a speaker note; the prompt asks for 100..500 chars and the
 *  normalizer truncates defensively rather than failing the outline. */
export const maxNoteChars = 500;

export interface DesignOutline {
  title: string;
  /** A short theme phrase (mood/topic) used to ground per-page styling. */
  theme: string;
  pages: OutlineItem[];
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
export function clipToBudget(v: unknown, max: number): string {
  const t = str(v);
  const chars = Array.from(t);
  if (chars.length <= max) return t;
  let cut = chars.slice(0, max).join("");
  const space = cut.lastIndexOf(" ");
  if (space > max * 0.6) cut = cut.slice(0, space);
  return cut.replace(/[\s,;:-]+$/u, "");
}

function strList(v: unknown, maxItems: number, maxChars: number): string[] {
  return (Array.isArray(v) ? v : []).map((x) => clipToBudget(x, maxChars)).filter(Boolean).slice(0, maxItems);
}

/** Read and clip the typed archetype payloads, dropping any that arrive empty,
 *  then downgrade an archetype whose payload did not survive to a form its
 *  content can support: no stat means no big number. Mirrors
 *  normalizeArchetypeFields in specs.go. */
function normalizeArchetypeFields(p: Record<string, unknown>, archetype: Archetype, points: string[]): Partial<OutlineItem> & { archetype: Archetype } {
  const b = archetypeBudgets;
  const out: Partial<OutlineItem> & { archetype: Archetype } = { archetype };
  const subhead = clipToBudget(p.subhead, b.subhead);
  if (subhead) out.subhead = subhead;

  const st = p.stat as Record<string, unknown> | undefined;
  if (st && typeof st === "object") {
    const value = clipToBudget(st.value, b.statValue);
    if (value) {
      const unit = clipToBudget(st.unit, b.statUnit);
      out.stat = { value, label: clipToBudget(st.label, b.statLabel), ...(unit ? { unit } : {}) };
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
      return label ? { label, ...(detail ? { detail } : {}) } : null;
    })
    .filter((x): x is Step => !!x)
    .slice(0, b.steps);
  if (steps.length) out.steps = steps;
  const columns = (Array.isArray(p.columns) ? p.columns : [])
    .map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const heading = clipToBudget(r.heading, b.columnHeading);
      const pts = strList(r.points, b.columnPoints, b.point);
      return heading || pts.length ? { heading, points: pts } : null;
    })
    .filter((x): x is Column => !!x)
    .slice(0, b.columns);
  if (columns.length) out.columns = columns;
  const im = p.image as Record<string, unknown> | undefined;
  if (im && typeof im === "object") {
    const subject = clipToBudget(im.subject, b.imageSubject);
    if (subject) {
      const t = im.treatment;
      out.image = { subject, treatment: t === "illustration" || t === "abstract" ? t : "photo" };
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

  // Downgrade an archetype whose payload did not survive.
  switch (archetype) {
    case "bigNumber": if (!out.stat) out.archetype = "bullets"; break;
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
  }
  return out;
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
    pages.push({
      id: nextId(),
      title: clipToBudget(pTitle, titleMax) || "Untitled",
      points,
      visualRole,
      ...(note ? { note } : {}),
      ...typed,
    });
  }
  if (!pages.length) {
    throw new OutlineError("The AI didn't return any pages. Try a more specific prompt.");
  }
  return { title, theme, pages };
}

/** JSON Schema for a DesignOutline, embedded in the generation prompt. */
export const outlineJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "pages"],
  properties: {
    title: { type: "string" },
    theme: { type: "string", description: "short mood/topic phrase" },
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
          points: { type: "array", maxItems: archetypeBudgets.points, items: { type: "string", maxLength: archetypeBudgets.point }, description: "bullets or agenda items; only for bullets/agenda" },
          stat: { type: "object", additionalProperties: false, required: ["value", "label"], properties: { value: { type: "string", maxLength: archetypeBudgets.statValue, description: "the figure, e.g. 42% or 3.2M" }, unit: { type: "string", maxLength: archetypeBudgets.statUnit }, label: { type: "string", maxLength: archetypeBudgets.statLabel, description: "what the figure means" } } },
          quote: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", maxLength: archetypeBudgets.quote }, attribution: { type: "string", maxLength: archetypeBudgets.attribution } } },
          steps: { type: "array", minItems: 2, maxItems: archetypeBudgets.steps, items: { type: "object", additionalProperties: false, required: ["label"], properties: { label: { type: "string", maxLength: archetypeBudgets.stepLabel }, detail: { type: "string", maxLength: archetypeBudgets.stepDetail } } } },
          columns: { type: "array", minItems: 2, maxItems: archetypeBudgets.columns, items: { type: "object", additionalProperties: false, required: ["heading", "points"], properties: { heading: { type: "string", maxLength: archetypeBudgets.columnHeading }, points: { type: "array", maxItems: archetypeBudgets.columnPoints, items: { type: "string", maxLength: archetypeBudgets.point } } } } },
          image: { type: "object", additionalProperties: false, required: ["subject"], properties: { subject: { type: "string", maxLength: archetypeBudgets.imageSubject, description: "what the picture shows, IN ENGLISH, concrete and specific; no text in the image" }, treatment: { type: "string", enum: ["photo", "illustration", "abstract"] } } },
          chart: { type: "object", additionalProperties: false, required: ["kind", "categories", "series"], properties: { kind: { type: "string", enum: ["bar", "line", "pie", "donut"] }, categories: { type: "array", maxItems: archetypeBudgets.chartCategories, items: { type: "string" } }, series: { type: "array", minItems: 1, maxItems: archetypeBudgets.chartSeries, items: { type: "object", additionalProperties: false, required: ["name", "values"], properties: { name: { type: "string" }, values: { type: "array", items: { type: "number" } } } } } } },
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
