// F28 T20 stage 1 - extract a reusable layout set from an existing deck,
// heuristics only (the vision-assisted correction pass is stage 2).
//
// Every page is decomposed into placeholder slots by simple, deterministic
// rules: the largest text is the title; other text boxes become body or
// content slots (content when the box is big or clearly multi-item) carrying
// the T11 capacity hints derived from their geometry; images become picture
// slots, charts chart slots, video/audio media slots; everything else -
// shapes, lines, decorations - is decorative and yields no slot. Near-identical
// pages (same roles in the same quantized positions) collapse into ONE layout,
// so a 20-slide deck with 15 "title + content" slides produces one such
// layout, not 15. Names describe structure ("Title + 2 content"), never a
// source product.
//
// Pure and framework-agnostic: the caller (the editor store) owns ids,
// undo, and installation into the document.

import { capacityForPlaceholder, type Fill, type Placeholder, type PlaceholderRole } from "@hc/schema";
import type { PageInput } from "./quality";

/** The minimal shape of a page this extraction reads (a schema Page fits). */
export interface ExtractPageLike {
  width: number;
  height: number;
  background?: Fill;
  children: unknown[];
}

/** One extracted layout: placeholders (with T11 capacities), the background of
 *  its first source page, and every page index that matched its signature. */
export interface ExtractedLayout {
  name: string;
  background?: Fill;
  placeholders: Placeholder[];
  sourcePageIndexes: number[];
  /** The dimensions the rects (and capacities) were derived against, so later
   *  passes never have to re-find the source page in a mutated document. */
  sourcePageSize: { width: number; height: number };
}

export interface ExtractedLayoutSet {
  layouts: ExtractedLayout[];
  /** Per input page: the index into `layouts` it belongs to, or null when the
   *  page produced no slots (nothing but decoration). */
  assignments: (number | null)[];
}

interface NodeLike {
  type?: string;
  hidden?: boolean;
  locked?: boolean;
  transform?: { x: number; y: number; scaleX: number; scaleY: number };
  size?: { width: number; height: number };
  content?: { runs?: { style?: { fontSize?: number } }[] }[];
}

function rectOf(n: NodeLike): { x: number; y: number; width: number; height: number } | null {
  if (!n.transform || !n.size) return null;
  const width = Math.abs(n.size.width * (n.transform.scaleX ?? 1));
  const height = Math.abs(n.size.height * (n.transform.scaleY ?? 1));
  if (width <= 0 || height <= 0) return null;
  return { x: n.transform.x, y: n.transform.y, width, height };
}

/** The largest run font size in a text node (0 when it has none). */
function maxFontOf(n: NodeLike): number {
  return Math.max(0, ...(n.content ?? []).flatMap((p) => (p.runs ?? []).map((r) => r.style?.fontSize ?? 0)));
}

/** body or content for a non-title text box: content when the box is large
 *  (a real region) or clearly multi-item, body for labels and captions. */
function textRole(n: NodeLike, rect: { width: number; height: number }, page: { width: number; height: number }): PlaceholderRole {
  const areaFrac = (rect.width / page.width) * (rect.height / page.height);
  const paragraphs = (n.content ?? []).length;
  return areaFrac >= 0.12 || paragraphs >= 3 ? "content" : "body";
}

const slotRoleByType: Record<string, PlaceholderRole> = {
  image: "picture",
  chart: "chart",
  video: "media",
  audio: "media",
};

/** Quantized signature cell for dedupe: role + position/size on a coarse 10%
 *  grid (10x10 cells). Two pages whose slots land in the same cells are the
 *  same layout; small alignment jitter between hand-built slides stays inside
 *  a cell and collapses. */
function signatureCell(role: PlaceholderRole, rect: { x: number; y: number; width: number; height: number }, page: { width: number; height: number }): string {
  const q = (v: number, span: number) => Math.max(0, Math.min(9, Math.floor((v / span) * 10)));
  return `${role}@${q(rect.x, page.width)},${q(rect.y, page.height)},${q(rect.width, page.width)},${q(rect.height, page.height)}`;
}

