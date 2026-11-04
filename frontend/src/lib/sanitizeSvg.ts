// Sanitises SVG markup before it reaches a live DOM sink (innerHTML or
// dangerouslySetInnerHTML). SVG text arrives from places we do not control: a
// workspace member's upload, an imported file, AI output, and a live icon
// provider. Parsing it into the page runs inline event handlers (onload,
// onerror) even on a detached host, so every such sink goes through here.
//
// The SVG profile keeps what the flattener and the tiles need (<style> classes,
// gradients, clip paths, transforms, inline style, data: and remote images) and
// drops <script>, event-handler attributes, javascript: URLs, <foreignObject>,
// and SMIL elements that can rewrite attributes. <use> is allowed only when it
// points at a fragment inside the same SVG.

import DOMPurify from "dompurify";

const CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ["use"],
  FORBID_TAGS: ["foreignObject"],
};

let hooked = false;
function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName.toLowerCase() !== "use") return;
    const ref = node.getAttribute("href") ?? node.getAttribute("xlink:href") ?? "";
    if (!ref.startsWith("#")) node.remove();
  });
}

// Tiles re-render the same bundled and provider SVGs many times; cache the
// cleaned text so a re-render does not re-parse it.
const cache = new Map<string, string>();
const CACHE_MAX = 1000;

/** Return `svg` with every script vector removed. Empty string when the DOM is unavailable. */
export function sanitizeSvg(svg: string): string {
  const hit = cache.get(svg);
  if (hit !== undefined) return hit;
  // No DOM (SSR, node tests): there is no live sink to protect, but returning
  // the input unchanged would be a silent bypass for any caller that later
  // reaches one, so fail closed.
  if (!DOMPurify.isSupported) return "";
  ensureHooks();
  const clean = DOMPurify.sanitize(svg, CONFIG) as string;
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(svg, clean);
  return clean;
}
