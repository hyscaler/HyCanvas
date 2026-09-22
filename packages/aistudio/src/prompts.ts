// F39 - centralized system prompts for the AI Creative Studio. The platform
// exposes only a free-text primitive (oc.aiText), so every generator embeds its
// JSON Schema in the prompt and the client validates the reply with the matching
// normalizer. Keeping the prompts here next to the schemas keeps the contract
// in one place and the frontend thin.

import { maxNoteChars, outlineJsonSchema, type DesignType } from "./outline";
import { composeRules, contentOnlyRule, lengthLimitRule, scopedInstructionRule, settingsAuthorityRule, verbosityRule, type Verbosity } from "./promptRules";

// Mirrors typeGuidance in backend/internal/aistudio/generate.go; change together.
const TYPE_GUIDANCE: Record<DesignType, string> = {
  deck: "A presentation deck: a cover, a statement of the thesis, evidence pages in varied forms (bullets, twoColumn, threeUp, process, bigNumber, chart, imageCaption, quote), and a closing with a specific ask. Aim for a clear narrative arc.",
  doc: "A multi-page document: a cover then sectioned pages, each a heading plus supporting points or a two-column layout. Favor 'bullets' and 'twoColumn'; skip agenda and section dividers.",
  "social-set": "A set of standalone social posts on one theme; each page is self-contained with its own punchy hook. Use 'statement', 'quote', 'bigNumber' and 'imageCaption' for impact; every page gets an image intent.",
  poster: "A single strong poster composition: one page, one bold message. Use the 'cover' archetype with an image intent.",
};

/** The archetype catalog and the story rules, word-for-word with outlineSystem
 *  in generate.go so the editor and the API plan decks the same way. Named
 *  forms are what let the composer put a number at display scale or two
 *  columns side by side; a bullet list can only ever be a bullet list. */
export const archetypeCatalogRule =
  "Every page names an archetype, its compositional form: " +
  "'cover' (title + subhead); 'agenda' (title + 3-6 points naming the sections to come, in order; only for decks of 6 or more pages); 'section' (a divider: short title, optional subhead); " +
  "'statement' (ONE idea as the title, at most 14 words, optional subhead; no points); " +
  "'bigNumber' (stat.value + stat.label, optional subhead as context; the figure is the slide); " +
  "'bullets' (title + 3-5 points, each a complete thought under 90 characters); " +
  "'twoColumn' (title + exactly 2 columns, each heading + 2-4 points; for comparisons and before/after); " +
  "'threeUp' (title + exactly 3 columns, each heading + 1-3 points; for features, pillars, options); " +
  "'process' (title + 3-5 steps, each label + detail; ONLY for a real sequence); " +
  "'quote' (quote.text + attribution); 'imageCaption' (title + image.subject + subhead as caption; the picture carries the slide); " +
  "'chart' (title + chart with real numbers from the brief or attached material; never invent data); 'closing' (title + subhead as the call to action).";

export const storyArcRule =
  "Plan a narrative arc before choosing forms: open with the cover, state the thesis as a 'statement' early, build with evidence, and end with a 'closing' that asks for something specific. " +
  "Vary the forms: no more than 40 percent of pages may be 'bullets'; never place the same archetype on two adjacent pages except 'bullets' at most twice in a row; " +
  "use 'bigNumber' whenever the brief or attached material contains a meaningful quantity; use 'section' dividers only for decks of 10 or more pages; " +
  "give an 'image' intent to every 'cover', 'imageCaption', 'section' and 'closing' page and to about half of the rest, with a concrete English subject and consistent treatment across the deck.";

export const copyToFormRule =
  "Write copy to fit the form: a title is a headline (under 60 characters), never a sentence with a full stop; points are parallel in structure and start with the same part of speech; a statement is one idea, not a summary; a stat.label says what the number means in plain words. Never write 'Slide 1', 'Introduction' or other structural labels as content.";

/** System prompt asking the model for a DesignOutline (titles + points + roles),
 *  never positions or styling. The client validates with normalizeOutline. */
export function outlineSystemPrompt(designType: DesignType, brandClause: string, pageCount?: number, verbosity?: Verbosity): string {
  const count = pageCount && pageCount > 0 ? `Aim for about ${pageCount} pages. ` : "";
  return [
    "You are a senior presentation designer and content strategist. You plan a deck the way a designer does: story first, then one compositional form per slide, then copy written to fit that form.",
    `Plan this design as an editable outline. ${TYPE_GUIDANCE[designType]}`,
    `${count}Output ONLY a single JSON object, no prose, no markdown, no code fences.`,
    `Schema: ${JSON.stringify(outlineJsonSchema)}.`,
    archetypeCatalogRule,
    storyArcRule,
    copyToFormRule,
    `The note is a REQUIRED speaker note for the presenter: 1-3 spoken-style sentences of plain text (no markdown, 100-${maxNoteChars} characters) that add context, evidence, or delivery cues. It must never restate the slide's visible text. Never exceed the length limit; rephrase rather than clipping mid-sentence.`,
    "Do NOT include any layout, colors, sizes, or positions. The archetype is the only visual decision you make; the composer owns geometry.",
    composeRules(settingsAuthorityRule(), contentOnlyRule(), verbosityRule(verbosity), lengthLimitRule(), scopedInstructionRule()),
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
