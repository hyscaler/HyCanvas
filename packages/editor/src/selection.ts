// Selection model (FR-1..FR-4). A small ordered set of node ids with the
// toggle/add/clear semantics the canvas and layer panel both drive. Marquee and
// click hit-testing come from the engine; here we filter to selectable nodes.

import { childrenOf, isContainer, type DesignFile, type Node } from "@hc/schema";
import type { Rect, Scene } from "@hc/engine";

/** A node is selectable by click/marquee when it is neither hidden nor locked. */
export function isSelectable(node: Node): boolean {
  return !node.hidden && !node.locked;
}

export class SelectionModel {
  private ids: string[] = [];

  get(): string[] {
    return [...this.ids];
  }
  has(id: string): boolean {
    return this.ids.includes(id);
  }
  set(ids: string[]): void {
    this.ids = [...new Set(ids)];
  }
  add(ids: string[]): void {
    for (const id of ids) if (!this.ids.includes(id)) this.ids.push(id);
  }
  remove(ids: string[]): void {
    const drop = new Set(ids);
    this.ids = this.ids.filter((id) => !drop.has(id));
  }
  /** Toggle membership without clearing the rest (Shift/Cmd-click, FR-2). */
  toggle(id: string): void {
    if (this.ids.includes(id)) this.remove([id]);
    else this.add([id]);
  }
  clear(): void {
    this.ids = [];
  }
}

/** All selectable top-level nodes on a page (Cmd/Ctrl+A, FR-4). */
export function selectAll(file: DesignFile, pageIndex = 0): string[] {
  const page = file.pages[pageIndex];
  return page ? page.children.filter(isSelectable).map((n) => n.id) : [];
}

/** All selectable nodes (any depth) sharing the seed node's type (FR-4). */
export function selectSameType(file: DesignFile, seedId: string, pageIndex = 0): string[] {
  const page = file.pages[pageIndex];
  if (!page) return [];
  let seedType: string | null = null;
  const all: Node[] = [];
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      all.push(n);
      if (n.id === seedId) seedType = n.type;
      if (isContainer(n)) walk(childrenOf(n));
    }
  };
  walk(page.children);
  if (!seedType) return [];
  return all.filter((n) => n.type === seedType && isSelectable(n)).map((n) => n.id);
}

/**
 * Marquee selection: hit-test the rectangle via the engine, then keep only
 * selectable (visible, unlocked) nodes (FR-3).
 */
export function marqueeSelect(
  scene: Scene,
  rect: Rect,
  mode: "intersect" | "contain",
): string[] {
  return scene
    .hitTestRect(rect, mode)
    .filter((n) => isSelectable(n))
    .map((n) => n.id);
}
