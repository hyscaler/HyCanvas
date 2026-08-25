import { describe, it, expect } from "vitest";
import { createBlankDesign, createNode, type DesignFile, type Node, type PageTransition } from "@hc/schema";
import { renderTransition, renderTransitionPair, transitionPairDurationMs, pairEnterTransition, morphPlan, morphDesignAt, morphHiddenIds, lerpNode } from "../transition";
import { transitionProgress } from "../animation";
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

// --- Exit / asymmetric transitions (v22, C03) ---------------------------------
describe("renderTransitionPair", () => {
  it("with no exit set it is exactly renderTransition", () => {
    const a = recorder();
    const b = recorder();
    renderTransition(a.ctx, t("slide", "left"), frame(0.5));
    renderTransitionPair(b.ctx, t("slide", "left"), undefined, frame(0.5));
    expect(b.draws).toEqual(a.draws);
  });

  it("composites the arriving layer beneath and the leaving layer on top", () => {
    const r = recorder();
    // B slides in from the right edge while A fades out over it.
    renderTransitionPair(r.ctx, t("slide", "left"), t("fade"), frame(0.5));
    expect(r.draws).toHaveLength(2);
    // First draw: the ARRIVING slide, translated in (halfway across).
    expect(r.draws[0].img).toBe("TO");
    expect(r.draws[0].dx).toBeCloseTo(50, 5); // W=100, (1-p)*W
    // Second draw (on top): the LEAVING slide at half alpha.
    expect(r.draws[1].img).toBe("FROM");
    expect(r.draws[1].alpha).toBeCloseTo(0.5, 5);
  });

  it("a slide exit moves the outgoing slide OUT in its own direction", () => {
    const r = recorder();
    renderTransitionPair(r.ctx, t("fade"), t("slide", "left"), frame(0.25));
    const leaving = r.draws.find((d) => d.img === "FROM")!;
    expect(leaving.dx).toBeCloseTo(-25, 5); // exits leftward by p*W
  });

  it("an explicit none exit drops the outgoing slide immediately", () => {
    const r = recorder();
    renderTransitionPair(r.ctx, t("fade"), t("none"), frame(0.5));
    expect(r.draws.map((d) => d.img)).toEqual(["TO"]); // no FROM layer at all
  });

  it("a wipe exit clips the outgoing slide to its shrinking remainder", () => {
    const r = recorder();
    renderTransitionPair(r.ctx, t("fade"), t("wipe", "left"), frame(0.4));
    // Remainder is (1-p)*W wide anchored at the right edge for a left wipe.
    const clip = r.clips[r.clips.length - 1];
    expect(clip.w).toBeCloseTo(60, 5);
    expect(clip.x).toBeCloseTo(40, 5);
  });
});

describe("transitionProgress easing (v22, C02)", () => {
  it("linear runs at constant speed; the default stays ease-in-out; unknown names clamp", () => {
    expect(transitionProgress(250, 1000, "linear")).toBeCloseTo(0.25, 6);
    expect(transitionProgress(250, 1000)).toBeCloseTo(transitionProgress(250, 1000, "a-future-easing"), 10);
    expect(transitionProgress(250, 1000)).not.toBeCloseTo(0.25, 3); // eased, not linear
    expect(transitionProgress(0, 0, "linear")).toBe(1); // zero duration snaps
  });
});

