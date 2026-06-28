// F39 Phase 2 - multi-page generation (outline-first). The model returns an
// editable DesignOutline (per-page title + key points + a visual role); the user
// can edit it; then each OutlineItem expands deterministically into an
// AiDesignSpec laid out by the Phase 1 engine. No page positions come from the
// model - only content and intent - so a whole deck shares one visual system.

import type { AiDesignSpec, BlockRole, DesignBackground, DesignLayout } from "./spec";

/** What kind of multi-page artifact we are generating. Drives length + arc. */
export type DesignType = "deck" | "doc" | "social-set" | "poster";
export const DESIGN_TYPES: DesignType[] = ["deck", "doc", "social-set", "poster"];

/** The narrative/visual role of a page; maps to a layout + emphasis. */
export type VisualRole =
  | "cover"
  | "agenda"
  | "content"
  | "comparison"
  | "quote"
  | "data"
  | "closing";
export const VISUAL_ROLES: VisualRole[] = ["cover", "agenda", "content", "comparison", "quote", "data", "closing"];

export interface OutlineItem {
  id: string;
  title: string;
  points: string[];
  visualRole: VisualRole;
}

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

/** Validate + normalize a parsed model value into a DesignOutline. Drops empty
 *  pages, defaults roles, and throws when nothing usable remains. */
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
    const points = Array.isArray(p.points) ? p.points.map(str).filter(Boolean).slice(0, 8) : [];
    if (!pTitle && !points.length) continue;
    const visualRole = VISUAL_ROLES.includes(p.visualRole as VisualRole) ? (p.visualRole as VisualRole) : "content";
    pages.push({ id: nextId(), title: pTitle || "Untitled", points, visualRole });
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
        required: ["title", "visualRole"],
        properties: {
          title: { type: "string" },
          points: { type: "array", items: { type: "string" } },
          visualRole: { type: "string", enum: VISUAL_ROLES },
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
