// F28 T12 - layout-grounded generation's pure core. A slide layout's
// placeholders define a per-layout CONTENT schema (bounded strings from the
// v21 capacities, arrays from the item ranges, everything required, keyed by
// placeholder id), so the model fills exactly the slots the layout offers and
// nothing else. Alongside it: the layout-selection contract (a compact catalog
// for the prompt, a strict selection schema, and a deterministic repair pass
// with a variety rule) and the fill normalizer that clips model output back to
// the capacities. No store, no network - everything here is testable alone.

import type { Placeholder, SlideLayout } from "@hc/schema";
import type { OutlineItem, VisualRole } from "./outline";
import { contentOnlyRule, lengthLimitRule } from "./promptRules";

/** Default capacity ceilings when a placeholder carries none (user-captured
 *  layouts may omit them); mirrors the built-ins' scale. */
const defaultMaxChars: Record<string, number> = { title: 60, body: 200, content: 400 };
const defaultMaxItems = 6;

/** A placeholder participates in the content fill when the model can write
 *  something into it: text roles take strings, content takes a list, picture
 *  takes an English image prompt. Chart/media/footer slots are skipped (charts
 *  arrive via the chart tool; footers are boilerplate). */
export function fillableRole(role: Placeholder["role"]): boolean {
  return role === "title" || role === "body" || role === "content" || role === "picture";
}

/** Derive the JSON content schema for one layout: an object whose properties
 *  are the layout's fillable placeholder ids, all required (the reference
 *  pattern: a filled slide never leaves a slot empty). */
export function deriveLayoutContentSchema(layout: SlideLayout): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const ph of layout.placeholders ?? []) {
    if (!fillableRole(ph.role)) continue;
    required.push(ph.id);
    if (ph.role === "content") {
      properties[ph.id] = {
        type: "array",
        minItems: ph.minItems ?? 2,
        maxItems: ph.maxItems ?? defaultMaxItems,
        items: { type: "string", maxLength: perItemMaxChars(ph) },
        description: "bullet points for this content area",
      };
    } else if (ph.role === "picture") {
      properties[ph.id] = {
        type: "string",
        maxLength: 300,
        description: "an image-generation prompt IN ENGLISH describing the picture for this slot",
      };
    } else {
      properties[ph.id] = {
        type: "string",
        minLength: Math.min(ph.minChars ?? 0, ph.maxChars ?? defaultMaxChars[ph.role]),
        maxLength: ph.maxChars ?? defaultMaxChars[ph.role],
        description: ph.role === "title" ? "this slide's heading" : "supporting text",
      };
    }
  }
  return { type: "object", additionalProperties: false, required, properties };
}

/** Per-item ceiling for a content list: the slot's total budget split across
 *  its maximum items, floored at a usable sentence length. */
function perItemMaxChars(ph: Placeholder): number {
  const total = ph.maxChars ?? defaultMaxChars.content;
  const items = ph.maxItems ?? defaultMaxItems;
  return Math.max(40, Math.round(total / Math.max(1, items)));
}

/** One line per layout for the selection prompt: id, name, and the slot
 *  signature, so the model picks by structure rather than guessing. */
export function layoutCatalogText(layouts: SlideLayout[]): string {
  return layouts
    .map((l) => {
      const sig = (l.placeholders ?? [])
        .filter((p) => fillableRole(p.role))
        .map((p) => p.role)
        .join("+") || "empty";
      return `- ${l.id}: ${l.name ?? l.id} (${sig})`;
    })
    .join("\n");
}

/** JSON schema for the selection reply: one valid layout id per outline item. */
export function layoutSelectionSchema(count: number, layoutIds: string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["layouts"],
    properties: {
      layouts: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: { type: "string", enum: layoutIds },
        description: "one layout id per page, in page order",
      },
    },
  };
}

/** Which layout roles suit a visual role, used by both the repair pass and the
 *  no-model fallback. Preference order matters: first match wins. */
const rolePreference: Record<VisualRole, string[]> = {
  cover: ["title"],
  agenda: ["title+content", "title+body"],
  content: ["title+content", "title+content+content"],
  comparison: ["title+body+content+body+content", "title+content+content"],
  quote: ["title", "title+body"],
  data: ["title+content", "title+picture+body"],
  closing: ["title", "title+body"],
};

