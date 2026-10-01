// Procedural artwork for a picture region that asked for an abstract
// treatment. A self-hosted instance often has no image provider, and an
// abstract subject finds no stock photograph either, so those regions kept
// a stand-in. This draws the abstraction itself: a few forms in the deck's
// own hues, deterministic from the page's seed so a deck composes the same
// on both doors, as plain shape and path nodes that stay editable and
// export everywhere. Five kinds, chosen by the seed, so a deck's abstract
// pages do not all look alike.

import type { Color, Node } from "@hc/schema";
import { createNode } from "@hc/schema";

export type ArtworkKind = "waves" | "blobs" | "rings" | "stripes" | "dots";
export const artworkKinds: ArtworkKind[] = ["waves", "blobs", "rings", "stripes", "dots"];

export interface ArtworkPalette {
  /** The ground the region sits on and two hues to draw in. */
  ground: Color;
  primary: Color;
  accent: Color;
}

interface Rect { x: number; y: number; width: number; height: number }

function mix(a: Color, b: Color, t: number): Color {
  const l = (x: number, y: number) => x + (y - x) * t;
  return { srgb: { r: l(a.srgb.r, b.srgb.r), g: l(a.srgb.g, b.srgb.g), b: l(a.srgb.b, b.srgb.b), a: 1 } };
}

/** A small deterministic generator: the same seed draws the same picture. */
function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
}

function ellipse(name: string, x: number, y: number, w: number, h: number, color: Color, opacity: number): Node {
  return createNode("shape", {
    name,
    shape: "ellipse",
    transform: { x: Math.round(x), y: Math.round(y), scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: Math.round(w), height: Math.round(h) },
    fills: [{ type: "solid", color: structuredClone(color) }],
    opacity,
  } as never) as Node;
}

function rect(name: string, x: number, y: number, w: number, h: number, color: Color, opacity: number, rotation = 0): Node {
  return createNode("shape", {
    name,
    shape: "rect",
    transform: { x: Math.round(x), y: Math.round(y), scaleX: 1, scaleY: 1, rotation },
    size: { width: Math.round(w), height: Math.round(h) },
    fills: [{ type: "solid", color: structuredClone(color) }],
    opacity,
  } as never) as Node;
}

type Seg = { x: number; y: number; cIn?: { x: number; y: number }; cOut?: { x: number; y: number } };

function path(name: string, w: number, h: number, segments: Seg[], color: Color, opacity: number, closed = true): Node {
  return createNode("path", {
    name,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: Math.round(w), height: Math.round(h) },
    segments,
    closed,
    fills: [{ type: "solid", color: structuredClone(color) }],
    opacity,
  } as never) as Node;
}

/** A closed wave band across the box: a sine along the top edge, down to the
 *  bottom edge and back. Cubic control points sit a third of a period out,
 *  which is the classic smooth approximation. */
function waveBand(w: number, h: number, top: number, amp: number, periods: number, phase: number): Seg[] {
  const n = Math.max(2, Math.round(periods * 2));
  const step = w / n;
  const segs: Seg[] = [];
  for (let i = 0; i <= n; i++) {
    const x = i * step;
    const y = top + Math.sin(phase + (i / n) * periods * Math.PI * 2) * amp;
    const prev = i > 0 ? segs[i - 1] : null;
    const seg: Seg = { x, y };
    if (prev) {
      prev.cOut = { x: prev.x + step / 3, y: prev.y };
      seg.cIn = { x: x - step / 3, y };
    }
    segs.push(seg);
  }
  segs.push({ x: w, y: h }, { x: 0, y: h });
  return segs;
}

