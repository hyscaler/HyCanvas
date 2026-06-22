// SVG path `d` parser -> editable scene-graph subpaths (shared with source import). Produces PathSegment lists where a cubic
// segment carries the outgoing control on the previous point (`cOut`) and the
// incoming control on this point (`cIn`) - the same convention @hc/engine and
// @hc/export read. Supports M/L/H/V/C/S/Q/T/Z (absolute + relative); arcs (A)
// are approximated by a line to the endpoint and reported by the caller.

import type { PathSegment } from "@hc/schema";

export interface SubPathData {
  segments: PathSegment[];
  closed: boolean;
}

type Pt = { x: number; y: number };

function tokenize(d: string): string[] {
  return d.match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
}

/** Parse an SVG path `d` string into one or more editable subpaths. */
export function parsePathData(d: string): SubPathData[] {
  const tokens = tokenize(d);
  const subpaths: SubPathData[] = [];
  let cur: SubPathData | null = null;
  let pos: Pt = { x: 0, y: 0 };
  let start: Pt = { x: 0, y: 0 };
  let prevCubicCtrl: Pt | null = null; // reflected control for S
  let prevQuadCtrl: Pt | null = null; // reflected control for T
  let i = 0;
  let cmd = "";

  const num = () => parseFloat(tokens[i++]);
  const isCmd = (t: string) => /^[a-zA-Z]$/.test(t);

  const pushSeg = (seg: PathSegment) => {
    cur!.segments.push(seg);
  };
  const lastSeg = () => cur!.segments[cur!.segments.length - 1];

  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    switch (C) {
      case "M": {
        const x = num() + (rel ? pos.x : 0);
        const y = num() + (rel ? pos.y : 0);
        cur = { segments: [{ x, y }], closed: false };
        subpaths.push(cur);
        pos = { x, y };
        start = { x, y };
        cmd = rel ? "l" : "L"; // subsequent pairs are implicit lineto
        prevCubicCtrl = prevQuadCtrl = null;
        break;
      }
      case "L": {
        const x = num() + (rel ? pos.x : 0);
        const y = num() + (rel ? pos.y : 0);
        pushSeg({ x, y });
        pos = { x, y };
        prevCubicCtrl = prevQuadCtrl = null;
        break;
      }
      case "H": {
        const x = num() + (rel ? pos.x : 0);
        pushSeg({ x, y: pos.y });
        pos = { x, y: pos.y };
        prevCubicCtrl = prevQuadCtrl = null;
        break;
      }
      case "V": {
        const y = num() + (rel ? pos.y : 0);
        pushSeg({ x: pos.x, y });
        pos = { x: pos.x, y };
        prevCubicCtrl = prevQuadCtrl = null;
        break;
      }
      case "C": {
        const c1 = { x: num() + (rel ? pos.x : 0), y: num() + (rel ? pos.y : 0) };
        const c2 = { x: num() + (rel ? pos.x : 0), y: num() + (rel ? pos.y : 0) };
        const end = { x: num() + (rel ? pos.x : 0), y: num() + (rel ? pos.y : 0) };
        if (cur) lastSeg().cOut = c1;
        pushSeg({ x: end.x, y: end.y, cIn: c2 });
        prevCubicCtrl = c2;
        prevQuadCtrl = null;
        pos = end;
        break;
      }
      case "S": {
        const c1: Pt = prevCubicCtrl ? { x: 2 * pos.x - prevCubicCtrl.x, y: 2 * pos.y - prevCubicCtrl.y } : { ...pos };
        const c2 = { x: num() + (rel ? pos.x : 0), y: num() + (rel ? pos.y : 0) };
        const end = { x: num() + (rel ? pos.x : 0), y: num() + (rel ? pos.y : 0) };
        if (cur) lastSeg().cOut = c1;
        pushSeg({ x: end.x, y: end.y, cIn: c2 });
        prevCubicCtrl = c2;
        prevQuadCtrl = null;
        pos = end;
        break;
      }
      case "Q": {
        const q = { x: num() + (rel ? pos.x : 0), y: num() + (rel ? pos.y : 0) };
        const end = { x: num() + (rel ? pos.x : 0), y: num() + (rel ? pos.y : 0) };
        // Quadratic -> cubic control points.
        const c1 = { x: pos.x + (2 / 3) * (q.x - pos.x), y: pos.y + (2 / 3) * (q.y - pos.y) };
        const c2 = { x: end.x + (2 / 3) * (q.x - end.x), y: end.y + (2 / 3) * (q.y - end.y) };
        if (cur) lastSeg().cOut = c1;
        pushSeg({ x: end.x, y: end.y, cIn: c2 });
        prevQuadCtrl = q;
        prevCubicCtrl = null;
        pos = end;
        break;
      }
      case "T": {
        const q: Pt = prevQuadCtrl ? { x: 2 * pos.x - prevQuadCtrl.x, y: 2 * pos.y - prevQuadCtrl.y } : { ...pos };
        const end = { x: num() + (rel ? pos.x : 0), y: num() + (rel ? pos.y : 0) };
        const c1 = { x: pos.x + (2 / 3) * (q.x - pos.x), y: pos.y + (2 / 3) * (q.y - pos.y) };
        const c2 = { x: end.x + (2 / 3) * (q.x - end.x), y: end.y + (2 / 3) * (q.y - end.y) };
        if (cur) lastSeg().cOut = c1;
        pushSeg({ x: end.x, y: end.y, cIn: c2 });
        prevQuadCtrl = q;
        prevCubicCtrl = null;
        pos = end;
        break;
      }
      case "A": {
        // Arc: skip the 5 flag/radius params and line to the endpoint (approx).
        num(); num(); num(); num(); num();
        const x = num() + (rel ? pos.x : 0);
        const y = num() + (rel ? pos.y : 0);
        pushSeg({ x, y });
        pos = { x, y };
        prevCubicCtrl = prevQuadCtrl = null;
        break;
      }
      case "Z": {
        if (cur) cur.closed = true;
        pos = { ...start };
        prevCubicCtrl = prevQuadCtrl = null;
        break;
      }
      default:
        i++; // unknown token; skip defensively
    }
  }
  return subpaths.filter((s) => s.segments.length > 0);
}

/** True when the path uses arc commands (approximated; caller may flag fidelity). */
export function pathUsesArcs(d: string): boolean {
  return /[aA]/.test(d);
}
