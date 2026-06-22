// QR code matrix generation (FR-13).
//
// Reuse note: the repo's only existing "QR" code (packages/stock/src/qr.ts) is
// a *node model* for the editor (it stores a value + style and defers the
// bit-matrix to a server render layer). There is no matrix encoder anywhere in
// the repo, so this module implements a correct byte-mode QR encoder from
// scratch: GF(256) Reed-Solomon error correction, the 8 standard data masks
// with penalty scoring, BCH format/version information, and the standard
// function-pattern layout, returning { size, modules } plus an SVG renderer.
//
// Supports EC levels L/M/Q/H and byte (8-bit Latin-1/UTF-8) mode. Picks the
// smallest version (1..40) that fits the payload for the requested EC level.

export type QrEcLevel = "L" | "M" | "Q" | "H";

export interface QrMatrix {
  size: number; // modules per side
  modules: boolean[][]; // true = dark
  version: number;
  ecLevel: QrEcLevel;
}

// ---- GF(256) arithmetic for Reed-Solomon (primitive poly 0x11d) ----

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function rsGeneratorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGeneratorPoly(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ res[0];
    res.shift();
    res.push(0);
    for (let j = 0; j < gen.length - 1; j++) {
      res[j] ^= gfMul(gen[j], factor);
    }
  }
  return res;
}

// ---- Capacity / block tables (byte mode codeword counts) ----

// Total data codewords per (version, ecLevel) and EC blocks structure.
// Source: ISO/IEC 18004 tables. Index: [version-1].
// Each entry: [ecCodewordsPerBlock, numBlocksGroup1, dataCwGroup1, numBlocksGroup2, dataCwGroup2]
const EC_LEVEL_INDEX: Record<QrEcLevel, number> = { L: 0, M: 1, Q: 2, H: 3 };

import { BLOCK_TABLE, ALIGN_POS } from "./qr-tables";

function dataCapacityCodewords(version: number, ec: QrEcLevel): number {
  const entry = BLOCK_TABLE[version - 1][EC_LEVEL_INDEX[ec]];
  const g1d = entry[2];
  const b1 = entry[1];
  const b2 = entry[3];
  const g2d = entry[4];
  return b1 * g1d + b2 * g2d;
}

function charCountBits(version: number): number {
  // Byte mode: 8 bits for versions 1-9, 16 for 10-40.
  return version <= 9 ? 8 : 16;
}

// ---- Bit buffer ----

class BitBuffer {
  bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  }
  get length(): number {
    return this.bits.length;
  }
}

function encodeData(text: string, version: number, ec: QrEcLevel): number[] {
  // UTF-8 encode the string into bytes.
  const bytes = utf8Bytes(text);
  const buf = new BitBuffer();
  // Mode indicator: byte mode = 0b0100.
  buf.put(0b0100, 4);
  buf.put(bytes.length, charCountBits(version));
  for (const b of bytes) buf.put(b, 8);

  const totalDataCw = dataCapacityCodewords(version, ec);
  const capacityBits = totalDataCw * 8;

  // Terminator (up to 4 zero bits).
  const remaining = capacityBits - buf.length;
  buf.put(0, Math.min(4, Math.max(0, remaining)));
  // Pad to a byte boundary.
  while (buf.length % 8 !== 0) buf.bits.push(0);

  // Convert to codewords.
  const cw: number[] = [];
  for (let i = 0; i < buf.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | buf.bits[i + j];
    cw.push(v);
  }
  // Pad bytes 0xEC, 0x11 alternating.
  const padBytes = [0xec, 0x11];
  let pi = 0;
  while (cw.length < totalDataCw) {
    cw.push(padBytes[pi % 2]);
    pi++;
  }
  return cw;
}

function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    let code = ch.codePointAt(0)!;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return out;
}

function pickVersion(text: string, ec: QrEcLevel): number {
  const byteLen = utf8Bytes(text).length;
  for (let v = 1; v <= 40; v++) {
    const ccBits = charCountBits(v);
    const headerBits = 4 + ccBits;
    const neededBits = headerBits + byteLen * 8;
    const capBits = dataCapacityCodewords(v, ec) * 8;
    if (neededBits <= capBits) return v;
  }
  throw new Error("qr: payload too large for byte mode (max version 40)");
}

// Interleave data + EC codewords across blocks per spec.
function buildFinalCodewords(dataCw: number[], version: number, ec: QrEcLevel): number[] {
  const entry = BLOCK_TABLE[version - 1][EC_LEVEL_INDEX[ec]];
  const ecPerBlock = entry[0];
  const numB1 = entry[1];
  const dataB1 = entry[2];
  const numB2 = entry[3];
  const dataB2 = entry[4];

  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < numB1; i++) {
    const d = dataCw.slice(offset, offset + dataB1);
    offset += dataB1;
    blocks.push(d);
    ecBlocks.push(rsEncode(d, ecPerBlock));
  }
  for (let i = 0; i < numB2; i++) {
    const d = dataCw.slice(offset, offset + dataB2);
    offset += dataB2;
    blocks.push(d);
    ecBlocks.push(rsEncode(d, ecPerBlock));
  }

  const result: number[] = [];
  const maxData = Math.max(dataB1, dataB2);
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.length) result.push(b[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const e of ecBlocks) result.push(e[i]);
  }
  return result;
}

