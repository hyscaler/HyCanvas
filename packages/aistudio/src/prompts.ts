// F39 - centralized system prompts for the AI Creative Studio. The platform
// exposes only a free-text primitive (oc.aiText), so every generator embeds its
// JSON Schema in the prompt and the client validates the reply with the matching
// normalizer. Keeping the prompts here next to the schemas keeps the contract
// in one place and the frontend thin.

import { maxNoteChars, outlineJsonSchema, type DesignType } from "./outline";
import { capacityClause, designTypeSizes } from "./capacity";
import { composeRules, contentOnlyRule, lengthLimitRule, scopedInstructionRule, settingsAuthorityRule, verbosityRule, type Verbosity } from "./promptRules";
import { kitVocabularyRule } from "./kit/vocab";

// Mirrors typeGuidance in backend/internal/aistudio/generate.go; change together.
const TYPE_GUIDANCE: Record<DesignType, string> = {
  deck: "A presentation deck: a cover, a statement of the thesis, evidence pages in varied forms (bullets, twoColumn, threeUp, process, timeline, bigNumber, kpiGrid, chart, table, imageCaption, quote, team), and a closing with a specific ask. Aim for a clear narrative arc.",
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
  "'chart' (title + chart with real numbers from the brief or attached material; never invent data); " +
  "'kpiGrid' (title + 2-4 stats, each value + label; several figures that belong together); " +
  "'timeline' (title + 3-5 steps, each with a short 'when' such as a year or quarter, a label and a detail; for history and roadmaps); " +
  "'table' (title + table.columns and table.rows with real values from the brief or attached material; 2-4 columns, up to 6 rows; never invent data); " +
  "'team' (title + 1-4 people, each name + role; no pictures are generated for people); 'composition' (a bespoke page for what no other form holds: a diagram, a comparison built from shapes, a page that is one typographic gesture; up to 8 cells on a 12-column by 6-row grid, each a heading, body, list, figure, label, icon or picture with an optional tone of tint, accent or deep, cells never overlapping, and optional links drawn as arrows between cells; at most one per deck); " +
  "'closing' (title + subhead as the call to action). " +
  "Every page except the cover names an 'eyebrow': two or three words saying what the page is about (The problem, What we tried, Traction, The ask), set small above the title. " +
  "Icons: a column, a kpiGrid stat, a timeline step, and a bullets, statement, bigNumber, cover, section or closing page may each name an 'icon', one English keyword for a simple icon (shield, clock, users, chart, leaf, globe, bolt, heart, coin, truck, calendar, rocket, target, star, lock, cloud); name one for every item in a set or for none, and name one for most pages that can carry one.";

export const storyArcRule =
  "Plan a narrative arc before choosing forms: open with the cover, state the thesis as a 'statement' early, build with evidence, and end with a 'closing' that asks for something specific. " +
  "Vary the forms: no more than 40 percent of pages may be 'bullets'; never place the same archetype on two adjacent pages except 'bullets' at most twice in a row; " +
  "use 'bigNumber' whenever the brief or attached material contains a meaningful quantity, 'kpiGrid' when two to four figures belong together, 'timeline' for dated history or a roadmap, and 'table' when the material is a small grid of real values; use 'section' dividers only for decks of 10 or more pages; " +
  "give an 'image' intent to every 'cover', 'imageCaption', 'section' and 'closing' page and to about half of the rest, with a concrete English subject and consistent treatment across the deck; for an internal, product or plan deck, name an 'illustration' keyword on the cover, sections and closing (growth, handshake, rocket, target, security, chart, analysis, team, idea, money, logistics, calendar, map) so a flat drawing stands in for the photo. Name a 'look' for the whole deck: 'editorial' (serif display, hairline rules, paper grounds; for stories, reports, culture, heritage, luxury), 'bold' (colour fields, giant numerals, heavy sans; for launches, campaigns, sport, youth, sales), 'technical' (a visible grid, mono labels, square corners; for engineering, data, infrastructure, developer audiences) or 'classic' (the balanced default); the subject and audience decide, not the mood words alone.";

export const copyToFormRule =
  "Write copy to fit the form: a title is a headline (under 60 characters), never a sentence with a full stop; points are parallel in structure and start with the same part of speech; a statement is one idea, not a summary; a stat.label says what the number means in plain words. Never write 'Slide 1', 'Introduction' or other structural labels as content. Never use a dash as a separator anywhere in slide copy (titles, subheads, points, labels); use a colon or a new sentence. A stat.value is the bare figure (42%, 3.2M, 312): no arrows, no words, no plus or minus for direction; the label says whether it rose or fell. Every figure comes from the brief or the attached material, exactly as given; never invent, round or extrapolate a number. Set every title, subhead, label and eyebrow in sentence case (the first word and proper nouns capitalized), never in Title Case. An eyebrow is a label of at most 24 characters and a stat label at most 60; a title under 60. Write to fit: copy over a budget is cut at a word, never rephrased. Data-heavy material is split across several table or chart pages, at most eight rows or twelve categories each, never one dense page; a table cell is at most 60 characters.";

/** System prompt asking the model for a DesignOutline (titles + points + roles),
 *  never positions or styling. The client validates with normalizeOutline. */
export function outlineSystemPrompt(designType: DesignType, brandClause: string, pageCount?: number, verbosity?: Verbosity): string {
  const count = pageCount && pageCount > 0 ? `Aim for about ${pageCount} pages. ` : "";
  const page = designTypeSizes[designType] ?? designTypeSizes.deck;
  const capacity = `${capacityClause(designType, page.width, page.height)} `;
  return [
    "You are a senior presentation designer and content strategist. You plan a deck the way a designer does: story first, then one compositional form per slide, then copy written to fit that form.",
    `Plan this design as an editable outline. ${TYPE_GUIDANCE[designType]}`,
    `${count}${capacity}Output ONLY a single JSON object, no prose, no markdown, no code fences.`,
    `Schema: ${JSON.stringify(outlineJsonSchema)}.`,
    archetypeCatalogRule,
    storyArcRule,
    copyToFormRule,
    // The kit's vocabulary: the style the deck is set in, its voice, the
    // drawings and the one signature form. Word-for-word with the Go door's
    // generated copy (kitvocab_gen.go); a deck of any type may carry them,
    // and the composer uses them where the kit sets the deck.
    designType === "deck" ? kitVocabularyRule : "",
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
