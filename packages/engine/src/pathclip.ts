// Minimal SVG path-data (`d`) parser used to clip a frame to a custom mask
// shape. Supports M/L/H/V/C/S/Q/T/Z (absolute + relative); arcs (A) degrade to a
// straight line to the endpoint. Quadratics and smooth curves are converted to
// cubic beziers so only moveTo/lineTo/bezierCurveTo/closePath are needed.
//
// The parsed path's bounding box is scaled to fill the target w x h box, so a
// custom mask authored in any coordinate space maps onto the frame.

import type { CanvasLike } from "./types";

type Pt = { x: number; y: number };
type Cmd =
  | { op: "M" | "L"; p: Pt }
  | { op: "C"; c1: Pt; c2: Pt; p: Pt }
  | { op: "Z" };

const NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

/** Parse a path `d` string into absolute moveTo/lineTo/cubic/close commands. */
export function parsePathCommands(d: string): Cmd[] {
  const cmds: Cmd[] = [];
  // Split into [letter, ...numbers] groups.
  const groups = d.match(/[a-z][^a-z]*/gi) ?? [];
  let cur: Pt = { x: 0, y: 0 };
  let start: Pt = { x: 0, y: 0 };
  let prevCtrl: Pt | null = null; // for S/T reflection
  let prevOp = "";

  for (const g of groups) {
    const op = g[0];
    const nums = (g.slice(1).match(NUM) ?? []).map(Number);
    const rel = op === op.toLowerCase();
    const O = op.toUpperCase();
    let i = 0;
    const rx = (v: number) => (rel ? cur.x + v : v);
    const ry = (v: number) => (rel ? cur.y + v : v);

    const lineTo = (p: Pt) => { cmds.push({ op: "L", p }); cur = p; prevCtrl = null; };

    if (O === "M") {
      // First pair is moveTo; subsequent pairs are implicit lineTos.
      let first = true;
      while (i + 1 < nums.length + 1 && i < nums.length) {
        const p = { x: rx(nums[i]), y: ry(nums[i + 1]) };
        i += 2;
        if (first) { cmds.push({ op: "M", p }); cur = p; start = p; first = false; }
        else lineTo(p);
        prevCtrl = null;
      }
    } else if (O === "L") {
      while (i + 1 < nums.length) { lineTo({ x: rx(nums[i]), y: ry(nums[i + 1]) }); i += 2; }
    } else if (O === "H") {
      while (i < nums.length) { lineTo({ x: rel ? cur.x + nums[i] : nums[i], y: cur.y }); i += 1; }
    } else if (O === "V") {
      while (i < nums.length) { lineTo({ x: cur.x, y: rel ? cur.y + nums[i] : nums[i] }); i += 1; }
    } else if (O === "C") {
      while (i + 5 < nums.length) {
        const c1 = { x: rx(nums[i]), y: ry(nums[i + 1]) };
        const c2 = { x: rx(nums[i + 2]), y: ry(nums[i + 3]) };
        const p = { x: rx(nums[i + 4]), y: ry(nums[i + 5]) };
        i += 6;
        cmds.push({ op: "C", c1, c2, p });
        cur = p; prevCtrl = c2;
      }
    } else if (O === "S") {
      while (i + 3 < nums.length) {
        const reflect: Pt = prevCtrl && (prevOp === "C" || prevOp === "S") ? { x: 2 * cur.x - prevCtrl.x, y: 2 * cur.y - prevCtrl.y } : { ...cur };
        const c2 = { x: rx(nums[i]), y: ry(nums[i + 1]) };
        const p = { x: rx(nums[i + 2]), y: ry(nums[i + 3]) };
        i += 4;
        cmds.push({ op: "C", c1: reflect, c2, p });
        cur = p; prevCtrl = c2;
      }
    } else if (O === "Q") {
      while (i + 3 < nums.length) {
        const q: Pt = { x: rx(nums[i]), y: ry(nums[i + 1]) };
        const p = { x: rx(nums[i + 2]), y: ry(nums[i + 3]) };
        i += 4;
        cmds.push(quadToCubic(cur, q, p));
        cur = p; prevCtrl = q;
      }
    } else if (O === "T") {
      while (i + 1 < nums.length) {
        const q: Pt = prevCtrl && (prevOp === "Q" || prevOp === "T") ? { x: 2 * cur.x - prevCtrl.x, y: 2 * cur.y - prevCtrl.y } : { ...cur };
        const p = { x: rx(nums[i]), y: ry(nums[i + 1]) };
        i += 2;
        cmds.push(quadToCubic(cur, q, p));
        cur = p; prevCtrl = q;
      }
    } else if (O === "A") {
      // Arc: 7 params (rx ry rot large sweep x y); degrade to a line to (x,y).
      while (i + 6 < nums.length) {
        const p = { x: rx(nums[i + 5]), y: ry(nums[i + 6]) };
        i += 7;
        lineTo(p);
      }
    } else if (O === "Z") {
      cmds.push({ op: "Z" });
      cur = { ...start };
      prevCtrl = null;
    }
    prevOp = O;
  }
  return cmds;
}

function quadToCubic(p0: Pt, q: Pt, p1: Pt): { op: "C"; c1: Pt; c2: Pt; p: Pt } {
  return {
    op: "C",
    c1: { x: p0.x + (2 / 3) * (q.x - p0.x), y: p0.y + (2 / 3) * (q.y - p0.y) },
    c2: { x: p1.x + (2 / 3) * (q.x - p1.x), y: p1.y + (2 / 3) * (q.y - p1.y) },
    p: p1,
  };
}

/**
 * Build the parsed path onto `ctx`, scaling its bounding box to fill w x h.
 * Returns false if nothing usable was parsed (caller should fall back to a rect).
 */
export function buildClipFromPathData(ctx: CanvasLike, d: string, w: number, h: number): boolean {
  const cmds = parsePathCommands(d);
  if (!cmds.length) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (p: Pt) => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); };
  for (const c of cmds) {
    if (c.op === "M" || c.op === "L") acc(c.p);
    else if (c.op === "C") { acc(c.c1); acc(c.c2); acc(c.p); }
  }
  if (!isFinite(minX) || maxX <= minX || maxY <= minY) return false;
  const sx = w / (maxX - minX);
  const sy = h / (maxY - minY);
  const tx = (p: Pt) => ({ x: (p.x - minX) * sx, y: (p.y - minY) * sy });
  let drew = false;
  for (const c of cmds) {
    if (c.op === "M") { const p = tx(c.p); ctx.moveTo(p.x, p.y); drew = true; }
    else if (c.op === "L") { const p = tx(c.p); ctx.lineTo(p.x, p.y); }
    else if (c.op === "C") {
      const c1 = tx(c.c1), c2 = tx(c.c2), p = tx(c.p);
      if (ctx.bezierCurveTo) ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    } else if (c.op === "Z") {
      ctx.closePath();
    }
  }
  return drew;
}