// ---- Matrix construction ----

function sizeForVersion(version: number): number {
  return version * 4 + 17;
}

type Cell = { dark: boolean; reserved: boolean };

function blankMatrix(size: number): Cell[][] {
  return Array.from({ length: size }, () =>
    Array.from({ length: size }, () => ({ dark: false, reserved: false })),
  );
}

function placeFinder(m: Cell[][], r: number, c: number): void {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      const inRing =
        (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
        (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
      const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      m[rr][cc].dark = inRing || inCenter;
      m[rr][cc].reserved = true;
    }
  }
}

function placeAlignment(m: Cell[][], version: number): void {
  const positions = ALIGN_POS[version - 1];
  if (!positions || positions.length === 0) return;
  for (const r of positions) {
    for (const c of positions) {
      // Skip if overlapping a finder pattern.
      if (m[r][c].reserved) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          const dark = ring === 2 || (dr === 0 && dc === 0);
          m[r + dr][c + dc].dark = dark;
          m[r + dr][c + dc].reserved = true;
        }
      }
    }
  }
}

function placeTiming(m: Cell[][]): void {
  const size = m.length;
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    if (!m[6][i].reserved) {
      m[6][i].dark = dark;
      m[6][i].reserved = true;
    }
    if (!m[i][6].reserved) {
      m[i][6].dark = dark;
      m[i][6].reserved = true;
    }
  }
}

function reserveFormatAndVersion(m: Cell[][], version: number): void {
  const size = m.length;
  // Dark module.
  m[size - 8][8].dark = true;
  m[size - 8][8].reserved = true;
  // Format info areas (reserve only).
  for (let i = 0; i <= 8; i++) {
    if (!m[8][i].reserved) m[8][i].reserved = true;
    if (!m[i][8].reserved) m[i][8].reserved = true;
  }
  for (let i = 0; i < 8; i++) {
    if (!m[8][size - 1 - i].reserved) m[8][size - 1 - i].reserved = true;
    if (!m[size - 1 - i][8].reserved) m[size - 1 - i][8].reserved = true;
  }
  // Version info (v >= 7): two 6x3 blocks.
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        m[i][size - 11 + j].reserved = true;
        m[size - 11 + j][i].reserved = true;
      }
    }
  }
}

function placeData(m: Cell[][], codewords: number[]): boolean[][] {
  const size = m.length;
  const bits: number[] = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  }
  let bitIdx = 0;
  let upward = true;
  // Track data-module mask map for later masking.
  const isData: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip timing column
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (m[row][cc].reserved) continue;
        const bit = bitIdx < bits.length ? bits[bitIdx] : 0;
        m[row][cc].dark = bit === 1;
        isData[row][cc] = true;
        bitIdx++;
      }
    }
    upward = !upward;
  }
  return isData;
}

const MASK_FNS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(
  base: Cell[][],
  isData: boolean[][],
  maskFn: (r: number, c: number) => boolean,
): boolean[][] {
  const size = base.length;
  const out: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      let dark = base[r][c].dark;
      if (isData[r][c] && maskFn(r, c)) dark = !dark;
      out[r][c] = dark;
    }
  }
  return out;
}

// BCH(15,5) format info.
function formatBits(ec: QrEcLevel, mask: number): number {
  const ecBits: Record<QrEcLevel, number> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };
  const data = (ecBits[ec] << 3) | mask;
  let rem = data << 10;
  const g = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= g << (i - 10);
  }
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function placeFormat(m: boolean[][], reserved: Cell[][], ec: QrEcLevel, mask: number): void {
  const size = m.length;
  const fmt = formatBits(ec, mask);
  for (let i = 0; i < 15; i++) {
    const bit = ((fmt >> i) & 1) === 1;
    // Around top-left.
    if (i < 6) m[8][i] = bit;
    else if (i === 6) m[8][7] = bit;
    else if (i === 7) m[8][8] = bit;
    else if (i === 8) m[7][8] = bit;
    else m[14 - i][8] = bit;
    // Around top-right / bottom-left.
    if (i < 8) m[size - 1 - i][8] = bit;
    else m[8][size - 15 + i] = bit;
  }
  reserved; // (format cells were pre-reserved during matrix build)
}

// BCH(18,6) version info for v >= 7.
function versionBits(version: number): number {
  let rem = version << 12;
  const g = 0b1111100100101;
  for (let i = 17; i >= 12; i--) {
    if ((rem >> i) & 1) rem ^= g << (i - 12);
  }
  return (version << 12) | rem;
}