function signature(l: SlideLayout): string {
  return (l.placeholders ?? []).filter((p) => fillableRole(p.role)).map((p) => p.role).join("+");
}

/** Deterministically pick a layout for a visual role: the first layout whose
 *  slot signature matches the role's preference list, else the first layout. */
export function preferredLayoutFor(role: VisualRole, layouts: SlideLayout[]): string {
  for (const want of rolePreference[role] ?? []) {
    const hit = layouts.find((l) => signature(l) === want);
    if (hit) return hit.id;
  }
  return layouts[0]?.id ?? "";
}

/** Repair a model layout selection: fix the length, replace invalid ids with
 *  the role-preferred layout (deterministic, never random), and enforce the
 *  variety rule - adjacent pages differ unless the role demands repetition
 *  (consecutive content pages may repeat only when no alternative exists). */
export function repairLayoutSelection(
  selected: unknown,
  items: { visualRole: VisualRole }[],
  layouts: SlideLayout[],
): string[] {
  const valid = new Set(layouts.map((l) => l.id));
  const raw = Array.isArray(selected) ? selected : [];
  const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const candidate = typeof raw[i] === "string" && valid.has(raw[i] as string)
      ? (raw[i] as string)
      : preferredLayoutFor(items[i].visualRole, layouts);
    out.push(candidate);
  }
  // Variety: break runs of the same layout when an alternative fits the role.
  for (let i = 1; i < out.length; i++) {
    if (out[i] !== out[i - 1] || layouts.length < 2) continue;
    const alternative = layouts.find((l) => l.id !== out[i - 1] && suitable(items[i].visualRole, l));
    if (alternative) out[i] = alternative.id;
  }
  return out;
}

/** A layout suits a role when it can hold the role's content: everything needs
 *  a title slot; content-ish roles also need at least one content slot. */
function suitable(role: VisualRole, l: SlideLayout): boolean {
  const sig = signature(l);
  if (!sig.includes("title")) return false;
  if (role === "content" || role === "agenda" || role === "data" || role === "comparison") {
    return sig.includes("content");
  }
  return true;
}

/** The normalized result of filling one layout: text per placeholder id and
 *  an English image prompt per picture slot. */
export interface LayoutFill {
  texts: Record<string, string>;
  /** Content lists joined for the caller that wants plain text, kept as lists here. */
  lists: Record<string, string[]>;
  imagePrompts: Record<string, string>;
}

/** Clip a string at a capacity: whole-word cut, no mid-word truncation. */
function clipText(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd();
}

/** Normalize a parsed fill reply against the layout: unknown keys dropped,
 *  strings clipped to their capacity, lists clipped to their item range, and a
 *  missing slot filled with an empty marker the applier can skip. */
export function normalizeLayoutFill(layout: SlideLayout, parsed: unknown): LayoutFill {
  const src = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const fill: LayoutFill = { texts: {}, lists: {}, imagePrompts: {} };
  for (const ph of layout.placeholders ?? []) {
    if (!fillableRole(ph.role)) continue;
    const v = src[ph.id];
    if (ph.role === "content") {
      const maxItems = ph.maxItems ?? defaultMaxItems;
      const items = (Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : [])
        .map((x) => clipText(String(x), perItemMaxChars(ph)))
        .filter(Boolean)
        .slice(0, maxItems);
      if (items.length) fill.lists[ph.id] = items;
    } else if (ph.role === "picture") {
      const prompt = typeof v === "string" ? clipText(v, 300) : "";
      if (prompt) fill.imagePrompts[ph.id] = prompt;
    } else {
      const max = ph.maxChars ?? defaultMaxChars[ph.role];
      const text = typeof v === "string" ? clipText(v, max) : "";
      if (text) fill.texts[ph.id] = text;
    }
  }
  return fill;
}

/** Deterministic fill from the outline item alone - the no-model fallback and
 *  the safety net when a fill call fails: the title lands in the title slot,
 *  points split across the content slots in order, the first leftover point
 *  becomes the body, and picture slots get a plain English prompt from the
 *  slide title. Never throws, never returns an unusable page. */
