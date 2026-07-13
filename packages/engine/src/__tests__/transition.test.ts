import { describe, it, expect } from "vitest";
import { createBlankDesign, createNode, type DesignFile, type Node, type PageTransition } from "@hc/schema";
import { renderTransition, morphPlan, morphDesignAt, morphHiddenIds, lerpNode } from "../transition";
import type { CanvasLike } from "../types";

// A recording context: the compositor only needs matrix ops, clip/rect,
// drawImage, and globalAlpha, so we capture those calls and assert the
// composite. This is what proves the same helper renders identically on any
// CanvasLike (browser, worker, server).
type DrawCall = { img: string; dx: number; dy: number; dw: number; dh: number; alpha: number; m: number[] };

function recorder() {
  const draws: DrawCall[] = [];
  const clips: { x: number; y: number; w: number; h: number }[] = [];
  let m = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  let pending: { x: number; y: number; w: number; h: number } | null = null;
  const ctx: CanvasLike = {
    save() { stack.push([...m]); },
    restore() { m = stack.pop() ?? [1, 0, 0, 1, 0, 0]; },
    setTransform(a, b, c, d, e, f) { m = [a, b, c, d, e, f]; },
    transform() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    beginPath() { pending = null; },
    closePath() {},
    moveTo() {},
    lineTo() {},
    rect(x, y, w, h) { pending = { x, y, w, h }; },
    clip() { if (pending) clips.push(pending); },
    drawImage(img, a, b, c, d) {
      draws.push({ img: String(img), dx: a, dy: b, dw: c ?? 0, dh: d ?? 0, alpha: ctx.globalAlpha, m: [...m] });
    },
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    font: "",
    textAlign: "left",
  } as unknown as CanvasLike;
  return { ctx, draws, clips, matrix: () => m };
}

const frame = (progress: number) => ({ from: "FROM", to: "TO", width: 100, height: 50, progress });
const t = (type: PageTransition["type"], direction?: PageTransition["direction"]) =>
  ({ type, durationMs: 300, direction } as PageTransition);

