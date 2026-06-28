// F39 - centralized system prompts for the AI Creative Studio. The platform
// exposes only a free-text primitive (oc.aiText), so every generator embeds its
// JSON Schema in the prompt and the client validates the reply with the matching
// normalizer. Keeping the prompts here next to the schemas keeps the contract
// in one place and the frontend thin.

import { outlineJsonSchema, type DesignType } from "./outline";

const TYPE_GUIDANCE: Record<DesignType, string> = {
  deck: "A presentation deck: a cover, an optional agenda, several content pages, an optional data or comparison page, and a closing/CTA page. Aim for a clear narrative arc.",
  doc: "A multi-page document: a title page then sectioned pages, each a heading plus supporting points. Favor the 'content' visual role.",
  "social-set": "A set of standalone social posts on one theme; each page is self-contained with its own punchy hook. Use 'cover' or 'quote' roles for impact.",
  poster: "A single strong poster composition: one page, one bold message. Use the 'cover' role.",
};

/** System prompt asking the model for a DesignOutline (titles + points + roles),
 *  never positions or styling. The client validates with normalizeOutline. */
export function outlineSystemPrompt(designType: DesignType, brandClause: string, pageCount?: number): string {
  const count = pageCount && pageCount > 0 ? `Aim for about ${pageCount} pages. ` : "";
  return [
    "You are an expert content strategist and presentation designer.",
    `Plan the structure of this design as an editable outline. ${TYPE_GUIDANCE[designType]}`,
    `${count}Output ONLY a single JSON object, no prose, no markdown, no code fences.`,
    `Schema: ${JSON.stringify(outlineJsonSchema)}.`,
    "Each page has a short title, 0-6 concise key points (real final copy, not placeholders), and a visualRole from the enum.",
    "Use 'cover' for the first page, 'closing' for the last when it fits, and pick roles that match each page's purpose.",
    "Do NOT include any layout, colors, sizes, or positions - only titles, points, and roles.",
    brandClause,
  ].filter(Boolean).join(" ");
}

/** User message grounding the outline request with the brief. */
export function outlineUserPrompt(prompt: string, designType: DesignType): string {
  return `Design type: ${designType}\nBrief: ${prompt.trim()}`;
}

/** Ground an image-generation prompt in the design context so generated media is
 *  style-consistent with the design (FR-23): palette, aspect, and an optional
 *  style/mood phrase. Pure string composition, provider-agnostic. */
export function groundImagePrompt(
  prompt: string,
  ctx: { palette?: string[]; aspect?: "square" | "portrait" | "landscape"; style?: string },
): string {
  const parts = [prompt.trim()];
  if (ctx.style) parts.push(`Style: ${ctx.style}.`);
  if (ctx.palette && ctx.palette.length) parts.push(`Use a color palette consistent with: ${ctx.palette.slice(0, 6).join(", ")}.`);
  if (ctx.aspect) parts.push(`Composition suited to a ${ctx.aspect} frame.`);
  parts.push("Cohesive, professional, suitable to sit alongside other graphics in one design.");
  return parts.join(" ");
}