describe("pair window helpers (exit-only fix)", () => {
  it("transitionPairDurationMs is the longer side; none counts as absent", () => {
    expect(transitionPairDurationMs(undefined, undefined)).toBe(0);
    expect(transitionPairDurationMs({ type: "fade", durationMs: 400 }, undefined)).toBe(400);
    expect(transitionPairDurationMs(undefined, { type: "fade", durationMs: 700 })).toBe(700);
    expect(transitionPairDurationMs({ type: "slide", durationMs: 400 }, { type: "fade", durationMs: 900 })).toBe(900);
    expect(transitionPairDurationMs({ type: "none", durationMs: 500 }, undefined)).toBe(0);
  });

  it("pairEnterTransition substitutes none for a page with no own transition", () => {
    expect(pairEnterTransition(undefined).type).toBe("none");
    expect(pairEnterTransition({ type: "zoom", durationMs: 300 }).type).toBe("zoom");
  });

  it("exitProgress drives the leaving layer independently of progress", () => {
    const r = recorder();
    renderTransitionPair(r.ctx, t("none"), t("fade"), { ...frame(0.2), exitProgress: 1 });
    // Arriving drawn in full; leaving at alpha 0 (fully exited) is still drawn
    // but invisible - assert the alpha came from exitProgress, not progress.
    const leaving = r.draws.find((d) => d.img === "FROM")!;
    expect(leaving.alpha).toBeCloseTo(0, 5);
  });
});

// --- Phase 2: Magic Move depth (C06-C09) ---------------------------------------
function group(id: string, x: number, y: number, kids: Node[], opts: { rotation?: number; scale?: number } = {}): Node {
  return {
    id, type: "group",
    transform: { x, y, scaleX: opts.scale ?? 1, scaleY: opts.scale ?? 1, rotation: opts.rotation ?? 0 },
    size: { width: 200, height: 200 }, opacity: 1, blendMode: "normal",
    children: kids,
  } as unknown as Node;
}

describe("morphPlan nested matching (C06)", () => {
  it("a node moving OUT of a group matches at its absolute position", () => {
    // From: shape "a" at (10,20) inside a group at (100,50). To: "a" top-level at (400,0).
    const d = deck([group("g1", 100, 50, [shape("a", 10)])], [shape("a", 400)]);
    (((d.pages[0].children[0] as unknown as { children: Node[] }).children[0]) as { transform: { y: number } }).transform.y = 20;
    const plan = morphPlan(d, 0, d, 1)!;
    expect(plan.ids).toEqual(["a"]);
    // Pose is FLATTENED: absolute from-position is group + child offset.
    expect(plan.fromPose.get("a")!.transform.x).toBe(110);
    expect(plan.fromPose.get("a")!.transform.y).toBe(70);
    expect(plan.toPose.get("a")!.transform.x).toBe(400);
    // Original refs (for buffer hiding) are the real document nodes.
    expect(plan.fromNodes.get("a")!.transform.x).toBe(10);
  });

  it("group scale bakes into the flattened pose", () => {
    const d = deck([group("g1", 100, 0, [shape("a", 10)], { scale: 2 })], [shape("a", 0)]);
    const plan = morphPlan(d, 0, d, 1)!;
    const pose = plan.fromPose.get("a")!;
    expect(pose.transform.x).toBe(120); // 100 + 10*2
    expect(pose.transform.scaleX).toBe(2);
  });

  it("matched groups still tween as units and never expose their children", () => {
    const d = deck(
      [group("g1", 0, 0, [shape("a", 10)])],
      [group("g1", 300, 0, [shape("a", 10)])],
    );
    const plan = morphPlan(d, 0, d, 1)!;
    expect(plan.ids).toEqual(["g1"]);
  });

  it("a rotated group is never descended (flattening would skew)", () => {
    const d = deck([group("g1", 0, 0, [shape("a", 10)], { rotation: 30 })], [shape("a", 400)]);
    expect(morphPlan(d, 0, d, 1)).toBeNull();
  });
});

describe("morphPlan forced matching (C09)", () => {
  it("a shared !!token pairs different-id nodes, beating automatic rules", () => {
    const d = deck([shape("x1", 0, "!!logo")], [shape("y9", 500, "!!logo")]);
    const plan = morphPlan(d, 0, d, 1)!;
    expect(plan.ids).toEqual(["y9"]);
    expect(plan.fromNodes.get("y9")!.id).toBe("x1");
  });

  it("a forced-token collision on one side falls back to automatic matching", () => {
    const d = deck([shape("x1", 0, "!!logo"), shape("x2", 50, "!!logo")], [shape("y9", 500, "!!logo")]);
    expect(morphPlan(d, 0, d, 1)).toBeNull(); // two carriers on the from side: no forced pair, names ambiguous
  });
});

