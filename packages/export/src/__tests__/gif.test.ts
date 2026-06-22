import { describe, it, expect } from "vitest";
import { encodeGif, type GifFrame } from "../gif";

// An independent, canonical GIF89a decoder (NOT a mirror of the encoder's
// internals) so a passing round-trip genuinely validates real-decoder
// compatibility, including the LZW variable-code-size growth boundary.
function lzwDecode(data: Uint8Array, minCodeSize: number): number[] {
  const CLEAR = 1 << minCodeSize;
  const EOI = CLEAR + 1;
  let codeSize = minCodeSize + 1;
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < CLEAR; i++) dict.push([i]);
    dict.push([]); // CLEAR slot
    dict.push([]); // EOI slot
  };
  reset();
  let next = EOI + 1;
  let bitBuf = 0;
  let bitCnt = 0;
  let p = 0;
  const read = (): number => {
    while (bitCnt < codeSize) {
      bitBuf |= (data[p++] ?? 0) << bitCnt;
      bitCnt += 8;
    }
    const code = bitBuf & ((1 << codeSize) - 1);
    bitBuf >>= codeSize;
    bitCnt -= codeSize;
    return code;
  };
  const out: number[] = [];
  let prev = -1;
  for (;;) {
    if (p >= data.length && bitCnt < codeSize) break;
    const code = read();
    if (code === CLEAR) {
      reset();
      next = EOI + 1;
      codeSize = minCodeSize + 1;
      prev = -1;
      continue;
    }
    if (code === EOI) break;
    let entry: number[];
    if (code < next && dict[code].length) entry = dict[code];
    else if (prev >= 0) entry = dict[prev].concat(dict[prev][0]); // KwKwK case
    else break;
    for (const v of entry) out.push(v);
    if (prev >= 0 && next < 4096) {
      dict[next] = dict[prev].concat(entry[0]);
      next++;
      if (next >= 1 << codeSize && next < 4096 && codeSize < 12) codeSize++;
    }
    prev = code;
  }
  return out;
}

interface DecodedFrame { indices: number[]; transparentIndex: number }
interface Decoded { width: number; height: number; gct: number[][]; loops: number; frames: DecodedFrame[] }

function decodeGif(bytes: Uint8Array): Decoded {
  let p = 0;
  const sig = String.fromCharCode(...bytes.subarray(0, 6));
  if (sig !== "GIF89a" && sig !== "GIF87a") throw new Error("bad signature: " + sig);
  p = 6;
  const u16 = () => bytes[p++] | (bytes[p++] << 8);
  const width = u16();
  const height = u16();
  const packed = bytes[p++];
  p++; // bg
  p++; // aspect
  const gctSize = 1 << ((packed & 0x07) + 1);
  const gct: number[][] = [];
  if (packed & 0x80) {
    for (let i = 0; i < gctSize; i++) gct.push([bytes[p++], bytes[p++], bytes[p++]]);
  }
  const skipSubBlocks = () => {
    for (;;) {
      const len = bytes[p++];
      if (len === 0) break;
      p += len;
    }
  };
  const frames: DecodedFrame[] = [];
  let loops = -1;
  let pendingTransparent = -1;
  for (;;) {
    const b = bytes[p++];
    if (b === 0x3b) break; // trailer
    if (b === 0x21) {
      const label = bytes[p++];
      if (label === 0xf9) {
        // Graphic Control Extension.
        const size = bytes[p++];
        const flags = bytes[p];
        pendingTransparent = flags & 0x01 ? bytes[p + 3] : -1;
        p += size;
        p++; // block terminator
      } else if (label === 0xff) {
        const size = bytes[p++];
        const name = String.fromCharCode(...bytes.subarray(p, p + size));
        p += size;
        if (name === "NETSCAPE2.0") {
          const sub = bytes[p++]; // 0x03
          void sub;
          p++; // 0x01
          loops = bytes[p++] | (bytes[p++] << 8);
          p++; // terminator
        } else {
          skipSubBlocks();
        }
      } else {
        skipSubBlocks();
      }
    } else if (b === 0x2c) {
      // Image Descriptor.
      u16(); // left
      u16(); // top
      u16(); // w
      u16(); // h
      const ipacked = bytes[p++];
      if (ipacked & 0x80) p += 3 * (1 << ((ipacked & 0x07) + 1)); // local color table
      const minCode = bytes[p++];
      const chunks: number[] = [];
      for (;;) {
        const len = bytes[p++];
        if (len === 0) break;
        for (let i = 0; i < len; i++) chunks.push(bytes[p++]);
      }
      const indices = lzwDecode(Uint8Array.from(chunks), minCode);
      frames.push({ indices, transparentIndex: pendingTransparent });
      pendingTransparent = -1;
    } else {
      throw new Error("unexpected block 0x" + b.toString(16));
    }
  }
  return { width, height, gct, loops, frames };
}

