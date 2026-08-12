// Scene graph: a parallel SceneNode tree over the scene-model Node tree, caching
// each node's world affine and axis-aligned page-space bounds (including effect
// bleed). One recursive build feeds render, hit-test, bounds, and dirty-rect.

import {
  isContainer,
  childrenOf,
  childNodesOf,
  type DesignFile,
  type Effect,
  type Node,
} from "@hc/schema";
import { enabledEffects } from "@hc/schema";
import { pointInLocalShape } from "./hit";
import { SpatialIndex } from "./spatial";
import {
  applyToPoint,
  fromTransform,
  identity,
  invert,
  matToArray,
  multiply,
  rectContainsRect,
  rectInflate,
  rectIntersects,
  rectUnion,
  transformRect,
  type Mat2D,
  type Point,
  type Rect,
} from "./math";
import type { HitOpts, Scene, SceneNode } from "./types";

// A Gaussian blur is visually ~3 standard deviations wide on each side. CSS
// `filter: blur(r)` uses r directly as the standard deviation, so its halo
// extends ~3r past the box; `drop-shadow`/`box-shadow` blur (how glow and drop
// shadows render here) uses std-dev = blur/2, so the halo extends ~1.5x its
// blur radius. Bounding only by the nominal radius (the old behavior) clipped
// the outer two-thirds of a blur halo, which showed as a sliver vanishing at
// the viewport edge under culling and as repaint residue from dirty-region
// invalidation. We bound by the visible extent instead.
const BLUR_HALO = 3; // filter: blur(r) -> ~3r
const SHADOW_HALO = 1.5; // drop-shadow blur -> ~1.5 * blur

/** Maximum outward bleed (in local px) a node's effects add to its bounds. */
export function effectBleed(node: Node): number {
  // Bounds follow what renders: a disabled blur must stop reserving its halo,
  // or the node keeps a ring of stale invalidation and culling slack.
  const effects = enabledEffects(node.effects);
  if (effects.length === 0) return 0;
  let bleed = 0;
  for (const e of effects as Effect[]) {
    switch (e.kind) {
      case "blur":
        bleed = Math.max(bleed, e.radius * BLUR_HALO);
        break;
      case "glow":
        bleed = Math.max(bleed, e.radius * SHADOW_HALO);
        break;
      case "outline":
        bleed = Math.max(bleed, e.width);
        break;
      case "shadow":
        bleed = Math.max(
          bleed,
          Math.abs(e.offsetX) + e.blur * SHADOW_HALO + e.spread,
          Math.abs(e.offsetY) + e.blur * SHADOW_HALO + e.spread,
        );
        break;
      default:
        break;
    }
  }
  return bleed;
}

/** Half a centered stroke bleeds outward past the node's geometric box, so a
 *  thick-stroked shape/line/path paints past `node.size`. Strokes are not in
 *  `node.effects`, so this is bounded separately and added to the effect bleed.
 */
function strokeBleed(node: Node): number {
  const w = (node as { stroke?: { width?: number } }).stroke?.width;
  return typeof w === "number" && w > 0 ? w / 2 : 0;
}

function localBox(node: Node): Rect {
  return { x: 0, y: 0, width: node.size.width, height: node.size.height };
}

/** Page-space AABB of a node under `world`, grown by its (transformed) bleed. */
function computeWorldBounds(node: Node, world: Mat2D): Rect {
  const inflated = rectInflate(localBox(node), effectBleed(node) + strokeBleed(node));
  return transformRect(world, inflated);
}

// The active page is modeled as an implicit root group so the whole subtree is
// one uniform SceneNode tree.
function pageRootNode(file: DesignFile, pageIndex: number): Node {
  const page = file.pages[pageIndex];
  return {
    id: page.id,
    type: "group",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: page.width, height: page.height },
    opacity: 1,
    blendMode: "normal",
    children: page.children,
  } as Node;
}

