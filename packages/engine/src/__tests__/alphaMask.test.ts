// The image alpha mask reaches the renderer (schema v20).
//
// Two wiring points decide whether this feature works at all, and both fail
// silently rather than loudly, which is why they are pinned here: the loader
// has to know the mask is an asset to fetch, and the draw path has to consume
// it. Miss the first and the image draws unmasked forever with no clue why.

import { describe, expect, it } from "vitest";
import { createScene } from "../scene";
import { clearMaskCache } from "../maskedImage";
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
