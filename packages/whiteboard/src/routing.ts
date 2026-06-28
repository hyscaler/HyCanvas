// Connector routing (FR-4, FR-11). Pure, deterministic, side-effect free.
// Resolves connector endpoints against node bounding boxes and produces a
// polyline for the renderer. Three styles: straight, elbow (orthogonal), and
// curved (elbow control points plus a midpoint for the renderer to curve).

import type { EndPoint } from "@hc/schema";

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Anchor = "top" | "right" | "bottom" | "left" | "center" | "auto";

/** Center of a box. */
function boxCenter(box: Box): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * The connection point on a box for a given anchor. "center" returns the box
 * center; "auto" picks the side whose midpoint is nearest `toward` (falling
 * back to the right side when `toward` is absent).
 */
export function anchorPoint(box: Box, anchor: Anchor, toward?: Point): Point {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  switch (anchor) {
    case "top":
      return { x: cx, y: box.y };
    case "bottom":
      return { x: cx, y: box.y + box.height };
    case "left":
      return { x: box.x, y: cy };
    case "right":
      return { x: box.x + box.width, y: cy };
    case "center":
      return { x: cx, y: cy };
    case "auto": {
      const sides: { side: Exclude<Anchor, "auto" | "center">; pt: Point }[] = [
        { side: "top", pt: { x: cx, y: box.y } },
        { side: "right", pt: { x: box.x + box.width, y: cy } },
        { side: "bottom", pt: { x: cx, y: box.y + box.height } },
        { side: "left", pt: { x: box.x, y: cy } },
      ];
      const target = toward ?? { x: box.x + box.width, y: cy };
      let best = sides[0];
      let bestD = Infinity;
      for (const s of sides) {
        const dx = s.pt.x - target.x;
        const dy = s.pt.y - target.y;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      return best.pt;
    }
  }
}

function normalizeAnchor(a: string | undefined): Anchor {
  switch (a) {
    case "top":
    case "right":
    case "bottom":
    case "left":
    case "center":
    case "auto":
      return a;
    default:
      return "auto";
  }
}

/**
 * Resolve a single endpoint to an absolute point. When the endpoint attaches to
 * a known node, use that node box's anchor (steering an "auto" anchor toward the
 * other endpoint's reference point). Otherwise use the floating `point`.
 */
function resolveEndpoint(
  ep: EndPoint,
  boxes: Record<string, Box>,
  otherRef: Point | undefined,
): Point {
  if (ep.attach && boxes[ep.attach.nodeId]) {
    const box = boxes[ep.attach.nodeId];
    return anchorPoint(box, normalizeAnchor(ep.attach.anchor), otherRef);
  }
  if (ep.point) return { x: ep.point.x, y: ep.point.y };
  return { x: 0, y: 0 };
}

/** Reference point used to steer the opposite endpoint's "auto" anchor. */
function endpointReference(ep: EndPoint, boxes: Record<string, Box>): Point | undefined {
  if (ep.attach && boxes[ep.attach.nodeId]) return boxCenter(boxes[ep.attach.nodeId]);
  if (ep.point) return { x: ep.point.x, y: ep.point.y };
  return undefined;
}

export interface RoutableConnector {
  route: "straight" | "elbow" | "curved";
  start: EndPoint;
  end: EndPoint;
  /** Optional user-placed bend points the route must visit, in order (FR-8). */
  waypoints?: Point[];
}

/**
 * Visit each point with orthogonal (axis-aligned) segments, inserting an L-bend
 * (horizontal-first) between any two points that are not already aligned. Used
 * to route an elbow connector through user waypoints.
 */
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

/**
 * Build the polyline for a connector. Deterministic and pure.
 *  - "straight": [start, end].
 *  - "elbow": orthogonal route, splitting on the dominant axis (3 to 5 points).
 *  - "curved": the elbow's endpoints plus a single midpoint control; the
 *     renderer draws the smooth curve through these.
 */
export function routeConnector(
  conn: RoutableConnector,
  boxes: Record<string, Box>,
): Point[] {
  // Steer auto anchors toward the other endpoint's reference.
  const startRef = endpointReference(conn.start, boxes);
  const endRef = endpointReference(conn.end, boxes);
  const a = resolveEndpoint(conn.start, boxes, endRef);
  const b = resolveEndpoint(conn.end, boxes, startRef);

  // User waypoints (FR-8): the route visits each in order. Straight and curved
  // pass through them directly as a polyline (curved is NOT spline-smoothed once
  // waypoints are present, so the rendered line and the hit-test polyline stay
  // identical); elbow routes orthogonally between consecutive points.
  const wps = conn.waypoints ?? [];
  if (wps.length > 0) {
    const through = [a, ...wps, b];
    return conn.route === "elbow" ? orthogonalChain(through) : through;
  }

  if (conn.route === "straight") {
    return [a, b];
  }

  const dx = b.x - a.x;
  const dy = b.y - a.y;

  // Degenerate: same point.
  if (dx === 0 && dy === 0) {
    return conn.route === "curved" ? [a, { x: a.x, y: a.y }, b] : [a, b];
  }

  // Orthogonal elbow: split on the dominant axis at the midpoint.
  let elbow: Point[];
  if (Math.abs(dx) >= Math.abs(dy)) {
    // Dominant horizontal: go to mid-x, turn vertically, continue.
    if (dy === 0) {
      elbow = [a, b];
    } else {
      const midX = a.x + dx / 2;
      elbow = [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
    }
  } else {
    // Dominant vertical: go to mid-y, turn horizontally, continue.
    if (dx === 0) {
      elbow = [a, b];
    } else {
      const midY = a.y + dy / 2;
      elbow = [a, { x: a.x, y: midY }, { x: b.x, y: midY }, b];
    }
  }

  if (conn.route === "elbow") {
    return elbow;
  }

  // Curved: endpoints plus a midpoint control between them.
  const mid: Point = { x: a.x + dx / 2, y: a.y + dy / 2 };
  return [a, mid, b];
}