function buildSceneNode(
  node: Node,
  parentWorld: Mat2D,
  parent: SceneNode | null,
  index: Map<string, SceneNode>,
): SceneNode {
  const world = multiply(parentWorld, fromTransform(node.transform));
  const sn: SceneNode = {
    node,
    worldTransform: matToArray(world),
    worldBounds: computeWorldBounds(node, world),
    dirty: false,
    parent,
  };
  // Duplicate ids are rejected by schema validate(); if one slips through, the
  // first occurrence wins rather than being silently shadowed.
  if (!index.has(node.id)) index.set(node.id, sn);
  // A mask stores its subject in `child`, not `children`, and building no
  // SceneNode for it left the subject invisible to render, hit test, bounds and
  // the spatial index. That absence is why masks drew a placeholder box.
  //
  // Boolean OPERANDS are deliberately excluded even though `childNodesOf`
  // returns them. They are inputs consumed into the boolean's own geometry, not
  // artwork in their own right: adding them here would paint each operand on
  // top of the combined result and make them separately selectable, which is
  // exactly what a boolean exists to stop. Traversal still sees them, because
  // id-uniqueness and version diffs must.
  const nested = isContainer(node)
    ? childrenOf(node)
    : node.type === "mask"
      ? childNodesOf(node)
      : [];
  if (nested.length > 0) {
    sn.children = nested.map((child) => buildSceneNode(child, world, sn, index));
  }
  return sn;
}

function mat(sn: SceneNode): Mat2D {
  const m = sn.worldTransform;
  return { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] };
}

/** Asset ids a node references (primary media + QR logo). */
function assetIdsOf(node: Node): string[] {
  const ids: string[] = [];
  // Image nodes hold their asset under `source.assetId`; others use `assetId`.
  if (node.type === "image") {
    const src = (node as { source?: { assetId?: unknown } }).source;
    if (typeof src?.assetId === "string" && src.assetId.length > 0) ids.push(src.assetId);
    // The alpha mask is a second asset on the same node. Without it here the
    // loader never fetches it, and the image would draw unmasked forever with
    // no clue why.
    const mask = (node as { alphaMask?: { assetId?: unknown } }).alphaMask;
    if (typeof mask?.assetId === "string" && mask.assetId.length > 0) ids.push(mask.assetId);
  } else {
    const direct = (node as { assetId?: unknown }).assetId;
    if (typeof direct === "string" && direct.length > 0) ids.push(direct);
  }
  const logo = (node as { logoAssetId?: unknown }).logoAssetId;
  if (typeof logo === "string" && logo.length > 0) ids.push(logo);
  return ids;
}

// --- connector hit geometry -------------------------------------------------
// A connector's drawn geometry is the routed polyline between its two endpoints,
// resolved from the live boxes of the nodes it attaches to (see render2d's
// drawConnector). pointInLocalShape can't see those boxes, so connector hit-
// testing happens here against the same routed polyline. Keep this in sync with
// render2d's routing so the clickable line matches what is drawn.

type HitBox = { x: number; y: number; width: number; height: number };
type ConnEnd = { point?: Point; attach?: { nodeId: string; anchor: string } };

function connectorAnchor(box: HitBox, anchor: string, toward: Point | null): Point {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  switch (anchor) {
    case "top": return { x: cx, y: box.y };
    case "bottom": return { x: cx, y: box.y + box.height };
    case "left": return { x: box.x, y: cy };
    case "right": return { x: box.x + box.width, y: cy };
    case "center": return { x: cx, y: cy };
    default: {
      const sides = [
        { x: cx, y: box.y },
        { x: box.x + box.width, y: cy },
        { x: cx, y: box.y + box.height },
        { x: box.x, y: cy },
      ];
      const target = toward ?? { x: box.x + box.width, y: cy };
      let best = sides[0];
      let bestD = Infinity;
      for (const s of sides) {
        const d = (s.x - target.x) ** 2 + (s.y - target.y) ** 2;
        if (d < bestD) { bestD = d; best = s; }
      }
      return best;
    }
  }
}

function connectorEndRefCenter(ep: ConnEnd, boxes: Record<string, HitBox>): Point | null {
  if (ep.attach && boxes[ep.attach.nodeId]) {
    const b = boxes[ep.attach.nodeId];
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  return ep.point ?? null;
}

function resolveConnectorEndpoint(ep: ConnEnd, boxes: Record<string, HitBox>, toward: Point | null): Point {
  if (ep.attach && boxes[ep.attach.nodeId]) return connectorAnchor(boxes[ep.attach.nodeId], ep.attach.anchor, toward);
  return ep.point ?? { x: 0, y: 0 };
}

/** Visit each point with axis-aligned segments (engine mirror of the same helper
 *  in render2d.ts) so an elbow route through waypoints hit-tests where it draws. */
function orthogonalChain(points: Point[]): Point[] {
  if (points.length === 0) return [];
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = out[out.length - 1];
    const q = points[i];
    if (p.x !== q.x && p.y !== q.y) out.push({ x: q.x, y: p.y });
    out.push(q);
  }
  return out;
}

