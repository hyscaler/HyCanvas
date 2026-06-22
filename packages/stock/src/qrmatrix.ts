// QR code bit-matrix encoder: turns a bound value into a
// scannable module matrix that the engine/server renders (drawQr reads
// node.modules). Pure and dependency-free. Byte (8-bit) mode, versions 1..6, all
// four error-correction levels, with Reed-Solomon over GF(256), block
// interleaving, and automatic best-mask selection. The algorithm follows the
// ISO/IEC 18004 reference (Nayuki's public-domain QR implementation).

import type { QrEcLevel } from "./qr";

// --- Galois field GF(256), primitive polynomial 0x11d ----------------------
const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] + LOG[b]) % 255];
}

// Reed-Solomon divisor (monic generator polynomial, coefficients excluding the
// leading 1), then the remainder of dividing the data by it.
function rsDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

function rsRemainder(data: Uint8Array, degree: number): Uint8Array {
  const divisor = rsDivisor(degree);
  const result = new Uint8Array(degree);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[degree - 1] = 0;
    for (let i = 0; i < degree; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

// --- Error-correction block table, versions 1..6 ---------------------------
interface EcEntry {
  ecPerBlock: number;
  groups: [number, number][]; // [blockCount, dataCodewordsPerBlock]
}
const EC_TABLE: Record<string, EcEntry> = {
  "1L": { ecPerBlock: 7, groups: [[1, 19]] },
  "1M": { ecPerBlock: 10, groups: [[1, 16]] },
  "1Q": { ecPerBlock: 13, groups: [[1, 13]] },
  "1H": { ecPerBlock: 17, groups: [[1, 9]] },
  "2L": { ecPerBlock: 10, groups: [[1, 34]] },
  "2M": { ecPerBlock: 16, groups: [[1, 28]] },
  "2Q": { ecPerBlock: 22, groups: [[1, 22]] },
  "2H": { ecPerBlock: 28, groups: [[1, 16]] },
  "3L": { ecPerBlock: 15, groups: [[1, 55]] },
  "3M": { ecPerBlock: 26, groups: [[1, 44]] },
  "3Q": { ecPerBlock: 18, groups: [[2, 17]] },
  "3H": { ecPerBlock: 22, groups: [[2, 13]] },
  "4L": { ecPerBlock: 20, groups: [[1, 80]] },
  "4M": { ecPerBlock: 18, groups: [[2, 32]] },
  "4Q": { ecPerBlock: 26, groups: [[2, 24]] },
  "4H": { ecPerBlock: 16, groups: [[4, 9]] },
  "5L": { ecPerBlock: 26, groups: [[1, 108]] },
  "5M": { ecPerBlock: 24, groups: [[2, 43]] },
  "5Q": { ecPerBlock: 18, groups: [[2, 15], [2, 16]] },
  "5H": { ecPerBlock: 22, groups: [[2, 11], [2, 12]] },
  "6L": { ecPerBlock: 18, groups: [[2, 68]] },
  "6M": { ecPerBlock: 16, groups: [[4, 27]] },
  "6Q": { ecPerBlock: 24, groups: [[4, 19]] },
  "6H": { ecPerBlock: 28, groups: [[4, 15]] },
};

function dataCapacity(entry: EcEntry): number {
  return entry.groups.reduce((s, [c, d]) => s + c * d, 0);
}

// Format-info error-correction indicator bits (M=0, L=1, H=2, Q=3).
const EC_FORMAT_BITS: Record<QrEcLevel, number> = { M: 0, L: 1, H: 2, Q: 3 };

function getBit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0;
}

function utf8Bytes(text: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
  // Minimal fallback for environments without TextEncoder.
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

/** Encode `value` into a scannable QR module matrix (true = dark). Throws if the
 *  value is too long for versions 1..6 at the requested EC level. */
export function encodeQrMatrix(value: string, ecLevel: QrEcLevel = "M"): boolean[][] {
  const bytes = utf8Bytes(value);

  // Pick the smallest version (1..6) whose data capacity holds the payload.
  let version = 0;
  let entry: EcEntry | null = null;
  for (let v = 1; v <= 6; v++) {
    const e = EC_TABLE[`${v}${ecLevel}`];
    const needBits = 4 + 8 + bytes.length * 8; // mode + 8-bit count + data
    if (needBits <= dataCapacity(e) * 8) {
      version = v;
      entry = e;
      break;
    }
  }
  if (!entry) throw new Error("encodeQrMatrix: value too long for QR versions 1-6");
  const dataCw = dataCapacity(entry);

  // Build the bit stream: byte mode (0100), 8-bit length, data, terminator, pad.
  const bits: number[] = [];
  const push = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  const capacityBits = dataCw * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  const dataCodewords = new Uint8Array(dataCw);
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    dataCodewords[i / 8] = byte;
  }
  for (let i = bits.length / 8, pad = 0; i < dataCw; i++, pad++) {
    dataCodewords[i] = pad % 2 === 0 ? 0xec : 0x11;
  }

  // Split into blocks, append EC, interleave (data then EC, column-major).
  const blocks: { data: Uint8Array; ec: Uint8Array }[] = [];
  let pos = 0;
  for (const [count, perBlock] of entry.groups) {
    for (let k = 0; k < count; k++) {
      const data = dataCodewords.slice(pos, pos + perBlock);
      pos += perBlock;
      blocks.push({ data, ec: rsRemainder(data, entry.ecPerBlock) });
    }
  }
  const interleaved: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) interleaved.push(b.data[i]);
  for (let i = 0; i < entry.ecPerBlock; i++) for (const b of blocks) interleaved.push(b.ec[i]);
  const allCw = Uint8Array.from(interleaved);

  // --- Build the module grid -----------------------------------------------
  const size = version * 4 + 17;
  const modules: number[][] = Array.from({ length: size }, () => new Array(size).fill(0));
  const isFn: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark ? 1 : 0;
    isFn[y][x] = true;
  };

  const drawFinder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = cx + dx;
        const yy = cy + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFn(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  };
  const drawAlign = (cx: number, cy: number) => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  };

  // Timing patterns.
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  // Finder patterns + separators.
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);
  // Alignment patterns (versions 2..6 have exactly one, at (size-7, size-7)).
  const alignPositions = version === 1 ? [] : [6, size - 7];
  for (let i = 0; i < alignPositions.length; i++) {
    for (let j = 0; j < alignPositions.length; j++) {
      const n = alignPositions.length;
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      drawAlign(alignPositions[i], alignPositions[j]);
    }
  }

  // Reserve the format-info area + dark module (drawn for real after masking).
  const drawFormat = (mask: number) => {
    const data = (EC_FORMAT_BITS[ecLevel] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    const fbits = ((data << 10) | rem) ^ 0x5412;
    // First copy (around the top-left finder).
    for (let i = 0; i <= 5; i++) setFn(8, i, getBit(fbits, i));
    setFn(8, 7, getBit(fbits, 6));
    setFn(8, 8, getBit(fbits, 7));
    setFn(7, 8, getBit(fbits, 8));
    for (let i = 9; i <= 14; i++) setFn(14 - i, 8, getBit(fbits, i));
    // Second copy (split across the other two finders) + always-dark module.
    for (let i = 0; i <= 7; i++) setFn(size - 1 - i, 8, getBit(fbits, i));
    for (let i = 8; i <= 14; i++) setFn(8, size - 15 + i, getBit(fbits, i));
    setFn(8, size - 8, true);
  };
  drawFormat(0); // reserve

  // --- Place data + EC codewords in the zigzag pattern ----------------------
  let bitIdx = 0;
  const totalBits = allCw.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column entirely
    for (let vert = 0; vert < size; vert++) {
      for (let k = 0; k < 2; k++) {
        const x = right - k;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFn[y][x] && bitIdx < totalBits) {
          modules[y][x] = getBit(allCw[bitIdx >> 3], 7 - (bitIdx & 7)) ? 1 : 0;
          bitIdx++;
        }
      }
    }
  }

  // --- Masking: pick the lowest-penalty mask --------------------------------
  const maskCond = (m: number, x: number, y: number): boolean => {
    switch (m) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };
  const applyMask = (m: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && maskCond(m, x, y)) modules[y][x] ^= 1;
  };

  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m);
    drawFormat(m);
    const p = penalty(modules, size);
    if (p < bestPenalty) {
      bestPenalty = p;
      bestMask = m;
    }
    applyMask(m); // revert data modules (XOR is its own inverse)
  }
  applyMask(bestMask);
  drawFormat(bestMask);

  return modules.map((row) => row.map((v) => v === 1));
}