function placeVersion(m: boolean[][], version: number): void {
  if (version < 7) return;
  const size = m.length;
  const v = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = ((v >> i) & 1) === 1;
    const row = Math.floor(i / 3);
    const col = i % 3;
    m[row][size - 11 + col] = bit;
    m[size - 11 + col][row] = bit;
  }
}

function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;
  // Rule 1: runs of 5+ same-color in row/col.
  for (let r = 0; r < size; r++) {
    let runColor = m[r][0];
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (m[r][c] === runColor) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        runColor = m[r][c];
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let c = 0; c < size; c++) {
    let runColor = m[0][c];
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (m[r][c] === runColor) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        runColor = m[r][c];
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  // Rule 2: 2x2 blocks of same color.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }
  // Rule 3: finder-like patterns 1:1:3:1:1 with 4 light.
  const pat1 = [true, false, true, true, true, false, true, false, false, false, false];
  const pat2 = [false, false, false, false, true, false, true, true, true, false, true];
  const matchAt = (arr: boolean[], pat: boolean[]) => {
    for (let i = 0; i + pat.length <= arr.length; i++) {
      let ok = true;
      for (let j = 0; j < pat.length; j++) {
        if (arr[i + j] !== pat[j]) {
          ok = false;
          break;
        }
      }
      if (ok) score += 40;
    }
  };
  for (let r = 0; r < size; r++) {
    const row = m[r];
    matchAt(row, pat1);
    matchAt(row, pat2);
  }
  for (let c = 0; c < size; c++) {
    const col = m.map((row) => row[c]);
    matchAt(col, pat1);
    matchAt(col, pat2);
  }
  // Rule 4: proportion of dark modules.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
  const ratio = (dark * 100) / (size * size);
  const k = Math.floor(Math.abs(ratio - 50) / 5);
  score += k * 10;
  return score;
}

/**
 * Encode `text` into a QR module matrix at the given EC level (default M).
 * Byte mode; the smallest fitting version (1..40) is chosen automatically and
 * the lowest-penalty data mask is selected per spec.
 */
export function encodeQr(text: string, ecLevel: QrEcLevel = "M"): QrMatrix {
  const version = pickVersion(text, ecLevel);
  const dataCw = encodeData(text, version, ecLevel);
  const finalCw = buildFinalCodewords(dataCw, version, ecLevel);

  const size = sizeForVersion(version);
  const base = blankMatrix(size);
  placeFinder(base, 0, 0);
  placeFinder(base, 0, size - 7);
  placeFinder(base, size - 7, 0);
  placeAlignment(base, version);
  placeTiming(base);
  reserveFormatAndVersion(base, version);
  const isData = placeData(base, finalCw);

  let best: boolean[][] | null = null;
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(base, isData, MASK_FNS[mask]);
    placeFormat(candidate, base, ecLevel, mask);
    placeVersion(candidate, version);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
      bestMask = mask;
    }
  }
  void bestMask;
  return { size, modules: best!, version, ecLevel };
}

export interface QrSvgOptions {
  fg?: string; // foreground (dark) color, default "#000000"
  bg?: string; // background color, default "#ffffff"
  moduleSize?: number; // px per module, default 4
  quietZone?: number; // modules of margin, default 4
  logo?: { href: string; sizeRatio?: number }; // optional center logo
}

/**
 * Render a QR matrix to an SVG string. Dark modules are emitted as <rect>
 * elements; the background is a single rect honoring `bg`. An optional center
 * logo is composited via an <image> element sized as a fraction of the code.
 */
export function qrToSvg(matrix: QrMatrix, opts: QrSvgOptions = {}): string {
  const fg = opts.fg ?? "#000000";
  const bg = opts.bg ?? "#ffffff";
  const ms = opts.moduleSize ?? 4;
  const qz = opts.quietZone ?? 4;
  const n = matrix.size;
  const dim = (n + qz * 2) * ms;

  const rects: string[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix.modules[r][c]) {
        const x = (c + qz) * ms;
        const y = (r + qz) * ms;
        rects.push(`<rect x="${x}" y="${y}" width="${ms}" height="${ms}" fill="${fg}"/>`);
      }
    }
  }

  let logoEl = "";
  if (opts.logo) {
    const ratio = Math.min(0.3, Math.max(0.05, opts.logo.sizeRatio ?? 0.2));
    const lw = dim * ratio;
    const lx = (dim - lw) / 2;
    logoEl = `<image href="${escapeAttr(opts.logo.href)}" x="${lx}" y="${lx}" width="${lw}" height="${lw}"/>`;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" ` +
    `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect x="0" y="0" width="${dim}" height="${dim}" fill="${bg}"/>` +
    rects.join("") +
    logoEl +
    `</svg>`
  );
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
