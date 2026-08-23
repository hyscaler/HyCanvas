// Insertion: map a StockAsset to native scene-graph nodes.
// Media become media nodes plus an AssetRef pointing at the CDN sourceUrl;
// icons/illustrations/shapes with inline SVG become editable vector nodes;
// shapes/frames/grids map to their native node types. Provenance is recorded so
// attribution survives export (FR-14).

import { createNode, type AssetRef, type Node } from "@hc/schema";
import { svgToNodes } from "./svg";
import { provenanceKey, type NodeProvenance, type StockAsset } from "./types";

export interface Insertion {
  nodes: Node[];
  assetRef?: AssetRef;
  provenance: NodeProvenance;
  /** True when a vector insert approximated arcs (fidelity note). */
  approximated?: boolean;
}

function provenanceOf(asset: StockAsset): NodeProvenance {
  return { origin: "stock", stockAssetId: asset.id, license: asset.license };
}

/** Stamp provenance onto a node under the agreed data key (serialized in-file). */
export function withProvenance<T extends Node>(node: T, prov: NodeProvenance): T {
  const data = { ...(node as { data?: Record<string, unknown> }).data, [provenanceKey]: prov };
  return { ...node, data } as T;
}

const REF_KIND: Record<string, AssetRef["kind"]> = {
  jpg: "image", png: "image", webp: "image", svg: "svg",
  mp4: "video", webm: "video", mp3: "audio", glb: "model3d", json: "lottie",
};

function mediaRef(asset: StockAsset): AssetRef {
  return {
    id: asset.id,
    kind: REF_KIND[asset.format] ?? "image",
    url: asset.sourceUrl,
    mime: `application/${asset.format}`,
    width: asset.width,
    height: asset.height,
    durationMs: asset.durationMs,
    checksum: asset.id,
  };
}

function box(asset: StockAsset): { width: number; height: number } {
  return { width: asset.width ?? 200, height: asset.height ?? 200 };
}

/**
 * Materialize a stock asset into editable nodes. Pure: returns the nodes,
 * an optional AssetRef to add to the design, and provenance. `idGen` lets tests
 * be deterministic.
 */
export function stockToNodes(asset: StockAsset, idGen: () => string = (() => { let i = 0; return () => `ins-${++i}`; })()): Insertion {
  const prov = provenanceOf(asset);
  const size = box(asset);

  // Vector kinds with inline SVG become editable nodes.
  if (asset.svg && (asset.kind === "icon" || asset.kind === "illustration" || asset.kind === "shape")) {
    const { nodes, approximated } = svgToNodes(asset.svg, idGen);
    return { nodes: nodes.map((n) => withProvenance(n, prov)), provenance: prov, approximated };
  }

  switch (asset.kind) {
    case "photo":
    case "background":
    case "sticker":
    case "illustration": {
      const ref = mediaRef(asset);
      const node = createNode("image", {
        id: idGen(),
        size,
        source: { assetId: ref.id, naturalWidth: asset.width ?? 0, naturalHeight: asset.height ?? 0 },
      } as Partial<Node>);
      return { nodes: [withProvenance(node, prov)], assetRef: ref, provenance: prov };
    }
    case "video": {
      const ref = mediaRef(asset);
      const node = createNode("video", { id: idGen(), size, assetId: ref.id } as Partial<Node>);
      return { nodes: [withProvenance(node, prov)], assetRef: ref, provenance: prov };
    }
    case "audio": {
      const ref = mediaRef(asset);
      const node = createNode("audio", { id: idGen(), size, assetId: ref.id } as Partial<Node>);
      return { nodes: [withProvenance(node, prov)], assetRef: ref, provenance: prov };
    }
    case "frame":
      return { nodes: [withProvenance(createNode("frame", { id: idGen(), size } as Partial<Node>), prov)], provenance: prov };
    case "grid":
      return { nodes: [withProvenance(createNode("grid", { id: idGen(), size } as Partial<Node>), prov)], provenance: prov };
    case "chart":
      return { nodes: [withProvenance(createNode("chart", { id: idGen(), size } as Partial<Node>), prov)], provenance: prov };
    case "shape":
    default: {
      const node = createNode("shape", { id: idGen(), shape: "rect", size } as Partial<Node>);
      return { nodes: [withProvenance(node, prov)], provenance: prov };
    }
  }
}
