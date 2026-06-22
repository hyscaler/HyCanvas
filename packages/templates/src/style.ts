// Style extraction and swap-styles. extractStyle
// walks the scene graph for a palette (fill colors by frequency), typography
// (text runs ranked into roles by size), and effects. applyStyle re-skins a
// design's content to a StyleDescriptor - colors remapped positionally, text
// typography swapped by role - leaving geometry and copy intact, and reports
// what could not be mapped cleanly.

import { childrenOf, type Color, type DesignFile, type Node } from "@hc/schema";
import { fromHex, toHex } from "@hc/color";
import type { StyleDescriptor } from "./types";

type AnyRec = Record<string, unknown>;

function visit(node: Node, fn: (n: Node) => void): void {
  fn(node);
  for (const c of childrenOf(node)) visit(c, fn);
  const rec = node as unknown as AnyRec;
  if (node.type === "mask" && rec.child) visit(rec.child as Node, fn);
  if (node.type === "boolean" && Array.isArray(rec.operands)) {
    for (const op of rec.operands as Node[]) visit(op, fn);
  }
}

function colorsInFills(fills: unknown, out: Color[]): void {
  if (!Array.isArray(fills)) return;
  for (const f of fills as AnyRec[]) {
    if (!f) continue;
    if (f.type === "solid" && f.color) out.push(f.color as Color);
    else if (f.type === "gradient" && Array.isArray(f.stops)) {
      for (const s of f.stops as AnyRec[]) if (s?.color) out.push(s.color as Color);
    }
  }
}

interface RunStyle { family: string; size: number; weight: number; }

function runStylesOf(node: Node): RunStyle[] {
  if (node.type !== "text") return [];
  const rec = node as unknown as AnyRec;
  const out: RunStyle[] = [];
  for (const para of (rec.content as AnyRec[]) ?? []) {
    for (const run of (para.runs as AnyRec[]) ?? []) {
      const st = (run.style as AnyRec) ?? {};
      const axes = (st.axes as Record<string, number>) ?? {};
      out.push({ family: String(st.fontFamily ?? "sans-serif"), size: Number(st.fontSize) || 16, weight: axes.wght ?? 400 });
    }
  }
  return out;
}

const ROLES = ["heading", "subheading", "body", "accent"] as const;

/** Extract a StyleDescriptor from a design (FR-9). */
export function extractStyle(file: DesignFile, maxPalette = 8): StyleDescriptor {
  const colorFreq = new Map<string, number>();
  const runs: RunStyle[] = [];
  const effects = new Set<string>();

  for (const page of file.pages) {
    if (page.background) {
      const bg: Color[] = [];
      colorsInFills([page.background], bg);
      for (const c of bg) {
        const hex = toHex(c).slice(0, 7);
        colorFreq.set(hex, (colorFreq.get(hex) ?? 0) + 1);
      }
    }
    for (const root of page.children) {
      visit(root, (n) => {
        const rec = n as unknown as AnyRec;
        const cols: Color[] = [];
        colorsInFills(rec.fills, cols);
        const stroke = rec.stroke as AnyRec | undefined;
        if (stroke?.fill) colorsInFills([stroke.fill], cols);
        for (const c of cols) {
          const hex = toHex(c).slice(0, 7); // drop alpha for palette grouping
          colorFreq.set(hex, (colorFreq.get(hex) ?? 0) + 1);
        }
        for (const e of (rec.effects as AnyRec[]) ?? []) if (e?.kind) effects.add(String(e.kind));
        runs.push(...runStylesOf(n));
      });
    }
  }

  const palette = [...colorFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxPalette).map((e) => e[0]);

  // Rank distinct run styles by size desc into roles.
  const distinct = new Map<string, RunStyle>();
  for (const r of runs) distinct.set(`${r.size}-${r.family}-${r.weight}`, r);
  const ranked = [...distinct.values()].sort((a, b) => b.size - a.size);
  const typography: StyleDescriptor["typography"] = ranked.slice(0, 4).map((r, i) => ({ role: ROLES[i], family: r.family, weight: r.weight }));

  return { palette, typography, effects: [...effects] };
}

export interface ApplyStyleResult {
  file: DesignFile;
  colorsRemapped: number;
  runsRestyled: number;
  /** Roles the target needed but the style did not define (nearest used). */
  approximated: string[];
}

/**
 * Re-skin a design to a StyleDescriptor (FR-7). Solid/gradient colors are
 * remapped positionally from the design's own palette onto the target palette;
 * text runs are restyled by role (largest run in a node = heading, else body).
 * Content (geometry and copy) is untouched. Pure: returns a new file.
 */
export function applyStyle(file: DesignFile, style: StyleDescriptor): ApplyStyleResult {
  const clone: DesignFile = JSON.parse(JSON.stringify(file));
  const approximated = new Set<string>();
  let colorsRemapped = 0;
  let runsRestyled = 0;

  // Build old-hex -> new-hex map from the design's palette onto the style's.
  const current = extractStyle(file).palette;
  const targetPalette = style.palette.length ? style.palette : current;
  const colorMap = new Map<string, string>();
  current.forEach((hex, i) => colorMap.set(hex, targetPalette[i % targetPalette.length]));

  const remapColor = (c: Color): Color => {
    const hex = toHex(c).slice(0, 7);
    const to = colorMap.get(hex);
    if (!to) return c;
    const nc = fromHex(to);
    if (!nc) return c;
    nc.srgb.a = c.srgb.a; // preserve alpha
    colorsRemapped++;
    return nc;
  };

  const remapFills = (fills: AnyRec[] | undefined) => {
    if (!Array.isArray(fills)) return;
    for (const f of fills) {
      if (f?.type === "solid" && f.color) f.color = remapColor(f.color as Color);
      else if (f?.type === "gradient" && Array.isArray(f.stops)) {
        for (const s of f.stops as AnyRec[]) if (s?.color) s.color = remapColor(s.color as Color);
      }
    }
  };

  const byRole = (role: string) => style.typography.find((t) => t.role === role);

  for (const page of clone.pages) {
    for (const root of page.children) {
      visit(root, (n) => {
        const rec = n as unknown as AnyRec;
        remapFills(rec.fills as AnyRec[] | undefined);
        const stroke = rec.stroke as AnyRec | undefined;
        if (stroke?.fill) remapFills([stroke.fill as AnyRec]);

        if (n.type === "text" && Array.isArray(rec.content)) {
          // Find the largest run size in this node -> heading; others -> body.
          let maxSize = -Infinity;
          for (const para of rec.content as AnyRec[]) {
            for (const run of (para.runs as AnyRec[]) ?? []) maxSize = Math.max(maxSize, Number((run.style as AnyRec)?.fontSize) || 16);
          }
          const heading = byRole("heading");
          const body = byRole("body") ?? heading;
          if (!body) approximated.add("typography");
          for (const para of rec.content as AnyRec[]) {
            for (const run of (para.runs as AnyRec[]) ?? []) {
              const st = (run.style as AnyRec) ?? (run.style = {});
              const size = Number(st.fontSize) || 16;
              const role = size >= maxSize ? heading : body;
              if (role) {
                st.fontFamily = role.family;
                st.axes = { ...(st.axes as Record<string, number>), wght: role.weight };
                runsRestyled++;
              }
            }
          }
        }
      });
    }
  }

  return { file: clone, colorsRemapped, runsRestyled, approximated: [...approximated] };
}
