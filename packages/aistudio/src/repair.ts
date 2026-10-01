// The deterministic repair pass. The design system fixes every ink to AA
// against the ground it was derived for, but a page can still put text on a
// ground the system did not plan (a stand-in, a badge, a palette a brand kit
// forced), and the checker used to flag that and ship it anyway: one deck
// went out with 32 failing texts and a report nobody read. Now what the
// checker can fix, it fixes, in place, before the deck leaves the composer.

import type { Color, Fill, Node } from "@hc/schema";
import { contrastRatio, fixToAA } from "@hc/color";
import { groundReferences, type PageInput } from "./quality";

const WHITE: Color = { srgb: { r: 1, g: 1, b: 1, a: 1 } };
const BLACK: Color = { srgb: { r: 0, g: 0, b: 0, a: 1 } };

function minRatio(c: Color, refs: Color[]): number {
  let r = Infinity;
  for (const ref of refs) r = Math.min(r, contrastRatio(c, ref));
  return r;
}

/** Hold every text run on the page to AA against the ground it sits on.
 *  The run's own hue is kept where a lightness walk reaches 4.5:1; where the
 *  ground spans stops no single tint clears, the run falls to whichever of
 *  black and white reads best across all of them. Returns how many runs were
 *  changed. */
export function repairContrast(page: PageInput): number {
  let changed = 0;
  for (const node of page.nodes) {
    if (node.type !== "text") continue;
    // Ornament set as type (a watermark glyph in a tint of the ground) is
    // meant to be faint; it is not copy and is never re-inked.
    if ((node as { data?: { decor?: boolean } }).data?.decor) continue;
    const refs = groundReferences(node, page.nodes, page.background);
    if (!refs.length) continue;
    const content = (node as { content?: Array<{ runs?: Array<{ style?: { fill?: Fill } }> }> }).content ?? [];
    for (const para of content) {
      for (const run of para.runs ?? []) {
        const fill = run.style?.fill;
        if (!fill || fill.type !== "solid" || !run.style) continue;
        if (minRatio(fill.color, refs) >= 4.5) continue;
        const worst = refs.reduce((a, b) => (contrastRatio(fill.color, a) <= contrastRatio(fill.color, b) ? a : b));
        let fixed = fixToAA(fill.color, worst);
        if (minRatio(fixed, refs) < 4.5) fixed = minRatio(WHITE, refs) >= minRatio(BLACK, refs) ? WHITE : BLACK;
        run.style.fill = { type: "solid", color: fixed };
        changed++;
      }
    }
  }
  return changed;
}
