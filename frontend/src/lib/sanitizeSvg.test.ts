/** @vitest-environment jsdom */
// Regression gate for the SVG sinks: markup that reaches innerHTML (the
// flattener's offscreen host) or dangerouslySetInnerHTML (sticker and icon
// tiles) must come out with no script vector, while everything the flattener
// reads (classes, gradients, transforms, inline style, images) survives.

import { describe, it, expect } from "vitest";
import { sanitizeSvg } from "./sanitizeSvg";
import { flattenSvgToNodes } from "./svgFlatten";

const HOSTILE = [
  '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__pwn=1"><rect width="1" height="1"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__pwn=1</script><rect width="1" height="1"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><image href="x" onerror="window.__pwn=1"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><img src="x" onerror="window.__pwn=1"></foreignObject></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:window.__pwn=1"><rect width="1" height="1"/></a></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><set attributeName="onmouseover" to="window.__pwn=1"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="href" to="javascript:window.__pwn=1"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/x.svg#a"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"></svg><img src="x" onerror="window.__pwn=1">',
];

describe("sanitizeSvg", () => {
  it.each(HOSTILE)("strips every script vector from %s", (svg) => {
    const out = sanitizeSvg(svg).toLowerCase();
    expect(out).not.toMatch(/<script|<foreignobject|<set|<animate|\son[a-z]+=|javascript:|evil\.example/);
  });

  it("keeps what the flattener reads", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><style>.a{fill:#ff0000}</style>' +
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#00f"/></linearGradient><path id="p" d="M0 0h1v1z"/></defs>' +
      '<g transform="translate(2 3)" opacity="0.5"><path class="a" d="M0 0h4v4z"/><rect fill="url(#g)" width="3" height="3"/></g>' +
      '<use href="#p"/><image href="data:image/png;base64,iVBORw0KGgo=" width="2" height="2"/></svg>';
    const out = sanitizeSvg(svg);
    for (const keep of ["<style>", "linearGradient", 'transform="translate(2 3)"', 'class="a"', 'fill="url(#g)"', 'href="#p"', "data:image/png;base64"]) {
      expect(out).toContain(keep);
    }
  });

  it("still flattens a normal icon", () => {
    const { nodes } = flattenSvgToNodes('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g transform="translate(4 4)"><rect width="16" height="16" fill="#ff0000"/></g></svg>');
    expect(nodes.length).toBe(1);
  });
});
