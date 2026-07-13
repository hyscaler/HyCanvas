// Shared text measurement used by the inline editor and the resize gizmo, so
// both wrap and fit at exactly the same points the canvas/export engine does.
// Keeping a single measurer here is load-bearing: if the editor and the gizmo
// measured differently, a resize would compute a height the render then
// contradicts.

import { layoutText } from "@hc/text";
import { canvasFontString } from "@hc/engine";
import type { CharStyle, Paragraph, TextNode } from "@hc/schema";

// Single shared offscreen context measuring text exactly as @hc/engine's render
// path does (same canvasFontString + letter-spacing).
let _measureCanvas: HTMLCanvasElement | null = null;
export const canvasMeasure = (text: string, style: CharStyle): number => {
  if (typeof document === "undefined") return text.length * (style.fontSize ?? 16) * 0.55;
  if (!_measureCanvas) _measureCanvas = document.createElement("canvas");
  const ctx = _measureCanvas.getContext("2d");
  if (!ctx) return text.length * (style.fontSize ?? 16) * 0.55;
  const lctx = ctx as unknown as { letterSpacing?: string };
  ctx.font = canvasFontString(style);
  if ("letterSpacing" in ctx) lctx.letterSpacing = `${style.letterSpacing ?? 0}px`;
  return ctx.measureText(text).width;
};

/** The height the engine would lay `content` out to at the node's current box
 *  width, measured as auto-height (grows to the content). Used to re-fit an
 *  auto-height text box after its width changes (edit typing, or a side-handle
 *  resize) so the box always contains the reflowed text. */
export function measuredTextHeight(node: TextNode, content?: Paragraph[]): number {
  const laid = layoutText(
    { ...node, content: content ?? node.content, box: { ...node.box, mode: "autoHeight" } } as TextNode,
    { measure: canvasMeasure },
  );
  return Math.max(1, Math.round(laid.height));
}

/** The narrowest box width the text can reflow to without the font shrinking,
 *  i.e. the widest unbreakable token (longest word) plus horizontal padding.
 *  Laying out at width 1 forces every break opportunity to wrap, so the widest
 *  resulting line is that minimum. Below this, a side-handle resize scales the
 *  font instead of wrapping further. */
export function minContentWidth(node: TextNode): number {
  const laid = layoutText(
    { ...node, box: { ...node.box, width: 1, mode: "fixed" } } as TextNode,
    { measure: canvasMeasure },
  );
  let max = 0;
  for (const ln of laid.lines) max = Math.max(max, ln.width);
  const pad = node.box.padding;
  return Math.max(1, Math.round(max + (pad ? pad.l + pad.r : 0)));
}