describe("renderTransition", () => {
  it("cross-fades a fade transition by progress", () => {
    const { ctx, draws } = recorder();
    renderTransition(ctx, t("fade"), frame(0.25));
    expect(draws).toHaveLength(2);
    expect(draws[0]).toMatchObject({ img: "FROM", alpha: 0.75 });
    expect(draws[1]).toMatchObject({ img: "TO", alpha: 0.25 });
  });

  it("clamps progress outside 0..1", () => {
    const { ctx, draws } = recorder();
    renderTransition(ctx, t("fade"), frame(1.8));
    expect(draws[0].alpha).toBeCloseTo(0); // from fully gone
    expect(draws[1].alpha).toBeCloseTo(1); // to fully present
  });

  it("slides the incoming slide in over a stationary outgoing one", () => {
    const { ctx, draws } = recorder();
    renderTransition(ctx, t("slide", "left"), frame(0.5));
    expect(draws[0]).toMatchObject({ img: "FROM", dx: 0, dy: 0 });
    expect(draws[1]).toMatchObject({ img: "TO", dx: 50, dy: 0 }); // half a width in
  });

  it("honors direction sign for slide", () => {
    const { ctx, draws } = recorder();
    renderTransition(ctx, t("slide", "right"), frame(0.5));
    expect(draws[1].dx).toBe(-50);
  });

  it("moves both slides together for push", () => {
    const { ctx, draws } = recorder();
    renderTransition(ctx, t("push", "left"), frame(0.5));
    expect(draws[0]).toMatchObject({ img: "FROM", dx: -50 });
    expect(draws[1]).toMatchObject({ img: "TO", dx: 50 });
  });

  it("pushes vertically for an up/down direction", () => {
    const { ctx, draws } = recorder();
    renderTransition(ctx, t("push", "up"), frame(0.5));
    // dx is -0 for a vertical push (negated zero); compare numerically, since
    // Object.is distinguishes -0 from +0 and the sign is meaningless here.
    expect(draws[0].dx).toBeCloseTo(0);
    expect(draws[0].dy).toBeCloseTo(-25);
    expect(draws[1].dx).toBeCloseTo(0);
    expect(draws[1].dy).toBeCloseTo(25);
  });

  it("clips a growing reveal rect for wipe", () => {
    const { ctx, draws, clips } = recorder();
    renderTransition(ctx, t("wipe", "left"), frame(0.4));
    expect(draws[0].img).toBe("FROM");
    expect(clips[0]).toEqual({ x: 0, y: 0, w: 40, h: 50 }); // 40% of width
    expect(draws[1].img).toBe("TO");
  });

  it("anchors the wipe rect to the far edge for the opposite direction", () => {
    const { ctx, clips } = recorder();
    renderTransition(ctx, t("wipe", "right"), frame(0.4));
    expect(clips[0]).toEqual({ x: 60, y: 0, w: 40, h: 50 });
  });

  it("shows only the outgoing slide in the first half of a flip, incoming after", () => {
    const a = recorder();
    renderTransition(a.ctx, t("flip"), frame(0.25));
    expect(a.draws).toHaveLength(1);
    expect(a.draws[0].img).toBe("FROM");
    expect(a.draws[0].m[0]).toBeCloseTo(0.5); // squashed to half width

    const b = recorder();
    renderTransition(b.ctx, t("flip"), frame(0.75));
    expect(b.draws[0].img).toBe("TO");
    expect(b.draws[0].m[0]).toBeCloseTo(0.5); // expanding back out
  });

  it("scales the incoming slide about the center for zoom", () => {
    const { ctx, draws } = recorder();
    renderTransition(ctx, t("zoom"), frame(0.5));
    expect(draws[0].img).toBe("FROM");
    const scale = draws[1].m[0];
    expect(scale).toBeCloseTo(0.65); // 0.3 + 0.7 * 0.5
    // Center-anchored: translate compensates for the scale.
    expect(draws[1].m[4]).toBeCloseTo((100 / 2) * (1 - scale));
    expect(draws[1].m[5]).toBeCloseTo((50 / 2) * (1 - scale));
  });

  it("cross-zooms both slides for morph-lite", () => {
    const { ctx, draws } = recorder();
    renderTransition(ctx, t("morph-lite"), frame(0.5));
    expect(draws[0].m[0]).toBeCloseTo(1.06); // outgoing zooms out
    expect(draws[1].m[0]).toBeCloseTo(0.94); // incoming zooms in
    expect(draws[0].alpha).toBeCloseTo(0.5);
  });

  it("cross-fades the buffers for morph (shared elements drawn by the caller)", () => {
    const { ctx, draws } = recorder();
    renderTransition(ctx, t("morph"), frame(0.5));
    expect(draws.map((d) => d.img)).toEqual(["FROM", "TO"]);
    expect(draws[0].alpha).toBeCloseTo(0.5);
  });

  it("falls back to the arriving slide for an unknown transition type", () => {
    const { ctx, draws } = recorder();
    renderTransition(ctx, { type: "cube-3d", durationMs: 300 } as unknown as PageTransition, frame(0.5));
    expect(draws).toHaveLength(1);
    expect(draws[0].img).toBe("TO");
  });

  it("leaves the context transform and alpha reset afterwards", () => {
    const { ctx, matrix } = recorder();
    renderTransition(ctx, t("zoom"), frame(0.5));
    expect(ctx.globalAlpha).toBe(1);
    expect(matrix()).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

// --- Magic Move -----------------------------------------------------------

function shape(id: string, x: number, name?: string): Node {
  const n = createNode("shape", {
    shape: "rect", opacity: 1,
    transform: { x, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 100, height: 100 },
    fills: [{ type: "solid", color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } }],
  } as unknown as Partial<Node>) as Node;
  (n as { id: string }).id = id;
  if (name) (n as { name?: string }).name = name;
  return n;
}

function deck(a: Node[], b: Node[]): DesignFile {
  const file = createBlankDesign({ title: "Deck", width: 800, height: 600 });
  file.pages[0].children = a;
  file.pages.push({ ...structuredClone(file.pages[0]), id: "p2", children: b });
  return file;
}

describe("morphPlan", () => {
  it("matches shared elements by stable node id", () => {
    const d = deck([shape("a", 0), shape("b", 10)], [shape("a", 200), shape("c", 5)]);
    const plan = morphPlan(d, 0, d, 1)!;
    expect(plan.ids).toEqual(["a"]);
    expect(plan.fromNodes.get("a")!.transform.x).toBe(0);
    expect(plan.toNodes.get("a")!.transform.x).toBe(200);
  });

  it("falls back to a name unique on both sides (duplicated slides regenerate ids)", () => {
    const d = deck([shape("old", 0, "Title")], [shape("new", 300, "Title")]);
    const plan = morphPlan(d, 0, d, 1)!;
    expect(plan.ids).toEqual(["new"]);
    expect(plan.fromNodes.get("new")!.id).toBe("old");
  });

  it("does not match an ambiguous name", () => {
    const d = deck([shape("a", 0, "Box"), shape("b", 1, "Box")], [shape("c", 9, "Box")]);
    expect(morphPlan(d, 0, d, 1)).toBeNull();
  });

  it("returns null when nothing is shared, so the caller cross-fades", () => {
    const d = deck([shape("a", 0)], [shape("b", 0)]);
    expect(morphPlan(d, 0, d, 1)).toBeNull();
  });
});

describe("lerpNode", () => {
  it("interpolates transform, size, and opacity, keeping destination appearance", () => {
    const a = shape("x", 0);
    const b = shape("x", 100);
    (b as { opacity: number }).opacity = 0;
    b.size.width = 200;
    const mid = lerpNode(a, b, 0.5);
    expect(mid.transform.x).toBe(50);
    expect(mid.size.width).toBe(150);
    expect(mid.opacity).toBe(0.5);
    expect(mid.id).toBe(b.id);
  });

  it("returns the endpoints exactly at p=0 and p=1", () => {
    const a = shape("x", 0);
    const b = shape("x", 100);
    expect(lerpNode(a, b, 0).transform.x).toBe(0);
    expect(lerpNode(a, b, 1).transform.x).toBe(100);
  });
});

describe("morphDesignAt / morphHiddenIds", () => {
  it("builds a design holding only the tweened shared elements", () => {
    const d = deck([shape("a", 0), shape("b", 10)], [shape("a", 200), shape("c", 5)]);
    const plan = morphPlan(d, 0, d, 1)!;
    const posed = morphDesignAt(plan, d, 1, 0.5);
    expect(posed.pages[1].children).toHaveLength(1);
    expect(posed.pages[1].children[0].transform.x).toBe(100); // halfway
    // Pure: the source design is untouched.
    expect(d.pages[1].children[0].transform.x).toBe(200);
  });

  it("reports the ids to hide in both buffers", () => {
    const d = deck([shape("old", 0, "Title")], [shape("new", 300, "Title")]);
    const plan = morphPlan(d, 0, d, 1)!;
    expect(morphHiddenIds(plan)).toEqual(new Set(["old", "new"]));
  });
});