function frame(w: number, h: number, fn: (x: number, y: number) => [number, number, number, number], delayMs: number): GifFrame {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      const o = (y * w + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
    }
  }
  return { rgba, delayMs };
}

describe("encodeGif", () => {
  it("round-trips a few-colour image exactly", () => {
    const W = 8, H = 6;
    const palette: [number, number, number][] = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
    const f = frame(W, H, (x) => [...palette[x % 3], 255] as [number, number, number, number], 100);
    const gif = encodeGif([f], { width: W, height: H });
    expect(String.fromCharCode(...gif.subarray(0, 6))).toBe("GIF89a");

    const dec = decodeGif(gif);
    expect(dec.width).toBe(W);
    expect(dec.height).toBe(H);
    expect(dec.loops).toBe(0); // infinite by default
    expect(dec.frames.length).toBe(1);
    expect(dec.frames[0].indices.length).toBe(W * H);
    // Every decoded pixel maps back to the exact original colour.
    for (let i = 0; i < W * H; i++) {
      const rgb = dec.gct[dec.frames[0].indices[i]];
      const expected = palette[(i % W) % 3];
      expect(rgb).toEqual(expected);
    }
  });

  it("writes multiple frames with per-frame delays and a transparent index", () => {
    const W = 4, H = 4;
    const a = frame(W, H, () => [10, 20, 30, 255], 40);
    const b = frame(W, H, (x, y) => (x === 0 && y === 0 ? [0, 0, 0, 0] : [200, 100, 50, 255]), 80);
    const gif = encodeGif([a, b], { width: W, height: H, loops: 3 });
    const dec = decodeGif(gif);
    expect(dec.frames.length).toBe(2);
    expect(dec.loops).toBe(3);
    // Frame b's (0,0) pixel is transparent.
    expect(dec.frames[1].transparentIndex).toBeGreaterThanOrEqual(0);
    expect(dec.frames[1].indices[0]).toBe(dec.frames[1].transparentIndex);
  });

  it("round-trips a high-colour gradient that grows the LZW code size", () => {
    // A 64x64 gradient yields many distinct colours and long runs, exercising the
    // variable code-size growth and (potentially) a dictionary reset.
    const W = 64, H = 64;
    const f = frame(W, H, (x, y) => [(x * 4) & 255, (y * 4) & 255, ((x + y) * 2) & 255, 255], 50);
    const gif = encodeGif([f], { width: W, height: H, maxColors: 256 });
    const dec = decodeGif(gif);
    expect(dec.frames[0].indices.length).toBe(W * H);
    // Decoded colours should be close to the originals (quantization error small).
    let maxErr = 0;
    for (let i = 0; i < W * H; i++) {
      const x = i % W, y = (i / W) | 0;
      const want = [(x * 4) & 255, (y * 4) & 255, ((x + y) * 2) & 255];
      const got = dec.gct[dec.frames[0].indices[i]];
      for (let c = 0; c < 3; c++) maxErr = Math.max(maxErr, Math.abs(got[c] - want[c]));
    }
    expect(maxErr).toBeLessThan(40); // 256-colour median cut stays close
  });

  it("throws on empty frame list", () => {
    expect(() => encodeGif([], { width: 4, height: 4 })).toThrow();
  });
});
