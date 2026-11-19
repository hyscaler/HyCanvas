// Grounding an image prompt in the design it is for. Its own module (re-exported
// from prompts.ts) because prompts.ts loads the kit vocabulary, and the
// editor grounds image prompts without composing anything (#77).

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
