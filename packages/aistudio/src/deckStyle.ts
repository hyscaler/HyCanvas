// Visual system for materialized slide layouts: the type scale a placeholder
// wears, and the per-role page treatment a generated deck paints.
//
// Both were previously hardcoded - every title 44px, every body 20px, every
// page the same deep background - which made generated decks read as
// scaffolding rather than design: text far too small for a 1920x1080 slide,
// and eight identical flat-colored pages in a row. Everything here derives
// from the SLOT'S OWN GEOMETRY and the page size instead, so the same layout
// system looks right at any canvas size, and the deck alternates between
// impact pages and readable content pages.
//
// Pure and deterministic: no model calls, no DOM. The editor's apply pass, the
// headless composer, and the adaptive-reflow engine all read the type scale
// from here so a slide looks identical however it was made.

import { fromHex, toHex, rgbToHsl, hslToRgb, contrastRatio } from "@hc/color";
import type { Color } from "@hc/schema";
import type { DesignBackground } from "./spec";

/** The roles that carry a text type scale. Other roles (picture, chart, media,
 *  footer) are placed, not typeset. */
export type TypedRole = "title" | "body" | "content";

/** Ladder steps as fractions of the slot's base size. Discrete on purpose: two
 *  crowded slides on the same layout land on the SAME smaller size, which is
 *  what keeps a deck looking consistent rather than individually tuned. */
const LADDER_STEPS = [1, 0.88, 0.78, 0.68, 0.6, 0.52];

/** Never below this share of the page height: past it the text is unreadable
 *  in a room, and a layout variant (E17) is the honest answer instead. */
const MIN_SIZE_FRAC = 0.011;

interface Rectish {
  width: number;
  height: number;
}

/** The type scale for one placeholder: the size it materializes at, plus the
 *  descending ladder adaptive reflow may step through.
 *
 *  The base comes from the slot's height (a tall slot is a display slot, a
 *  short strip is a caption) bounded by page-relative floors and ceilings that
 *  keep it in presentation-typography range: titles land near 6-9% of page
 *  height (44pt-ish on a 16:9 slide), body copy near 3-4%, list content near
 *  3%. A hard cap on width keeps a narrow column from wearing headline type. */
export function slotTypeScale(
  role: TypedRole,
  rect: Rectish,
  page: { width: number; height: number },
): { base: number; ladder: number[] } {
  const ph = Math.max(1, page.height);
  const h = Math.max(1, rect.height);
  const w = Math.max(1, rect.width);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  let base: number;
  switch (role) {
    case "title":
      // A title fills roughly half its slot's height (one or two lines with
      // breathing room), floored so a thin title strip still reads as a
      // heading and capped so a full-bleed cover slot stays a title, not art.
      base = clamp(h * 0.46, ph * 0.042, ph * 0.095);
      // A title in a half-width column cannot wear full-slide display type.
      base = Math.min(base, w * 0.075);
      break;
    case "body":
      base = clamp(h * 0.3, ph * 0.024, ph * 0.045);
      base = Math.min(base, w * 0.055);
      break;
    default:
      // List content: sized so a slot's worth of bullets fills it without
      // crowding; the fit pass below steps down when there are more.
      base = clamp(h * 0.13, ph * 0.026, ph * 0.042);
      base = Math.min(base, w * 0.05);
      break;
  }

  const rounded = Math.max(sizeFloor(page), Math.round(base));
  return { base: rounded, ladder: ladderFrom(rounded, page) };
}

/** The reflow floor for a page: below this, text is unreadable in a room and
 *  a denser layout variant is the honest answer instead of smaller type. */
export function sizeFloor(page: { height: number }): number {
  return Math.max(9, Math.round(Math.max(1, page.height) * MIN_SIZE_FRAC));
}

/** The descending ladder for a given starting size. Used for the slot's own
 *  base, and for a size the user set by hand (which becomes its own ceiling:
 *  reflow may absorb overflow below it, but never "corrects" it upward). */