/** A soft organic blob: eight points on a wobbly circle joined by cubics. */
function blob(cx: number, cy: number, r: number, wobble: number, rand: () => number): Seg[] {
  const n = 8;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (1 - wobble / 2 + rand() * wobble);
    pts.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
  }
  const segs: Seg[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    // Tangent along the chord between the neighbours, a quarter of it each way.
    const tx = (next.x - prev.x) / 4;
    const ty = (next.y - prev.y) / 4;
    segs.push({ x: p.x, y: p.y, cIn: { x: p.x - tx, y: p.y - ty }, cOut: { x: p.x + tx, y: p.y + ty } });
  }
  return segs;
}

/** Draw one kind into a box. Every child stays inside the box, so the
 *  group is the only thing the quality loop needs to see. */
export function artworkNodes(kind: ArtworkKind, box: Rect, palette: ArtworkPalette, seed: number): Node[] {
  const rand = rng(seed);
  const w = box.width;
  const h = box.height;
  const { ground, primary, accent } = palette;
  const soft = mix(ground, primary, 0.35);
  const mid = mix(ground, primary, 0.65);
  const out: Node[] = [];
  switch (kind) {
    case "waves": {
      const bands = 4;
      for (let i = 0; i < bands; i++) {
        const top = h * (0.35 + (i / bands) * 0.5);
        const color = i % 2 === 0 ? mix(soft, primary, i / bands) : mix(mid, accent, i / bands);
        out.push(path("Wave", w, h, waveBand(w, h, top, h * 0.06, 1.5 + i * 0.5, rand() * Math.PI * 2), color, 0.9));
      }
      break;
    }
    case "blobs": {
      const n = 3;
      for (let i = 0; i < n; i++) {
        const r = Math.min(w, h) * (0.22 + rand() * 0.14);
        const cx = r + rand() * (w - 2 * r);
        const cy = r + rand() * (h - 2 * r);
        const color = i === 0 ? mid : i === 1 ? mix(soft, accent, 0.5) : primary;
        out.push(path("Blob", w, h, blob(cx, cy, r, 0.35, rand), color, 0.8));
      }
      break;
    }
    case "rings": {
      const cx = w * (0.55 + rand() * 0.2);
      const cy = h * (0.45 + rand() * 0.2);
      const rMax = Math.min(cx, w - cx, cy, h - cy) * 0.98;
      const rings = 5;
      for (let i = rings; i >= 1; i--) {
        const r = rMax * (i / rings);
        const color = i % 2 === 0 ? mix(soft, primary, i / rings) : mix(ground, accent, 0.25 + (i / rings) * 0.4);
        out.push(ellipse("Ring", cx - r, cy - r, r * 2, r * 2, color, 0.95));
      }
      break;
    }
    case "stripes": {
      // Diagonal bands: rotated rects, each kept inside the box by a
      // generous inset so the rotation never carries a corner out.
      const n = 5;
      const bandW = w / (n * 1.6);
      for (let i = 0; i < n; i++) {
        const x = (i / n) * w + bandW * 0.2;
        const color = i % 2 === 0 ? mix(soft, primary, 0.3 + (i / n) * 0.5) : mix(mid, accent, (i / n) * 0.6);
        out.push(rect("Stripe", x, h * 0.18, bandW, h * 0.64, color, 0.85, 0));
      }
      break;
    }
    case "dots": {
      const cols = 9;
      const rows = 6;
      const cw = w / cols;
      const rh = h / rows;
      const ox = rand();
      const oy = rand();
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const t = Math.min(1, Math.hypot(c / cols - ox, r / rows - oy));
          const d = Math.min(cw, rh) * (0.16 + (1 - t) * 0.5);
          const color = t < 0.4 ? mix(primary, accent, 0.4) : mix(soft, primary, 0.5);
          out.push(ellipse("Dot", c * cw + (cw - d) / 2, r * rh + (rh - d) / 2, d, d, color, 0.9));
        }
      }
      break;
    }
  }
  return out;
}

/** Pick a kind from the seed. */
export function artworkKindFor(seed: number): ArtworkKind {
  const n = artworkKinds.length;
  return artworkKinds[((seed % n) + n) % n];
}
