// The image alpha mask reaches the renderer (schema v20).
//
// Two wiring points decide whether this feature works at all, and both fail
// silently rather than loudly, which is why they are pinned here: the loader
// has to know the mask is an asset to fetch, and the draw path has to consume
// it. Miss the first and the image draws unmasked forever with no clue why.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createScene } from "../scene";
// Deliberately the package entry point, not ../maskedImage: the editor's
// refinement brush imports these from `@hc/engine`, so the re-export is part
// of what must not silently disappear.
import { clearMaskCache, maskedCanvas } from "../index";
import type { DesignFile, Node } from "@hc/schema";

function imageNode(alphaMask?: { assetId: string; width: number; height: number }): Node {
  return {
    id: "img", type: "image",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 100, height: 80 }, opacity: 1, blendMode: "normal",
    source: { assetId: "photo", naturalWidth: 100, naturalHeight: 80 },
    fit: "cover",
    ...(alphaMask ? { alphaMask } : {}),
  } as unknown as Node;
}

function fileWith(node: Node): DesignFile {
  return {
    schemaVersion: 20, id: "d", title: "t", assets: [], fonts: [], meta: {},
    pages: [{ id: "p1", width: 200, height: 200, children: [node] }],
  } as unknown as DesignFile;
}

describe("the mask is discoverable as an asset", () => {
  it("is reported among the node's assets, so the loader fetches it", () => {
    const scene = createScene(fileWith(imageNode({ assetId: "cutout", width: 100, height: 80 })), 0);
    // nodesUsingAsset is the loader's view of which nodes need which bytes.
    expect(scene.nodesUsingAsset("cutout")).toContain("img");
    expect(scene.nodesUsingAsset("photo")).toContain("img");
  });

  it("reports only the source when there is no mask", () => {
    const scene = createScene(fileWith(imageNode()), 0);
    expect(scene.nodesUsingAsset("photo")).toContain("img");
    expect(scene.nodesUsingAsset("cutout")).toEqual([]);
  });
});

describe("masking degrades rather than disappearing", () => {
  it("returns null where the runtime has no canvas, so the caller draws unmasked", async () => {
    // Node has no OffscreenCanvas or document. Both outcomes are wrong when a
    // mask exists, but showing the whole photo is obvious and recoverable
    // whereas failing to draw leaves a hole nobody can diagnose.
    clearMaskCache();
    const { maskedCanvas } = await import("../maskedImage");
    const fake = { width: 10, height: 10 } as unknown as CanvasImageSource;
    expect(maskedCanvas("k", fake, fake, 10, 10)).toBeNull();
  });
});

// The refinement brush repaints the mask over and over, so its correctness
// hangs on the cache contract: hits must be free, and an invalidation (a new
// key from the commit's fresh asset id, or an explicit clearMaskCache after a
// commit) must force a rebuild, or the engine keeps serving the stale cutout.
// A minimal OffscreenCanvas stand-in makes the pipeline runnable headless.
class FakeCtx {
  draws = 0;
  globalCompositeOperation = "source-over";
  drawImage(): void {
    this.draws++;
  }
  getImageData(_x: number, _y: number, w: number, h: number): { data: Uint8ClampedArray } {
    return { data: new Uint8ClampedArray(w * h * 4) };
  }
  putImageData(): void {}
}

class FakeOffscreenCanvas {
  width: number;
  height: number;
  private ctx = new FakeCtx();
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
  getContext(): FakeCtx {
    return this.ctx;
  }
}

describe("the composite cache under repeated refinement", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearMaskCache();
  });

  const img = { width: 10, height: 10 } as unknown as CanvasImageSource;

  it("serves the same composite for an unchanged image+mask pair", () => {
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    clearMaskCache();
    const a = maskedCanvas("photo:mask-v1:100x80", img, img, 100, 80);
    const b = maskedCanvas("photo:mask-v1:100x80", img, img, 100, 80);
    expect(a).not.toBeNull();
    expect(b).toBe(a); // a cache hit is the SAME canvas, no per-pixel rework
  });

  it("rebuilds when the mask asset changes (each commit mints a new asset id)", () => {
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    clearMaskCache();
    const before = maskedCanvas("photo:mask-v1:100x80", img, img, 100, 80);
    const after = maskedCanvas("photo:mask-v2:100x80", img, img, 100, 80);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it("rebuilds after clearMaskCache even under an identical key", () => {
    // The brush's post-commit invalidation: without it a data-URL fallback
    // commit (same dimensions, same node) could keep hitting the old entry.
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    clearMaskCache();
    const before = maskedCanvas("photo:mask-v1:100x80", img, img, 100, 80);
    clearMaskCache();
    const after = maskedCanvas("photo:mask-v1:100x80", img, img, 100, 80);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });
});
