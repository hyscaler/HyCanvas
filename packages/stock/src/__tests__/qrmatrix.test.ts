import { describe, it, expect } from "vitest";
import { encodeQrMatrix } from "../qrmatrix";
import { createQrNode, rebindQrValue } from "../qr";

// Independent GF(256) + EC table + decoder, written separately from the encoder,
// so a passing round-trip genuinely validates placement, masking, byte encoding,
// block interleaving, and Reed-Solomon correctness (syndromes must be zero).
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
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[(LOG[a] + LOG[b]) % 255]);

const EC_TABLE: Record<string, { ec: number; groups: [number, number][] }> = {
  "1L": { ec: 7, groups: [[1, 19]] }, "1M": { ec: 10, groups: [[1, 16]] }, "1Q": { ec: 13, groups: [[1, 13]] }, "1H": { ec: 17, groups: [[1, 9]] },
  "2L": { ec: 10, groups: [[1, 34]] }, "2M": { ec: 16, groups: [[1, 28]] }, "2Q": { ec: 22, groups: [[1, 22]] }, "2H": { ec: 28, groups: [[1, 16]] },
  "3L": { ec: 15, groups: [[1, 55]] }, "3M": { ec: 26, groups: [[1, 44]] }, "3Q": { ec: 18, groups: [[2, 17]] }, "3H": { ec: 22, groups: [[2, 13]] },
  "4L": { ec: 20, groups: [[1, 80]] }, "4M": { ec: 18, groups: [[2, 32]] }, "4Q": { ec: 26, groups: [[2, 24]] }, "4H": { ec: 16, groups: [[4, 9]] },
  "5L": { ec: 26, groups: [[1, 108]] }, "5M": { ec: 24, groups: [[2, 43]] }, "5Q": { ec: 18, groups: [[2, 15], [2, 16]] }, "5H": { ec: 22, groups: [[2, 11], [2, 12]] },
  "6L": { ec: 18, groups: [[2, 68]] }, "6M": { ec: 16, groups: [[4, 27]] }, "6Q": { ec: 24, groups: [[4, 19]] }, "6H": { ec: 28, groups: [[4, 15]] },
};
const EC_FROM_BITS: Record<number, string> = { 0: "M", 1: "L", 2: "H", 3: "Q" };

function maskCond(m: number, x: number, y: number): boolean {
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
}

// Rebuild the function-module grid for a version (mirrors the spec layout).
function functionGrid(size: number): boolean[][] {
  const isFn: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x: number, y: number) => {
    if (x >= 0 && x < size && y >= 0 && y < size) isFn[y][x] = true;
  };
  for (let i = 0; i < size; i++) { set(6, i); set(i, 6); }
  const finder = (cx: number, cy: number) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) set(cx + dx, cy + dy); };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const version = (size - 17) / 4;
  if (version >= 2) {
    const c = size - 7;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(c + dx, c + dy);
  }
  // Format-info area + dark module.
  for (let i = 0; i <= 5; i++) set(8, i);
  set(8, 7); set(8, 8); set(7, 8);
  for (let i = 9; i <= 14; i++) set(14 - i, 8);
  for (let i = 0; i <= 7; i++) set(size - 1 - i, 8);
  for (let i = 8; i <= 14; i++) set(8, size - 15 + i);
  set(8, size - 8);
  return isFn;
}

