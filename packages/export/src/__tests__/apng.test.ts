import { describe, it, expect } from "vitest";
import { encodeApng } from "../apng";

// Minimal PNG framing (the encoder re-CRCs everything, so input CRCs can be
// placeholders; only chunk length/type/data framing must be valid).
function be32(n: number): number[] { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function rawChunk(type: string, data: number[]): number[] {
  return [...be32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
}
function makePng(w: number, h: number, idat: number[]): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [...be32(w), ...be32(h), 8, 6, 0, 0, 0]; // 8-bit RGBA
  return Uint8Array.from([...sig, ...rawChunk("IHDR", ihdr), ...rawChunk("IDAT", idat), ...rawChunk("IEND", [])]);
}
function count(buf: Uint8Array, type: string): number {
  const s = Buffer.from(buf).toString("latin1");
  return s.split(type).length - 1;
}

describe("encodeApng", () => {
  it("assembles frames into a valid APNG structure", () => {
    const out = encodeApng([
      { png: makePng(4, 3, [1, 2, 3, 4]), delayMs: 100 },
      { png: makePng(4, 3, [5, 6, 7, 8]), delayMs: 120 },
      { png: makePng(4, 3, [9, 10]), delayMs: 80 },
    ], { loops: 0 });

    // PNG signature.
    expect(Array.from(out.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // One acTL, one fcTL per frame, fdAT for the 2 non-first frames, IDAT for frame 0.
    expect(count(out, "acTL")).toBe(1);
    expect(count(out, "fcTL")).toBe(3);
    expect(count(out, "fdAT")).toBe(2);
    expect(count(out, "IDAT")).toBeGreaterThanOrEqual(1);
    // Ends with IEND.
    expect(Buffer.from(out.slice(-8)).toString("latin1")).toContain("IEND");

    // acTL frame count = 3 (read the 4 bytes after the acTL type tag).
    const s = Buffer.from(out);
    const acIdx = s.indexOf("acTL");
    expect(s.readUInt32BE(acIdx + 4)).toBe(3); // num_frames
  });

  it("throws on no frames", () => {
    expect(() => encodeApng([])).toThrow();
  });
});