export function fallbackLayoutFill(layout: SlideLayout, item: OutlineItem): LayoutFill {
  const fill: LayoutFill = { texts: {}, lists: {}, imagePrompts: {} };
  const contentSlots = (layout.placeholders ?? []).filter((p) => p.role === "content");
  const bodySlots = (layout.placeholders ?? []).filter((p) => p.role === "body");
  const titleSlot = (layout.placeholders ?? []).find((p) => p.role === "title");
  const pictureSlots = (layout.placeholders ?? []).filter((p) => p.role === "picture");
  if (titleSlot) fill.texts[titleSlot.id] = item.title;
  if (contentSlots.length) {
    // Split the points evenly across the content slots, in slot order.
    const per = Math.max(1, Math.ceil(item.points.length / contentSlots.length));
    contentSlots.forEach((slot, i) => {
      const chunk = item.points.slice(i * per, (i + 1) * per);
      if (chunk.length) fill.lists[slot.id] = chunk;
    });
    if (bodySlots.length && item.note) fill.texts[bodySlots[0].id] = item.note;
  } else if (bodySlots.length) {
    bodySlots.forEach((slot, i) => {
      const text = i === 0 ? item.points.join(" ") || item.note || "" : "";
      if (text) fill.texts[slot.id] = text;
    });
  }
  for (const slot of pictureSlots) {
    fill.imagePrompts[slot.id] = `${item.title}, clean professional photography, no text`;
  }
  return normalizeLayoutFill(layout, { ...fill.texts, ...fill.lists, ...fill.imagePrompts });
}

/** System prompt for the one layout-selection call. */
export function layoutSelectionSystemPrompt(count: number, layouts: SlideLayout[]): string {
  return (
    "You assign one slide layout per page of a presentation outline. Pick by structure: the layout's slots must fit the page's content. Vary layouts across adjacent pages where the content allows. " +
    "Output ONLY a single JSON object matching the schema, no prose or fences. Schema: " +
    JSON.stringify(layoutSelectionSchema(count, layouts.map((l) => l.id))) +
    "\n\nAvailable layouts:\n" + layoutCatalogText(layouts)
  );
}

/** System prompt for one per-page fill call against a derived schema. */
export function layoutFillSystemPrompt(schema: Record<string, unknown>): string {
  return (
    "You write the final content for ONE presentation slide, filling exactly the slots the schema names (keyed by slot id). " +
    contentOnlyRule() + " " + lengthLimitRule() +
    " Output ONLY a single JSON object matching the schema, no prose or fences. Schema: " + JSON.stringify(schema)
  );
}

/** Schema for the regenerate-slide relayout decision: keep or switch. */
export function relayoutDecisionSchema(layoutIds: string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["relayout"],
    properties: {
      relayout: { type: "boolean", description: "true ONLY when the instruction warrants a different layout" },
      layoutId: { type: "string", enum: layoutIds, description: "the layout to switch to when relayout is true" },
    },
  };
}

/** System prompt for the relayout decision. */
export function relayoutDecisionSystemPrompt(layouts: SlideLayout[]): string {
  return (
    "Decide whether regenerating this slide per the instruction warrants a DIFFERENT layout. Keep the current layout unless the instruction clearly asks for a structural change (comparison, picture, more columns). " +
    "Output ONLY a single JSON object matching the schema, no prose or fences. Schema: " +
    JSON.stringify(relayoutDecisionSchema(layouts.map((l) => l.id))) +
    "\n\nAvailable layouts:\n" + layoutCatalogText(layouts)
  );
}

/** System prompt for the regeneration fill: rewrite against the slide's own
 *  current content, honoring the instruction, never inventing off-slide facts
 *  unless the instruction asks for new material. */
export function regenerateFillSystemPrompt(schema: Record<string, unknown>): string {
  return (
    "You REWRITE the content of ONE existing presentation slide per the user's instruction, filling exactly the slots the schema names (keyed by slot id). Ground the rewrite in the slide's current content; add new material only where the instruction asks for it. " +
    "Output ONLY a single JSON object matching the schema, no prose or fences. Schema: " + JSON.stringify(schema)
  );
}