/** A structural name: "Title + 2 content", "Picture + body", "Content". */
function structuralName(placeholders: Placeholder[]): string {
  const counts = new Map<PlaceholderRole, number>();
  for (const ph of placeholders) counts.set(ph.role, (counts.get(ph.role) ?? 0) + 1);
  const parts: string[] = [];
  if (counts.has("title")) parts.push("Title");
  const order: PlaceholderRole[] = ["content", "body", "picture", "chart", "media"];
  const label: Record<string, string> = { content: "content", body: "text", picture: "picture", chart: "chart", media: "media" };
  for (const role of order) {
    const c = counts.get(role);
    if (!c) continue;
    parts.push(c > 1 ? `${c} ${label[role]}` : label[role]);
  }
  if (!parts.length) return "Blank";
  const [head, ...rest] = parts;
  const name = [head, ...rest].join(" + ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Extract the deduped layout set from a deck's pages (top-level nodes only,
 *  mirroring what save-page-as-layout captures). */
export function extractLayoutSet(pages: ExtractPageLike[]): ExtractedLayoutSet {
  const bySignature = new Map<string, number>();
  const layouts: ExtractedLayout[] = [];
  const assignments: (number | null)[] = [];

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    const nodes = (page.children as NodeLike[]).filter((n) => !n.hidden);
    const texts = nodes.filter((n) => n.type === "text" && rectOf(n) && (n.content?.length ?? 0) > 0);
    // Largest font wins; ties break by READING ORDER (top, then left), never
    // by child z-order, so two identical pages whose children are stacked
    // differently still pick the same title and dedupe.
    const titleNode = texts.length
      ? texts.reduce((a, b) => {
          const fa = maxFontOf(a);
          const fb = maxFontOf(b);
          if (fb !== fa) return fb > fa ? b : a;
          const ra = rectOf(a)!;
          const rb = rectOf(b)!;
          return rb.y < ra.y || (rb.y === ra.y && rb.x < ra.x) ? b : a;
        })
      : null;

    const slots: { role: PlaceholderRole; rect: { x: number; y: number; width: number; height: number } }[] = [];
    for (const n of nodes) {
      const rect = rectOf(n);
      if (!rect) continue;
      if (n.type === "text" && texts.includes(n)) {
        slots.push({ role: n === titleNode ? "title" : textRole(n, rect, page), rect });
      } else if (n.type && slotRoleByType[n.type]) {
        slots.push({ role: slotRoleByType[n.type], rect });
      }
      // Everything else is decorative: no slot.
    }
    if (!slots.length) {
      assignments.push(null);
      continue;
    }
    // Reading order (top-to-bottom, then left-to-right) keeps ids stable and
    // fills sensible.
    slots.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    // Page dimensions lead the signature: rects are ABSOLUTE (from the source
    // page) and applying a layout only scales DOWN, so proportionally equal
    // pages of DIFFERENT sizes must stay separate layouts - collapsing them
    // would materialize the smaller page's boxes miniature on the larger one.
    const signature = `${page.width}x${page.height}|` + slots.map((s) => signatureCell(s.role, s.rect, page)).sort().join("|");

    const existing = bySignature.get(signature);
    if (existing !== undefined) {
      layouts[existing].sourcePageIndexes.push(pi);
      assignments.push(existing);
      continue;
    }
    const placeholders: Placeholder[] = slots.map((s, i) => ({
      id: `ph-${i + 1}`,
      role: s.role,
      rect: s.rect,
      ...capacityForPlaceholder(s.role, s.rect, page),
    }));
    const layout: ExtractedLayout = {
      name: structuralName(placeholders),
      ...(page.background ? { background: page.background } : {}),
      placeholders,
      sourcePageIndexes: [pi],
      sourcePageSize: { width: page.width, height: page.height },
    };
    bySignature.set(signature, layouts.length);
    assignments.push(layouts.length);
    layouts.push(layout);
  }

  // Duplicate structural names get a counter suffix ("Title + content 2"), so
  // two DIFFERENT geometries with the same role mix stay distinguishable.
  const seen = new Map<string, number>();
  for (const l of layouts) {
    const n = (seen.get(l.name) ?? 0) + 1;
    seen.set(l.name, n);
    if (n > 1) l.name = `${l.name} ${n}`;
  }
  return { layouts, assignments };
}

// --- Stage 2: vision-assisted correction --------------------------------------
//
// The heuristics above only see geometry; a vision-capable model looking at the
// RENDERED page can tell a decorative pull-quote from body copy, or a logo from
// a picture region. The client renders the source page with the candidate
// slots drawn over it, sends it through the describe-image provider with the
// instruction below, and applies the corrections that come back - then does
// ONE self-review pass with the corrected overlay; an empty reply confirms.
// Everything the model returns is validated here: unknown slot ids and roles
// are dropped, a layout never loses its last slot, and a second title demotes
// to body, so a bad reply can only ever fall back to the heuristic result.

const reviewableRoles: PlaceholderRole[] = ["title", "body", "content", "picture", "chart", "media"];

export interface LayoutReviewCorrection {
  id: string;
  role: PlaceholderRole | "decorative";
}

