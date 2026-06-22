// Flatten an SVG's group transforms before converting to scene nodes. The
// @hc/stock `svgToNodes` is a flat, dependency-free scanner that ignores
// ancestor <g transform="..."> nesting, so a grouped/transformed SVG (e.g. a
// Canva export) would import with wrong positions/scales. Here, in the browser,
// we parse the DOM, accumulate each leaf's full transform matrix (translate /
// scale / rotate / matrix / skew, nested), convert that single leaf via
// svgToNodes (which yields it in its own local coordinates), then bake the
// accumulated matrix onto the resulting node's transform. Rotation is preserved;
// shear is folded into scale/rotation by `decompose` (rare in practice).

import { svgToNodes } from "@hc/stock";
import { decompose, fromTransform, identity, multiply, type Mat2D } from "@hc/engine";
import type { Node } from "@hc/schema";

const LEAF = new Set(["path", "rect", "circle", "ellipse", "line", "polygon", "polyline", "text", "image"]);
const CONTAINER = new Set(["g", "a", "svg"]);

const RAD = Math.PI / 180;

/** Parse an SVG `transform` attribute (a list of functions) into one matrix. */
export function parseTransform(s: string | null): Mat2D {
  let m = identity();
  if (!s) return m;
  for (const fn of s.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = fn[2].split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n));
    let t: Mat2D | null = null;
    switch (fn[1]) {
      case "translate": t = { a: 1, b: 0, c: 0, d: 1, e: a[0] || 0, f: a[1] || 0 }; break;
      case "scale": { const sx = a[0] ?? 1; const sy = a[1] ?? sx; t = { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }; break; }
      case "rotate": {
        const ang = (a[0] || 0) * RAD, cos = Math.cos(ang), sin = Math.sin(ang);
        const r: Mat2D = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
        t = a.length >= 3
          ? multiply(multiply({ a: 1, b: 0, c: 0, d: 1, e: a[1], f: a[2] }, r), { a: 1, b: 0, c: 0, d: 1, e: -a[1], f: -a[2] })
          : r;
        break;
      }
      case "matrix": if (a.length === 6) t = { a: a[0], b: a[1], c: a[2], d: a[3], e: a[4], f: a[5] }; break;
      case "skewX": t = { a: 1, b: 0, c: Math.tan((a[0] || 0) * RAD), d: 1, e: 0, f: 0 }; break;
      case "skewY": t = { a: 1, b: Math.tan((a[0] || 0) * RAD), c: 0, d: 1, e: 0, f: 0 }; break;
    }
    if (t) m = multiply(m, t);
  }
  return m;
}

export interface FlattenResult {
  nodes: Node[];
  assets: { assetId: string; url: string }[];
  approximated: boolean;
}

/** Convert an SVG string to scene nodes with group transforms resolved. */
export function flattenSvgToNodes(svgText: string): FlattenResult {
  const idGen = () => `svg-${crypto.randomUUID()}`;
  // No DOM (SSR / tests without jsdom): fall back to the flat parser.
  if (typeof DOMParser === "undefined") {
    const r = svgToNodes(svgText, idGen);
    return { nodes: r.nodes, assets: r.assets, approximated: r.approximated };
  }
  const nodes: Node[] = [];
  const assets: { assetId: string; url: string }[] = [];
  let approximated = false;
  const root = new DOMParser().parseFromString(svgText, "image/svg+xml").documentElement;

  const walk = (el: Element, ctm: Mat2D) => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      const m = multiply(ctm, parseTransform(child.getAttribute("transform")));
      if (CONTAINER.has(tag)) { walk(child, m); continue; }
      if (!LEAF.has(tag)) continue; // skip defs/clipPath/gradients/etc.
      const r = svgToNodes(child.outerHTML, idGen);
      approximated = approximated || r.approximated;
      assets.push(...r.assets);
      for (const n of r.nodes) {
        n.transform = decompose(multiply(m, fromTransform(n.transform)));
        nodes.push(n);
      }
    }
  };
  walk(root, identity());
  return { nodes, assets, approximated };
}
