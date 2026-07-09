// Accessibility helpers over the open format (doc 28 FR-29).
//
// Pure and framework-agnostic: reading order and alt text are properties of the
// document, so the checker, the editor's Reading Order pane, and an accessible
// export (tagged PDF) all resolve them the same way.
//
// The guiding rule is that these fields can never hide content. An absent
// `readingOrder` falls back to z-order; a partial one is completed with the
// remaining nodes in z-order; ids that no longer exist are ignored.

import type { DesignFile, Node, Page } from "./schema";

/** The alt text a node exposes to assistive technology, if any.
 *  `NodeBase.altText` generalizes the older image-only `ImageNode.alt`, which
 *  stays supported so files written before v12 keep their descriptions. */
export function nodeAltText(node: Node): string | undefined {
  const generic = (node as { altText?: string }).altText?.trim();
  if (generic) return generic;
  const imageAlt = node.type === "image" ? (node as { alt?: string }).alt?.trim() : undefined;
  return imageAlt || undefined;
}

/** True when the node is marked presentational, so a checker should not demand
 *  a description and an accessible export should skip it. */
export function isDecorative(node: Node): boolean {
  return (node as { decorative?: boolean }).decorative === true;
}

/** A node needs alt text when it conveys meaning: it is an image (or carries a
 *  link/interaction) and is neither decorative nor already described. */
export function needsAltText(node: Node): boolean {
  if (isDecorative(node)) return false;
  if (nodeAltText(node)) return false;
  return node.type === "image";
}

/**
 * The order assistive technology should traverse a page's top-level nodes.
 *
 * Resolution: take `page.readingOrder`, keep only ids that still exist, then
 * append every remaining node in z-order. So a missing list means pure z-order,
 * a stale id is dropped rather than throwing, and a node added after the list
 * was authored still gets read. Nothing is ever omitted.
 */
export function resolveReadingOrder(page: Page): Node[] {
  const children = page.children ?? [];
  if (!page.readingOrder?.length) return [...children];
  const byId = new Map(children.map((n) => [n.id, n]));
  const ordered: Node[] = [];
  const taken = new Set<string>();
  for (const id of page.readingOrder) {
    const n = byId.get(id);
    if (n && !taken.has(id)) {
      ordered.push(n);
      taken.add(id);
    }
  }
  for (const n of children) if (!taken.has(n.id)) ordered.push(n); // never hide a node
  return ordered;
}

/** The reading order as ids, normalized (existing ids first, then the rest in
 *  z-order). Writing this back makes an implicit order explicit. */
export function normalizeReadingOrder(page: Page): string[] {
  return resolveReadingOrder(page).map((n) => n.id);
}

/** Move the node at `from` to `to` within a page's reading order, returning the
 *  new id list. Used by the Reading Order pane's drag-to-reorder. */
export function moveInReadingOrder(page: Page, from: number, to: number): string[] {
  const ids = normalizeReadingOrder(page);
  if (from < 0 || from >= ids.length || to < 0 || to >= ids.length || from === to) return ids;
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Every node on a page that still needs a description, in reading order. */
export function nodesNeedingAltText(page: Page): Node[] {
  return resolveReadingOrder(page).filter(needsAltText);
}

/** Deck-wide count of nodes still missing a description (decorative excluded). */
export function missingAltTextCount(file: DesignFile): number {
  return file.pages.reduce((acc, p) => acc + nodesNeedingAltText(p).length, 0);
}