export function ladderFrom(base: number, page: { height: number }): number[] {
  const floor = sizeFloor(page);
  const start = Math.max(floor, Math.round(base));
  const ladder: number[] = [];
  for (const step of LADDER_STEPS) {
    const size = Math.max(floor, Math.round(start * step));
    if (!ladder.includes(size)) ladder.push(size);
  }
  return ladder;
}

// ---------------------------------------------------------------------------
// Per-role page treatment
// ---------------------------------------------------------------------------

/** Page roles that carry the deck's IMPACT treatment (the deep themed
 *  background). Everything else is a reading page and gets paper. */
const IMPACT_ROLES = new Set(["cover", "quote", "closing", "statement", "section"]);

export interface PageTreatment {
  /** The page background to paint. */
  background: DesignBackground;
  /** True when the background is the deck's deep color (light ink), false on
   *  a paper page (dark ink). Callers derive ink with readableTextColor, this
   *  just says which side of the deck's system the page sits on. */
  impact: boolean;
  /** Accent hex for a rule/marker on a reading page (null on impact pages,
   *  where the whole background already carries the color). */
  accent: string | null;
}

function mix(a: Color, b: Color, t: number): Color {
  const l = (x: number, y: number) => x + (y - x) * t;
  return {
    srgb: {
      r: l(a.srgb.r, b.srgb.r),
      g: l(a.srgb.g, b.srgb.g),
      b: l(a.srgb.b, b.srgb.b),
      a: 1,
    },
  };
}

const WHITE: Color = { srgb: { r: 1, g: 1, b: 1, a: 1 } };
const BLACK: Color = { srgb: { r: 0, g: 0, b: 0, a: 1 } };

/** Lift a color until it reads clearly against a near-white page: a deep navy
 *  used as an accent rule would otherwise vanish into the ink. */
function accentOnPaper(seed: Color, paper: Color): string {
  const hsl = rgbToHsl(seed);
  let out = seed;
  // Keep the hue, raise saturation and pull lightness into the mid range so
  // the accent stays recognizably the deck's color while staying visible.
  out = hslToRgb({ h: hsl.h, s: Math.min(1, Math.max(hsl.s, 0.45)), l: Math.min(0.55, Math.max(0.34, hsl.l)), a: 1 });
  // A pale accent on pale paper is no accent at all.
  if (contrastRatio(out, paper) < 1.6) out = mix(out, BLACK, 0.25);
  return toHex(out);
}

/** Decide how one generated page is painted, from its outline role and the
 *  deck's theme background.
 *
 *  A deck where every page is the same deep fill reads as unfinished. Impact
 *  pages (cover, section, quote, closing) keep the themed background; reading
 *  pages flip to a paper tinted with the SAME hue, so the deck alternates
 *  without ever leaving its palette. */
export function pageTreatment(visualRole: string | undefined, themeBackground: DesignBackground): PageTreatment {
  const deepHex = themeBackground.color ?? "#1f2937";
  const accentHex = themeBackground.color2 ?? deepHex;
  if (!visualRole || IMPACT_ROLES.has(visualRole)) {
    return { background: { ...themeBackground }, impact: true, accent: null };
  }
  const seed = fromHex(accentHex) ?? fromHex(deepHex) ?? BLACK;
  // Paper: white carrying a whisper of the deck's hue, so a content page still
  // belongs to the deck. Kept very light - this is a reading surface.
  const paper = mix(WHITE, seed, 0.055);
  return {
    background: { kind: "solid", color: toHex(paper) },
    impact: false,
    accent: accentOnPaper(seed, paper),
  };
}

/** Geometry for the accent rule a reading page draws beside its title: a short
 *  bar on the title's leading edge, above it. Null when the title slot has no
 *  room above it (a title already at the page top edge keeps the page clean
 *  rather than growing a bar off-canvas). */
export function accentRuleRect(
  titleRect: { x: number; y: number; width: number; height: number },
  page: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  const gap = page.height * 0.022;
  const barHeight = Math.max(3, Math.round(page.height * 0.0075));
  const y = titleRect.y - gap - barHeight;
  if (y < page.height * 0.015) return null;
  return {
    x: titleRect.x,
    y,
    width: Math.max(24, Math.round(Math.min(titleRect.width * 0.16, page.width * 0.07))),
    height: barHeight,
  };
}
