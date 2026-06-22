// Scene graph: a parallel SceneNode tree over the scene-model Node tree, caching
// each node's world affine and axis-aligned page-space bounds (including effect
// bleed). One recursive build feeds render, hit-test, bounds, and dirty-rect.

import {
  isContainer,
  childrenOf,
  type DesignFile,
  type Effect,
  type Node,
} from "@hc/schema";
import { pointInLocalShape } from "./hit";
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

/** Maximum outward bleed (in local px) a node's effects add to its bounds. */
export function effectBleed(node: Node): number {
  const effects = node.effects;
  if (!effects || effects.length === 0) return 0;
  let bleed = 0;
  for (const e of effects as Effect[]) {
    switch (e.kind) {
      case "blur":
        bleed = Math.max(bleed, e.radius);
        break;
      case "glow":
        bleed = Math.max(bleed, e.radius);
        break;
      case "outline":
        bleed = Math.max(bleed, e.width);
        break;
      case "shadow":
        bleed = Math.max(
          bleed,
          Math.abs(e.offsetX) + e.blur + e.spread,
          Math.abs(e.offsetY) + e.blur + e.spread,
        );
        break;
      default:
        break;
    }
  }
  return bleed;
}

function localBox(node: Node): Rect {
  return { x: 0, y: 0, width: node.size.width, height: node.size.height };
}

/** Page-space AABB of a node under `world`, grown by its (transformed) bleed. */
function computeWorldBounds(node: Node, world: Mat2D): Rect {
  const inflated = rectInflate(localBox(node), effectBleed(node));
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
  if (isContainer(node)) {
    sn.children = childrenOf(node).map((child) =>
      buildSceneNode(child, world, sn, index),
    );
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

/** The connector's routed polyline in page space (straight/elbow; curved is
 *  approximated by its elbow polyline for hit-testing). */
function connectorPolyline(
  conn: { route: string; start: ConnEnd; end: ConnEnd },
  boxes: Record<string, HitBox>,
): Point[] {
  const a = resolveConnectorEndpoint(conn.start, boxes, connectorEndRefCenter(conn.end, boxes));
  const b = resolveConnectorEndpoint(conn.end, boxes, connectorEndRefCenter(conn.start, boxes));
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
    };
    if (!conn.start || !conn.end) return false;
    const pts = connectorPolyline({ route: conn.route, start: conn.start, end: conn.end }, this.boxMap());
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
    const conn = sn.node as unknown as { route: string; start?: ConnEnd; end?: ConnEnd };
    if (!conn.start || !conn.end) return null;
    const pts = connectorPolyline({ route: conn.route, start: conn.start, end: conn.end }, this.boxMap());
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
          if (hit) return hit;
        }
      }
      if (sn === this.root) return null; // the implicit page root is not selectable
      if (ignoreLocked && node.locked) return null;
      // Groups have no own surface; only their children are hittable.
      if (node.type === "group") return null;

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
