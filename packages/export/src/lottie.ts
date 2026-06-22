// Lottie (Bodymovin) animated-vector export. Pure and dependency-free:
// converts a design page's node animations into a Lottie JSON document. Each node
// becomes a shape layer (a coloured rectangle at the node's size); its transform
// (position/scale/rotation/opacity) is baked into Lottie keyframes by sampling
// the shared @hc/engine animation math at the chosen frame rate, so an exported
// Lottie plays back exactly like the in-editor preview and present mode.

import type { DesignFile, Node, NodeAnimation, ImageMotion, Fill } from "@hc/schema";
import { childrenOf } from "@hc/schema";
import {
  type AnimPatch, IDENTITY_PATCH, appliedOpacity, clipEnd,
  entrancePatch, emphasisPatch, customPatch, imageMotionPatch,
} from "@hc/engine";

export interface LottieOptions {
  /** Frame rate of the exported animation (default 30). */
  fps?: number;
  /** Override the animation length in ms (default: the page's animated duration). */
  durationMs?: number;
}

// A minimal, valid subset of the Lottie schema. `unknown`-free so the JSON is
// stable and round-trippable; consumers (lottie-web, After Effects) accept it.
export interface LottieDocument {
  v: string;
  fr: number;
  ip: number;
  op: number;
  w: number;
  h: number;
  nm: string;
  ddd: 0;
  assets: [];
  layers: LottieLayer[];
}

interface Keyed {
  a: 0 | 1;
  k: number | number[] | LottieKeyframe[];
}
interface LottieKeyframe {
  t: number;
  s: number[];
  i?: { x: number[]; y: number[] };
  o?: { x: number[]; y: number[] };
}
interface LottieLayer {
  ddd: 0;
  ind: number;
  ty: 4;
  nm: string;
  sr: 1;
  ks: { o: Keyed; r: Keyed; p: Keyed; a: Keyed; s: Keyed };
  shapes: object[];
  ip: number;
  op: number;
  st: 0;
  bm: 0;
}

function compose(a: AnimPatch | null, b: AnimPatch): AnimPatch {
  const base = a ?? IDENTITY_PATCH;
  return {
    dx: base.dx + b.dx,
    dy: base.dy + b.dy,
    scale: base.scale * b.scale,
    rotate: base.rotate + b.rotate,
    opacityMul: base.opacityMul * b.opacityMul,
  };
}

function patchAt(node: Node, tMs: number): AnimPatch {
  const anim = (node as unknown as { animation?: NodeAnimation }).animation;
  const motion = node.type === "image" ? (node as unknown as { motion?: ImageMotion }).motion : undefined;
  let patch: AnimPatch | null = null;
  const entEnd = clipEnd(anim?.entrance);
  if (anim?.entrance && tMs <= entEnd) patch = entrancePatch(anim.entrance, tMs);
  else if (anim?.emphasis) patch = emphasisPatch(anim.emphasis, tMs - entEnd);
  else if (anim?.entrance) patch = entrancePatch(anim.entrance, entEnd);
  if (anim?.custom) patch = compose(patch, customPatch(anim.custom, tMs - entEnd));
  if (motion) patch = compose(patch, imageMotionPatch(motion, tMs));
  return patch ?? { ...IDENTITY_PATCH };
}

function isAnimated(node: Node): boolean {
  const anim = (node as unknown as { animation?: NodeAnimation }).animation;
  const motion = node.type === "image" ? (node as unknown as { motion?: ImageMotion }).motion : undefined;
  return Boolean(anim?.entrance || anim?.emphasis || anim?.custom || motion);
}

function fillColor(node: Node): number[] {
  const fills = (node as unknown as { fills?: Fill[] }).fills;
  const solid = fills?.find((f) => f.type === "solid");
  if (solid && solid.type === "solid") {
    const c = solid.color.srgb;
    return [c.r, c.g, c.b, 1];
  }
  return [0.8, 0.8, 0.8, 1]; // neutral default so shapes are visible
}

// Build an animated-or-static Lottie property from per-frame samples.
function prop(samples: number[][], totalFrames: number): Keyed {
  const allEqual = samples.every((s) => s.every((v, i) => v === samples[0][i]));
  if (allEqual) return { a: 0, k: samples[0].length === 1 ? samples[0][0] : samples[0] };
  const k: LottieKeyframe[] = samples.map((s, f) => ({
    t: f,
    s,
    i: { x: [0.833], y: [0.833] },
    o: { x: [0.167], y: [0.167] },
  }));
  k.push({ t: totalFrames, s: samples[samples.length - 1] });
  return { a: 1, k };
}

