// Animated PNG (APNG) encoder: assembles a sequence of full-frame PNGs
// into one animated PNG. Lossless and dependency-free - it reuses each frame's
// already-encoded image data (the browser/canvas produced the PNGs), splicing
// the IDAT of frame 0 and converting later frames' IDAT to fdAT, wrapped with
// the acTL/fcTL animation-control chunks. All frames must share dimensions and
// color type (true for canvas-rendered frames of one design).

const SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Chunk { type: string; data: Uint8Array }

/** Parse PNG chunks (after the 8-byte signature). */
function parseChunks(png: Uint8Array): Chunk[] {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: Chunk[] = [];
  let p = 8; // skip signature
  while (p + 8 <= png.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    const data = png.subarray(p + 8, p + 8 + len);
    out.push({ type, data });
    p += 12 + len; // length + type + data + crc
    if (type === "IEND") break;
  }
  return out;
}

/** Serialize one PNG chunk (type + data) with a fresh CRC. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out[4] = type.charCodeAt(0); out[5] = type.charCodeAt(1); out[6] = type.charCodeAt(2); out[7] = type.charCodeAt(3);
  out.set(data, 8);
  // CRC covers the type + data.
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export interface ApngFrame {
  png: Uint8Array;
  /** Frame display time in milliseconds. */
  delayMs: number;
}

export interface ApngOptions {
  /** Loop count; 0 = infinite (default). */
  loops?: number;
}

/** Encode PNG frames into a single animated PNG (APNG). */
export function encodeApng(frames: ApngFrame[], opts: ApngOptions = {}): Uint8Array {
  if (!frames.length) throw new Error("encodeApng: no frames");
  const parts: Uint8Array[] = [SIG];
  let seq = 0;

  const first = parseChunks(frames[0].png);
  const ihdr = first.find((c) => c.type === "IHDR");
  if (!ihdr) throw new Error("encodeApng: frame 0 missing IHDR");
  parts.push(chunk("IHDR", ihdr.data));
  // Carry a palette / transparency if present (indexed/paletted PNGs).
  for (const c of first) if (c.type === "PLTE" || c.type === "tRNS") parts.push(chunk(c.type, c.data));

  // acTL: number of frames + play count.
  const actl = new Uint8Array(8);
  new DataView(actl.buffer).setUint32(0, frames.length);
  new DataView(actl.buffer).setUint32(4, opts.loops ?? 0);
  parts.push(chunk("acTL", actl));

  const fcTL = (w: number, h: number, delayMs: number): Uint8Array => {
    const d = new Uint8Array(26);
    const dv = new DataView(d.buffer);
    dv.setUint32(0, seq++);      // sequence number
    dv.setUint32(4, w);          // width
    dv.setUint32(8, h);          // height
    dv.setUint32(12, 0);         // x offset
    dv.setUint32(16, 0);         // y offset
    dv.setUint16(20, Math.max(1, Math.round(delayMs))); // delay numerator (ms)
    dv.setUint16(22, 1000);      // delay denominator (1/1000 s)
    d[24] = 0;                   // dispose op: none
    d[25] = 0;                   // blend op: source
    return d;
  };

  const dims = (() => {
    const dv = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
    return { w: dv.getUint32(0), h: dv.getUint32(4) };
  })();

  frames.forEach((frame, i) => {
    const chunks = i === 0 ? first : parseChunks(frame.png);
    const idats = chunks.filter((c) => c.type === "IDAT");
    parts.push(chunk("fcTL", fcTL(dims.w, dims.h, frame.delayMs)));
    if (i === 0) {
      // Frame 0's pixels stay in IDAT (it is also the default image).
      for (const d of idats) parts.push(chunk("IDAT", d.data));
    } else {
      // Later frames: IDAT -> fdAT (sequence number prefix + data).
      for (const d of idats) {
        const fd = new Uint8Array(4 + d.data.length);
        new DataView(fd.buffer).setUint32(0, seq++);
        fd.set(d.data, 4);
        parts.push(chunk("fdAT", fd));
      }
    }
  });

  parts.push(chunk("IEND", new Uint8Array(0)));

  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
