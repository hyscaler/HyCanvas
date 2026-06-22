// Default styles and small constructors for the rich-text model.

import type { CharStyle, Color, Fill, Paragraph, ParagraphStyle, Run } from "@hc/schema";

export const BLACK: Color = { srgb: { r: 0, g: 0, b: 0, a: 1 } };
export const SOLID_BLACK: Fill = { type: "solid", color: BLACK };

export const DEFAULT_CHAR_STYLE: CharStyle = {
  fontFamily: "system",
  fontStyle: "Regular",
  fontSize: 16,
  fill: SOLID_BLACK,
};

export const DEFAULT_PARAGRAPH_STYLE: ParagraphStyle = {
  align: "left",
  direction: "auto",
};

export function createRun(text: string, style: Partial<CharStyle> = {}): Run {
  return { text, style: { ...DEFAULT_CHAR_STYLE, ...style } };
}

export function createParagraph(
  text = "",
  charStyle: Partial<CharStyle> = {},
  paraStyle: Partial<ParagraphStyle> = {},
): Paragraph {
  return {
    runs: text ? [createRun(text, charStyle)] : [],
    style: { ...DEFAULT_PARAGRAPH_STYLE, ...paraStyle },
  };
}

/** Content for a new text node from a plain string (one paragraph per line). */
export function contentFromText(text: string, charStyle: Partial<CharStyle> = {}): Paragraph[] {
  return text.split("\n").map((line) => createParagraph(line, charStyle));
}