describe("lerpNode appearance tween (C08)", () => {
  it("tweens solid fill color, stroke, and corner radius; alpha preserved", () => {
    const a = shape("s", 0);
    (a as unknown as { fills: unknown[] }).fills = [{ type: "solid", color: { srgb: { r: 1, g: 0, b: 0, a: 0.5 } } }];
    (a as unknown as { stroke?: unknown }).stroke = { fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }, width: 2, align: "center", cap: "butt", join: "miter" };
    const b = structuredClone(a);
    (b as unknown as { fills: unknown[] }).fills = [{ type: "solid", color: { srgb: { r: 0, g: 0, b: 1, a: 0.5 } } }];
    (b as unknown as { stroke: { width: number } }).stroke.width = 6;
    (b as unknown as { cornerRadius?: unknown }).cornerRadius = { topLeft: 20, topRight: 20, bottomRight: 20, bottomLeft: 20 };
    const mid = lerpNode(a, b, 0.5) as unknown as {
      fills: { color: { srgb: { r: number; b: number; a: number } } }[];
      stroke: { width: number };
      cornerRadius: { topLeft: number };
    };
    expect(mid.fills[0].color.srgb.r).toBeCloseTo(0.5, 5);
    expect(mid.fills[0].color.srgb.b).toBeCloseTo(0.5, 5);
    expect(mid.fills[0].color.srgb.a).toBeCloseTo(0.5, 5);
    expect(mid.stroke.width).toBeCloseTo(4, 5);
    expect(mid.cornerRadius.topLeft).toBeCloseTo(10, 5); // absent radius lerps from 0
  });

  it("gradient stops tween index-matched; mismatched shapes snap to the destination", () => {
    const a = shape("s", 0);
    (a as unknown as { fills: unknown[] }).fills = [{
      type: "gradient", gradient: "linear", angle: 0,
      stops: [{ position: 0, color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } }, { position: 1, color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }],
    }];
    const b = structuredClone(a);
    (b as unknown as { fills: { stops: { position: number; color: { srgb: { r: number } } }[] }[] }).fills[0].stops[0].color.srgb.r = 0;
    const mid = lerpNode(a, b, 0.5) as unknown as { fills: { stops: { color: { srgb: { r: number } } }[] }[] };
    expect(mid.fills[0].stops[0].color.srgb.r).toBeCloseTo(0.5, 5);
    // Mismatched stop count: destination wins whole.
    const c = structuredClone(a);
    (c as unknown as { fills: { stops: unknown[] }[] }).fills[0].stops.push({ position: 0.5, color: { srgb: { r: 0, g: 1, b: 0, a: 1 } } });
    const snap = lerpNode(a, c, 0.25) as unknown as { fills: { stops: unknown[] }[] };
    expect(snap.fills[0].stops).toHaveLength(3);
  });
});

describe("morphDesignAt per-element easing (C07)", () => {
  it("an element with an entrance easing re-eases from the linear clock", () => {
    const a = shape("a", 0);
    const b = shape("a", 1000);
    (b as unknown as { animation?: unknown }).animation = { entrance: { preset: "fade", durationMs: 300, delayMs: 0, easing: "linear" } };
    const d = deck([a], [b]);
    const plan = morphPlan(d, 0, d, 1)!;
    // Global eased progress 0.8 but linear clock 0.5: the linear-eased element
    // sits at its halfway point, not at 0.8.
    const posed = morphDesignAt(plan, d, 1, 0.8, { linearProgress: 0.5 });
    expect(posed.pages[1].children[0].transform.x).toBeCloseTo(500, 3);
    // Without a per-element easing the global progress applies.
    (b as unknown as { animation?: unknown }).animation = undefined;
    const plan2 = morphPlan(d, 0, d, 1)!;
    const posed2 = morphDesignAt(plan2, d, 1, 0.8, { linearProgress: 0.5 });
    expect(posed2.pages[1].children[0].transform.x).toBeCloseTo(800, 3);
  });
});