/** The connector's routed polyline in page space (straight/elbow; curved is
 *  approximated by its elbow polyline for hit-testing). Mirrors render2d's
 *  drawConnector, including user waypoints (FR-8), so the clickable line and the
 *  selection bounds match exactly what is drawn. */
function connectorPolyline(
  conn: { route: string; start: ConnEnd; end: ConnEnd; waypoints?: Point[] },
  boxes: Record<string, HitBox>,
): Point[] {
  const a = resolveConnectorEndpoint(conn.start, boxes, connectorEndRefCenter(conn.end, boxes));
  const b = resolveConnectorEndpoint(conn.end, boxes, connectorEndRefCenter(conn.start, boxes));
  // User waypoints: route through them (elbow stays orthogonal), matching the
  // renderer. Curved+waypoints draws as a polyline, so the hit polyline matches.
  const wps = conn.waypoints && conn.waypoints.length > 0 ? conn.waypoints : null;
  if (wps) {
    const through = [a, ...wps, b];
    return conn.route === "elbow" ? orthogonalChain(through) : through;
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (conn.route === "straight" || (dx === 0 && dy === 0)) return [a, b];
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dy === 0) return [a, b];
    const midX = a.x + dx / 2;
    return [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
  }
  if (dx === 0) return [a, b];
  const midY = a.y + dy / 2;
  return [a, { x: a.x, y: midY }, { x: b.x, y: midY }, b];
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

class SceneImpl implements Scene {
  readonly file: DesignFile;
  readonly activePageId: string;
  root: SceneNode;
  private index = new Map<string, SceneNode>();
  private assetIndex = new Map<string, Set<string>>();
  private dirty: Rect | null = null;
  // Lazily built over the scene's selectable leaves; a scene is rebuilt on doc
  // edits (getScene cache invalidates on rev), so the static index is fine.
  private spatial: SpatialIndex | null = null;

  constructor(file: DesignFile, pageIndex: number) {
    this.file = file;
    this.activePageId = file.pages[pageIndex].id;
    this.root = buildSceneNode(
      pageRootNode(file, pageIndex),
      identity(),
      null,
      this.index,
    );
    for (const sn of this.index.values()) {
      for (const assetId of assetIdsOf(sn.node)) {
        let set = this.assetIndex.get(assetId);
        if (!set) {
          set = new Set();
          this.assetIndex.set(assetId, set);
        }
        set.add(sn.node.id);
      }
    }
  }

  getSceneNode(nodeId: string): SceneNode | null {
    return this.index.get(nodeId) ?? null;
  }

  /** Page-space boxes (translate + scale, mirroring render2d's buildBoxMap) for
   *  every node, used to resolve connector endpoints during hit-testing. */
  private boxMap(): Record<string, HitBox> {
    const boxes: Record<string, HitBox> = {};
    for (const sn of this.index.values()) {
      const wt = sn.worldTransform;
      const sx = Math.hypot(wt[0], wt[1]) || 1;
      const sy = Math.hypot(wt[2], wt[3]) || 1;
      boxes[sn.node.id] = {
        x: wt[4],
        y: wt[5],
        width: sn.node.size.width * sx,
        height: sn.node.size.height * sy,
      };
    }
    return boxes;
  }

  /** True if a page-space point lands on a connector's routed line (within a
   *  click-friendly tolerance). */
  private connectorHit(node: Node, point: Point): boolean {
    const conn = node as unknown as {
      route: string;
      start?: ConnEnd;
      end?: ConnEnd;
      stroke?: { width?: number };
      waypoints?: Point[];
    };
    if (!conn.start || !conn.end) return false;
    const pts = connectorPolyline({ route: conn.route, start: conn.start, end: conn.end, waypoints: conn.waypoints }, this.boxMap());
    const tol = Math.max(6, (conn.stroke?.width ?? 2) / 2 + 5);
    for (let i = 0; i < pts.length - 1; i++) {
      if (distToSegment(point, pts[i], pts[i + 1]) <= tol) return true;
    }
    return false;
  }

  nodesUsingAsset(assetId: string): string[] {
    const set = this.assetIndex.get(assetId);
    return set ? [...set] : [];
  }

  getBounds(nodeId: string): Rect | null {
    return this.index.get(nodeId)?.worldBounds ?? null;
  }

  connectorBounds(nodeId: string): Rect | null {
    const sn = this.index.get(nodeId);
    if (!sn || sn.node.type !== "connector") return null;
    const conn = sn.node as unknown as { route: string; start?: ConnEnd; end?: ConnEnd; waypoints?: Point[] };
    if (!conn.start || !conn.end) return null;
    const pts = connectorPolyline({ route: conn.route, start: conn.start, end: conn.end, waypoints: conn.waypoints }, this.boxMap());
    if (pts.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  markDirty(nodeId: string): void {
    const sn = this.index.get(nodeId);
    if (!sn) return;
    sn.dirty = true;
    this.invalidateRegion(sn.worldBounds);
  }

  invalidateRegion(rect: Rect): void {
    this.dirty = this.dirty ? rectUnion(this.dirty, rect) : { ...rect };
  }

  dirtyRegion(): Rect | null {
    return this.dirty;
  }

  clearDirty(): void {
    this.dirty = null;
  }

  hitTest(point: Point, opts: HitOpts = {}): Node | null {
    const ignoreLocked = opts.ignoreLocked !== false;
    const deep = opts.deep !== false;
    const precise = opts.alpha !== false;

    const visit = (sn: SceneNode): Node | null => {
      const node = sn.node;
      if (node.hidden) return null;
      // Children paint above the parent, so test them front-to-back first.
      if (sn.children && deep) {
        for (let i = sn.children.length - 1; i >= 0; i--) {
          const hit = visit(sn.children[i]);
          if (!hit) continue;
          // A mask selects as a UNIT, like a group. Its subject is what makes
          // the hit precise (you can only click where the mask actually shows
          // something), but the MASK is what gets returned, for two reasons: a
          // mask is one object as far as the user is concerned, and its subject
          // lives in `child` rather than `children`, so `@hc/editor`'s
          // `locate()` cannot find it. Returning the subject produced a
          // selection that every store action silently ignored, because they
          // all begin by locating the id and bailing when that fails.
          if (node.type !== "mask") return hit;
          return ignoreLocked && node.locked ? null : node;
        }
      }
      if (sn === this.root) return null; // the implicit page root is not selectable
      if (ignoreLocked && node.locked) return null;
      // Groups have no own surface; only their children are hittable. A mask is
      // the same: it is selectable only where its subject actually paints, so
      // an empty corner of its box is not an invisible click target.
      if (node.type === "group" || node.type === "mask") return null;

      // Connectors are routed lines between attached nodes, not a box at the
      // node's own transform; test the page-space point against the routed line.
      if (node.type === "connector") return this.connectorHit(node, point) ? node : null;

      const inv = invert(mat(sn));
      if (!inv) return null;
      const local = applyToPoint(inv, point);
      return pointInLocalShape(node, local, precise) ? node : null;
    };

    return visit(this.root);
  }

  queryViewport(rect: Rect): Node[] {
    if (!this.spatial) {
      const idx = new SpatialIndex();
      for (const sn of this.index.values()) {
        if (sn === this.root || isContainer(sn.node)) continue; // selectable leaves only
        // A masked subject is not independently selectable (the mask is the
        // unit), so it must not appear as a leaf here either. Presence
        // interest-management and the AI agent's off-screen context both read
        // this, and both should see the mask.
        if (sn.parent?.node.type === "mask") continue;
        idx.insert(sn.node.id, sn.worldBounds);
      }
      this.spatial = idx;
    }
    const out: Node[] = [];
    for (const id of this.spatial.queryRect(rect)) {
      const sn = this.index.get(id);
      if (sn && !sn.node.hidden) out.push(sn.node);
    }
    return out;
  }

  hitTestRect(rect: Rect, mode: "intersect" | "contain"): Node[] {
    const out: Node[] = [];
    const top = this.root.children ?? [];
    for (const sn of top) {
      if (sn.node.hidden) continue;
      const ok =
        mode === "contain"
          ? rectContainsRect(rect, sn.worldBounds)
          : rectIntersects(rect, sn.worldBounds);
      if (ok) out.push(sn.node);
    }
    return out;
  }
}

/** Build an in-memory scene from a design file (FR-1). */
export function createScene(file: DesignFile, pageIndex = 0): Scene {
  if (file.pages.length === 0) {
    throw new Error("createScene: design has no pages");
  }
  const idx = Math.max(0, Math.min(pageIndex, file.pages.length - 1));
  return new SceneImpl(file, idx);
}
