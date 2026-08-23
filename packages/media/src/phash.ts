// Perceptual hashing for near-duplicate detection. A simple
// average-hash (aHash): downsample to 8x8 grayscale, then set each of the 64
// bits to whether that cell is brighter than the mean. Near-duplicates (resave,
// resize, light re-encode) keep a small Hamming distance. Pure and deterministic.

export interface Bitmap {
  width: number;
  height: number;
  data: Uint8ClampedArray | number[]; // RGBA, 0..255
}

const SIZE = 8; // 8x8 -> 64-bit hash

/** Box-downsample to SIZE x SIZE grayscale (0..255). */
function downsampleGray(bmp: Bitmap): number[] {
  const out: number[] = new Array(SIZE * SIZE).fill(0);
  if (bmp.width === 0 || bmp.height === 0) return out;
  const cw = bmp.width / SIZE;
  const ch = bmp.height / SIZE;
  for (let gy = 0; gy < SIZE; gy++) {
    for (let gx = 0; gx < SIZE; gx++) {
      const x0 = Math.floor(gx * cw);
      const y0 = Math.floor(gy * ch);
      const x1 = Math.max(x0 + 1, Math.floor((gx + 1) * cw));
      const y1 = Math.max(y0 + 1, Math.floor((gy + 1) * ch));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1 && y < bmp.height; y++) {
        for (let x = x0; x < x1 && x < bmp.width; x++) {
          const o = (y * bmp.width + x) * 4;
          // Rec. 601 luma.
          const lum = 0.299 * bmp.data[o] + 0.587 * bmp.data[o + 1] + 0.114 * bmp.data[o + 2];
          sum += lum;
          count++;
        }
      }
      out[gy * SIZE + gx] = count ? sum / count : 0;
    }
  }
  return out;
}

/** 64-bit average hash as a 16-character lowercase hex string. */
export function averageHash(bmp: Bitmap): string {
  const gray = downsampleGray(bmp);
  const mean = gray.reduce((a, b) => a + b, 0) / gray.length;
  let hex = "";
  for (let nibble = 0; nibble < 16; nibble++) {
    let v = 0;
    for (let bit = 0; bit < 4; bit++) {
      const idx = nibble * 4 + bit;
      v = (v << 1) | (gray[idx] >= mean ? 1 : 0);
    }
    hex += v.toString(16);
  }
  return hex;
}

const POPCOUNT: number[] = Array.from({ length: 16 }, (_, i) =>
  ((i >> 0) & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1),
);

/** Hamming distance between two equal-length hex hashes (count of differing bits). */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new Error("hash length mismatch");
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    d += POPCOUNT[(parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 0xf];
  }
  return d;
}

/** Default near-duplicate threshold: <= 5 differing bits out of 64. */
export const nearDuplicateMaxDistance = 5;

export function isNearDuplicate(a: string, b: string, maxDistance = nearDuplicateMaxDistance): boolean {
  return hammingDistance(a, b) <= maxDistance;
}
