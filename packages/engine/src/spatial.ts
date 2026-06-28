// Spatial index (F30 FR-27): a uniform-grid spatial hash over page-space AABBs.
// Gives sublinear viewport queries for render culling, presence interest
// management, and the AI agent's off-screen cluster context. Pure, no DOM.
//
// A uniform grid (vs a quadtree) is simple, allocation-light, and ideal for the
// typical board where nodes are small relative to the canvas; a single very large
// node spans many cells (more bucket entries) but still queries correctly. The
// query re-tests the precise AABB so callers get exact intersect results.

import type { Rect } from "./math";
import { rectIntersects } from "./math";

export class SpatialIndex {
  private readonly cell: number;
  private readonly buckets = new Map<string, string[]>();
  private readonly rects = new Map<string, Rect>();

  constructor(cellSize = 512) {
    this.cell = Math.max(1, cellSize);
  }

  private key(cx: number, cy: number): string {
    return cx + ":" + cy;
  }

  private cellsOf(r: Rect): { x0: number; y0: number; x1: number; y1: number } {
    return {
      x0: Math.floor(r.x / this.cell),
      y0: Math.floor(r.y / this.cell),
      x1: Math.floor((r.x + r.width) / this.cell),
      y1: Math.floor((r.y + r.height) / this.cell),
    };
  }

  /** Index `id` by its page-space AABB (last write wins for a repeated id). */
  insert(id: string, rect: Rect): void {
    if (this.rects.has(id)) this.remove(id);
    this.rects.set(id, rect);
    const c = this.cellsOf(rect);
    for (let cy = c.y0; cy <= c.y1; cy++) {
      for (let cx = c.x0; cx <= c.x1; cx++) {
        const k = this.key(cx, cy);
        const b = this.buckets.get(k);
        if (b) b.push(id);
        else this.buckets.set(k, [id]);
      }
    }
  }

  remove(id: string): void {
    const r = this.rects.get(id);
    if (!r) return;
    this.rects.delete(id);
    const c = this.cellsOf(r);
    for (let cy = c.y0; cy <= c.y1; cy++) {
      for (let cx = c.x0; cx <= c.x1; cx++) {
        const k = this.key(cx, cy);
        const b = this.buckets.get(k);
        if (!b) continue;
        const i = b.indexOf(id);
        if (i >= 0) b.splice(i, 1);
        if (b.length === 0) this.buckets.delete(k);
      }
    }
  }

  /** Ids whose AABB intersects `rect`, deduped and precise-intersect-filtered. */
  queryRect(rect: Rect): string[] {
    const c = this.cellsOf(rect);
    const seen = new Set<string>();
    const out: string[] = [];
    for (let cy = c.y0; cy <= c.y1; cy++) {
      for (let cx = c.x0; cx <= c.x1; cx++) {
        const b = this.buckets.get(this.key(cx, cy));
        if (!b) continue;
        for (const id of b) {
          if (seen.has(id)) continue;
          seen.add(id);
          const r = this.rects.get(id);
          if (r && rectIntersects(rect, r)) out.push(id);
        }
      }
    }
    return out;
  }

  get size(): number {
    return this.rects.size;
  }
}
