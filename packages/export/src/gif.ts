// Animated GIF89a encoder. Pure and dependency-free: median-cut colour
// quantization to one shared global palette (<=256 colours), variable-width LZW
// compression, per-frame delays, NETSCAPE2.0 looping, and 1-bit transparency.
// Input frames are raw RGBA pixels (e.g. from canvas getImageData); all frames
// share a single global colour table so the animation stays small and visually
// consistent across frames.

export interface GifFrame {
  /** RGBA pixels, length = width * height * 4. */
  rgba: Uint8Array;
  /** Frame display time in milliseconds. */
  delayMs: number;
}

export interface GifOptions {
  width: number;
  height: number;
  /** Loop count; 0 = infinite (default). */
  loops?: number;
  /** Maximum palette size, 2..256 (default 256). */
  maxColors?: number;
  /** Pixels with alpha below this become transparent; 0 disables (default 128). */
  transparentAlpha?: number;
}

type RGB = [number, number, number];

// Median-cut quantization: repeatedly split the colour box with the widest axis
// at its median until we reach the target colour count, then average each box.
function quantize(samples: RGB[], maxColors: number): RGB[] {
  if (samples.length === 0) return [[0, 0, 0]];
  let boxes: RGB[][] = [samples];
  while (boxes.length < maxColors) {
    let target = -1;
    let bestRange = -1;
    let bestAxis = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.length < 2) continue;
      const mn: RGB = [255, 255, 255];
      const mx: RGB = [0, 0, 0];
      for (const c of box) {
        for (let a = 0; a < 3; a++) {
          if (c[a] < mn[a]) mn[a] = c[a];
          if (c[a] > mx[a]) mx[a] = c[a];
        }
      }
      for (let a = 0; a < 3; a++) {
        const range = mx[a] - mn[a];
        if (range > bestRange) {
          bestRange = range;
          target = i;
          bestAxis = a;
        }
      }
    }
    if (target < 0) break; // every box has a single colour
    const box = boxes[target];
    box.sort((p, q) => p[bestAxis] - q[bestAxis]);
    const mid = box.length >> 1;
    boxes.splice(target, 1, box.slice(0, mid), box.slice(mid));
  }
  return boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const c of box) {
      r += c[0];
      g += c[1];
      b += c[2];
    }
    const n = box.length || 1;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)] as RGB;
  });
}

function nearestIndex(palette: RGB[], r: number, g: number, b: number, cache: Map<number, number>): number {
  const key = (r << 16) | (g << 8) | b;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const dr = p[0] - r;
    const dg = p[1] - g;
    const db = p[2] - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  cache.set(key, best);
  return best;
}

// Variable-width LZW compression as specified by the GIF spec: codes grow from
// minCodeSize+1 bits up to 12, with a clear code resetting the dictionary.
function lzwCompress(indices: Uint8Array, minCodeSize: number): number[] {
  const CLEAR = 1 << minCodeSize;
  const EOI = CLEAR + 1;
  let codeSize = minCodeSize + 1;
  let dict = new Map<number, number>();
  let next = EOI + 1;
  const reset = () => {
    dict = new Map();
    next = EOI + 1;
    codeSize = minCodeSize + 1;
  };
  reset();

  let bitBuf = 0;
  let bitCnt = 0;
  const out: number[] = [];
  const write = (code: number) => {
    bitBuf |= code << bitCnt;
    bitCnt += codeSize;
    while (bitCnt >= 8) {
      out.push(bitBuf & 0xff);
      bitBuf >>= 8;
      bitCnt -= 8;
    }
  };

  write(CLEAR);
  if (indices.length === 0) {
    write(EOI);
    if (bitCnt > 0) out.push(bitBuf & 0xff);
    return out;
  }

  let cur = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (cur << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      cur = found;
    } else {
      write(cur);
      if (next === 4096) {
        // Dictionary full: emit a clear code (at the current size) and reset.
        write(CLEAR);
        reset();
      } else {
        // Grow the code size BEFORE assigning the next code, so the code that
        // crosses the 2^codeSize boundary is still emitted at the old size and a
        // standard decoder (which bumps one step later) stays in lockstep.
        if (next >= 1 << codeSize && codeSize < 12) codeSize++;
        dict.set(key, next);
        next++;
      }
      cur = k;
    }
  }
  write(cur);
  write(EOI);
  if (bitCnt > 0) out.push(bitBuf & 0xff);
  return out;
}

function pushU16(out: number[], v: number) {
  out.push(v & 0xff, (v >> 8) & 0xff);
}

