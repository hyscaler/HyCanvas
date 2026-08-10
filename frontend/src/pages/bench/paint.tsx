// AC-10 browser paint benchmark (doc 16): real GPU-composited canvas paint of
// the 1000-node / 50-page scale scenario, measured with rAF frame deltas in an
// actual browser. The engine's CPU harness (packages/engine bench.ts) proves
// the lower bound against a null context; this page is the end-to-end half:
// a real <canvas> at devicePixelRatio, continuous pan/zoom (every frame
// repaints), and periodic page flips (scene build churn included).
//
// Run headless via `npm run bench:paint` (drives system Chrome through
// puppeteer-core against the dev server), or open /bench/paint in any browser.
// Results land in the DOM and on window.__benchResult for automation. Inert
// otherwise: generated content only, no data or API access.

import { useEffect, useRef, useState } from "react";
import { createBlankDesign, createNode, type DesignFile, type Node } from "@hc/schema";
import { createScene, renderScene, type CanvasLike, type Scene } from "@hc/engine";
import { tr } from "@/lib/i18n";

const PAGES = 50;
const NODES_PER_PAGE = 1000;
const WARMUP_FRAMES = 30;
const TIMED_FRAMES = 300;
const FLIP_EVERY = 30; // frames between page flips (scene build cost included)

// Mirrors the engine perf harness's content mix (rects/ellipses with fills and
// strokes plus periodic text), so the CPU and browser numbers describe the
// same workload.
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

function buildDeck(): DesignFile {
  const file = createBlankDesign({ title: tr("page.ac_10_bench"), width: 1920, height: 1080 });
  const template = file.pages[0];
  file.pages = Array.from({ length: PAGES }, (_, p) => ({
    ...structuredClone(template),
    id: `page-${p}`,
    children: buildNodes(NODES_PER_PAGE),
  }));
  return file;
}

interface BenchOutcome {
  pages: number;
  nodesPerPage: number;
  frames: number;
  fpsAvg: number;
  fpsP50: number;
  fpsP95Low: number; // fps implied by the 95th-percentile (slow) frame
  worstMs: number;
  sceneBuildMs: number; // mean per-page scene build during flips
  dpr: number;
}

declare global {
  interface Window {
    __benchResult?: BenchOutcome;
  }
}

export default function PaintBench() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState("building deck…");
  const [result, setResult] = useState<BenchOutcome | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    let disposed = false;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.min(window.innerWidth, 1600);
    const height = Math.min(window.innerHeight - 120, 900);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setStatus("no 2d context");
      return;
    }

    const file = buildDeck();
    const scenes = new Map<number, Scene>();
    const buildTimes: number[] = [];
    const sceneFor = (idx: number): Scene => {
      const hit = scenes.get(idx);
      if (hit) return hit;
      const t0 = performance.now();
      const scene = createScene(file, idx);
      buildTimes.push(performance.now() - t0);
      scenes.set(idx, scene);
      return scene;
    };

    setStatus(`painting ${PAGES}x${NODES_PER_PAGE} nodes…`);
    const deltas: number[] = [];
    let frame = 0;
    let last = 0;
    let pageIdx = 0;

    const tick = (now: number) => {
      if (disposed) return;
      if (last > 0 && frame > WARMUP_FRAMES) deltas.push(now - last);
      last = now;
      frame++;
      // Continuous pan + zoom so every frame is a full repaint, plus periodic
      // page flips so scene (re)build cost is inside the measurement.
      if (frame % FLIP_EVERY === 0) pageIdx = (pageIdx + 1) % PAGES;
      const t = frame / 60;
      const zoom = 0.6 + 0.25 * Math.sin(t * 0.8);
      const vp = {
        width,
        height,
        dpr,
        zoom,
        panX: 300 + 250 * Math.sin(t * 1.1),
        panY: 200 + 180 * Math.cos(t * 0.9),
      };
      renderScene(sceneFor(pageIdx), ctx as unknown as CanvasLike, vp);
      if (deltas.length < TIMED_FRAMES) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const sorted = [...deltas].sort((a, b) => a - b);
      const avg = deltas.reduce((s, d) => s + d, 0) / deltas.length;
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const outcome: BenchOutcome = {
        pages: PAGES,
        nodesPerPage: NODES_PER_PAGE,
        frames: deltas.length,
        fpsAvg: Math.round((1000 / avg) * 10) / 10,
        fpsP50: Math.round((1000 / p50) * 10) / 10,
        fpsP95Low: Math.round((1000 / p95) * 10) / 10,
        worstMs: Math.round(sorted[sorted.length - 1] * 10) / 10,
        sceneBuildMs: buildTimes.length
          ? Math.round((buildTimes.reduce((s, d) => s + d, 0) / buildTimes.length) * 100) / 100
          : 0,
        dpr,
      };
      window.__benchResult = outcome;
      setResult(outcome);
      setStatus("done");
    };
    raf = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <main className="light min-h-screen bg-white p-4 font-mono text-sm text-neutral-800">
      <h1 className="mb-1 text-base font-semibold">{tr("page.ac_10_paint_benchmark")}</h1>
      <p className="mb-2" data-testid="bench-status">
        {status}
        {result &&
          ` | avg ${result.fpsAvg} fps · p50 ${result.fpsP50} fps · p95-slow ${result.fpsP95Low} fps · worst ${result.worstMs}ms · scene build ${result.sceneBuildMs}ms/page · dpr ${result.dpr}`}
      </p>
      <canvas ref={canvasRef} className="border border-neutral-200" />
    </main>
  );
}
