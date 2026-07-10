import { describe, it, expect } from "vitest";
import { createBlankDesign, createNode, type Node, type Page } from "@hc/schema";
import { childIndexForBuildOrder, planBuildOrder, startModeLabel } from "../buildorder";

function node(id: string, entrance?: { preset?: string; durationMs?: number; delayMs?: number; startMode?: string }): Node {
  const n = createNode("shape", {
    shape: "rect", opacity: 1,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 10, height: 10 },
    fills: [{ type: "solid", color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } }],
  } as unknown as Partial<Node>) as Node;
  (n as { id: string }).id = id;
  (n as { name?: string }).name = id.toUpperCase();
  if (entrance) {
    (n as unknown as { animation: unknown }).animation = {
      entrance: {
        preset: entrance.preset ?? "fade",
        durationMs: entrance.durationMs ?? 500,
        delayMs: entrance.delayMs ?? 0,
        easing: "linear",
        ...(entrance.startMode ? { startMode: entrance.startMode } : {}),
      },
    };
  }
  return n;
}
function page(children: Node[]): Page {
  const f = createBlankDesign({ title: "D", width: 100, height: 100 });
  return { ...f.pages[0], children };
}

describe("planBuildOrder", () => {
  it("is empty for a page with no animations", () => {
    const plan = planBuildOrder(page([node("a"), node("b")]));
    expect(plan.steps).toEqual([]);
    expect(plan.totalMs).toBe(0);
  });

  it("omits non-animated nodes and numbers the rest from 1", () => {
    const plan = planBuildOrder(page([node("a"), node("b", { durationMs: 300 }), node("c", { durationMs: 200 })]));
    expect(plan.steps.map((s) => s.nodeId)).toEqual(["b", "c"]);
    expect(plan.steps.map((s) => s.order)).toEqual([1, 2]);
  });

  it("keeps the child index, so a caller can reorder the real children", () => {
    const plan = planBuildOrder(page([node("a"), node("b", {}), node("c"), node("d", {})]));
    expect(plan.steps.map((s) => s.childIndex)).toEqual([1, 3]); // b and d
  });

  it("resolves delay start mode as an absolute offset", () => {
    const plan = planBuildOrder(page([node("a", { delayMs: 200, durationMs: 500 })]));
    expect(plan.steps[0].startMs).toBe(200);
    expect(plan.steps[0].endMs).toBe(700);
    expect(plan.totalMs).toBe(700);
  });

  it("starts a with-previous clip alongside the previous one", () => {
    const plan = planBuildOrder(
      page([node("a", { delayMs: 100, durationMs: 400 }), node("b", { startMode: "with-previous", durationMs: 400 })]),
    );
    expect(plan.steps[0].startMs).toBe(100);
    expect(plan.steps[1].startMs).toBe(100); // same start
  });

  it("starts an after-previous clip when the previous ends", () => {
    const plan = planBuildOrder(
      page([node("a", { delayMs: 100, durationMs: 400 }), node("b", { startMode: "after-previous", durationMs: 300 })]),
    );
    expect(plan.steps[1].startMs).toBe(500); // 100 + 400
    expect(plan.totalMs).toBe(800);
  });

  it("totalMs is the latest end, not the sum", () => {
    const plan = planBuildOrder(
      page([node("a", { delayMs: 0, durationMs: 900 }), node("b", { startMode: "with-previous", durationMs: 200 })]),
    );
    expect(plan.totalMs).toBe(900);
  });

  it("agrees with playback: step order matches sequenceStarts' walk", () => {
    const p = page([node("x", { durationMs: 100 }), node("y", { startMode: "after-previous", durationMs: 100 })]);
    const plan = planBuildOrder(p);
    expect(plan.steps[0].nodeId).toBe("x");
    expect(plan.steps[1].startMs).toBe(plan.steps[0].endMs);
  });

  it("carries the preset, start mode, and name for the strip", () => {
    const plan = planBuildOrder(page([node("a", { preset: "rise", startMode: "with-previous" })]));
    expect(plan.steps[0]).toMatchObject({ preset: "rise", startMode: "with-previous", nodeName: "A" });
  });

  it("defaults an omitted startMode to delay", () => {
    expect(planBuildOrder(page([node("a", {})])).steps[0].startMode).toBe("delay");
  });
});

describe("childIndexForBuildOrder", () => {
  it("maps a build position to the child index, skipping non-animated nodes", () => {
    // children: a(no anim), b(anim), c(no anim), d(anim)
    const p = page([node("a"), node("b", {}), node("c"), node("d", {})]);
    // Move build step 1 (b) to build position 2 (where d sits): child index 3.
    expect(childIndexForBuildOrder(p, 1, 2)).toBe(3);
    // Move build step 2 (d) to build position 1 (where b sits): child index 1.
    expect(childIndexForBuildOrder(p, 2, 1)).toBe(1);
  });

  it("returns null for a no-op or out-of-range move", () => {
    const p = page([node("a", {}), node("b", {})]);
    expect(childIndexForBuildOrder(p, 1, 1)).toBeNull();
    expect(childIndexForBuildOrder(p, 0, 1)).toBeNull();
    expect(childIndexForBuildOrder(p, 1, 3)).toBeNull();
    expect(childIndexForBuildOrder(p, 5, 1)).toBeNull();
  });

  it("returns null when nothing animates", () => {
    expect(childIndexForBuildOrder(page([node("a")]), 1, 1)).toBeNull();
  });
});

describe("startModeLabel", () => {
  it("labels every mode", () => {
    expect(startModeLabel("delay")).toBe("On delay");
    expect(startModeLabel("with-previous")).toBe("With previous");
    expect(startModeLabel("after-previous")).toBe("After previous");
  });
});
