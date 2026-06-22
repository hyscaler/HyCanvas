import { describe, it, expect } from "vitest";
import type { DesignFile } from "@hc/schema";
import { designPageToLottie } from "../lottie";

function baseFile(children: object[]): DesignFile {
  return {
    version: 4,
    id: "d1",
    title: "t",
    pages: [{ id: "p1", name: "Page 1", width: 800, height: 600, children: children as never }],
  } as unknown as DesignFile;
}

function rect(id: string, anim?: object): object {
  return {
    id,
    type: "rect",
    name: id,
    transform: { x: 100, y: 50, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 200, height: 120 },
    opacity: 1,
    fills: [{ type: "solid", color: { srgb: { r: 0.2, g: 0.4, b: 0.8, a: 1 } } }],
    ...(anim ? { animation: anim } : {}),
  };
}

describe("designPageToLottie", () => {
  it("produces a valid Lottie document with one layer per node", () => {
    const doc = designPageToLottie(baseFile([rect("a"), rect("b")]), 0, { fps: 30 });
    expect(doc.v).toMatch(/^5\./);
    expect(doc.fr).toBe(30);
    expect(doc.w).toBe(800);
    expect(doc.h).toBe(600);
    expect(doc.layers.length).toBe(2);
    for (const l of doc.layers) {
      expect(l.ty).toBe(4);
      expect(l.shapes.length).toBe(1);
      expect(l.ks.p).toBeDefined();
    }
  });

  it("bakes animated transforms into keyframes and keeps static nodes constant", () => {
    const animated = rect("anim", { entrance: { preset: "rise", easing: "ease-out", delayMs: 0, durationMs: 500 } });
    const doc = designPageToLottie(baseFile([rect("static"), animated]), 0, { fps: 20 });
    // Animated rise => the position property is keyframed (a:1); static => a:0.
    const layerByName = (n: string) => doc.layers.find((l) => l.nm === n)!;
    expect(layerByName("anim").ks.p.a).toBe(1);
    expect(layerByName("static").ks.p.a).toBe(0);
    // op (frame count) reflects the 500ms entrance at 20fps = 10 frames.
    expect(doc.op).toBe(10);
  });

  it("defaults to a one-second timeline when nothing animates", () => {
    const doc = designPageToLottie(baseFile([rect("a")]), 0, { fps: 24 });
    expect(doc.op).toBe(24);
    expect(doc.fr).toBe(24);
  });

  it("serializes to JSON without throwing (round-trippable)", () => {
    const doc = designPageToLottie(baseFile([rect("a")]), 0);
    const json = JSON.stringify(doc);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json).layers.length).toBe(1);
  });
});