// Penalty score per ISO 18004 (four rules) used to choose the mask.
function penalty(m: number[][], size: number): number {
  let score = 0;
  // Rule 1: runs of 5+ same-colour modules in each row/column.
  for (let y = 0; y < size; y++) {
    let runColor = -1;
    let runLen = 0;
    for (let x = 0; x < size; x++) {
      if (m[y][x] === runColor) {
        runLen++;
        if (runLen === 5) score += 3;
        else if (runLen > 5) score += 1;
      } else {
        runColor = m[y][x];
        runLen = 1;
      }
    }
  }
  for (let x = 0; x < size; x++) {
    let runColor = -1;
    let runLen = 0;
    for (let y = 0; y < size; y++) {
      if (m[y][x] === runColor) {
        runLen++;
        if (runLen === 5) score += 3;
        else if (runLen > 5) score += 1;
      } else {
        runColor = m[y][x];
        runLen = 1;
      }
    }
  }
  // Rule 2: 2x2 blocks of the same colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }
  }
  // Rule 3: finder-like 1:1:3:1:1 patterns in rows/columns.
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (get: (i: number) => number, start: number, pat: number[]) => {
    for (let i = 0; i < pat.length; i++) if (get(start + i) !== pat[i]) return false;
    return true;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x <= size - 11; x++) {
      if (matches((i) => m[y][i], x, pat1) || matches((i) => m[y][i], x, pat2)) score += 40;
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y <= size - 11; y++) {
      if (matches((i) => m[i][x], y, pat1) || matches((i) => m[i][x], y, pat2)) score += 40;
    }
  }
  // Rule 4: deviation of dark-module proportion from 50%.
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) dark += m[y][x];
  const total = size * size;
  const ratio = (dark * 100) / total;
  const k = Math.floor(Math.abs(ratio - 50) / 5);
  score += k * 10;
  return score;
}