function layerFor(node: Node, ind: number, frames: number, fps: number): LottieLayer {
  const t = node.transform;
  const w = Math.max(1, node.size.width);
  const h = Math.max(1, node.size.height);
  const pos: number[][] = [];
  const scale: number[][] = [];
  const rot: number[][] = [];
  const op: number[][] = [];
  for (let f = 0; f <= frames; f++) {
    const p = patchAt(node, (f / fps) * 1000);
    pos.push([t.x + p.dx, t.y + p.dy]);
    scale.push([t.scaleX * p.scale * 100, t.scaleY * p.scale * 100]);
    rot.push([t.rotation + p.rotate]);
    op.push([appliedOpacity(node.opacity, p.opacityMul) * 100]);
  }
  const c = fillColor(node);
  return {
    ddd: 0,
    ind,
    ty: 4,
    nm: (node as unknown as { name?: string }).name ?? node.type,
    sr: 1,
    ks: {
      o: prop(op, frames),
      r: prop(rot, frames),
      p: prop(pos, frames),
      a: { a: 0, k: [0, 0, 0] },
      s: prop(scale, frames),
    },
    shapes: [
      {
        ty: "gr",
        nm: "group",
        it: [
          { ty: "rc", nm: "rect", d: 1, s: { a: 0, k: [w, h] }, p: { a: 0, k: [w / 2, h / 2] }, r: { a: 0, k: 0 } },
          { ty: "fl", nm: "fill", c: { a: 0, k: c.slice(0, 3) }, o: { a: 0, k: (c[3] ?? 1) * 100 }, r: 1 },
          { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
        ],
      },
    ],
    ip: 0,
    op: frames,
    st: 0,
    bm: 0,
  };
}

/** Convert one design page into a Lottie animation document. Static (un-animated)
 *  nodes are still emitted as layers with constant transforms, so the exported
 *  Lottie is a faithful, self-contained render of the page. */
export function designPageToLottie(file: DesignFile, pageIndex: number, opts: LottieOptions = {}): LottieDocument {
  const page = file.pages[pageIndex];
  if (!page) throw new Error("designPageToLottie: page out of range");
  const fps = Math.max(1, Math.round(opts.fps ?? 30));
  // Default duration: longest animated window, or one second if nothing animates.
  let durMs = opts.durationMs;
  if (durMs === undefined) {
    let total = 0;
    const scan = (nodes: Node[]) => {
      for (const n of nodes) {
        if (isAnimated(n)) {
          const anim = (n as unknown as { animation?: NodeAnimation }).animation;
          const entEnd = clipEnd(anim?.entrance);
          let end = entEnd;
          if (anim?.emphasis) end = Math.max(end, entEnd + clipEnd(anim.emphasis));
          if (anim?.custom) end = Math.max(end, entEnd + anim.custom.durationMs);
          if (n.type === "image" && (n as unknown as { motion?: ImageMotion }).motion) end = Math.max(end, 2000);
          total = Math.max(total, end);
        }
        const kids = childrenOf(n);
        if (kids.length) scan(kids);
      }
    };
    scan(page.children);
    durMs = total || 1000;
  }
  const frames = Math.max(1, Math.round((durMs / 1000) * fps));

  // Flatten the page into draw order (Lottie has no nesting here; children are
  // baked with their own transforms). First layer renders on top in Lottie, so
  // reverse the natural back-to-front order.
  const flat: Node[] = [];
  const collect = (nodes: Node[]) => {
    for (const n of nodes) {
      flat.push(n);
      const kids = childrenOf(n);
      if (kids.length) collect(kids);
    }
  };
  collect(page.children);

  const layers: LottieLayer[] = [];
  let ind = 1;
  for (let i = flat.length - 1; i >= 0; i--) {
    layers.push(layerFor(flat[i], ind++, frames, fps));
  }

  return {
    v: "5.7.0",
    fr: fps,
    ip: 0,
    op: frames,
    w: Math.round(page.width ?? 1920),
    h: Math.round(page.height ?? 1080),
    nm: page.name ?? `page-${pageIndex + 1}`,
    ddd: 0,
    assets: [],
    layers,
  };
}
