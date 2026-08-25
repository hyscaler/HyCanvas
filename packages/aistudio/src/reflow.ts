// Adaptive smart-slide reflow (F40 E15). Pure and deterministic, no model
// calls, no DOM: given a layout-linked page's placeholder slots and the text
// each one holds, decide the largest role-appropriate font size that fits
// each slot (stepping DOWN on overflow, back UP when content shrinks), and
// return an over/underflow verdict per slot so the editor can propose a
// denser or sparser layout variant (E17) when stepping cannot absorb the
// change. The fit model is the same conservative chars-per-line estimate the
// layout engine and the v21 capacity hints use (avg glyph advance ~0.52em,
// line height ~1.3), so the three systems agree about what "fits" means.
//
// Height is deliberately NOT part of the output: the editor's own refit rule
// ("a box may never lie about containing its text") already grows a fixed box
// past its slot when needed and returns it when content shrinks; reflow's job
// is to make that growth rarely necessary.

import type { SlideLayout, Placeholder } from "@hc/schema";

/** The discrete size ladders reflow may choose from, per slot role. Stepping
 *  through a ladder (never arbitrary values) keeps decks visually consistent:
 *  two slides that both overflow a little land on the SAME smaller size. */
export const reflowLadders: Record<"title" | "body" | "content", number[]> = {
  title: [44, 40, 36, 32, 28],
  body: [20, 18, 16, 14],
  content: [20, 18, 16, 14, 12],
};

const AVG_GLYPH_EM = 0.52;
const LINE_HEIGHT = 1.3;

export interface ReflowSlotInput {
  /** The node currently materializing this slot. */
  nodeId: string;
  placeholderId: string;
  /** The box's CURRENT rect (the slot rect unless the user or refit moved it). */
  rect: { width: number; height: number };
  /** The dominant (max) run font size the node wears today. */
  fontSize: number;
  /** Plain text per paragraph (a bullet item is one paragraph). */
  paragraphs: string[];
}

export interface ReflowAdjustment {
  nodeId: string;
  /** The ladder size to apply across the node's runs. */
  fontSize: number;
}

export type ReflowVerdict = "fits" | "overfull" | "underfull";

export interface ReflowResult {
  adjustments: ReflowAdjustment[];
  /** Per placeholder id, after the best adjustment. */
  verdicts: Record<string, ReflowVerdict>;
  changed: boolean;
}

/** Lines the text needs at a font size in a box width (min 1 per paragraph). */
function neededLines(paragraphs: string[], fontSize: number, boxWidth: number): number {
  const charsPerLine = Math.max(4, Math.floor(boxWidth / (AVG_GLYPH_EM * fontSize)));
  let lines = 0;
  for (const p of paragraphs) {
    const len = p.trim().length;
    lines += Math.max(1, Math.ceil(len / charsPerLine));
  }
  return lines;
}

function availableLines(fontSize: number, boxHeight: number): number {
  return Math.max(1, Math.floor(boxHeight / (LINE_HEIGHT * fontSize)));
}

function fitsAt(slot: ReflowSlotInput, fontSize: number): boolean {
  return neededLines(slot.paragraphs, fontSize, slot.rect.width) <= availableLines(fontSize, slot.rect.height);
}

/** Reflow one layout-linked page. Slots whose role has no ladder (picture,
 *  chart, media, footer) are ignored; a slot whose CURRENT size sits above
 *  its ladder cap is treated as deliberately styled - reflow steps down from
 *  the user's own size on overflow but never "restores" past it. */
export function reflowPage(layout: SlideLayout, slots: ReflowSlotInput[]): ReflowResult {
  const roleById = new Map<string, Placeholder["role"]>();
  for (const ph of layout.placeholders ?? []) roleById.set(ph.id, ph.role);

  const adjustments: ReflowAdjustment[] = [];
  const verdicts: Record<string, ReflowVerdict> = {};

  for (const slot of slots) {
    const role = roleById.get(slot.placeholderId);
    if (role !== "title" && role !== "body" && role !== "content") continue;
    const hasText = slot.paragraphs.some((p) => p.trim().length > 0);
    if (!hasText) {
      verdicts[slot.placeholderId] = "fits";
      continue;
    }
    const baseLadder = reflowLadders[role];
    // A size the user chose deliberately (any size OFF the ladder, above the
    // cap or between steps) becomes that slot's own ceiling: the ladder below
    // it still absorbs overflow, but while the content fits reflow never
    // "corrects" a deliberate style choice onto the ladder in either
    // direction. On-ladder sizes step freely both ways.
    const ladder = baseLadder.includes(slot.fontSize)
      ? baseLadder
      : [slot.fontSize, ...baseLadder.filter((s) => s < slot.fontSize)];

    let chosen: number | null = null;
    for (const size of ladder) {
      if (fitsAt(slot, size)) {
        chosen = size;
        break;
      }
    }
    const floor = ladder[ladder.length - 1];
    const applied = chosen ?? floor;
    if (applied !== slot.fontSize) {
      adjustments.push({ nodeId: slot.nodeId, fontSize: applied });
    }
    if (chosen === null) {
      verdicts[slot.placeholderId] = "overfull";
    } else if (
      role === "content" &&
      chosen === ladder[0] &&
      neededLines(slot.paragraphs, chosen, slot.rect.width) * 3 < availableLines(chosen, slot.rect.height)
    ) {
      // A content slot using under a third of its room at full size reads as
      // sparse; the variant proposal (E17) may offer a lighter layout.
      verdicts[slot.placeholderId] = "underfull";
    } else {
      verdicts[slot.placeholderId] = "fits";
    }
  }

  return { adjustments, verdicts, changed: adjustments.length > 0 };
}

/** The number of content slots a layout offers (the density axis variants
 *  move along). */
function contentSlots(l: SlideLayout): number {
  return (l.placeholders ?? []).filter((p) => p.role === "content").length;
}

/** Pick the nearest DENSER (overfull) or SPARSER (underfull) variant of the
 *  current layout: a layout with a title slot and strictly more (or fewer,
 *  but at least one) content slots, nearest first, id as the deterministic
 *  tiebreak. Null when no variant would actually help. */
export function variantCandidate(
  layouts: SlideLayout[],
  currentId: string,
  direction: "denser" | "sparser",
): SlideLayout | null {
  const current = layouts.find((l) => l.id === currentId);
  if (!current) return null;
  const base = contentSlots(current);
  const hasTitle = (l: SlideLayout) => (l.placeholders ?? []).some((p) => p.role === "title");
  const candidates = layouts.filter((l) => {
    if (l.id === currentId || !hasTitle(l)) return false;
    const n = contentSlots(l);
    return direction === "denser" ? n > base : n < base && n >= 1;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const da = Math.abs(contentSlots(a) - base);
    const db = Math.abs(contentSlots(b) - base);
    if (da !== db) return da - db;
    return a.id < b.id ? -1 : 1;
  });
  return candidates[0];
}
