import { describe, it, expect } from "vitest";
import { createBlankDesign, createNode, type DesignFile, type Node } from "@hc/schema";
import { planDeckFrames, planDurationMs, slideDurationMs, visibleSlideIndices } from "../deck";

function shape(id: string): Node {
  const n = createNode("shape", {
    shape: "rect", opacity: 1,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 100, height: 100 },
    fills: [{ type: "solid", color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } }],
  } as unknown as Partial<Node>) as Node;
  (n as { id: string }).id = id;
  return n;
}

/** A deck of `n` pages; page i>0 carries `transition` when given. */
function deck(n: number, transition?: unknown): DesignFile {
  const file = createBlankDesign({ title: "Deck", width: 800, height: 600 });
  file.pages[0].children = [shape("n0")];
  for (let i = 1; i < n; i++) {
    file.pages.push({
      ...structuredClone(file.pages[0]),
      id: `p${i}`,
      children: [shape(`n${i}`)],
      ...(transition ? { transition } : {}),
    } as DesignFile["pages"][number]);
  }
  return file;
}

const FADE = { type: "fade", durationMs: 1000 };

describe("visibleSlideIndices", () => {
  it("lists every page of a plain deck", () => {
    expect(visibleSlideIndices(deck(3))).toEqual([0, 1, 2]);
  });

  it("skips hidden slides, as present mode does", () => {
    const d = deck(3);
    (d.pages[1] as { hidden?: boolean }).hidden = true;
    expect(visibleSlideIndices(d)).toEqual([0, 2]);
  });
});

describe("slideDurationMs", () => {
  it("is the animation window plus the hold", () => {
    const d = deck(1);
    // No animations on this page, so the duration is exactly the hold.
    expect(slideDurationMs(d, 0, 2000)).toBe(2000);
    expect(slideDurationMs(d, 0, 500)).toBe(500);
  });
});

describe("planDeckFrames", () => {
  it("emits slide frames for every visible page", () => {
    const frames = planDeckFrames(deck(2), { fps: 10, holdMs: 1000 });
    const slides = frames.filter((f) => f.kind === "slide");
    expect(new Set(slides.map((f) => (f as { pageIndex: number }).pageIndex))).toEqual(new Set([0, 1]));
  });

  it("emits transition frames only when the arriving page declares one", () => {
    const plain = planDeckFrames(deck(2), { fps: 10, holdMs: 500 });
    expect(plain.some((f) => f.kind === "transition")).toBe(false);

    const withT = planDeckFrames(deck(2, FADE), { fps: 10, holdMs: 500 });
    const trs = withT.filter((f) => f.kind === "transition");
    expect(trs.length).toBe(10); // 1000ms at 10fps
  });

  it("never transitions into the first slide", () => {
    const frames = planDeckFrames(deck(2, FADE), { fps: 10, holdMs: 500 });
    const first = frames[0];
    expect(first.kind).toBe("slide");
    expect((first as { pageIndex: number }).pageIndex).toBe(0);
  });

  it("orders each transition immediately before its arriving slide", () => {
    const frames = planDeckFrames(deck(2, FADE), { fps: 5, holdMs: 400 });
    const firstTr = frames.findIndex((f) => f.kind === "transition");
    const firstP1 = frames.findIndex((f) => f.kind === "slide" && (f as { pageIndex: number }).pageIndex === 1);
    expect(firstTr).toBeGreaterThan(0);
    expect(firstP1).toBeGreaterThan(firstTr);
  });

  it("ramps transition progress from >0 to exactly 1", () => {
    const frames = planDeckFrames(deck(2, FADE), { fps: 10, holdMs: 100 });
    const trs = frames.filter((f) => f.kind === "transition") as { progress: number }[];
    expect(trs[0].progress).toBeGreaterThan(0);
    expect(trs[trs.length - 1].progress).toBeCloseTo(1, 5);
    // Monotonically increasing (the eased curve never goes backwards).
    for (let i = 1; i < trs.length; i++) expect(trs[i].progress).toBeGreaterThanOrEqual(trs[i - 1].progress);
  });

  it("carries the from/to indices and the arriving slide's animation time", () => {
    const frames = planDeckFrames(deck(2, FADE), { fps: 4, holdMs: 100 });
    const tr = frames.find((f) => f.kind === "transition") as { fromIndex: number; toIndex: number; toTMs: number };
    expect(tr.fromIndex).toBe(0);
    expect(tr.toIndex).toBe(1);
    expect(tr.toTMs).toBeGreaterThan(0); // the arriving slide is already entering
  });

  it("drops transitions under reduced motion", () => {
    const frames = planDeckFrames(deck(3, FADE), { fps: 10, holdMs: 300, reducedMotion: true });
    expect(frames.some((f) => f.kind === "transition")).toBe(false);
    expect(frames.every((f) => f.kind === "slide")).toBe(true);
  });

  it("skips hidden slides and their transitions", () => {
    const d = deck(3, FADE);
    (d.pages[1] as { hidden?: boolean }).hidden = true;
    const frames = planDeckFrames(d, { fps: 5, holdMs: 200 });
    const seen = new Set(frames.filter((f) => f.kind === "slide").map((f) => (f as { pageIndex: number }).pageIndex));
    expect(seen).toEqual(new Set([0, 2]));
    // The surviving transition bridges 0 -> 2, not 0 -> 1.
    const tr = frames.find((f) => f.kind === "transition") as { fromIndex: number; toIndex: number };
    expect(tr.fromIndex).toBe(0);
    expect(tr.toIndex).toBe(2);
  });

  it("restricts the playthrough to the requested pages", () => {
    const frames = planDeckFrames(deck(4, FADE), { fps: 5, holdMs: 200, pageIndices: [1, 3] });
    const seen = new Set(frames.filter((f) => f.kind === "slide").map((f) => (f as { pageIndex: number }).pageIndex));
    expect(seen).toEqual(new Set([1, 3]));
    // The transition bridges the selected pair, and page 1 (now first) has none.
    const trs = frames.filter((f) => f.kind === "transition") as { fromIndex: number; toIndex: number }[];
    expect(trs.every((t) => t.fromIndex === 1 && t.toIndex === 3)).toBe(true);
  });

  it("still skips hidden pages inside a requested selection", () => {
    const d = deck(3, FADE);
    (d.pages[1] as { hidden?: boolean }).hidden = true;
    const frames = planDeckFrames(d, { fps: 5, holdMs: 200, pageIndices: [0, 1, 2] });
    const seen = new Set(frames.filter((f) => f.kind === "slide").map((f) => (f as { pageIndex: number }).pageIndex));
    expect(seen).toEqual(new Set([0, 2]));
  });

  it("bounds the frame count, so a long deck cannot exhaust memory", () => {
    const frames = planDeckFrames(deck(40, FADE), { fps: 30, holdMs: 3000, maxFrames: 50 });
    expect(frames.length).toBe(50);
  });

  it("returns no frames for an empty (all-hidden) deck", () => {
    const d = deck(2);
    d.pages.forEach((p) => ((p as { hidden?: boolean }).hidden = true));
    expect(planDeckFrames(d)).toEqual([]);
  });

  it("uses a uniform delay so any encoder can consume the plan", () => {
    const frames = planDeckFrames(deck(2, FADE), { fps: 20, holdMs: 500 });
    expect(new Set(frames.map((f) => f.delayMs))).toEqual(new Set([50]));
    expect(planDurationMs(frames)).toBe(frames.length * 50);
  });

  it("clamps fps into a sane range", () => {
    expect(planDeckFrames(deck(1), { fps: 0, holdMs: 1000 })[0].delayMs).toBe(1000); // 1 fps
    expect(planDeckFrames(deck(1), { fps: 999, holdMs: 1000 })[0].delayMs).toBe(17); // 60 fps
  });
});

