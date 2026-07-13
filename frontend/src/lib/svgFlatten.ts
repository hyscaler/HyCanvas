// Flatten an SVG's group transforms before converting to scene nodes. The
// @hc/stock `svgToNodes` is a flat, dependency-free scanner that ignores
// ancestor <g transform="..."> nesting, so a grouped/transformed SVG (e.g. an
// export from another design tool) would import with wrong positions/scales. Here, in the browser,
// we parse the DOM, accumulate each leaf's full transform matrix (translate /
// scale / rotate / matrix / skew, nested), convert that single leaf via
// svgToNodes (which yields it in its own local coordinates), then bake the
// accumulated matrix onto the resulting node's transform. Rotation is preserved;
// shear is folded into scale/rotation by `decompose` (rare in practice).

import { svgToNodes, parseGradients } from "@hc/stock";
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

// Paint/text properties whose resolved (computed) value we bake onto each leaf so
// svgToNodes sees the real color even when it came from a <style> CSS class,
// `currentColor`, or inheritance rather than an inline attribute.
const COMPUTED_PROPS = [
  "fill", "fill-opacity", "stroke", "stroke-opacity", "stroke-width", "opacity",
  "font-family", "font-size", "font-weight", "font-style", "text-anchor",
];

/** Overwrite the element's inline style with its computed paint/text values, so
 *  the downstream attribute parser (which lets `style` win) picks them up. */
function inlineComputedPaint(el: Element): void {
  const cs = window.getComputedStyle(el);
  const decls: string[] = [];
  for (const p of COMPUTED_PROPS) {
    const v = cs.getPropertyValue(p).trim();
    if (v && v !== "normal") decls.push(`${p}:${v}`);
  }
  if (decls.length) el.setAttribute("style", decls.join(";"));
}

/** Convert an SVG string to scene nodes with group transforms resolved. */
export function flattenSvgToNodes(svgText: string, opts: { fallbackFill?: boolean } = {}): FlattenResult {
  const idGen = () => `svg-${crypto.randomUUID()}`;
  const fallbackFill = opts.fallbackFill ?? false;
  // Gradient defs live on the root; parse once and inject into every per-leaf
  // convert (each leaf's outerHTML does not include <defs>).
  const gradients = parseGradients(svgText);
  // No DOM (SSR / tests without jsdom): fall back to the flat parser.
  if (typeof DOMParser === "undefined" || typeof document === "undefined" || !document.body) {
    const r = svgToNodes(svgText, idGen, { fallbackFill, gradients });
    return { nodes: r.nodes, assets: r.assets, approximated: r.approximated };
  }
  const nodes: Node[] = [];
  const assets: { assetId: string; url: string }[] = [];
  let approximated = false;

  // Mount the SVG offscreen so the browser resolves CSS (<style> classes,
  // currentColor, inherited fills) into computed styles we can read per leaf.
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none";
  host.innerHTML = svgText;
  const root = host.querySelector("svg");
  if (!root) {
    const r = svgToNodes(svgText, idGen, { fallbackFill, gradients });
    return { nodes: r.nodes, assets: r.assets, approximated: r.approximated };
  }
  document.body.appendChild(host);

  // `co` is the accumulated container opacity. CSS `opacity` does not inherit, so
  // a `<g opacity="0.5">` must be folded onto its leaves manually (each leaf's
  // own computed opacity is group-independent).
  const walk = (el: Element, ctm: Mat2D, co: number) => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      const m = multiply(ctm, parseTransform(child.getAttribute("transform")));
      if (CONTAINER.has(tag)) {
        const go = parseFloat(window.getComputedStyle(child).opacity);
        walk(child, m, co * (Number.isFinite(go) ? go : 1));
        continue;
      }
      if (!LEAF.has(tag)) continue; // skip defs/clipPath/gradients/etc.
      inlineComputedPaint(child);
      const r = svgToNodes(child.outerHTML, idGen, { fallbackFill, gradients });
      approximated = approximated || r.approximated;
      assets.push(...r.assets);
      for (const n of r.nodes) {
        n.transform = decompose(multiply(m, fromTransform(n.transform)));
        if (co < 1) n.opacity = Math.max(0, Math.min(1, (n.opacity ?? 1) * co));
        nodes.push(n);
      }
    }
  };
  try {
    walk(root, identity(), 1);
  } finally {
    host.remove();
  }
  return { nodes, assets, approximated };
}
