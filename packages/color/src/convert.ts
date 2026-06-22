// Color-space conversions (F09 FR-2, FR-3). sRGB is canonical; every other
// representation is derived from or merged into the `Color.srgb` channels.
//
// CMYK uses the naive device formula by default. The optional `profile`
// argument is accepted now so callers and the public contract are stable; a
// real ICC/CMM path can be wired in later without
// changing signatures. When a profile is supplied we still use the naive
// transform but record the profile is the caller's responsibility for export.

import type { Color } from "@hc/schema";

export type Rgb = { r: number; g: number; b: number; a: number }; // 0..1
export type Hsl = { h: number; s: number; l: number; a: number }; // h 0..360, s/l/a 0..1
export type Cmyk = { c: number; m: number; y: number; k: number }; // 0..1

/** Clamp n into [0,1]. */
export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Build a canonical Color from sRGB channels (0..1). */
export function color(r: number, g: number, b: number, a = 1): Color {
  return { srgb: { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: clamp01(a) } };
}

// HEX <-> sRGB. Supports #rgb, #rgba, #rrggbb, #rrggbbaa (with or without #).

const HEX_RE = /^#?([0-9a-fA-F]{3,8})$/;

/** Parse a HEX string to a Color, or null if malformed. */
export function fromHex(s: string): Color | null {
  const m = HEX_RE.exec(s.trim());
  if (!m) return null;
  const h = m[1];
  let r: number, g: number, b: number, a = 255;
  if (h.length === 3 || h.length === 4) {
    r = parseInt(h[0] + h[0], 16);
    g = parseInt(h[1] + h[1], 16);
    b = parseInt(h[2] + h[2], 16);
    if (h.length === 4) a = parseInt(h[3] + h[3], 16);
  } else if (h.length === 6 || h.length === 8) {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
    if (h.length === 8) a = parseInt(h.slice(6, 8), 16);
  } else {
    return null; // 5 or 7 hex digits are invalid
  }
  return color(r / 255, g / 255, b / 255, a / 255);
}

function ch(n: number): string {
  return Math.round(clamp01(n) * 255)
    .toString(16)
    .padStart(2, "0");
}

/**
 * Format a Color as a HEX string. Includes the alpha byte only when the color
 * is not fully opaque. Always lowercase, always with a leading `#`.
 */
export function toHex(c: Color): string {
  const { r, g, b, a } = c.srgb;
  const base = `#${ch(r)}${ch(g)}${ch(b)}`;
  return a >= 1 ? base : `${base}${ch(a)}`;
}

// sRGB <-> HSL.

/** Convert sRGB (0..1) to HSL (h 0..360). */
export function rgbToHsl(c: Color): Hsl {
  const { r, g, b, a } = c.srgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return { h: round(h, 4), s: round(s, 6), l: round(l, 6), a };
}

function hue2rgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

/** Convert HSL (h 0..360) to a Color. */
export function hslToRgb(hsl: Hsl): Color {
  const h = ((hsl.h % 360) + 360) % 360 / 360;
  const s = clamp01(hsl.s);
  const l = clamp01(hsl.l);
  if (s === 0) return color(l, l, l, hsl.a);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return color(hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3), hsl.a);
}

// sRGB <-> CMYK (naive device transform; profile param reserved for future CMM).

/**
 * Convert a Color to CMYK. Returns the device-naive conversion. If the color
 * carries explicit `cmyk` data it is authoritative and returned verbatim.
 */
export function rgbToCmyk(c: Color, _profile?: string): Cmyk {
  if (c.cmyk) return { ...c.cmyk };
  const { r, g, b } = c.srgb;
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 1 };
  const inv = 1 - k;
  return {
    c: round((1 - r - k) / inv, 6),
    m: round((1 - g - k) / inv, 6),
    y: round((1 - b - k) / inv, 6),
    k: round(k, 6),
  };
}

/**
 * Convert CMYK to a Color, preserving the source CMYK as authoritative print
 * data on the result (so a round trip through sRGB does not lose it).
 */
export function cmykToRgb(cmyk: Cmyk, _profile?: string): Color {
  const c = clamp01(cmyk.c);
  const m = clamp01(cmyk.m);
  const y = clamp01(cmyk.y);
  const k = clamp01(cmyk.k);
  const out = color((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k), 1);
  out.cmyk = { c, m, y, k };
  return out;
}
