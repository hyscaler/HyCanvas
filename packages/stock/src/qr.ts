// QR mini-app node model. The QR node stores its bound
// value and style plus the precomputed scannable module matrix (the engine's
// drawQr reads node.modules). The matrix regenerates whenever the bound value or
// EC level changes, via the bit-matrix encoder (Reed-Solomon + masking).

import { createNode, type Color, type Node } from "@hc/schema";
import { encodeQrMatrix } from "./qrmatrix";

export type QrEcLevel = "L" | "M" | "Q" | "H";

export interface QrOptions {
  ecLevel?: QrEcLevel;
  foreground?: Color;
  background?: Color;
  size?: number; // px, square
  logoAssetId?: string;
}

const black: Color = { srgb: { r: 0, g: 0, b: 0, a: 1 } };
const WHITE: Color = { srgb: { r: 1, g: 1, b: 1, a: 1 } };

/** Create an editable QR node bound to `value` (FR-10). */
export function createQrNode(value: string, opts: QrOptions = {}, id = "qr"): Node {
  const s = opts.size ?? 240;
  const ecLevel = opts.ecLevel ?? "M";
  return createNode("qr", {
    id,
    size: { width: s, height: s },
    value,
    ecLevel,
    modules: encodeQrMatrix(value, ecLevel),
    foreground: opts.foreground ?? black,
    background: opts.background ?? WHITE,
    ...(opts.logoAssetId ? { logoAssetId: opts.logoAssetId } : {}),
  } as Partial<Node>);
}

/** The value a QR node encodes (its live binding). */
export function qrValue(node: Node): string | undefined {
  return (node as unknown as { value?: string }).value;
}

/**
 * Rebind a QR node to a new value (FR-10: the code regenerates when the bound
 * value changes). Returns a new node; the matrix is re-derived at render time.
 */
export function rebindQrValue(node: Node, value: string): Node {
  if (node.type !== "qr") throw new Error("rebindQrValue: not a qr node");
  const ecLevel = (node as unknown as { ecLevel?: QrEcLevel }).ecLevel ?? "M";
  return { ...node, value, modules: encodeQrMatrix(value, ecLevel) } as Node;
}
