// The colours a page already uses, for building a brand palette from the
// work instead of typing hex values: every solid fill and stroke on the
// page's nodes (groups walked), every text run's colour, and the page
// background, most used first.

import type { Color, Node, Page } from "@hc/schema";
import { toHex } from "@hc/color";

type SolidFill = { type: "solid"; color: Color };

function solid(f: unknown): Color | null {
  const fill = f as Partial<SolidFill> | null | undefined;
  if (!fill || fill.type !== "solid" || !fill.color) return null;
  const a = fill.color.srgb?.a;
  if (a !== undefined && a <= 0) return null;
  return fill.color;
}

/** Every colour a set of nodes carries, counted by use. */
export function countNodeColors(nodes: readonly Node[], tally: Map<string, number> = new Map()): Map<string, number> {
  const bump = (c: Color | null) => {
    if (!c) return;
    const hex = toHex(c);
    tally.set(hex, (tally.get(hex) ?? 0) + 1);
  };
  for (const n of nodes) {
    const anyNode = n as unknown as {
      fills?: unknown[];
      stroke?: { fill?: unknown };
      content?: { runs?: { style?: { fill?: unknown } }[] }[];
      children?: Node[];
    };
    for (const f of anyNode.fills ?? []) bump(solid(f));
    if (anyNode.stroke) bump(solid(anyNode.stroke.fill));
    for (const para of anyNode.content ?? []) for (const run of para.runs ?? []) bump(solid(run.style?.fill));
    if (anyNode.children?.length) countNodeColors(anyNode.children, tally);
  }
  return tally;
}

/** The page's colours, most used first, capped. */
export function collectPageColors(page: Page, limit = 12): string[] {
  const tally = countNodeColors(page.children);
  const bg = solid((page as unknown as { background?: unknown }).background);
  if (bg) {
    const hex = toHex(bg);
    tally.set(hex, (tally.get(hex) ?? 0) + 1);
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([hex]) => hex);
}

/** The colours of a selection, in the order they were found. */
export function collectSelectionColors(nodes: readonly Node[]): string[] {
  return [...countNodeColors(nodes).keys()];
}
