import { describe, it, expect } from "vitest";
import { anchorPoint, routeConnector, type Box } from "../routing";

const boxA: Box = { x: 0, y: 0, width: 100, height: 100 };
const boxB: Box = { x: 300, y: 0, width: 100, height: 100 };

describe("anchorPoint", () => {
  it("returns the correct fixed side points", () => {
    expect(anchorPoint(boxA, "top")).toEqual({ x: 50, y: 0 });
    expect(anchorPoint(boxA, "bottom")).toEqual({ x: 50, y: 100 });
    expect(anchorPoint(boxA, "left")).toEqual({ x: 0, y: 50 });
    expect(anchorPoint(boxA, "right")).toEqual({ x: 100, y: 50 });
    expect(anchorPoint(boxA, "center")).toEqual({ x: 50, y: 50 });
  });

  it("auto picks the side nearest toward", () => {
    // toward a point to the right -> right side
    expect(anchorPoint(boxA, "auto", { x: 500, y: 50 })).toEqual({ x: 100, y: 50 });
    // toward a point above -> top side
    expect(anchorPoint(boxA, "auto", { x: 50, y: -500 })).toEqual({ x: 50, y: 0 });
    // toward a point below -> bottom side
    expect(anchorPoint(boxA, "auto", { x: 50, y: 500 })).toEqual({ x: 50, y: 100 });
  });

  it("auto without toward falls back to the right side", () => {
    expect(anchorPoint(boxA, "auto")).toEqual({ x: 100, y: 50 });
  });
});

describe("routeConnector", () => {
  const boxes = { a: boxA, b: boxB };

  it("straight returns just the two endpoints", () => {
    const pts = routeConnector(
      { route: "straight", start: { point: { x: 0, y: 0 } }, end: { point: { x: 10, y: 20 } } },
      {},
    );
    expect(pts).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 20 },
    ]);
  });

  it("resolves attached endpoints via auto anchors facing each other", () => {
    const pts = routeConnector(
      {
        route: "straight",
        start: { attach: { nodeId: "a", anchor: "auto" } },
        end: { attach: { nodeId: "b", anchor: "auto" } },
      },
      boxes,
    );
    // a is left of b -> a's right side, b's left side
    expect(pts[0]).toEqual({ x: 100, y: 50 });
    expect(pts[1]).toEqual({ x: 300, y: 50 });
  });

  it("elbow produces an orthogonal polyline with axis-aligned segments", () => {
    const pts = routeConnector(
      {
        route: "elbow",
        start: { attach: { nodeId: "a", anchor: "auto" } },
        end: { attach: { nodeId: "b", anchor: "auto" } },
      },
      boxes,
    );
    expect(pts.length).toBeGreaterThanOrEqual(2);
    // every consecutive segment is horizontal or vertical
    for (let i = 1; i < pts.length; i++) {
      const horiz = pts[i].y === pts[i - 1].y;
      const vert = pts[i].x === pts[i - 1].x;
      expect(horiz || vert).toBe(true);
    }
    // starts and ends at the resolved anchors
    expect(pts[0]).toEqual({ x: 100, y: 50 });
    expect(pts[pts.length - 1]).toEqual({ x: 300, y: 50 });
  });

  it("elbow splits on the dominant axis for diagonal endpoints", () => {
    const pts = routeConnector(
      {
        route: "elbow",
        start: { point: { x: 0, y: 0 } },
        end: { point: { x: 200, y: 100 } },
      },
      {},
    );
    // dominant horizontal: midX turn
    expect(pts).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 200, y: 100 },
    ]);
  });

  it("curved returns endpoints plus a midpoint control", () => {
    const pts = routeConnector(
      {
        route: "curved",
        start: { point: { x: 0, y: 0 } },
        end: { point: { x: 100, y: 40 } },
      },
      {},
    );
    expect(pts).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 20 },
      { x: 100, y: 40 },
    ]);
  });

  it("is deterministic and does not mutate inputs", () => {
    const conn = {
      route: "elbow" as const,
      start: { point: { x: 0, y: 0 } },
      end: { point: { x: 50, y: 80 } },
    };
    const frozen = JSON.stringify(conn);
    const a = routeConnector(conn, {});
    const b = routeConnector(conn, {});
    expect(a).toEqual(b);
    expect(JSON.stringify(conn)).toBe(frozen);
  });
});
