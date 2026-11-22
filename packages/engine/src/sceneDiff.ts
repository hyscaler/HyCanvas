// What changed between two builds of the same page, as one page-space
// rectangle to repaint.
//
// The editor rebuilds a page's scene on every edit. During a live transform
// (a drag, resize or rotate) only a few nodes move, so repainting the union of
// their old and new bounds is enough, instead of the whole canvas. This walks
// both scenes by node id and compares the cached world transform and bounds,
// which the scene computed when it was built: the nodes themselves are mutated
// in place by the editor, so the previous scene's cache is the only record of
// where they were.
//
// It only sees geometry. A change that leaves every node where it was (a new
// fill color, an image that finished loading) reports nothing, so the caller
// uses it only where geometry is the whole change, and repaints fully
// otherwise.

import type { Rect, Scene, SceneNode } from "./types";

export type SceneChange =
  /** Nothing moved. */
  | { kind: "none" }
  /** Repaint this page-space rectangle (old and new bounds of what moved). */
  | { kind: "region"; rect: Rect; changed: number }
  /** The node set differs, or something moved whose effect is not local
   *  (a connector follows a moved node): repaint everything. */
  | { kind: "all" };

function flatten(root: SceneNode, out: Map<string, SceneNode>, order: string[]): void {
  if (root.children) {
    for (const c of root.children) {
      out.set(c.node.id, c);
      order.push(c.node.id);
      flatten(c, out, order);
    }
  }
}

/** How far outside its box a node may paint, in its own units, estimated
 *  generously: a blurred shadow is visible to about three times its blur, a
 *  text effect scales with the type size, a stroke sits half outside. The
 *  scene's own bounds carry a tighter estimate that is fine for culling but
 *  would leave the edge of a soft shadow behind when its node moves away. */
function paintOverflow(node: SceneNode["node"]): number {
  const n = node as unknown as {
    stroke?: { width?: number };
    effects?: Array<Record<string, unknown>>;
    textEffects?: Array<Record<string, unknown>>;
    content?: Array<{ runs?: Array<{ style?: { fontSize?: number } }> }>;
  };
  let out = 2;
  if (typeof n.stroke?.width === "number") out += Math.max(0, n.stroke.width);
  const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? Math.abs(v) : 0);
  for (const e of n.effects ?? []) {
    if (e.enabled === false) continue;
    out = Math.max(out, 2 + Math.max(num(e.offsetX), num(e.offsetY)) + 3 * num(e.blur) + num(e.spread) + 3 * num(e.radius) + num(e.width));
  }
  if (n.textEffects?.length) {
    let fs = 0;
    for (const para of n.content ?? []) for (const run of para.runs ?? []) fs = Math.max(fs, num(run.style?.fontSize));
    for (const e of n.textEffects) {
      if (e.enabled === false) continue;
      let extra = fs; // neon, lift and echo scale with the type size
      for (const v of Object.values(e)) extra += 3 * num(v);
      out = Math.max(out, extra);
    }
  }
  return out;
}

function sameGeometry(a: SceneNode, b: SceneNode): boolean {
  const ta = a.worldTransform, tb = b.worldTransform;
  for (let i = 0; i < 6; i++) if (ta[i] !== tb[i]) return false;
  const ba = a.worldBounds, bb = b.worldBounds;
  return ba.x === bb.x && ba.y === bb.y && ba.width === bb.width && ba.height === bb.height;
}

/** Compare two scenes of the same page. */
export function diffScenes(prev: Scene, next: Scene): SceneChange {
  if (prev.activePageId !== next.activePageId) return { kind: "all" };
  const a = new Map<string, SceneNode>(), b = new Map<string, SceneNode>();
  const orderA: string[] = [], orderB: string[] = [];
  flatten(prev.root, a, orderA);
  flatten(next.root, b, orderB);
  // Added, removed or restacked nodes change what overlaps what.
  if (orderA.length !== orderB.length) return { kind: "all" };
  for (let i = 0; i < orderA.length; i++) if (orderA[i] !== orderB[i]) return { kind: "all" };

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const moved = new Set<string>();
  const add = (sn: SceneNode) => {
    const r = sn.worldBounds, t = sn.worldTransform;
    // Overflow in page units: the node's own, times its world scale.
    const pad = paintOverflow(sn.node) * Math.max(Math.hypot(t[0], t[1]), Math.hypot(t[2], t[3]), 1);
    x0 = Math.min(x0, r.x - pad); y0 = Math.min(y0, r.y - pad);
    x1 = Math.max(x1, r.x + r.width + pad); y1 = Math.max(y1, r.y + r.height + pad);
  };
  for (const id of orderB) {
    const pa = a.get(id)!, pb = b.get(id)!;
    if (pa.node.type !== pb.node.type) return { kind: "all" };
    if (sameGeometry(pa, pb)) continue;
    moved.add(id);
    add(pa);
    add(pb);
  }
  if (moved.size === 0) return { kind: "none" };
  // A connector attached to a moved node re-routes along a path its own box
  // does not bound, so its old and new strokes cannot be bounded here.
  for (const id of orderB) {
    const n = b.get(id)!.node as { type: string; start?: { attach?: { nodeId: string } }; end?: { attach?: { nodeId: string } } };
    if (n.type !== "connector") continue;
    if (moved.has(id)) return { kind: "all" };
    const s = n.start?.attach?.nodeId, e = n.end?.attach?.nodeId;
    if ((s && moved.has(s)) || (e && moved.has(e))) return { kind: "all" };
  }
  if (!isFinite(x0) || !isFinite(y0) || !isFinite(x1) || !isFinite(y1)) return { kind: "all" };
  return { kind: "region", rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, changed: moved.size };
}
