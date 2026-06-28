import { describe, it, expect } from "vitest";
import { createBlankDesign, createNode, type Node } from "@hc/schema";
import { benchmarkRender, benchmarkSceneBuild } from "../bench";

// `n` top-level nodes: a grid of rects/ellipses with fills and strokes, plus
// periodic text, to exercise the common draw paths.
function buildNodes(n: number): Node[] {
  const cols = Math.ceil(Math.sqrt(n));
  const children: Node[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i % cols) * 40;
    const y = Math.floor(i / cols) * 40;
    if (i % 7 === 0) {
      children.push(createNode("text", {
        transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 120, height: 24 },
        content: [{ runs: [{ text: `Item ${i}`, style: { fontFamily: "system", fontStyle: "Regular", fontSize: 14, fill: { type: "solid", color: { srgb: { r: 0.1, g: 0.1, b: 0.1, a: 1 } } } } }], style: { align: "left", direction: "auto" } }],
      } as unknown as Partial<Node>));
    } else {
      children.push(createNode("shape", {
        shape: i % 2 ? "rect" : "ellipse",
        transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 32, height: 32 },
        fills: [{ type: "solid", color: { srgb: { r: (i % 5) / 5, g: 0.5, b: 0.8, a: 1 } } }],
        stroke: { fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }, width: 1, align: "center", cap: "butt", join: "miter" },
      } as unknown as Partial<Node>));
    }
  }
  return children;
}

// A single-page design with `n` top-level nodes.
function bigDesign(n: number) {
  const file = createBlankDesign({ title: "Perf", width: 1920, height: 1080 });
  file.pages[0].children = buildNodes(n);
  return file;
}

// A `pageCount`-page design, each page with `nodesPerPage` nodes (the AC-10
// scale scenario: a large multi-page deck materialized into the one Y.Doc).
function bigMultiPageDesign(pageCount: number, nodesPerPage: number) {
  const file = createBlankDesign({ title: "PerfDeck", width: 1920, height: 1080 });
  const template = file.pages[0];
  file.pages = Array.from({ length: pageCount }, (_, p) => ({
    ...structuredClone(template),
    id: `page-${p}`,
    children: buildNodes(nodesPerPage),
  }));
  return file;
}

describe("render performance", () => {
  it("renders a 1000-node page and reports frame timing", () => {
    const file = bigDesign(1000);
    const res = benchmarkRender(file, { frames: 40, warmup: 5 });
    expect(res.nodeCount).toBe(1000);
    // Report the baseline (visible with `vitest --reporter verbose`).
    // eslint-disable-next-line no-console
    console.log(`[perf] 1000 nodes: avg ${res.avgMs.toFixed(2)}ms/frame (${res.fps.toFixed(0)} fps), min ${res.minMs.toFixed(2)} max ${res.maxMs.toFixed(2)}`);
    // Gross-regression guard only (not a strict 60fps gate, to stay CI-stable):
    // the CPU-side traversal+dispatch of 1000 nodes against a null context should
    // be well under a generous ceiling.
    expect(res.avgMs).toBeLessThan(50);
  });

  it("scales roughly linearly with node count", () => {
    const small = benchmarkRender(bigDesign(200), { frames: 20, warmup: 3 });
    const large = benchmarkRender(bigDesign(1000), { frames: 20, warmup: 3 });
    // 5x the nodes should not be wildly super-linear (allow generous slack for
    // fixed per-frame overhead and timer noise).
    expect(large.avgMs).toBeLessThan(small.avgMs * 15 + 5);
  });

  // AC-10 measurement (1000-element page in a 50-page design). HONEST SCOPE: this
  // measures CPU cost only - scene build + render traversal against a null context
  // - NOT real GPU paint (there is no rasterizer in Node). So it is a necessary
  // lower bound (if CPU alone blows the 16ms frame budget, 60fps is impossible),
  // not sufficient proof; the true paint number needs a browser benchmark.
  it("measures AC-10: 50-page deck build + current-page frame cost", () => {
    const PAGES = 50;
    const NODES = 1000;
    const file = bigMultiPageDesign(PAGES, NODES);

    // Per-frame cost: the editor paints only the OPEN page, so render one page.
    const frame = benchmarkRender(file, { frames: 40, warmup: 5, pageIndex: 0 });
    // Load/scale cost: build every page's scene graph once.
    const build = benchmarkSceneBuild(file);

    const FRAME_BUDGET_MS = 16; // 60fps
    /* eslint-disable no-console */
    console.log(`[perf][AC-10] page render: avg ${frame.avgMs.toFixed(2)}ms/frame (${frame.fps.toFixed(0)} fps, CPU-only) for ${NODES} nodes; ${frame.avgMs < FRAME_BUDGET_MS ? "WITHIN" : "OVER"} the ${FRAME_BUDGET_MS}ms budget`);
    console.log(`[perf][AC-10] ${PAGES}-page scene build: total ${build.totalMs.toFixed(1)}ms, ${build.perPageMs.toFixed(2)}ms/page (CPU-only, all pages materialized - no subdocuments yet)`);
    /* eslint-enable no-console */

    expect(frame.nodeCount).toBe(NODES);
    expect(build.pages).toBe(PAGES);
    // Regression guards (generous, CI-stable - not strict AC-10 gates):
    expect(frame.avgMs).toBeLessThan(50);
    expect(build.totalMs).toBeLessThan(15000);
  });
});