// --- Exit transitions in the planner (v22, F28 completion review) -------------
describe("planDeckFrames with exit transitions", () => {
  it("an EXIT-ONLY page still gets a transition window in the export", () => {
    const file = deck(2); // page 2 has NO transition of its own
    (file.pages[0] as { transitionOut?: unknown }).transitionOut = { type: "fade", durationMs: 1000 };
    const frames = planDeckFrames(file, { fps: 10 });
    const transitions = frames.filter((f) => f.kind === "transition");
    expect(transitions.length).toBe(10); // 1s at 10fps
    const t0 = transitions[0] as { transition: { type: string }; exitTransition?: { type: string }; exitProgress?: number };
    expect(t0.transition.type).toBe("none"); // arriving placed at once
    expect(t0.exitTransition?.type).toBe("fade");
    expect(t0.exitProgress).toBeGreaterThan(0);
  });

  it("each layer runs its own clock: a short exit finishes before a long enter", () => {
    const file = deck(2, { type: "slide", durationMs: 1000 });
    (file.pages[0] as { transitionOut?: unknown }).transitionOut = { type: "fade", durationMs: 500, easing: "linear" };
    const frames = planDeckFrames(file, { fps: 10 }).filter((f) => f.kind === "transition") as {
      progress: number; exitProgress?: number; toTMs: number;
    }[];
    expect(frames.length).toBe(10); // window = max(1000, 500)
    // At 600ms the exit (500ms, linear) is already clamped to 1.
    const at600 = frames.find((f) => Math.round(f.toTMs) === 600)!;
    expect(at600.exitProgress).toBe(1);
    expect(at600.progress).toBeLessThan(1);
  });

  it("no transition on either side plans no transition frames (unchanged)", () => {
    const frames = planDeckFrames(deck(2), { fps: 10 });
    expect(frames.every((f) => f.kind === "slide")).toBe(true);
  });
});
