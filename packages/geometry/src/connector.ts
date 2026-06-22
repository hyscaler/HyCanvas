// Connector routing. Produces an open VectorPath between two
// resolved endpoints. Obstacle-avoiding auto-routing is deferred.

import type { VectorPath } from "@hc/schema";
import type { Point } from "./types";

export type ConnectorRoute = "straight" | "elbow" | "curved";

function openPath(points: Point[]): VectorPath {
  return {
    subpaths: [{ closed: false, anchors: points.map((p) => ({ x: p.x, y: p.y, corner: true })) }],
    fillRule: "nonzero",
  };
}

export function routeConnector(start: Point, end: Point, route: ConnectorRoute): VectorPath {
  if (route === "elbow") {
    const midX = (start.x + end.x) / 2;
    return openPath([start, { x: midX, y: start.y }, { x: midX, y: end.y }, end]);
  }
  if (route === "curved") {
    // Bow horizontally; fall back to the vertical span so a vertical connector
    // still curves instead of collapsing to a straight line.
    const dx = (end.x - start.x) / 2 || (end.y - start.y) / 2;
    return {
      subpaths: [
        {
          closed: false,
          anchors: [
            { x: start.x, y: start.y, outHandle: { x: dx, y: 0 } },
            { x: end.x, y: end.y, inHandle: { x: -dx, y: 0 } },
          ],
        },
      ],
      fillRule: "nonzero",
    };
  }
  return openPath([start, end]); // straight
}