function decodeQr(modules: boolean[][]): { text: string; syndromesOk: boolean } {
  const size = modules.length;
  const m = modules.map((r) => r.map((v) => (v ? 1 : 0)));
  const isFn = functionGrid(size);

  // Read the 15-bit format info (first copy), unmask, extract EC level + mask.
  const fbit = (i: number): number => {
    if (i <= 5) return m[i][8];
    if (i === 6) return m[7][8];
    if (i === 7) return m[8][8];
    if (i === 8) return m[8][7];
    return m[8][14 - i];
  };
  let fmt = 0;
  for (let i = 0; i < 15; i++) fmt |= fbit(i) << i;
  fmt ^= 0x5412;
  const data5 = fmt >> 10;
  const ecLevel = EC_FROM_BITS[(data5 >> 3) & 3];
  const mask = data5 & 7;

  // Unmask data modules.
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && maskCond(mask, x, y)) m[y][x] ^= 1;

  // Read codeword bits in the zigzag order (mutating `right` to skip column 6).
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let k = 0; k < 2; k++) {
        const x = right - k;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFn[y][x]) bits.push(m[y][x]);
      }
    }
  }
  const allCw: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    allCw.push(b);
  }

  // De-interleave into blocks.
  const version = (size - 17) / 4;
  const entry = EC_TABLE[`${version}${ecLevel}`];
  const blockDataLens: number[] = [];
  for (const [count, perBlock] of entry.groups) for (let k = 0; k < count; k++) blockDataLens.push(perBlock);
  const numBlocks = blockDataLens.length;
  const maxData = Math.max(...blockDataLens);
  const blocksData: number[][] = blockDataLens.map(() => []);
  let idx = 0;
  for (let col = 0; col < maxData; col++) for (let b = 0; b < numBlocks; b++) if (col < blockDataLens[b]) blocksData[b].push(allCw[idx++]);
  const blocksEc: number[][] = blockDataLens.map(() => []);
  for (let col = 0; col < entry.ec; col++) for (let b = 0; b < numBlocks; b++) blocksEc[b].push(allCw[idx++]);

  // RS syndrome check: every codeword block must evaluate to zero at alpha^j.
  let syndromesOk = true;
  for (let b = 0; b < numBlocks; b++) {
    const code = blocksData[b].concat(blocksEc[b]);
    for (let j = 0; j < entry.ec; j++) {
      let s = 0;
      for (const c of code) s = mul(s, EXP[j]) ^ c;
      if (s !== 0) syndromesOk = false;
    }
  }

  // Parse byte mode from the concatenated data codewords.
  const dataCw: number[] = [];
  for (const bd of blocksData) dataCw.push(...bd);
  const db: number[] = [];
  for (const c of dataCw) for (let i = 7; i >= 0; i--) db.push((c >> i) & 1);
  let p = 0;
  const take = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | db[p++];
    return v;
  };
  const mode = take(4);
  const len = take(8);
  const out: number[] = [];
  if (mode === 0b0100) for (let i = 0; i < len; i++) out.push(take(8));
  const text = new TextDecoder().decode(Uint8Array.from(out));
  return { text, syndromesOk };
}

describe("encodeQrMatrix", () => {
  it("produces a square matrix with finder patterns at three corners", () => {
    const mat = encodeQrMatrix("HELLO", "M");
    const size = mat.length;
    expect(mat.every((r) => r.length === size)).toBe(true);
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      expect(mat[cy][cx]).toBe(true); // finder centre dark
      expect(mat[cy - 2][cx]).toBe(false); // inner white ring
    }
    for (let x = 8; x < size - 8; x++) expect(mat[6][x]).toBe(x % 2 === 0); // timing
  });

  it("round-trips short and long values at every EC level", () => {
    const cases: [string, "L" | "M" | "Q" | "H"][] = [
      ["HELLO WORLD", "M"],
      ["https://hycanvas.example/d/abc123", "L"],
      ["x", "H"],
      ["The quick brown fox jumps over the lazy dog. 1234567890", "Q"],
    ];
    for (const [value, ec] of cases) {
      const { text, syndromesOk } = decodeQr(encodeQrMatrix(value, ec));
      expect(text).toBe(value); // placement + masking + encoding correct
      expect(syndromesOk).toBe(true); // Reed-Solomon codewords valid
    }
  });

  it("selects a larger version as the payload grows", () => {
    expect(encodeQrMatrix("hi", "L").length).toBe(21); // version 1
    expect(encodeQrMatrix("x".repeat(120), "L").length).toBeGreaterThan(21);
  });

  it("throws when the value exceeds version-6 capacity", () => {
    expect(() => encodeQrMatrix("x".repeat(2000), "H")).toThrow();
  });
});

describe("QR node integration", () => {
  it("createQrNode embeds a decodable matrix", () => {
    const node = createQrNode("https://example.com", { ecLevel: "M" }) as unknown as { modules: boolean[][] };
    const dec = decodeQr(node.modules);
    expect(dec.text).toBe("https://example.com");
    expect(dec.syndromesOk).toBe(true);
  });

  it("rebindQrValue regenerates the matrix for the new value", () => {
    const node = createQrNode("first", { ecLevel: "L" });
    const rebound = rebindQrValue(node, "second") as unknown as { modules: boolean[][]; value: string };
    expect(rebound.value).toBe("second");
    expect(decodeQr(rebound.modules).text).toBe("second");
  });
});
