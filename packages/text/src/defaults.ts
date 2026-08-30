// Default styles and small constructors for the rich-text model.

import type { CharStyle, Color, Fill, Paragraph, ParagraphStyle, Run } from "@hc/schema";

export const black: Color = { srgb: { r: 0, g: 0, b: 0, a: 1 } };
export const solidBlack: Fill = { type: "solid", color: black };

export const defaultCharStyle: CharStyle = {
  fontFamily: "system",
  fontStyle: "Regular",
  fontSize: 16,
  fill: solidBlack,
};

export const defaultParagraphStyle: ParagraphStyle = {
  align: "left",
  direction: "auto",
};

export function createRun(text: string, style: Partial<CharStyle> = {}): Run {
  return { text, style: { ...defaultCharStyle, ...style } };
}

export function createParagraph(
  text = "",
  charStyle: Partial<CharStyle> = {},
  paraStyle: Partial<ParagraphStyle> = {},
): Paragraph {
  return {
    runs: text ? [createRun(text, charStyle)] : [],
    style: { ...defaultParagraphStyle, ...paraStyle },
  };
}

/** Content for a new text node from a plain string (one paragraph per line). */
export function contentFromText(text: string, charStyle: Partial<CharStyle> = {}): Paragraph[] {
  return text.split("\n").map((line) => createParagraph(line, charStyle));
}
