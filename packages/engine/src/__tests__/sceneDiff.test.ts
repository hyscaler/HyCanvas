import { describe, expect, it } from "vitest";
import { createBlankDesign, createNode, type DesignFile, type Node } from "@hc/schema";
import { createScene } from "../scene";
import { diffScenes } from "../sceneDiff";
import { renderScene } from "../render2d";

const rect = (x: number, y: number, extra: Partial<Node> = {}): Node =>
  createNode("shape", {
    shape: "rect",
    transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 50, height: 40 },
    fills: [{ type: "solid", color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } }],
    ...extra,
  } as unknown as Partial<Node>);

function doc(children: Node[]): DesignFile {
  const f = createBlankDesign({ title: "t", width: 1000, height: 800 });
  f.pages[0].children = children;
  return f;
}

describe("diffScenes", () => {
  it("reports nothing when no node moved", () => {
    const f = doc([rect(10, 10), rect(200, 200)]);
    expect(diffScenes(createScene(f, 0), createScene(f, 0))).toEqual({ kind: "none" });
  });

  it("reports the union of a moved node's old and new bounds (the node is mutated in place)", () => {
    const a = rect(10, 10), b = rect(500, 500);
    const f = doc([a, b]);
    const before = createScene(f, 0);
    a.transform.x = 110; // the editor mutates in place, then rebuilds the scene
    const change = diffScenes(before, createScene(f, 0));
    expect(change.kind).toBe("region");
    if (change.kind !== "region") return;
    expect(change.changed).toBe(1);
    // Covers the old box (10..60) and the new one (110..160), not the far node.
    expect(change.rect.x).toBeLessThanOrEqual(10);
    expect(change.rect.x + change.rect.width).toBeGreaterThanOrEqual(160);
    expect(change.rect.x + change.rect.width).toBeLessThan(500);
    expect(change.rect.y + change.rect.height).toBeLessThan(500);
  });

  it("asks for a full repaint when nodes are added, removed or restacked", () => {
    const a = rect(10, 10), b = rect(200, 200);
    const f = doc([a, b]);
    const before = createScene(f, 0);
    f.pages[0].children = [b, a];
    expect(diffScenes(before, createScene(f, 0)).kind).toBe("all");
    f.pages[0].children = [a];
    expect(diffScenes(before, createScene(f, 0)).kind).toBe("all");
  });

  it("asks for a full repaint when a connector follows a moved node", () => {
    const a = rect(10, 10), b = rect(300, 300);
    const c = createNode("connector", {
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 10, height: 10 },
      start: { attach: { nodeId: a.id, anchor: "right" } },
      end: { attach: { nodeId: b.id, anchor: "left" } },
    } as unknown as Partial<Node>);
    const f = doc([a, b, c]);
    const before = createScene(f, 0);
    a.transform.x = 60;
    expect(diffScenes(before, createScene(f, 0)).kind).toBe("all");
  });
});

describe("renderScene region", () => {
  it("skips leaf nodes outside the region and paints the ones inside", () => {
    const f = doc([rect(10, 10), rect(600, 600)]);
    const fills: Array<[number, number]> = [];
    let m = [1, 0, 0, 1, 0, 0];
    const stack: number[][] = [];
    const ctx = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "save") return () => stack.push([...m]);
        if (prop === "restore") return () => { m = stack.pop() ?? m; };
        if (prop === "setTransform") return (a: number, b: number, c: number, d: number, e: number, g: number) => { m = [a, b, c, d, e, g]; };
        if (prop === "transform") return (a: number, b: number, c: number, d: number, e: number, g: number) => {
          m = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * g + m[4], m[1] * e + m[3] * g + m[5]];
        };
        if (prop === "fillRect" || prop === "rect" || prop === "roundRect") return () => { fills.push([m[4], m[5]]); };
        if (prop === "measureText") return () => ({ width: 0 });
        if (prop === "createLinearGradient" || prop === "createRadialGradient") return () => ({ addColorStop() {} });
        return () => undefined;
      },
      set() { return true; },
      has() { return false; },
    }) as unknown as Parameters<typeof renderScene>[1];
    const vp = { zoom: 1, panX: 0, panY: 0, dpr: 1, width: 1000, height: 800 };
    renderScene(createScene(f, 0), ctx, vp, { skipBackground: true });
    const all = fills.length;
    fills.length = 0;
    renderScene(createScene(f, 0), ctx, vp, { skipBackground: true, region: { x: 0, y: 0, width: 100, height: 100 } });
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.length).toBeLessThan(all);
    // Nothing at the far node's origin was painted.
    expect(fills.some(([x, y]) => x >= 600 && y >= 600)).toBe(false);
  });
});

describe("image nodes drawn from a downscaled copy", () => {
  it("samples the whole of a smaller bitmap, not its top-left corner", () => {
    const f = createBlankDesign({ title: "t", width: 800, height: 600 });
    f.pages[0].children = [createNode("image", {
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 800, height: 600 },
      source: { assetId: "a1", naturalWidth: 4000, naturalHeight: 3000 },
    } as unknown as Partial<Node>)];
    const calls: number[][] = [];
    const ctx = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "drawImage") return (_img: unknown, ...rest: number[]) => { calls.push(rest); };
        if (prop === "measureText") return () => ({ width: 0 });
        return () => undefined;
      },
      set() { return true; },
      has() { return false; },
    }) as unknown as Parameters<typeof renderScene>[1];
    const small = { width: 512, height: 384 }; // the asset's 512 px variant
    const assets = { image: () => small, status: () => "ready" as const, onChange: () => () => {} };
    renderScene(createScene(f, 0), ctx, { zoom: 1, panX: 0, panY: 0, dpr: 1, width: 800, height: 600 }, { assets, skipBackground: true });
    expect(calls).toHaveLength(1);
    const [sx, sy, sw, sh, dx, dy, dw, dh] = calls[0];
    expect([sx, sy]).toEqual([0, 0]);
    expect(sw).toBeCloseTo(512, 5);
    expect(sh).toBeCloseTo(384, 5);
    expect([dx, dy, dw, dh]).toEqual([0, 0, 800, 600]);
  });
});
