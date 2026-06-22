// Canvas font helpers: turn a rich-text CharStyle into a Canvas2D `font` string,
// a family stack, line advance, and case transform, so on-canvas text uses the
// chosen typeface, weight, and style. Font FILES are loaded by the host
// (browser FontFace / font provider); here we only name the family with a
// sensible fallback so text still renders before the real face arrives.

import type { CharStyle } from "@hc/schema";

const SYSTEM_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const NAMED_WEIGHTS: Record<string, number> = {
  thin: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  book: 400,
  regular: 400,
  normal: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
};

/** CSS font-family stack for a family name, with a system fallback. */
export function fontFamilyStack(family: string | undefined): string {
  if (!family || family.toLowerCase() === "system") return SYSTEM_STACK;
  return `"${family}", ${SYSTEM_STACK}`;
}

/** Numeric weight from a named style ("SemiBold" -> 600), default 400. */
export function weightFromFontStyle(fontStyle: string | undefined): number {
  if (!fontStyle) return 400;
  const key = fontStyle.toLowerCase().replace(/italic|oblique|\s+/g, "");
  return NAMED_WEIGHTS[key] ?? 400;
}

type FontLike = Pick<CharStyle, "fontFamily" | "fontStyle" | "fontSize"> & {
  axes?: Record<string, number>;
  case?: CharStyle["case"];
};

/** A Canvas2D `font` string (e.g. `italic small-caps 600 24px "Inter", ...`). */
export function canvasFontString(style: FontLike): string {
  const size = style.fontSize;
  const weight = style.axes?.wght ?? weightFromFontStyle(style.fontStyle);
  const italic = /italic|oblique/i.test(style.fontStyle ?? "") ? "italic " : "";
  // Small caps render via the font-variant slot of the canvas `font` shorthand.
  const variant = style.case === "smallcaps" ? "small-caps " : "";
  return `${italic}${variant}${weight} ${size}px ${fontFamilyStack(style.fontFamily)}`;
}

/** Resolve a line advance in px from a CharStyle lineHeight (default 1.2x). */
export function resolveLineAdvance(
  size: number,
  lineHeight: CharStyle["lineHeight"],
): number {
  if (lineHeight == null) return size * 1.2;
  if (typeof lineHeight === "number") return size * lineHeight;
  if (lineHeight.mode === "absolute") return lineHeight.value;
  if (lineHeight.mode === "multiple") return size * lineHeight.value;
  return size * 1.2; // auto
}

/** Apply a case transform to display text. */
export function applyTextCase(text: string, textCase: CharStyle["case"]): string {
  switch (textCase) {
    case "upper":
      return text.toUpperCase();
    case "lower":
      return text.toLowerCase();
    case "title":
      return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    default:
      return text;
  }
}