// i18n-ignore: model instruction, never translated.
export function layoutReviewInstruction(
  layout: Pick<ExtractedLayout, "placeholders">,
  page: { width: number; height: number },
): string {
  const pct = (v: number, span: number) => Math.round((v / span) * 100);
  const slots = layout.placeholders
    .map((p) => `${p.id}: ${p.role} at ${pct(p.rect.x, page.width)},${pct(p.rect.y, page.height)} size ${pct(p.rect.width, page.width)}x${pct(p.rect.height, page.height)} (% of page)`)
    .join("; ");
  return [
    "This slide render has candidate layout slots drawn as labeled boxes.",
    `Slots: ${slots}.`,
    "Correct any slot whose role is wrong, judging from what the box actually contains:",
    "title (the slide's one heading), body (short text, captions, labels), content (the main text/list region),",
    "picture (photos/illustrations), chart, media (video), or decorative (logos, ornaments, page furniture - not a content slot).",
    'Reply with ONLY JSON, no prose: {"corrections":[{"id":"ph-2","role":"picture"}]} listing JUST the slots to change;',
    'reply {"corrections":[]} when every role is already right.',
  ].join(" ");
}

/** Parse the model's reply tolerantly: fences stripped, non-JSON rejected,
 *  unknown ids and roles dropped. A garbage reply yields no corrections. */
