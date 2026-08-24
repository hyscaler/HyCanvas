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
    const titleNode = texts.length ? texts.reduce((a, b) => (maxFontOf(b) > maxFontOf(a) ? b : a)) : null;

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
    const signature = slots.map((s) => signatureCell(s.role, s.rect, page)).sort().join("|");

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