// Break the LZW byte stream into <=255-byte sub-blocks terminated by a 0 byte.
function pushSubBlocks(out: number[], bytes: number[]) {
  let p = 0;
  while (p < bytes.length) {
    const len = Math.min(255, bytes.length - p);
    out.push(len);
    for (let i = 0; i < len; i++) out.push(bytes[p + i]);
    p += len;
  }
  out.push(0);
}

/** Encode RGBA frames into a single animated GIF89a. */
export function encodeGif(frames: GifFrame[], opts: GifOptions): Uint8Array {
  if (!frames.length) throw new Error("encodeGif: no frames");
  const { width, height } = opts;
  if (width <= 0 || height <= 0) throw new Error("encodeGif: invalid dimensions");
  const transparentAlpha = opts.transparentAlpha ?? 128;
  const maxColors = Math.max(2, Math.min(256, opts.maxColors ?? 256));

  // Detect transparency and collect opaque colour samples across all frames.
  let hasTransparency = false;
  const samples: RGB[] = [];
  const pxPerFrame = width * height;
  const stride = Math.max(1, Math.floor((pxPerFrame * frames.length) / 16384)); // cap samples
  let counter = 0;
  for (const frame of frames) {
    for (let p = 0; p < pxPerFrame; p++) {
      const a = frame.rgba[p * 4 + 3];
      if (transparentAlpha > 0 && a < transparentAlpha) {
        hasTransparency = true;
        continue;
      }
      if (counter++ % stride === 0) {
        samples.push([frame.rgba[p * 4], frame.rgba[p * 4 + 1], frame.rgba[p * 4 + 2]]);
      }
    }
  }

  const paletteColors = quantize(samples, maxColors - (hasTransparency ? 1 : 0));
  const transparentIndex = hasTransparency ? paletteColors.length : -1;
  const totalColors = paletteColors.length + (hasTransparency ? 1 : 0);
  let bitsPerPixel = 2;
  while (1 << bitsPerPixel < totalColors) bitsPerPixel++;
  const gctSize = 1 << bitsPerPixel; // padded colour-table entry count

  const out: number[] = [];
  // Header.
  for (const ch of "GIF89a") out.push(ch.charCodeAt(0));
  // Logical Screen Descriptor.
  pushU16(out, width);
  pushU16(out, height);
  out.push(0x80 | (7 << 4) | (bitsPerPixel - 1)); // GCT present, 8-bit colour res, GCT size
  out.push(transparentIndex >= 0 ? transparentIndex : 0); // background colour index
  out.push(0); // pixel aspect ratio
  // Global Colour Table (padded to gctSize entries).
  for (let i = 0; i < gctSize; i++) {
    const c = paletteColors[i];
    if (c) out.push(c[0], c[1], c[2]);
    else out.push(0, 0, 0);
  }
  // NETSCAPE2.0 looping extension.
  out.push(0x21, 0xff, 0x0b);
  for (const ch of "NETSCAPE2.0") out.push(ch.charCodeAt(0));
  out.push(0x03, 0x01);
  pushU16(out, opts.loops ?? 0);
  out.push(0x00);

  const cache = new Map<number, number>();
  for (const frame of frames) {
    // Graphic Control Extension (delay + transparency).
    out.push(0x21, 0xf9, 0x04);
    const disposal = hasTransparency ? 2 : 1; // restore-to-bg when transparent
    out.push((disposal << 2) | (transparentIndex >= 0 ? 1 : 0));
    pushU16(out, Math.max(0, Math.round(frame.delayMs / 10))); // centiseconds
    out.push(transparentIndex >= 0 ? transparentIndex : 0);
    out.push(0x00);
    // Image Descriptor (full frame, no local colour table).
    out.push(0x2c);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU16(out, width);
    pushU16(out, height);
    out.push(0x00);
    // Map pixels to palette indices.
    const indices = new Uint8Array(pxPerFrame);
    for (let p = 0; p < pxPerFrame; p++) {
      const a = frame.rgba[p * 4 + 3];
      if (transparentIndex >= 0 && a < transparentAlpha) {
        indices[p] = transparentIndex;
      } else {
        indices[p] = nearestIndex(
          paletteColors,
          frame.rgba[p * 4],
          frame.rgba[p * 4 + 1],
          frame.rgba[p * 4 + 2],
          cache,
        );
      }
    }
    out.push(bitsPerPixel); // LZW minimum code size
    pushSubBlocks(out, lzwCompress(indices, bitsPerPixel));
  }
  out.push(0x3b); // trailer
  return Uint8Array.from(out);
}