export function parseLayoutReview(text: string, validIds: string[]): LayoutReviewCorrection[] {
  // The closing fence is stripped WITHOUT a leading `\s*`, then trimmed. That
  // reads the same and behaves the same on an already-trimmed string, but
  // `\s*```$` had no anchor on its left, so on a reply full of spaces and no
  // closing fence the engine restarted the whitespace run at every offset:
  // quadratic work on model output, which is exactly the input we do not
  // control.
  const cleaned = text.trim().replace(/^```(?:json)?[ \t]*\n?/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = (parsed as { corrections?: unknown }).corrections;
  if (!Array.isArray(list)) return [];
  const ids = new Set(validIds);
  const out: LayoutReviewCorrection[] = [];
  for (const c of list as { id?: unknown; role?: unknown }[]) {
    if (typeof c?.id !== "string" || typeof c?.role !== "string" || !ids.has(c.id)) continue;
    const role = c.role as PlaceholderRole | "decorative";
    if (role !== "decorative" && !reviewableRoles.includes(role as PlaceholderRole)) continue;
    if (!out.some((x) => x.id === c.id)) out.push({ id: c.id, role });
  }
  return out;
}

/** Apply validated corrections to a layout, returning a new one: decorative
 *  slots are removed (never the last one), role changes recompute the T11
 *  capacities, at most one title survives (later ones demote to body), and
 *  the structural name is refreshed. No-op corrections return the input. */
export function applyLayoutReview(
  layout: ExtractedLayout,
  corrections: LayoutReviewCorrection[],
  page: { width: number; height: number },
): ExtractedLayout {
  if (!corrections.length) return layout;
  const byId = new Map(corrections.map((c) => [c.id, c.role]));
  let changed = false;
  const kept: Placeholder[] = [];
  for (const ph of layout.placeholders) {
    const next = byId.get(ph.id);
    if (next === undefined || next === ph.role) {
      kept.push(ph);
      continue;
    }
    changed = true;
    if (next === "decorative") continue; // removed
    // Rebuild the slot for its new role: capacities are role-derived, so the
    // old ones must not linger (a picture slot with maxChars is nonsense).
    kept.push({ id: ph.id, role: next, rect: ph.rect, ...capacityForPlaceholder(next, ph.rect, page) });
  }
  if (!changed) return layout;
  if (!kept.length) return layout; // the model tried to delete everything: keep the heuristics
  let sawTitle = false;
  const singleTitle = kept.map((ph) => {
    if (ph.role !== "title") return ph;
    if (!sawTitle) {
      sawTitle = true;
      return ph;
    }
    return { id: ph.id, role: "body" as PlaceholderRole, rect: ph.rect, ...capacityForPlaceholder("body", ph.rect, page) };
  });
  return { ...layout, placeholders: singleTitle, name: structuralName(singleTitle) };
}

// --- Stage 3: capacity verification --------------------------------------------
//
// A capacity hint is a promise to generation: "maxChars of text fits here".
// The T11 heuristic derives it from area alone, which over-promises on wide,
// short boxes and on slots the vision pass re-roled. This pass simulates the
// MAX fill in every text slot (the same conservative glyph-advance estimate
// the layout engine uses) and shrinks any capacity whose fill outgrows its box
// to what actually fits; a box too small for a single fill line loses its
// hints entirely. Shrink-to-fit guarantees the qualityCheck invariant by
// construction (a shrunk slot's estimated fill never exceeds its rect, so max
// fill can never create a NEW overflow or overlap) - the invariant is pinned
// by a test running qualityCheck over maxFillSimulationNodes, rather than by
// an unreachable runtime gate.

/** Font sizes the placeholder materialization uses per role, and the line
 *  height the estimate assumes (conservative, mirrors the layout engine). */
const fillFontSize: Record<string, number> = { title: 44, body: 20, content: 20 };
const fillLineHeight = 1.35;
const textCapacityRoles = new Set<PlaceholderRole>(["title", "body", "content"]);

function fillMetrics(role: PlaceholderRole, rect: { width: number; height: number }): { charsPerLine: number; maxLines: number; lineH: number } {
  const fontSize = fillFontSize[role] ?? 20;
  const lineH = fontSize * fillLineHeight;
  return {
    charsPerLine: Math.max(1, Math.floor(rect.width / (fontSize * 0.52))),
    maxLines: Math.floor(rect.height / lineH),
    lineH,
  };
}

/** Estimated rendered height of a slot filled to its capacity. Lists render
 *  one bulleted paragraph per item, each wrapping independently. */
export function estimatedFillHeight(ph: Placeholder): number {
  const { charsPerLine, lineH } = fillMetrics(ph.role, ph.rect);
  const maxChars = ph.maxChars ?? 0;
  let lines: number;
  if (ph.role === "content" && ph.maxItems) {
    const perItem = Math.max(1, Math.ceil(maxChars / ph.maxItems / charsPerLine));
    lines = ph.maxItems * perItem;
  } else {
    lines = Math.max(1, Math.ceil(maxChars / charsPerLine));
  }
  return lines * lineH;
}

/**
 * The geometry-only node list for a max-fill simulation of a layout: every
 * slot at its rect, text slots grown to their estimated fill height. Feed it
 * to qualityCheck to verify the shrink-to-fit invariant (tests do exactly
 * that); shapes carry no text so the contrast check does not apply.
 */
export function maxFillSimulationNodes(placeholders: Placeholder[], opts: { grown: boolean }): PageInput["nodes"] {
  return placeholders.map((ph) => ({
    id: ph.id,
    type: "shape",
    transform: { x: ph.rect.x, y: ph.rect.y, scaleX: 1, scaleY: 1, rotation: 0 },
    size: {
      width: ph.rect.width,
      height:
        opts.grown && textCapacityRoles.has(ph.role) && ph.maxChars
          ? Math.max(ph.rect.height, estimatedFillHeight(ph))
          : ph.rect.height,
    },
  })) as unknown as PageInput["nodes"];
}

/**
 * Verify (and shrink) the capacity hints on one extracted layout against its
 * source page size. Deterministic and idempotent: a slot whose max fill
 * outgrows its box shrinks to what fits; a slot that cannot honestly hold
 * even one line loses its hints.
 */
export function verifyLayoutCapacities(layout: ExtractedLayout, page: { width: number; height: number }): ExtractedLayout {
  const hasTextCaps = layout.placeholders.some((p) => textCapacityRoles.has(p.role) && p.maxChars);
  if (!hasTextCaps) return layout;

  let changed = false;
  const shrunk: Placeholder[] = layout.placeholders.map((ph) => {
    if (!textCapacityRoles.has(ph.role) || !ph.maxChars) return ph;
    const { charsPerLine, maxLines } = fillMetrics(ph.role, ph.rect);
    if (maxLines < 1) {
      // The box cannot hold a single line at the fill size: the hint is a lie.
      changed = true;
      const { maxChars: _mc, minChars: _nc, minItems: _ni, maxItems: _xi, ...rest } = ph;
      return rest as Placeholder;
    }
    const fitItems = ph.maxItems !== undefined ? Math.max(1, Math.min(ph.maxItems, maxLines)) : undefined;
    // Lists reserve one line per item; prose uses every line.
    const fitChars = (fitItems !== undefined ? Math.floor(maxLines / fitItems) * fitItems : maxLines) * charsPerLine;
    const nextMax = Math.min(ph.maxChars, fitChars);
    if (nextMax === ph.maxChars && fitItems === ph.maxItems) return ph;
    changed = true;
    return {
      ...ph,
      maxChars: nextMax,
      ...(ph.minChars !== undefined ? { minChars: Math.min(ph.minChars, Math.round(nextMax / 2)) } : {}),
      ...(fitItems !== undefined ? { maxItems: fitItems } : {}),
      ...(ph.minItems !== undefined && fitItems !== undefined ? { minItems: Math.min(ph.minItems, fitItems) } : {}),
    };
  });

  if (!changed) return layout;
  return { ...layout, placeholders: shrunk };
}
