// Archetype composition: one slide form to one laid-out page.
//
// The outline names a form (statement, bigNumber, twoColumn, process...) and
// carries the typed content that form needs. This module owns everything
// visual about turning that into nodes: the grid, the type sizes, where the
// picture goes, which pages are impact and which are paper, the kicker and
// page number that make a deck read as one object. The model decided the
// form; nothing here asks it anything.
//
// Every archetype composes from the same DesignSystem, so a deck is one
// system applied thirteen ways rather than thirteen unrelated slides. Rhythm
// comes from the forms themselves (an impact page after two paper pages, an
// image on the left then on the right) and never from randomness: the same
// outline composes to the same bytes, which the goja parity test relies on.
//
// Text is sized by stepping down the deck's ladder until it fits its region,
// never below the readability floor. When content is sparse the cluster is
// centered in its region rather than left clinging to the top edge, which is
// what a designer does with a short slide and what generated decks never did.

import { createNode, roundedCorners, type Color, type Fill, type Node } from "@hc/schema";
import type { Archetype, CompositionCell, DesignType, OutlineItem } from "./outline";
import { contrastRatio, fixToAA } from "@hc/color";
import type { DeckMotion, DesignSystem } from "./designSystem";
import { ICON_BOX, ICON_GLYPHS, ICON_KEYWORDS } from "./iconset";
import { ILLUSTRATIONS, ILLUSTRATION_KEYWORDS, type IllustrationDrawing } from "./illustrationset";
import type { PageVariant } from "./measure";
import { ladderFrom, sizeFloor } from "./deckStyle";
import { LOOKS, type LookSpec } from "./look";
import { artworkKindFor, artworkNodes } from "./artwork";

export interface ComposedPage {
  background: Fill;
  nodes: Node[];
  /** Placeholder id to image prompt, for every picture region on the page.
   *  The region itself is a tagged stand-in node the image pipeline replaces. */
  imagePrompts: Record<string, string>;
  impact: boolean;
  archetype: Archetype;
  /** Names of text nodes whose copy reached the floor of the ladder and still
   *  did not fit. Geometry has done what it can; only shorter copy fixes it. */
  overfull: string[];
}

export interface ComposeContext {
  /** Zero-based page index and the deck length, for rhythm and numbering. */
  index: number;
  total: number;
  /** A compose-time variation chosen by the fixer (measure.ts), never by the
   *  model: two-up bullets for a long list, larger bullets for a sparse page. */
  variant?: PageVariant;
  /** For a section divider: its one-based number among the deck's sections. */
  section?: number;
  /** What the pages are: a deck carries furniture (footer, page number) a
   *  standalone post or poster never does. */
  designType?: DesignType;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Forms painted on the deep ground. Everything else reads on paper. */
const IMPACT: ReadonlySet<Archetype> = new Set(["cover", "section", "statement", "quote", "closing"]);

export function archetypeIsImpact(a: Archetype): boolean {
  return IMPACT.has(a);
}

// Type sizes as fractions of page height. One scale for the whole deck.
const T = {
  coverTitle: 0.108,
  coverSub: 0.034,
  sectionTitle: 0.085,
  statement: 0.072,
  statementSub: 0.03,
  numeral: 0.3,
  unit: 0.09,
  statLabel: 0.036,
  title: 0.07,
  point: 0.034,
  agendaItem: 0.04,
  colHead: 0.036,
  stepNumber: 0.06,
  stepLabel: 0.034,
  detail: 0.028,
  quote: 0.056,
  attribution: 0.03,
  kicker: 0.02,
  pageNumber: 0.018,
  caption: 0.03,
  kpiFigure: 0.16,
  icon: 0.07,
  pageIcon: 0.075,
  sectionNumber: 0.085,
  eyebrow: 0.02,
  footer: 0.019,
  badge: 0.052,
  tableCell: 0.026,
  timelineWhen: 0.026,
  monogram: 0.06,
  personName: 0.034,
  personRole: 0.027,
} as const;

/** The sizes a "large" variant steps up: the body-level type of the
 *  horizontal forms and the marks that sit with it. Titles and display
 *  figures keep their scale, so a page reads as the same deck set bigger,
 *  not as a different design. */
const LARGE_KEYS = new Set<keyof typeof T>(["point", "agendaItem", "colHead", "stepNumber", "stepLabel", "detail", "timelineWhen", "icon", "monogram", "personName", "personRole"]);
const LARGE_SCALE = 1.3;

// Average glyph advance as a fraction of the em, per role. Headings are set
// in a display face and wider; body in a text face.
const ADVANCE = { heading: 0.55, body: 0.5 } as const;
/** Bold display digits and their marks ($ % , . k M) average wider than
 *  running text; a figure is sized by this so it holds one line. */
const NUMERAL_ADVANCE = 0.62;

/** The list marker gutter the text engine reserves, in ems (layoutText). */
const LIST_GUTTER_EM = 1.6;

/** Join a heading's last two words with a no-break space so the final word
 *  never sits alone on the last line. Only when there are enough words that
 *  the join cannot force one overlong line: a two-word title is left as is,
 *  and so is one whose joined pair would not hold one line of `maxChars`
 *  characters, since the pair is one unbreakable chunk to every renderer. */
export function keepLastWordCompany(text: string, maxChars = Infinity): string {
  if (text.trim().split(/\s+/).length < 3) return text;
  // Walked backwards rather than matched. The pattern this replaces,
  // / +(\S+)\s*$/, backtracks quadratically when a long unbroken run of
  // non-spaces is followed by a long run of spaces: `\S+` cannot reach the end,
  // so the engine retries from every position in the run. At 80k characters
  // that measured 1.8s, and headings here can carry model output.
  //
  // The shape the pattern accepted: trailing whitespace, before it the final
  // run of non-whitespace (the last word), before that at least one space.
  // Each scan below is one backward pass, so the whole thing is linear.
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  let word = end;
  while (word > 0 && !/\s/.test(text[word - 1])) word--;
  if (word === end) return text; // no last word
  let gap = word;
  while (gap > 0 && text[gap - 1] === " ") gap--;
  if (gap === word) return text; // the word is not preceded by a space
  let prev = gap;
  while (prev > 0 && !/\s/.test(text[prev - 1])) prev--;
  // The pair as one chunk: the previous word, one space, the last word.
  if (Array.from(text.slice(prev, gap)).length + 1 + Array.from(text.slice(word, end)).length > maxChars) return text;
  return text.slice(0, gap) + "\u00A0" + text.slice(word, end);
}

/** The glyph a keyword names, or null when the set has no picture for it.
 *  Matched whole, then by the first word the keyword contains that the set
 *  knows ("cloud storage" finds the cloud), so a model that writes a phrase
 *  still gets a picture and one that invents a word gets none. */
export function iconGlyphFor(keyword: string | undefined): string | null {
  if (!keyword) return null;
  const k = keyword.trim().toLowerCase();
  if (!k) return null;
  // A glyph's own name (circle-check, alert-triangle) is the glyph.
  if (ICON_GLYPHS[k]) return k;
  const direct = ICON_KEYWORDS[k];
  if (direct) return direct;
  for (const w of k.split(/[^a-z]+/)) {
    if (w && ICON_KEYWORDS[w]) return ICON_KEYWORDS[w];
  }
  return null;
}

// --- motion --------------------------------------------------------------

/** How each kind of element enters, by the name the composer gave it. One
 *  orchestrated reveal per page rather than an effect per element: pictures
 *  and marks fade in, headings rise, everything else follows in reading
 *  order with a short stagger. Furniture (the kicker, the page number) is
 *  already there when the page arrives. */
const MOTION: Record<string, { preset: "fade" | "rise"; durationMs: number } | null> = {
  "Kicker": null, "Page number": null, "Logo": null, "Footer": null,
  "Image": { preset: "fade", durationMs: 700 }, "Decor": { preset: "fade", durationMs: 600 },
  "Panel": { preset: "fade", durationMs: 450 }, "Eyebrow": { preset: "fade", durationMs: 350 }, "Badge": { preset: "fade", durationMs: 350 },
  "Illustration": { preset: "fade", durationMs: 700 },
  "Section number": { preset: "rise", durationMs: 550 },
  "Accent": { preset: "fade", durationMs: 350 }, "Divider": { preset: "fade", durationMs: 350 },
  "Sequence": { preset: "fade", durationMs: 350 }, "Marker": { preset: "fade", durationMs: 350 }, "Icon": { preset: "fade", durationMs: 350 },
  "Title": { preset: "rise", durationMs: 550 }, "Statement": { preset: "rise", durationMs: 550 },
  "Quote": { preset: "rise", durationMs: 550 }, "Figure": { preset: "rise", durationMs: 550 }, "Mark": { preset: "rise", durationMs: 550 },
  "Chart": { preset: "fade", durationMs: 500 }, "Table": { preset: "fade", durationMs: 500 },
};
const MOTION_DEFAULT = { preset: "rise" as const, durationMs: 450 };
const MOTION_STAGGER_MS = 120;
const MOTION_MAX_DELAY_MS = 1080;

/** Give the page's elements their entrances, in z-order, and return the same
 *  array. Deterministic, so the editor and the API animate the same deck the
 *  same way; "none" removes any entrance a caller may have left on a node. */
export function applyMotion<N extends { name?: string; animation?: unknown }>(nodes: N[], motion: DeckMotion): N[] {
  let i = 0;
  for (const n of nodes) {
    const spec = n.name !== undefined && n.name in MOTION ? MOTION[n.name] : MOTION_DEFAULT;
    if (motion === "none" || !spec) {
      delete n.animation;
      continue;
    }
    n.animation = {
      entrance: {
        preset: spec.preset,
        durationMs: spec.durationMs,
        delayMs: Math.min(MOTION_MAX_DELAY_MS, i * MOTION_STAGGER_MS),
        easing: "ease-out-cubic",
        startMode: "delay",
      },
    };
    i += 1;
  }
  return nodes;
}

/** The drawing a keyword names, or null when the set has no drawing for
 *  it; matched whole, then by the first known word in a phrase. */
export function illustrationFor(keyword: string | undefined): string | null {
  if (!keyword) return null;
  const k = keyword.trim().toLowerCase();
  if (!k) return null;
  if (ILLUSTRATION_KEYWORDS[k]) return ILLUSTRATION_KEYWORDS[k];
  for (const w of k.split(/[^a-z]+/)) if (w && ILLUSTRATION_KEYWORDS[w]) return ILLUSTRATION_KEYWORDS[w];
  return null;
}

/** Decode a baked path string (M/L/C/Z, absolute coordinates) into the
 *  schema's contours, scaled by k and offset by (ox, oy). */
export function decodeDrawingPath(path: string, k: number, ox: number, oy: number): Array<{ segments: Array<{ x: number; y: number; cIn?: { x: number; y: number }; cOut?: { x: number; y: number } }>; closed: boolean }> {
  const out: Array<{ segments: Array<{ x: number; y: number; cIn?: { x: number; y: number }; cOut?: { x: number; y: number } }>; closed: boolean }> = [];
  const re = /([MLCZ])([^MLCZ]*)/g;
  let cur: (typeof out)[number] | null = null;
  const pt = (x: number, y: number) => ({ x: Math.round((x * k + ox) * 100) / 100, y: Math.round((y * k + oy) * 100) / 100 });
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) {
    const nums = m[2].trim() ? m[2].trim().split(/[\s,]+/).map(Number) : [];
    switch (m[1]) {
      case "M": cur = { segments: [pt(nums[0], nums[1])], closed: false }; out.push(cur); break;
      case "L": if (cur) cur.segments.push(pt(nums[0], nums[1])); break;
      case "C": if (cur) { const last = cur.segments[cur.segments.length - 1]; last.cOut = pt(nums[0], nums[1]); cur.segments.push({ ...pt(nums[4], nums[5]), cIn: pt(nums[2], nums[3]) }); } break;
      case "Z": if (cur) cur.closed = true; break;
    }
  }
  return out.filter((c) => c.segments.length >= 2);
}

class Composer {
  private readonly W: number;
  private readonly H: number;
  private readonly m: number;
  private readonly col: number;
  private nodes: Node[] = [];
  private prompts: Record<string, string> = {};
  private overfull: string[] = [];
  private slotSeq = 0;

  constructor(private readonly ds: DesignSystem, private readonly item: OutlineItem, private readonly ctx: ComposeContext, private readonly impact: boolean) {
    this.W = ds.size.width;
    this.H = ds.size.height;
    this.m = ds.margin;
    this.col = (this.W - 2 * this.m - (ds.columns - 1) * ds.gutter) / ds.columns;
  }

  // --- geometry ------------------------------------------------------------

  /** The rect covering columns [from, from+n) of the 12-column grid, between
   *  the vertical margins. */
  span(from: number, n: number): Rect {
    const x = this.m + from * (this.col + this.ds.gutter);
    return { x, y: this.m, width: n * this.col + (n - 1) * this.ds.gutter, height: this.H - 2 * this.m };
  }

  /** Mirror a rect for right-to-left decks. Every placement goes through this
   *  so RTL is a property of the system, not of each archetype. */
  private mirror(r: Rect): Rect {
    return this.ds.dir === "rtl" ? { ...r, x: this.W - r.x - r.width } : r;
  }

  private get align(): "left" | "right" {
    return this.ds.dir === "rtl" ? "right" : "left";
  }

  /** The deck's house style: what the forms are made of. */
  private get look(): LookSpec {
    return LOOKS[this.ds.look];
  }
  /** Whether this page sits on the deep ground: an impact page unless the
   *  look sets its impact pages on paper, and every page of a deck whose
   *  theme keeps its reading pages dark. */
  private get onDeep(): boolean {
    return this.impact ? this.look.impactFill !== "paper" : this.ds.readingGround === "deep";
  }
  /** The ink that reads on a ground the system did not plan for: black or
   *  white, whichever clears it by more. */
  private inkOn(ground: Color): Color {
    return contrastRatio(WHITE_INK, ground) >= contrastRatio(BLACK_INK, ground) ? WHITE_INK : BLACK_INK;
  }
  /** What an impact page sits on, per the look. */
  private impactBackground(): Fill {
    if (this.look.impactFill === "paper") return this.ds.paperBackground;
    if (this.look.impactFill === "flat") return { type: "solid", color: structuredClone(this.ds.colors.deep) } as Fill;
    return this.ds.impactBackground;
  }
  private get ground(): Color {
    return this.onDeep ? this.ds.colors.deep : this.ds.colors.paper;
  }
  private get ink(): Color {
    return this.onDeep ? this.ds.colors.inkOnDeep : this.ds.colors.ink;
  }
  private get muted(): Color {
    return this.onDeep ? this.ds.colors.mutedOnDeep : this.ds.colors.mutedOnPaper;
  }
  private get accent(): Color {
    return this.onDeep ? this.ds.colors.accentOnDeep : this.ds.colors.accentOnPaper;
  }
  /** The accent for small text, held to AA. */
  private get accentInk(): Color {
    return this.onDeep ? this.ds.colors.accentInkOnDeep : this.ds.colors.accentInkOnPaper;
  }
  /** The fill of a panel or a picture stand-in: lifted off the ground a little. */
  private get lifted(): Color {
    return this.onDeep ? mix(this.ds.colors.deep, this.ds.colors.inkOnDeep, 0.08) : this.ds.colors.tint;
  }
  /** Where a reading page's content starts: under the eyebrow band. */
  private get top(): number {
    return this.m + this.ds.unit * 7;
  }

  /** A type size from the scale, in pixels, stepped up when the fixer set
   *  this page "large" and the size is one the variant governs. */
  private sz(key: keyof typeof T): number {
    const large = this.ctx.variant === "large" && LARGE_KEYS.has(key) ? LARGE_SCALE : 1;
    return this.H * T[key] * large * (this.look.scale[key] ?? 1);
  }

  // --- measurement -----------------------------------------------------------

  private lines(text: string, size: number, width: number, role: "heading" | "body"): number {
    // Greedy by words, the way both renderers break a line: a word moves to
    // the next line whole, and a chunk no line can hold (a long word, a pair
    // joined by a no-break space) takes a line of its own and runs past the
    // box, exactly as it will when drawn. Counting characters instead made a
    // narrow column look like it held copy it could not.
    const perLine = Math.max(1, width / (size * ADVANCE[role]));
    let n = 0;
    for (const seg of text.split("\n")) {
      const words = seg.split(" ").filter((w) => w.length > 0);
      if (!words.length) { n += 1; continue; }
      let lineLen = 0;
      let lines = 1;
      for (const w of words) {
        const wl = Array.from(w).length;
        if (lineLen === 0) { lineLen = wl; continue; }
        if (lineLen + 1 + wl <= perLine) lineLen += 1 + wl;
        else { lines++; lineLen = wl; }
      }
      n += lines;
    }
    return n;
  }

  /** The longest chunk no line break can split, in characters. */
  private longestChunk(paragraphs: string[]): number {
    let longest = 0;
    for (const p of paragraphs) for (const w of p.split(/[ \n]+/)) longest = Math.max(longest, Array.from(w).length);
    return longest;
  }

  /** The largest ladder size at which the paragraphs fit the region.
   *  gutterEm is the list marker gutter, in ems, taken off the wrap width. */
  private fit(paragraphs: string[], width: number, height: number, base: number, lineHeight: number, role: "heading" | "body", paraGap: number, gutterEm = 0): number {
    const ladder = ladderFrom(base, this.ds.size);
    const longest = this.longestChunk(paragraphs);
    for (const size of ladder) {
      // A word no line can hold runs past the box in every renderer; the
      // type steps down first.
      if (longest * ADVANCE[role] * size > Math.max(1, width - gutterEm * size)) continue;
      if (this.measure(paragraphs, width, size, lineHeight, role, paraGap, gutterEm) <= height) return size;
    }
    return ladder[ladder.length - 1];
  }

  private measure(paragraphs: string[], width: number, size: number, lineHeight: number, role: "heading" | "body", paraGap: number, gutterEm = 0): number {
    let h = 0;
    paragraphs.forEach((p, i) => {
      h += this.lines(p, size, Math.max(1, width - gutterEm * size), role) * size * lineHeight;
      if (i < paragraphs.length - 1) h += paraGap * size;
    });
    return Math.ceil(h);
  }

  // --- primitives ------------------------------------------------------------

  private text(opts: {
    name: string;
    rect: Rect;
    paragraphs: string[];
    role: "heading" | "body";
    base: number;
    lineHeight?: number;
    color?: Color;
    bold?: boolean;
    align?: "left" | "right" | "center";
    valign?: "top" | "middle" | "bottom";
    tracking?: number;
    paraGap?: number;
    /** Fit the type to the rect (default) or force this exact size. */
    exactSize?: number;
    /** Set every paragraph as a list item: a real marker in a gutter with a
     *  hanging indent, laid out by the text engine and the exporters alike,
     *  instead of a bullet character baked into the copy. */
    list?: "bullet" | "number";
    /** Set in the look's mono face when it has one (labels, markers). */
    mono?: boolean;
  }): { node: Node; height: number; size: number } {
    const lineHeight = opts.lineHeight ?? (opts.role === "heading" ? 1.1 : 1.4);
    const paraGap = opts.paraGap ?? (opts.role === "heading" ? 0.2 : 0.45);
    const plain = opts.paragraphs.length ? opts.paragraphs : [""];
    const gutterEm = opts.list ? LIST_GUTTER_EM : 0;
    const size = opts.exactSize ?? this.fit(plain, opts.rect.width, opts.rect.height, opts.base, lineHeight, opts.role, paraGap, gutterEm);
    // A heading never leaves its last word alone on the final line, when the
    // pair the join makes still holds one line at this size. The joined words
    // are one unbreakable chunk to every renderer, and in a narrow column at
    // display size that chunk ran past the box and over the picture beside it.
    const lineChars = Math.max(1, opts.rect.width - gutterEm * size) / (size * ADVANCE[opts.role]);
    const paragraphs = plain.map((p) => (opts.role === "heading" ? keepLastWordCompany(p, lineChars) : p));
    const needed = this.measure(paragraphs, opts.rect.width, size, lineHeight, opts.role, paraGap, gutterEm);
    // At the floor and still over: the ladder is exhausted. Recorded for the
    // report rather than hidden by a clip, because only shorter copy fixes it.
    if (!opts.exactSize && needed > opts.rect.height) this.overfull.push(opts.name);
    const height = Math.min(opts.rect.height, needed);
    // The node is as tall as its text, not as tall as the region it was
    // offered. A title offered a fifth of the page and set on one line would
    // otherwise leave a transparent box over everything placed beneath it,
    // stealing hit-tests in the editor and confusing reflow. Bottom- and
    // middle-anchored text keeps the region, because the anchor is the point.
    const valign = opts.valign ?? "top";
    const boxHeight = valign === "top" ? height : opts.rect.height;
    const r = this.mirror({ ...opts.rect, height: boxHeight });
    const align = opts.align ?? this.align;
    const style = {
      fontFamily: opts.mono && this.ds.fonts.mono ? this.ds.fonts.mono : opts.role === "heading" ? this.ds.fonts.heading : this.ds.fonts.body,
      fontStyle: opts.bold ? "Bold" : "Regular",
      fontSize: size,
      letterSpacing: opts.tracking ? opts.tracking * size : undefined,
      fill: { type: "solid", color: structuredClone(opts.color ?? this.ink) },
    };
    const node = createNode("text", {
      name: opts.name,
      transform: { x: r.x, y: r.y, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: r.width, height: r.height },
      box: { mode: "fixed", width: r.width, height: r.height, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: opts.valign ?? "top" },
      content: paragraphs.map((p) => ({
        runs: [{ text: p, style: structuredClone(style) }],
        style: { align, direction: "auto", ...(opts.list ? { list: { type: opts.list, level: 0 } } : {}) },
      })),
    } as never) as Node;
    return { node, height, size };
  }

  /** A stat as one paragraph of two runs: the figure at display scale and the
   *  unit beside it at a third of that, sharing a baseline. */
  private numeral(rect: Rect, value: string, unit: string | undefined, color: Color, baseSize?: number): { node: Node; height: number; size: number } {
    const base = baseSize ?? this.sz("numeral");
    // A figure never wraps: it is sized to hold one line of its width, the
    // unit counted at its own smaller size and the digits at a bold display
    // advance. The general ladder cannot do this: its floor is half the base,
    // a long figure in a narrow column needs less than that, and when nothing
    // fit the ladder shipped its floor and the browser wrapped the figure
    // over the label beneath it.
    const unitScale = T.unit / T.numeral;
    const ems = Array.from(value).length * NUMERAL_ADVANCE + (unit ? (1 + Array.from(unit).length) * NUMERAL_ADVANCE * unitScale : 0);
    const size = Math.max(sizeFloor(this.ds.size), Math.min(Math.round(base), Math.floor(rect.width / Math.max(ems, NUMERAL_ADVANCE)), Math.round(rect.height)));
    const r = this.mirror(rect);
    // Line height one: the baseline sits on the box's bottom edge, so a tall
    // glyph never rises past the box's top into the rule above it.
    const runStyle = (fontSize: number) => ({
      fontFamily: this.look.numeralMono && this.ds.fonts.mono ? this.ds.fonts.mono : this.ds.fonts.heading,
      fontStyle: this.look.numeralBold ? "Bold" : "Regular",
      fontSize,
      lineHeight: 1,
      letterSpacing: -0.02 * fontSize,
      fill: { type: "solid", color: structuredClone(color) },
    });
    const runs = [{ text: value, style: runStyle(size) }];
    if (unit) runs.push({ text: " " + unit, style: runStyle(Math.round(size * (T.unit / T.numeral))) });
    const node = createNode("text", {
      name: "Figure",
      transform: { x: r.x, y: r.y, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: r.width, height: r.height },
      box: { mode: "fixed", width: r.width, height: r.height, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "bottom" },
      content: [{ runs, style: { align: this.align, direction: "auto" } }],
    } as never) as Node;
    return { node, height: size, size };
  }

  private rect(name: string, r0: Rect, fill: Color, radius = 0, data?: Record<string, unknown>, stroke?: { color: Color; width: number }): Node {
    const r = this.mirror(r0);
    return createNode("shape", {
      name,
      shape: "rect",
      transform: { x: r.x, y: r.y, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: r.width, height: r.height },
      fills: [{ type: "solid", color: structuredClone(fill) }],
      ...(stroke ? { stroke: { fill: { type: "solid", color: structuredClone(stroke.color) }, width: stroke.width, align: "inside" } } : {}),
      // The file format's radius is per corner; the renderers read that form
      // and draw a bare number as square corners.
      ...(radius > 0 ? { cornerRadius: roundedCorners(radius) } : {}),
      ...(data ? { data } : {}),
    } as never) as Node;
  }

  /** The accent rule: the deck's one repeated mark. Short, above a heading. */
  private accentRule(x: number, y: number, color?: Color): Node {
    const u = this.ds.unit;
    const w = Math.round(u * this.look.ruleLength);
    const h = Math.max(this.look.ruleThickness < 0.3 ? 2 : 6, Math.round(u * this.look.ruleThickness));
    return this.rect("Accent", { x, y, width: w, height: h }, color ?? this.accent, this.look.radius > 0 ? Math.round(h / 2) : 0);
  }

  /** A panel drawn behind a cell's content, made the way the look makes
   *  one: the system's tint, a stronger tint of the primary hue, or the
   *  ground outlined by a hairline. Tagged so the quality loop knows the
   *  content sits on it on purpose. */
  private panel(r: Rect): Node {
    const radius = Math.round(this.ds.radius * 3);
    const c = this.ds.colors;
    if (this.look.panel === "outline") {
      return this.rect("Panel", r, this.ground, radius, { panel: true }, { color: mix(this.ink, this.ground, 0.72), width: 1 });
    }
    if (this.look.panel === "strong") {
      return this.rect("Panel", r, this.onDeep ? mix(c.deep, c.primary, 0.35) : mix(c.paper, c.primary, 0.16), radius, { panel: true });
    }
    return this.rect("Panel", r, this.lifted, radius, { panel: true });
  }

  /** The eyebrow: two or three words, small and tracked, in the accent. */
  private eyebrowNode(text: string, rect: Rect, align?: "left" | "right" | "center"): Node {
    return this.text({ name: "Eyebrow", rect, paragraphs: [text], role: "body", base: this.sz("eyebrow"), color: this.accentInk, exactSize: Math.round(this.sz("eyebrow")), tracking: this.look.tracking, mono: this.look.monoLabels, lineHeight: 1.2, align }).node;
  }

  /** An eyebrow as a cluster block, for impact pages that name one. */
  private eyebrowBlock(): Array<{ kind: "text"; make: (rect: Rect) => { node: Node; height: number }; maxFrac: number }> {
    const e = this.item.eyebrow?.trim();
    if (!e) return [];
    return [{ kind: "text", maxFrac: 0.1, make: (r: Rect) => this.text({ name: "Eyebrow", rect: r, paragraphs: [e], role: "body", base: this.sz("eyebrow"), color: this.accentInk, exactSize: Math.round(this.sz("eyebrow")), tracking: this.look.tracking, mono: this.look.monoLabels, lineHeight: 1.2 }) }];
  }

  /** The kit's logo for this page's ground: the dark-ground version on a
   *  deep page when the kit has one, else the primary. The box keeps the
   *  primary's minimum width; the aspect is the chosen picture's. */
  private pageLogo(): { assetId: string; url: string; aspect?: number; minSizePx?: number } | null {
    const logo = this.ds.logo;
    if (!logo) return null;
    if (this.onDeep && logo.dark) return { ...logo.dark, minSizePx: logo.minSizePx };
    return logo;
  }

  /** The brand logo as an image node fitted into a box. Tagged so brand
   *  tooling recognises it as the kit's logo, not a picture to regenerate. */
  private logoNode(r0: Rect): Node {
    const logo = this.pageLogo()!;
    const r = this.mirror(r0);
    return createNode("image", {
      name: "Logo",
      source: { assetId: logo.assetId, naturalWidth: 0, naturalHeight: 0 },
      fit: "contain",
      transform: { x: r.x, y: r.y, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: r.width, height: r.height },
      data: { brandLogo: true },
    } as never) as Node;
  }

  /** An icon from the set, baked into a path node at its final size: the
   *  glyph's contours scaled from the pack's box into the square, filled in
   *  one color under the even-odd rule so its interior contours cut holes.
   *  Coordinates are in node space at final size (transform scale 1), so the
   *  quality loop and the renderers see the same box. */
  private icon(glyph: string, x: number, y: number, size: number, color: Color): Node | null {
    const contours = ICON_GLYPHS[glyph];
    if (!contours?.length) return null;
    const k = size / ICON_BOX;
    const pt = (p: { x: number; y: number }) => ({ x: Math.round(p.x * k * 100) / 100, y: Math.round(p.y * k * 100) / 100 });
    const scaled = contours.map((c) => ({
      closed: c.closed,
      segments: c.segments.map((sg) => ({ ...pt(sg), ...(sg.cIn ? { cIn: pt(sg.cIn) } : {}), ...(sg.cOut ? { cOut: pt(sg.cOut) } : {}) })),
    }));
    const [first, ...rest] = scaled;
    const r = this.mirror({ x, y, width: size, height: size });
    return createNode("path", {
      name: "Icon",
      transform: { x: r.x, y: r.y, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: size, height: size },
      segments: first.segments,
      closed: first.closed,
      ...(rest.length ? { contours: rest } : {}),
      fills: [{ type: "solid", color: structuredClone(color) }],
      data: { icon: glyph },
    } as never) as Node;
  }

  /** A picture region: the same neutral stand-in the editor materializes for
   *  a picture slot, tagged so the image pipeline finds it by placeholder id
   *  and replaces it wholesale when the picture lands. */
  private imageSlot(r: Rect, prompt: string, radius = 0): Node {
    // An abstract intent is drawn here and now: a few forms in the deck's
    // hues, deterministic from the page, editable everywhere. No provider
    // could give it a photograph and no stock search finds one, so the
    // region used to keep its stand-in for good.
    if (this.item.image?.treatment === "abstract") return this.artwork(r);
    this.slotSeq += 1;
    const id = `img-${this.ctx.index + 1}-${this.slotSeq}`;
    this.prompts[id] = prompt;
    // A designed block until the picture lands, and for good if it never
    // does: a self-hosted instance with no image provider and no stock key
    // keeps every stand-in, and a flat tint read as an empty box on the post.
    // A soft run from the ground's lift toward the primary hue reads as a
    // colour panel instead; the picture replaces the fill when it arrives.
    const c = this.ds.colors;
    const from = this.lifted;
    const to = this.onDeep ? mix(c.primary, c.deep, 0.45) : mix(c.primary, c.paper, 0.72);
    const node = this.rect("Image", r, from, radius, { placeholderId: id, aiImagePrompt: prompt });
    (node as unknown as { fills: unknown[] }).fills = [{ type: "gradient", gradient: "linear", angle: 135, stops: [{ position: 0, color: structuredClone(from) }, { position: 1, color: structuredClone(to) }] }];
    return node;
  }

  /** A drawing from the illustration set, fitted into a rect and recolored
   *  to the deck: the pack's line becomes the page's ink, its accent the
   *  deck's accent, its greys tints of the ground, its white the ground's
   *  own lift. One path node per fill layer, grouped, so the drawing is
   *  editable vector everywhere and the quality loop sees one box. */
  private illustration(name: string, r0: Rect): Node | null {
    const d: IllustrationDrawing | undefined = ILLUSTRATIONS[name];
    if (!d) return null;
    const k = Math.min(r0.width / d.w, r0.height / d.h);
    const w = Math.round(d.w * k);
    const h = Math.round(d.h * k);
    const r = this.mirror({ x: r0.x + Math.round((r0.width - w) / 2), y: r0.y + Math.round((r0.height - h) / 2), width: w, height: h });
    const c = this.ds.colors;
    const ground = this.ground;
    const roleColor = (role: string): Color => {
      switch (role) {
        case "line": case "stroke": return this.ink;
        case "accent": return this.accent;
        case "white": return this.onDeep ? mix(c.deep, c.inkOnDeep, 0.16) : c.paper;
        case "grey": return this.onDeep ? mix(c.deep, c.inkOnDeep, 0.3) : mix(ground, this.ink, 0.18);
        case "grey2": return this.onDeep ? mix(c.deep, c.inkOnDeep, 0.22) : mix(ground, this.ink, 0.1);
        case "grey3": return this.onDeep ? mix(c.deep, c.inkOnDeep, 0.45) : mix(ground, this.ink, 0.4);
        default: return this.ink;
      }
    };
    const children: Node[] = [];
    for (const [role, path] of d.layers) {
      const contours = decodeDrawingPath(path, k, 0, 0);
      if (!contours.length) continue;
      const [first, ...rest] = contours;
      const color = roleColor(role);
      const stroke = role === "stroke";
      children.push(createNode("path", {
        name: role,
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: w, height: h },
        segments: first.segments,
        closed: first.closed,
        ...(rest.length ? { contours: rest } : {}),
        ...(stroke
          ? { stroke: { fill: { type: "solid", color: structuredClone(color) }, width: Math.max(1, Math.round(k)), align: "center", cap: "round", join: "round" } }
          : { fills: [{ type: "solid", color: structuredClone(color) }] }),
      } as never) as Node);
    }
    if (!children.length) return null;
    return createNode("group", {
      name: "Illustration",
      children,
      transform: { x: r.x, y: r.y, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: w, height: h },
      data: { illustration: name },
    } as never) as Node;
  }

  /** The drawing the outline named for this page, when the set knows it;
   *  for an illustration intent that named none, one the subject's own words
   *  match ("a handshake between partners" finds the handshake). */
  private get namedIllustration(): string | null {
    const im = this.item.image;
    return illustrationFor(im?.illustration) ?? (im?.treatment === "illustration" ? illustrationFor(im.subject) : null);
  }

  /** Procedural artwork in a region: one kind chosen by the page's seed,
   *  every form inside the box, grouped so the quality loop sees one node.
   *  Tagged so the picture ladders leave it alone. */
  private artwork(r0: Rect): Node {
    const r = this.mirror(r0);
    const seed = Array.from(this.item.title).reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, this.ctx.index * 7919 + 17);
    const kind = artworkKindFor(seed);
    const c = this.ds.colors;
    const children = artworkNodes(kind, { x: 0, y: 0, width: r.width, height: r.height }, { ground: this.ground, primary: c.primary, accent: this.accent }, seed);
    return createNode("group", {
      name: "Artwork",
      children,
      transform: { x: r.x, y: r.y, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: r.width, height: r.height },
      data: { artwork: kind },
    } as never) as Node;
  }

  /** What the picture should show, in the deck's treatment. Falls back to the
   *  slide's own subject when the outline named no image, so a form that
   *  needs a picture (cover, imageCaption) always gets a usable prompt. */
  private imagePrompt(): string {
    const im = this.item.image;
    const treatment = im?.treatment ?? "photo";
    const subject = im?.subject || this.item.title;
    const style =
      treatment === "illustration" ? "flat editorial illustration, limited palette" :
      treatment === "abstract" ? "abstract composition, soft forms" :
      "clean professional photography";
    // Subject first (the picture ladder reads it back as everything before
    // the first comma), then the treatment, then the deck's art direction so
    // every picture in the deck is lit and toned the same way.
    return `${subject}, ${style}, ${this.ds.artDirection}`;
  }

  /** Reading-page furniture: the deck title small at the top, the page number
   *  small at the bottom. Impact pages stay quiet. */
  private furniture(region?: { x: number; width: number }, opts?: { band?: boolean; footerInk?: Color }): void {
    const u = this.ds.unit;
    // The technical look shows its grid: eleven faint column lines behind a
    // reading page's body, drawn first so everything sits over them.
    if (!this.impact && this.look.gridLines && !this.isPost) {
      const lines: Node[] = [];
      for (let i = 1; i < this.ds.columns; i++) {
        const x = Math.round(this.m + i * (this.col + this.ds.gutter) - this.ds.gutter / 2);
        const line = this.rect("Decor", { x, y: this.top, width: 1, height: this.bodyBottom - this.top }, this.ink, 0, { decor: true });
        (line as unknown as { opacity: number }).opacity = 0.08;
        lines.push(line);
      }
      this.nodes.unshift(...lines);
    }
    // A page whose picture bleeds to an edge keeps its furniture in the text
    // column, so nothing sits on the picture; every other page runs the
    // footer across the full width.
    const x0 = region?.x ?? this.m;
    const w0 = region?.width ?? this.W - 2 * this.m;
    const fx0 = x0;
    const fw0 = w0;
    // The brand's logo, small and in the same place on every page so the deck
    // reads as the brand's: top-leading on impact pages, where nothing else
    // sits above the margin, and bottom-leading on reading pages, level with
    // the page number on the trailing side. Fitted into its box, never
    // stretched; the editor and the API list the asset in the file.
    // The logo's footprint, so the footer text starts after it.
    let logoW = 0;
    if (this.ds.logo) {
      const chosen = this.pageLogo()!;
      const aspect = chosen.aspect && chosen.aspect > 0 ? chosen.aspect : 2.5;
      let h = this.impact ? u * 4 : u * 3;
      let w = Math.round(h * aspect);
      // The kit's floor on the logo's width wins over the deck's scale, up to
      // the room the margin leaves: a brand that says "never under 120px"
      // gets 120px.
      const min = this.ds.logo.minSizePx ?? 0;
      if (min > w) {
        const hMax = this.impact ? u * 6 : u * 4;
        h = Math.min(hMax, min / aspect);
        w = Math.round(h * aspect);
      }
      const y = this.impact ? u * 2 : this.H - u * 1.5 - h;
      const placedW = Math.min(w, fw0);
      this.nodes.push(this.logoNode({ x: this.impact ? x0 : fx0, y, width: placedW, height: Math.round(h) }));
      if (!this.impact) logoW = placedW + u * 2;
    }
    // The eyebrow band on a reading page: the short rule, then two or three
    // words on what the page is about, in the accent, above the title. A
    // page the outline gave no eyebrow shows the deck's name there instead.
    if (!this.impact && opts?.band !== false) {
      const label = this.item.eyebrow?.trim() || this.ds.kicker;
      this.nodes.push(this.accentRule(x0, this.m + u * 0.5));
      if (label) this.nodes.push(this.eyebrowNode(label, { x: x0, y: this.m + u * 2.2, width: w0, height: u * 2.8 }));
    }
    // The footer: the deck's name on the leading side (after the logo when
    // there is one), the page's place in the deck on the trailing side.
    const footerY = this.H - u * 4.2;
    // The deck's name on one line; a narrow text column (a picture page)
    // drops it rather than wrap it, and keeps the page number.
    const footerW = fw0 - logoW - u * 14;
    if (this.item.archetype !== "cover" && !this.isPost && this.ds.kicker && footerW >= u * 24) {
      this.nodes.push(this.text({
        name: "Footer", rect: { x: fx0 + logoW, y: footerY, width: footerW, height: u * 2.6 }, mono: this.look.monoLabels,
        paragraphs: [this.ds.kicker], role: "body", base: this.sz("footer"), color: opts?.footerInk ?? this.muted, exactSize: Math.round(this.sz("footer")), tracking: 0.04,
      }).node);
    }
    if (this.item.archetype !== "cover" && !this.isPost) {
      const n = this.text({
        name: "Page number", rect: { x: fx0 + fw0 - u * 12, y: footerY, width: u * 12, height: u * 2.6 }, mono: this.look.monoLabels,
        paragraphs: [`${String(this.ctx.index + 1).padStart(2, "0")} / ${String(this.ctx.total).padStart(2, "0")}`], role: "body", base: this.sz("footer"), color: opts?.footerInk ?? this.muted,
        align: this.ds.dir === "rtl" ? "left" : "right", exactSize: Math.round(this.sz("footer")), tracking: 0.04,
      });
      this.nodes.push(n.node);
    }
  }

  /** Measure-then-place a vertical cluster of text blocks inside a region,
   *  centered when it is shorter than the region. Each block is measured at
   *  the size it fits at, so the cluster's height is honest before anything
   *  is placed. */
  private cluster(region: Rect, blocks: Array<{ kind: "rule"; color?: Color } | { kind: "icon"; glyph: string; size: number } | { kind: "text"; make: (rect: Rect) => { node: Node; height: number } ; maxFrac: number }>, gapUnits = 2, center = true): void {
    const u = this.ds.unit;
    // First pass: measure with each block offered its share of the region.
    const measured = blocks.map((b) => {
      if (b.kind === "rule") return { b, height: Math.max(6, Math.round(this.ds.unit * 0.6)), node: null as Node | null };
      if (b.kind === "icon") return { b, height: b.size, node: null as Node | null };
      const probe = b.make({ x: region.x, y: region.y, width: region.width, height: Math.max(u * 2, region.height * b.maxFrac) });
      return { b, height: probe.height, node: null as Node | null };
    });
    const total = measured.reduce((s, m) => s + m.height, 0) + gapUnits * u * (blocks.length - 1);
    let y = region.y + (center ? Math.max(0, Math.round((region.height - total) / 2)) : 0);
    for (const mrow of measured) {
      if (mrow.b.kind === "rule") {
        this.nodes.push(this.accentRule(region.x, y, mrow.b.color));
      } else if (mrow.b.kind === "icon") {
        const ic = this.icon(mrow.b.glyph, region.x, y, mrow.b.size, this.accent);
        if (ic) this.nodes.push(ic);
      } else {
        const made = mrow.b.make({ x: region.x, y, width: region.width, height: mrow.height });
        this.nodes.push(made.node);
      }
      y += mrow.height + gapUnits * u;
    }
  }

  /** The page's own icon as a cluster block, or nothing when the outline
   *  named none the set knows. */
  private pageIconBlock(): Array<{ kind: "icon"; glyph: string; size: number }> {
    const glyph = iconGlyphFor(this.item.icon);
    return glyph ? [{ kind: "icon", glyph, size: Math.round(this.sz("pageIcon")) }] : [];
  }

  /** The decor an impact page carries where a picture would go: one large
   *  soft disc of the deck's own hue, bleeding off the trailing edge, with
   *  the page's icon set in it when the outline named one. Ornament, not
   *  content: tagged so the quality loop and the measure ignore it, drawn
   *  behind everything. Only where nothing else sits (never over a picture). */
  private decor(region: Rect): void {
    const d = Math.round(this.H * 0.6);
    const cx = region.x + region.width * 0.65;
    const cy = this.H * 0.5;
    const r = this.mirror({ x: Math.round(cx - d / 2), y: Math.round(cy - d / 2), width: d, height: d });
    const disc = createNode("shape", {
      name: "Decor",
      shape: "ellipse",
      transform: { x: r.x, y: r.y, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: r.width, height: r.height },
      fills: [{ type: "solid", color: structuredClone(mix(this.ds.colors.deep, this.ds.colors.primary, 0.6)) }],
      opacity: 0.55,
      data: { decor: true },
    } as never) as Node;
    // A second, smaller disc in a gradient of the deck's two hues, bleeding
    // off the top trailing corner: the one bright mark on a deep ground.
    const cd = Math.round(this.H * 0.4);
    const cr = this.mirror({ x: Math.round(this.W - cd * 0.55), y: Math.round(-cd * 0.45), width: cd, height: cd });
    const corner = createNode("shape", {
      name: "Decor",
      shape: "ellipse",
      transform: { x: cr.x, y: cr.y, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: cr.width, height: cr.height },
      fills: [{ type: "gradient", gradient: "linear", angle: 135, stops: [{ position: 0, color: structuredClone(this.ds.colors.accentOnDeep) }, { position: 1, color: structuredClone(this.ds.colors.primary) }] }],
      opacity: 0.9,
      data: { decor: true },
    } as never) as Node;
    const out: Node[] = [corner, disc];
    const glyph = iconGlyphFor(this.item.icon);
    if (glyph) {
      const size = Math.round(d * 0.38);
      const ic = this.icon(glyph, Math.round(cx - size / 2), Math.round(cy - size / 2), size, this.ds.colors.accentOnDeep);
      if (ic) {
        (ic as unknown as { name: string; data: Record<string, unknown> }).name = "Decor";
        (ic as unknown as { data: Record<string, unknown> }).data = { ...((ic as unknown as { data?: Record<string, unknown> }).data ?? {}), decor: true };
        out.push(ic);
      }
    }
    this.nodes.unshift(...out);
  }

  // --- archetypes --------------------------------------------------------------

  compose(): ComposedPage {
    const a = (this.item.archetype ?? "bullets") as Archetype;
    switch (a) {
      case "cover": this.cover(); break;
      case "section": this.section(); break;
      case "statement": this.statement(); break;
      case "bigNumber": this.bigNumber(); break;
      case "twoColumn": this.columns(2); break;
      case "threeUp": this.columns(3); break;
      case "process": this.process(); break;
      case "quote": this.quote(); break;
      case "imageCaption": this.imageCaption(); break;
      case "chart": this.chart(); break;
      case "closing": this.closing(); break;
      case "agenda": this.agenda(); break;
      case "kpiGrid": this.kpiGrid(); break;
      case "timeline": this.timeline(); break;
      case "table": this.table(); break;
      case "team": this.team(); break;
      case "composition": this.composition(); break;
      default: this.bullets(); break;
    }
    applyMotion(this.nodes as Array<Node & { animation?: unknown }>, this.ds.motion);
    return {
      background: structuredClone(this.impact ? this.impactBackground() : this.onDeep ? ({ type: "solid", color: this.ds.colors.deep } as Fill) : this.ds.paperBackground),
      nodes: this.nodes,
      imagePrompts: this.prompts,
      impact: this.impact,
      archetype: a,
      overfull: Array.from(new Set(this.overfull)),
    };
  }

  private titleBlock(base: number, bold = false) {
    return {
      kind: "text" as const,
      maxFrac: 0.5,
      make: (r: Rect) => this.text({ name: "Title", rect: r, paragraphs: [this.item.title], role: "heading", base, bold, lineHeight: 1.08 }),
    };
  }
  private subheadBlock(base: number, text: string | undefined, color?: Color) {
    return text
      ? [{ kind: "text" as const, maxFrac: 0.3, make: (r: Rect) => this.text({ name: "Subhead", rect: r, paragraphs: [text], role: "body", base, color: color ?? this.muted, lineHeight: 1.35 }) }]
      : [];
  }

  private cover(): void {
    const drawing = this.namedIllustration;
    const hasImage = !!this.item.image && !drawing;
    if (this.portrait && (drawing || hasImage)) {
      this.cluster(this.stackedPicture(drawing, hasImage), [
        ...this.eyebrowBlock(),
        { kind: "rule" },
        this.titleBlock(this.sz("coverTitle")),
        ...this.subheadBlock(this.sz("coverSub"), this.item.subhead ?? this.item.points[0]),
      ], 3, false);
      this.furniture();
      return;
    }
    if (this.look.cover === "typographic" && !hasImage) { this.typographicImpact("cover", drawing); return; }
    if (this.look.cover === "field") { this.fieldImpact("cover", drawing, hasImage); return; }
    const textCols = hasImage || drawing ? 6 : 8;
    const region = this.span(0, textCols);
    if (drawing) {
      // A drawing where the picture would go, sized to the trailing half
      // with the page's own air around it; nothing bleeds.
      const s = this.span(7, 5);
      const u = this.ds.unit;
      const ill = this.illustration(drawing, { x: s.x, y: this.m + u * 2, width: s.width, height: this.H - 2 * this.m - u * 4 });
      if (ill) this.nodes.push(ill);
    } else if (hasImage) {
      // Half-bleed picture on the trailing side: to the page edges, not the
      // margins, so it reads as the ground the words sit against.
      const s = this.span(7, 5);
      this.nodes.push(this.imageSlot({ x: s.x, y: 0, width: this.W - s.x, height: this.H }, this.imagePrompt()));
    } else {
      this.decor(this.span(8, 4));
    }
    this.cluster(region, [
      ...this.eyebrowBlock(),
      { kind: "rule" },
      this.titleBlock(this.sz("coverTitle")),
      ...this.subheadBlock(this.sz("coverSub"), this.item.subhead ?? this.item.points[0]),
    ], 3);
    this.furniture();
  }

  private section(): void {
    const drawing = this.namedIllustration;
    const hasImage = !!this.item.image && !drawing;
    if (this.portrait && (drawing || hasImage)) {
      const n = this.ctx.section;
      this.cluster(this.stackedPicture(drawing, hasImage), [
        ...this.eyebrowBlock(),
        ...(n ? [{ kind: "text" as const, maxFrac: 0.25, make: (r: Rect) => this.text({ name: "Section number", rect: r, paragraphs: [String(n).padStart(2, "0")], role: "heading", base: this.sz("sectionNumber"), bold: true, color: this.accentInk, exactSize: Math.round(this.sz("sectionNumber")), lineHeight: 1 }) }] : []),
        { kind: "rule" },
        this.titleBlock(this.sz("sectionTitle")),
        ...this.subheadBlock(this.sz("statementSub"), this.item.subhead),
      ], 3, false);
      this.furniture();
      return;
    }
    if (this.look.cover === "typographic" && !hasImage) { this.typographicImpact("section", drawing); return; }
    if (this.look.cover === "field") { this.fieldImpact("section", drawing, hasImage); return; }
    if (drawing) {
      const s = this.span(7, 5);
      const u = this.ds.unit;
      const ill = this.illustration(drawing, { x: s.x, y: this.m + u * 2, width: s.width, height: this.H - 2 * this.m - u * 4 });
      if (ill) this.nodes.push(ill);
    } else if (hasImage) {
      const s = this.span(8, 4);
      this.nodes.push(this.imageSlot({ x: s.x, y: 0, width: this.W - s.x, height: this.H }, this.imagePrompt()));
    } else {
      this.decor(this.span(8, 4));
    }
    const region = this.span(0, hasImage ? 7 : drawing ? 6 : 8);
    // A divider says where it sits in the deck: its number, large and in the
    // accent, above the rule.
    const n = this.ctx.section;
    const number = n
      ? [{ kind: "text" as const, maxFrac: 0.25, make: (r: Rect) => this.text({ name: "Section number", rect: r, paragraphs: [String(n).padStart(2, "0")], role: "heading", base: this.sz("sectionNumber"), bold: true, color: this.accentInk, exactSize: Math.round(this.sz("sectionNumber")), lineHeight: 1.05, tracking: 0.02 }) }]
      : [];
    this.cluster(region, [
      ...this.eyebrowBlock(),
      ...number,
      { kind: "rule" },
      this.titleBlock(this.sz("sectionTitle")),
      ...this.subheadBlock(this.sz("statementSub"), this.item.subhead),
    ], 3);
    this.furniture(hasImage ? { x: region.x, width: region.width } : undefined);
  }

  /** The editorial construction of an impact page: the words are the
   *  picture. Ten columns of display type on the paper, a hairline above,
   *  the eyebrow small and tracked; a drawing, when named, sits small in the
   *  trailing bottom corner and the words keep to nine columns so the two
   *  never meet. */
  private typographicImpact(kind: "cover" | "section" | "closing", drawing: string | null): void {
    const u = this.ds.unit;
    const region = { ...this.span(0, drawing ? 9 : 10), y: this.m + u * 4, height: this.H - 2 * this.m - u * 4 };
    const n = kind === "section" ? this.ctx.section : undefined;
    this.cluster(region, [
      ...this.eyebrowBlock(),
      ...(n ? [{ kind: "text" as const, maxFrac: 0.25, make: (r: Rect) => this.text({ name: "Section number", rect: r, paragraphs: [String(n).padStart(2, "0")], role: "heading", base: this.sz("sectionNumber"), bold: true, color: this.accentInk, exactSize: Math.round(this.sz("sectionNumber")), lineHeight: 1.05, tracking: 0.02 }) }] : []),
      { kind: "rule" },
      this.titleBlock(this.sz(kind === "cover" ? "coverTitle" : "sectionTitle"), this.look.headlineBold),
      ...this.subheadBlock(kind === "section" ? this.sz("statementSub") : this.sz("coverSub"), this.item.subhead ?? (kind === "section" ? undefined : this.item.points[0]), kind === "closing" ? this.ink : undefined),
    ], 3);
    if (drawing) {
      const s = this.span(9, 3);
      const h = Math.round(this.H * 0.3);
      const ill = this.illustration(drawing, { x: s.x, y: this.H - this.m - u * 2 - h, width: s.width, height: h });
      if (ill) this.nodes.push(ill);
    }
    this.furniture();
  }

  /** The bold construction of an impact page: a full-bleed colour field on
   *  the leading seven columns carries the words reversed out of it, and
   *  the drawing, the picture or the decor takes the rest on the deep
   *  ground. The field is a panel to the quality loop; the words on it take
   *  the ink that clears it. */
  private fieldImpact(kind: "cover" | "section" | "closing", drawing: string | null, hasImage: boolean): void {
    const u = this.ds.unit;
    const c = this.ds.colors;
    const s = this.span(0, 7);
    const fieldW = s.x + s.width + Math.round(this.ds.gutter / 2);
    const field = c.primary;
    const ink = this.inkOn(field);
    // The secondary ink on the field: softened toward it, held to AA.
    const soft = fixToAA(mix(ink, field, 0.22), field);
    this.nodes.push(this.rect("Field", { x: 0, y: 0, width: fieldW, height: this.H }, field, 0, { panel: true }));
    // The words keep above the footer band on a section or a closing, which
    // carry one; a cover has none and takes the full height.
    const bottom = kind === "cover" ? this.H - this.m : this.bodyBottom;
    const region = { x: this.m, y: this.m, width: fieldW - 2 * this.m, height: bottom - this.m };
    const e = this.item.eyebrow?.trim();
    const n = kind === "section" ? this.ctx.section : undefined;
    const sub = this.item.subhead ?? (kind === "section" ? undefined : this.item.points[0]);
    this.cluster(region, [
      ...(e ? [{ kind: "text" as const, maxFrac: 0.1, make: (r: Rect) => this.text({ name: "Eyebrow", rect: r, paragraphs: [e], role: "body", base: this.sz("eyebrow"), color: soft, exactSize: Math.round(this.sz("eyebrow")), tracking: this.look.tracking, mono: this.look.monoLabels, lineHeight: 1.2 }) }] : []),
      ...(n ? [{ kind: "text" as const, maxFrac: 0.25, make: (r: Rect) => this.text({ name: "Section number", rect: r, paragraphs: [String(n).padStart(2, "0")], role: "heading", base: this.sz("sectionNumber"), bold: true, color: ink, exactSize: Math.round(this.sz("sectionNumber")), lineHeight: 1.05 }) }] : []),
      { kind: "rule", color: ink },
      { kind: "text" as const, maxFrac: 0.5, make: (r: Rect) => this.text({ name: "Title", rect: r, paragraphs: [this.item.title], role: "heading", base: this.sz(kind === "cover" ? "coverTitle" : "sectionTitle"), bold: true, color: ink, lineHeight: 1.08 }) },
      ...(sub ? [{ kind: "text" as const, maxFrac: 0.3, make: (r: Rect) => this.text({ name: "Subhead", rect: r, paragraphs: [sub], role: "body", base: this.sz("coverSub"), color: soft, lineHeight: 1.35 }) }] : []),
    ], 3);
    const t = this.span(7, 5);
    if (drawing) {
      const ill = this.illustration(drawing, { x: t.x, y: this.m + u * 2, width: this.W - t.x - this.m, height: this.H - 2 * this.m - u * 4 });
      if (ill) this.nodes.push(ill);
    } else if (hasImage) {
      this.nodes.push(this.imageSlot({ x: fieldW, y: 0, width: this.W - fieldW, height: this.H }, this.imagePrompt()));
    } else {
      this.decor(this.span(8, 4));
    }
    // The furniture keeps to the field, as the split forms keep theirs to
    // the text column: nothing sits on the picture, and the footer and page
    // number take the field's own ink.
    this.furniture({ x: this.m, width: fieldW - 2 * this.m }, { footerInk: soft });
  }

  private statement(): void {
    // One idea, set large, with room around it. The type is the visual.
    this.cluster(this.span(0, 10), [
      ...this.eyebrowBlock(),
      ...this.pageIconBlock(),
      { kind: "rule" },
      { kind: "text", maxFrac: 0.6, make: (r) => this.text({ name: "Statement", rect: r, paragraphs: [this.item.title], role: "heading", base: this.sz("statement"), bold: this.look.headlineBold, lineHeight: 1.12 }) },
      ...this.subheadBlock(this.sz("statementSub"), this.item.subhead),
    ], 3);
    this.furniture();
  }

  private bigNumber(): void {
    const stat = this.item.stat!;
    const hasImage = !!this.item.image;
    const left = this.span(0, hasImage ? 6 : 7);
    const rightCols = hasImage ? this.span(7, 5) : this.span(8, 4);
    const u = this.ds.unit;
    // Figure and its label on the leading side; context (or the picture) on
    // the trailing side, aligned to the figure's block. The block is centered
    // in the area under the kicker: a number is the whole slide, and it
    // should sit where the eye lands, not under the top margin.
    const figureH = Math.round(this.H * 0.36);
    const labelProbe = this.text({ name: "Label", rect: { x: left.x, y: 0, width: left.width, height: u * 12 }, paragraphs: [stat.label], role: "heading", base: this.sz("statLabel"), bold: true, lineHeight: 1.2 });
    // The page's icon, when named, sits above the rule and the figure.
    const glyph = iconGlyphFor(stat.icon ?? this.item.icon);
    const iconSize = glyph ? Math.round(this.sz("pageIcon")) : 0;
    const iconH = glyph ? iconSize + u * 2 : 0;
    // The numeral is fitted first so the rule and the icon sit on the
    // glyphs, not on the top of a box taller than them.
    const probeFig = this.numeral({ x: left.x, y: 0, width: left.width, height: figureH }, stat.value, stat.unit, this.accentInk);
    const figH = probeFig.height;
    const blockH = iconH + u * 3 + figH + u * 2 + labelProbe.height;
    const areaTop = this.top;
    const offset = Math.max(0, Math.round((this.bodyBottom - areaTop - blockH) / 2));
    const top = areaTop + offset + iconH + u * 3;
    const figureRect = { x: left.x, y: top, width: left.width, height: figH };
    const fig = this.numeral(figureRect, stat.value, stat.unit, this.accentInk);
    if (glyph) {
      const ic = this.icon(glyph, left.x, areaTop + offset, iconSize, this.accent);
      if (ic) this.nodes.push(ic);
    }
    this.nodes.push(this.accentRule(left.x, top - u * 3));
    this.nodes.push(fig.node);
    const labelY = top + figureRect.height + u * 2;
    const label = this.text({ name: "Label", rect: { x: left.x, y: labelY, width: left.width, height: u * 12 }, paragraphs: [stat.label], role: "heading", base: this.sz("statLabel"), bold: true, lineHeight: 1.2 });
    this.nodes.push(label.node);
    if (hasImage) {
      this.nodes.push(this.imageSlot({ x: rightCols.x, y: top, width: rightCols.width, height: labelY + label.height - top }, this.imagePrompt(), this.ds.radius * 2));
      if (this.item.subhead) {
        const ctxText = this.text({ name: "Context", rect: { x: left.x, y: labelY + label.height + u * 2, width: left.width, height: Math.max(u * 4, this.bodyBottom - (labelY + label.height + u * 2)) }, paragraphs: [this.item.subhead], role: "body", base: this.sz("detail"), color: this.muted });
        this.nodes.push(ctxText.node);
      }
    } else if (this.item.subhead) {
      const ctxText = this.text({ name: "Context", rect: { x: rightCols.x, y: top, width: rightCols.width, height: labelY + label.height - top }, paragraphs: [this.item.subhead], role: "body", base: this.sz("caption"), color: this.muted, valign: "bottom", lineHeight: 1.45 });
      this.nodes.push(ctxText.node);
    }
    this.furniture();
  }

  private bullets(): void {
    const hasImage = !!this.item.image;
    // Alternate the picture's side down the deck so two illustrated pages in a
    // row do not stamp the same silhouette.
    const imageLeading = hasImage && this.ctx.index % 2 === 1;
    const textCols = hasImage ? 7 : 8;
    const region = hasImage && imageLeading ? this.span(5, 7) : this.span(0, textCols);
    const u = this.ds.unit;
    const content = { ...region, y: this.top, height: this.bodyBottom - this.top };
    if (hasImage) {
      const s = imageLeading ? this.span(0, 4) : this.span(8, 4);
      this.nodes.push(this.imageSlot({ x: s.x, y: content.y, width: s.width, height: content.height }, this.imagePrompt(), this.ds.radius * 2));
    }
    const points = this.item.points;
    const variant = this.ctx.variant;
    if (variant === "twoUp" && points.length >= 4 && !hasImage) {
      // A long list set as two unnamed columns under one title: the remedy
      // for a run of bullet pages or a list that would otherwise shrink.
      const half = Math.ceil(points.length / 2);
      const [l, r] = [this.span(0, 6), this.span(6, 6)];
      const u2 = this.ds.unit;
      const title = this.text({ name: "Title", rect: { ...this.span(0, 12), y: content.y, height: this.H * 0.2 }, paragraphs: [this.item.title], role: "heading", base: this.sz("title"), bold: false, lineHeight: 1.08 });
      const bodyTop = content.y + title.height + u2 * 4;
      const avail = this.H - this.m - bodyTop;
      const make = (span: Rect, pts: string[], y0: number) => this.text({ name: "Points", rect: { x: span.x, y: y0, width: span.width - this.ds.gutter, height: avail }, paragraphs: pts, role: "body", base: this.sz("point"), lineHeight: 1.35, paraGap: 0.55, list: "bullet" });
      const tallest = Math.max(make(l, points.slice(0, half), 0).height, make(r, points.slice(half), 0).height);
      const y0 = bodyTop + Math.max(0, Math.round((avail - tallest) / 2));
      // Re-anchor the title so the whole cluster is centered, as cluster() does.
      const total = title.height + u2 * 4 + tallest;
      const shift = Math.max(0, Math.round((content.height - total) / 2));
      this.nodes.push(this.text({ name: "Title", rect: { ...this.span(0, 12), y: content.y + shift, height: this.H * 0.2 }, paragraphs: [this.item.title], role: "heading", base: this.sz("title"), bold: false, lineHeight: 1.08 }).node);
      this.nodes.push(make(l, points.slice(0, half), y0 - (bodyTop - (content.y + shift + title.height + u2 * 4))).node);
      this.nodes.push(make(r, points.slice(half), y0 - (bodyTop - (content.y + shift + title.height + u2 * 4))).node);
      this.furniture();
      return;
    }
    const pointBase = variant === "large" ? this.H * T.agendaItem : this.sz("point");
    this.cluster(content, [
      ...this.pageIconBlock(),
      this.titleBlock(this.sz("title")),
      { kind: "text", maxFrac: 0.7, make: (r) => this.text({ name: "Points", rect: r, paragraphs: points, role: "body", base: pointBase, lineHeight: 1.35, paraGap: 0.55, list: "bullet" }) },
    ], 3, true);
    this.furniture();
  }

  private agenda(): void {
    const u = this.ds.unit;
    const content = { y: this.top, height: this.bodyBottom - this.top };
    // Title on the leading third, the numbered list on the trailing two thirds:
    // an agenda IS a sequence, so the numbers carry information. Each item
    // is a numbered badge and a label, the way a designed agenda reads.
    const left = { ...this.span(0, 4), ...content };
    const right = { ...this.span(5, 7), ...content };
    this.cluster(left, [this.titleBlock(this.sz("title"))], 3);
    const items = this.item.points.slice(0, 8);
    const badge = Math.round(this.sz("badge"));
    const gapY = u * 2.2;
    const labelX = right.x + badge + u * 2;
    const labelW = right.width - badge - u * 2;
    const rows = items.map((pt) => {
      const label = this.text({ name: "Agenda item", rect: { x: labelX, y: 0, width: labelW, height: u * 8 }, paragraphs: [pt], role: "heading", base: this.sz("agendaItem"), lineHeight: 1.2 });
      return { pt, h: Math.max(badge, label.height) };
    });
    const total = rows.reduce((a, r) => a + r.h, 0) + gapY * Math.max(0, rows.length - 1);
    let y = right.y + Math.max(0, Math.round((right.height - total) / 2));
    rows.forEach((row, i) => {
      this.nodes.push(this.rect("Badge", { x: right.x, y, width: badge, height: badge }, this.lifted, Math.round(badge * 0.28), { panel: true }));
      this.nodes.push(this.text({ name: "Number", rect: { x: right.x, y, width: badge, height: badge }, paragraphs: [String(i + 1).padStart(2, "0")], role: "body", base: this.sz("eyebrow"), color: this.accentInk, bold: true, exactSize: Math.round(this.sz("eyebrow")), align: "center", valign: "middle", lineHeight: 1, tracking: 0.04 }).node);
      this.nodes.push(this.text({ name: "Agenda item", rect: { x: labelX, y: y + Math.max(0, Math.round((badge - row.h) / 2)), width: labelW, height: row.h }, paragraphs: [row.pt], role: "heading", base: this.sz("agendaItem"), lineHeight: 1.2, valign: "middle" }).node);
      y += row.h + gapY;
    });
    this.furniture();
  }

  private columns(n: 2 | 3): void {
    const cols = (this.item.columns ?? []).slice(0, n);
    const u = this.ds.unit;
    const top = this.top;
    const title = this.text({ name: "Title", rect: { ...this.span(0, 12), y: top, height: this.H * 0.2 }, paragraphs: [this.item.title], role: "heading", base: this.sz("title"), bold: false, lineHeight: 1.08 });
    this.nodes.push(title.node);
    const bodyTop = top + title.height + u * 4;
    const bodyH = this.H - this.m - bodyTop;
    // Each column sits on a tinted panel; the panel's outer rect is the
    // column, the content is inset by the padding.
    const pad = u * 3;
    const spans = n === 2 ? [this.span(0, 6), this.span(6, 6)] : [this.span(0, 4), this.span(4, 4), this.span(8, 4)];
    const outers = spans.map((sp, i) => ({ x: sp.x, width: sp.width - (i < n - 1 ? this.ds.gutter : 0) }));
    const inners = outers.map((o) => ({ x: o.x + pad, width: o.width - 2 * pad }));
    // Two passes: measure each column at y=0 to learn the tallest, then place
    // every column so that block is centered in what remains under the title.
    // A short comparison used to sit under the title with a void beneath it.
    // Icons are all or nothing: one column with a picture and two without
    // reads as a mistake, so a column set gets icons only when every column
    // named one the set knows.
    const glyphs = cols.map((c) => iconGlyphFor(c.icon));
    const withIcons = glyphs.length > 0 && glyphs.every((g) => !!g);
    const iconSize = Math.round(this.sz("icon"));
    // Headings share one height so the point lists start on the same row
    // across the set even when one heading wraps.
    const headH = Math.max(0, ...cols.map((c, i) => this.text({ name: "Heading", rect: { x: inners[i].x, y: 0, width: inners[i].width, height: u * 10 }, paragraphs: [c.heading], role: "heading", base: this.sz("colHead"), bold: true, lineHeight: 1.15 }).height));
    const build = (c: { heading: string; points: string[] }, inner: { x: number; width: number }, y0: number, glyph: string | null) => {
      const out: Node[] = [];
      let y = y0;
      if (withIcons && glyph) {
        const ic = this.icon(glyph, inner.x, y, iconSize, this.accent);
        if (ic) out.push(ic);
        y += iconSize + u * 2;
      }
      out.push(this.accentRule(inner.x, y));
      const head = this.text({ name: "Heading", rect: { x: inner.x, y: y + u * 2.5, width: inner.width, height: u * 10 }, paragraphs: [c.heading], role: "heading", base: this.sz("colHead"), bold: true, lineHeight: 1.15 });
      out.push(head.node);
      let bottom = y + u * 2.5 + Math.max(head.height, headH);
      const pts = c.points;
      if (pts.length) {
        const py = bottom + u * 2;
        const body = this.text({ name: "Points", rect: { x: inner.x, y: py, width: inner.width, height: Math.max(u * 4, this.bodyBottom - py) }, paragraphs: pts, role: "body", base: this.sz("point") * (n === 3 ? 0.92 : 1), lineHeight: 1.35, paraGap: 0.5, list: "bullet" });
        out.push(body.node);
        bottom = py + body.height;
      }
      return { nodes: out, height: bottom - y0 };
    };
    const tallest = Math.max(...cols.map((c, i) => build(c, inners[i], 0, glyphs[i]).height));
    const panelH = tallest + 2 * pad;
    const y0 = bodyTop + Math.min(u * 8, Math.max(0, Math.round((bodyH - panelH) / 2)));
    cols.forEach((c, i) => {
      this.nodes.push(this.panel({ x: outers[i].x, y: y0, width: outers[i].width, height: panelH }));
      this.nodes.push(...build(c, inners[i], y0 + pad, glyphs[i]).nodes);
    });
    this.furniture();
  }

  private process(): void {
    const steps = this.item.steps ?? [];
    const u = this.ds.unit;
    const top = this.top;
    const title = this.text({ name: "Title", rect: { ...this.span(0, 12), y: top, height: this.H * 0.2 }, paragraphs: [this.item.title], role: "heading", base: this.sz("title"), bold: false, lineHeight: 1.08 });
    this.nodes.push(title.node);
    const bodyTop = top + title.height + u * 5;
    const n = steps.length;
    if (n <= 4) {
      // A row: numerals on a shared line, drawn as segments between them, and
      // measured first so the row sits in the middle of the space under the
      // title rather than pressed up against it.
      const perCols = Math.floor(12 / n);
      const numSize = Math.round(this.sz("stepNumber"));
      const numBox = Math.round(numSize * 1.15);
      const lineColor = mix(this.ds.colors.ink, this.ds.colors.paper, 0.8);
      const build = (y0: number) => {
        const out: Node[] = [];
        let bottom = y0;
        const lineY = y0 + Math.round(numBox / 2) - Math.round(this.ds.rule / 2);
        // Labels share one height so every detail starts on the same row.
        const labelH = Math.max(0, ...steps.map((st, i) => { const sp = this.span(i * perCols, perCols); return this.text({ name: "Label", rect: { x: sp.x, y: 0, width: sp.width - this.ds.gutter, height: u * 8 }, paragraphs: [st.label], role: "heading", base: this.sz("stepLabel"), bold: true, lineHeight: 1.15 }).height; }));
        steps.forEach((st, i) => {
          const s = this.span(i * perCols, perCols);
          const inner = { x: s.x, width: s.width - this.ds.gutter };
          out.push(this.text({ name: "Step", rect: { x: inner.x, y: y0, width: numBox, height: numBox }, paragraphs: [String(i + 1)], role: "heading", base: numSize, bold: true, color: this.accent, exactSize: numSize, valign: "middle", align: "left", lineHeight: 1 }).node);
          if (i < n - 1) {
            const next = this.span((i + 1) * perCols, perCols);
            const x0 = inner.x + numBox + u;
            const x1 = next.x - u;
            if (x1 > x0) out.push(this.rect("Sequence", { x: x0, y: lineY, width: x1 - x0, height: this.ds.rule }, lineColor));
          }
          const ly = y0 + numBox + u * 2;
          const label = this.text({ name: "Label", rect: { x: inner.x, y: ly, width: inner.width, height: u * 8 }, paragraphs: [st.label], role: "heading", base: this.sz("stepLabel"), bold: true, lineHeight: 1.15 });
          out.push(label.node);
          let b = ly + Math.max(label.height, labelH);
          if (st.detail) {
            const dy = b + u;
            const det = this.text({ name: "Detail", rect: { x: inner.x, y: dy, width: inner.width, height: Math.max(u * 4, this.bodyBottom - dy) }, paragraphs: [st.detail], role: "body", base: this.sz("detail"), color: this.muted, lineHeight: 1.4 });
            out.push(det.node);
            b = dy + det.height;
          }
          bottom = Math.max(bottom, b);
        });
        return { nodes: out, height: bottom - y0 };
      };
      const rowH = build(0).height;
      const avail = this.bodyBottom - bodyTop;
      this.nodes.push(...build(bodyTop + Math.min(u * 8, Math.max(0, Math.round((avail - rowH) / 2)))).nodes);
    } else {
      // Five steps: a numbered list down the page.
      const items = steps.map((st) => `${st.label}${st.detail ? `: ${st.detail}` : ""}`);
      this.nodes.push(this.text({ name: "Steps", rect: { ...this.span(0, 10), y: bodyTop, height: this.bodyBottom - bodyTop }, paragraphs: items, role: "body", base: this.sz("point"), lineHeight: 1.35, paraGap: 0.7, list: "number" }).node);
    }
    this.furniture();
  }

  private quote(): void {
    const q = this.item.quote!;
    const u = this.ds.unit;
    const region = this.span(1, 10);
    // The opening mark is set as its own object at display scale: it is the
    // form's signature, not punctuation inside the text.
    const markSize = Math.round(this.H * 0.2);
    this.cluster(region, [
      { kind: "text", maxFrac: 0.2, make: (r) => this.text({ name: "Mark", rect: { ...r, height: Math.round(markSize * 0.75) }, paragraphs: ["“"], role: "heading", base: markSize, bold: true, color: this.accent, exactSize: markSize, lineHeight: 0.75 }) },
      { kind: "text", maxFrac: 0.55, make: (r) => this.text({ name: "Quote", rect: r, paragraphs: [q.text], role: "heading", base: this.sz("quote"), lineHeight: 1.2 }) },
      ...(q.attribution ? [{ kind: "text" as const, maxFrac: 0.15, make: (r: Rect) => this.text({ name: "Attribution", rect: r, paragraphs: [q.attribution!], role: "body", base: this.sz("attribution"), color: this.muted }) }] : []),
    ], 2.5);
    void u;
    this.furniture();
  }

  private imageCaption(): void {
    if (this.compact) {
      // A square or portrait page: the picture across the top, bleeding to
      // three edges, and the words beneath it at full width. The four-column
      // text slot of the side-by-side form held a title in six lines here.
      const drawing = this.namedIllustration;
      const u = this.ds.unit;
      const picH = Math.round(this.H * 0.48);
      if (drawing) {
        const ill = this.illustration(drawing, { x: this.m, y: this.m, width: this.W - 2 * this.m, height: picH - this.m - u });
        if (ill) this.nodes.push(ill);
      } else {
        this.nodes.push(this.imageSlot({ x: 0, y: 0, width: this.W, height: picH }, this.imagePrompt()));
      }
      const top = picH + u * 3;
      this.cluster({ x: this.m, y: top, width: this.W - 2 * this.m, height: this.bodyBottom - top }, [
        ...this.eyebrowBlock(),
        { kind: "rule" },
        this.titleBlock(this.sz("title") * 0.95),
        ...this.subheadBlock(this.sz("caption"), this.item.subhead ?? this.item.points[0]),
      ], 2.5, false);
      // The band would sit on the picture; the eyebrow is in the cluster.
      this.furniture(undefined, { band: false });
      return;
    }
    // The picture carries the slide: it bleeds to three edges on the leading
    // side and the words take the trailing column on paper.
    const imageLeading = this.ctx.index % 2 === 0;
    const imgCols = 7;
    const s = imageLeading ? this.span(0, imgCols) : this.span(12 - imgCols, imgCols);
    const imgRect = imageLeading
      ? { x: 0, y: 0, width: s.x + s.width - this.ds.gutter / 2, height: this.H }
      : { x: s.x - this.ds.gutter / 2, y: 0, width: this.W - s.x + this.ds.gutter / 2, height: this.H };
    const drawing = this.namedIllustration;
    const ill = drawing ? this.illustration(drawing, { x: s.x, y: this.m + this.ds.unit * 2, width: s.width, height: this.H - 2 * this.m - this.ds.unit * 4 }) : null;
    if (ill) this.nodes.push(ill);
    else this.nodes.push(this.imageSlot(imgRect, this.imagePrompt()));
    const textSpan = imageLeading ? this.span(8, 4) : this.span(0, 4);
    const u = this.ds.unit;
    this.cluster({ ...textSpan, y: this.top, height: this.bodyBottom - this.top }, [
      { kind: "rule" },
      this.titleBlock(this.sz("title") * 0.95),
      ...this.subheadBlock(this.sz("caption"), this.item.subhead ?? this.item.points[0]),
    ], 2.5);
    // Kicker and page number stay in the text column, off the picture.
    this.furniture({ x: textSpan.x, width: textSpan.width });
  }

  private chart(): void {
    const c = this.item.chart!;
    const u = this.ds.unit;
    const top = this.top;
    const title = this.text({ name: "Title", rect: { ...this.span(0, 8), y: top, height: this.H * 0.18 }, paragraphs: [this.item.title], role: "heading", base: this.sz("title"), bold: false, lineHeight: 1.08 });
    this.nodes.push(title.node);
    let y = top + title.height + u * 1.5;
    if (this.item.subhead) {
      const take = this.text({ name: "Takeaway", rect: { ...this.span(0, 8), y, height: u * 8 }, paragraphs: [this.item.subhead], role: "body", base: this.sz("caption"), color: this.muted });
      this.nodes.push(take.node);
      y += take.height + u * 3;
    } else {
      y += u * 2;
    }
    const r = this.mirror({ ...this.span(0, 12), y, height: this.bodyBottom - y });
    const palette = [this.ds.colors.accentOnPaper, this.ds.colors.primary, this.ds.colors.deep];
    this.nodes.push(createNode("chart", {
      name: "Chart",
      chartType: c.kind,
      categories: [...c.categories],
      series: c.series.map((s, i) => ({ name: s.name, values: [...s.values], color: structuredClone(palette[i % palette.length]) })),
      options: {},
      // Chart text scales from one base size; the renderers' built-in 11px
      // is fine print on a 1920-wide slide. Bars and lines carry their
      // values, a legend only when there is more than one series.
      style: {
        fontSize: Math.round(this.sz("caption") * 0.85),
        valueLabels: c.kind === "bar" || c.kind === "line",
        legend: { show: c.series.length > 1, position: "bottom" },
        axes: { showX: true, showY: c.kind === "bar" || c.kind === "line" },
      },
      transform: { x: r.x, y: r.y, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: r.width, height: r.height },
    } as never) as Node);
    this.furniture();
  }

  /** n equal cells across the content width, gutter between them. */
  private cells(n: number, y: number, height: number): Rect[] {
    const g = this.ds.gutter;
    const w = (this.W - 2 * this.m - g * (n - 1)) / n;
    return Array.from({ length: n }, (_, i) => ({ x: this.m + i * (w + g), y, width: w, height }));
  }

  /** Where the body of a reading page must end: above the footer band. */
  private get bodyBottom(): number {
    return this.H - this.ds.unit * 6;
  }

  /** A standalone page (a social post, a poster): no footer, no page number,
   *  since there is no deck for them to place the page in. */
  private get isPost(): boolean {
    return this.ctx.designType === "social-set" || this.ctx.designType === "poster";
  }

  /** A portrait page: the side-by-side forms stack, picture above the words,
   *  since a column a third of a portrait page's width holds three words. */
  private get portrait(): boolean {
    return this.W < this.H;
  }

  /** Square or portrait: a caption page's four-column text slot is too narrow
   *  to carry a title, so the picture goes above the words. */
  private get compact(): boolean {
    return this.W / this.H < 1.3;
  }

  /** The picture or drawing across the top of a stacked impact page, and the
   *  region the words take beneath it. */
  private stackedPicture(drawing: string | null, hasImage: boolean): Rect {
    const u = this.ds.unit;
    const picH = Math.round(this.H * 0.46);
    if (drawing) {
      const ill = this.illustration(drawing, { x: this.m, y: this.m + u * 2, width: this.W - 2 * this.m, height: picH - this.m - u * 2 });
      if (ill) this.nodes.push(ill);
    } else if (hasImage) {
      this.nodes.push(this.imageSlot({ x: 0, y: 0, width: this.W, height: picH }, this.imagePrompt()));
    }
    const top = picH + u * 3;
    return { x: this.m, y: top, width: this.W - 2 * this.m, height: this.bodyBottom - top };
  }

  /** The title at the top of a reading page; returns where the body starts
   *  and how much height is left for it above the footer. */
  private headed(): { bodyTop: number; bodyH: number } {
    const u = this.ds.unit;
    const top = this.top;
    const title = this.text({ name: "Title", rect: { ...this.span(0, 12), y: top, height: this.H * 0.2 }, paragraphs: [this.item.title], role: "heading", base: this.sz("title"), bold: false, lineHeight: 1.08 });
    this.nodes.push(title.node);
    const bodyTop = top + title.height + u * 4;
    return { bodyTop, bodyH: this.bodyBottom - bodyTop };
  }

  /** Two to four figures that belong together: one row, or two by two for
   *  four, each figure on its own accent rule with its label beneath. */
  private kpiGrid(): void {
    const stats = (this.item.stats ?? []).slice(0, 4);
    const u = this.ds.unit;
    const { bodyTop, bodyH } = this.headed();
    const perRow = stats.length === 4 ? 2 : stats.length;
    const rows = stats.length === 4 ? 2 : 1;
    let figureH = Math.round(this.sz("kpiFigure"));
    // Icons are all or nothing across the grid, as on column pages.
    const glyphs = stats.map((st) => iconGlyphFor(st.icon));
    const withIcons = glyphs.length > 0 && glyphs.every((g) => !!g);
    const iconSize = Math.round(this.sz("icon"));
    const iconH = withIcons ? iconSize + u * 1.5 : 0;
    const build = (y0: number) => {
      const out: Node[] = [];
      let bottom = y0;
      for (let r = 0; r < rows; r++) {
        const rowStats = stats.slice(r * perRow, (r + 1) * perRow);
        // Measure the row's tallest label first so every row sits on one grid.
        const cellsR = this.cells(rowStats.length, 0, figureH);
        let labelH = 0;
        rowStats.forEach((st, i) => {
          labelH = Math.max(labelH, this.text({ name: "Label", rect: { x: cellsR[i].x, y: 0, width: cellsR[i].width - u * 6, height: u * 8 }, paragraphs: [st.label], role: "heading", base: this.sz("statLabel") * (rows > 1 ? 0.85 : 1), bold: true, lineHeight: 1.2 }).height);
        });
        const rowTop = bottom + (r > 0 ? u * 3 : 0);
        const pad = u * 3;
        // The figures are fitted first: a row's numerals share the height of
        // the tallest, so the rule, the figure and the label stack on what the
        // glyphs measure and not on the box they were offered.
        const cw = cellsR[0].width - 2 * pad;
        // A row's numerals share one size, the largest at which every figure
        // in the row holds its line, so "4,120" and "$310k" sit at one scale.
        const rowSize = Math.min(...rowStats.map((st) => this.numeral({ x: 0, y: 0, width: cw, height: figureH }, st.value, st.unit, this.accentInk, figureH).size));
        const figH = rowSize;
        const contentH = iconH + u * 2 + figH + u * 1.5 + labelH;
        rowStats.forEach((st, i) => {
          const c = cellsR[i];
          // The cell's panel first, then its content inset by the padding.
          out.push(this.panel({ x: c.x, y: rowTop, width: c.width, height: contentH + 2 * pad }));
          const cx = c.x + pad;
          const cy = rowTop + pad;
          if (withIcons) {
            const ic = this.icon(glyphs[r * perRow + i]!, cx, cy, iconSize, this.accent);
            if (ic) out.push(ic);
          }
          const ruleY = cy + iconH;
          out.push(this.accentRule(cx, ruleY));
          const fig = this.numeral({ x: cx, y: ruleY + u * 2, width: cw, height: figH }, st.value, st.unit, this.accentInk, rowSize);
          out.push(fig.node);
          out.push(this.text({ name: "Label", rect: { x: cx, y: ruleY + u * 2 + figH + u * 1.5, width: cw, height: labelH }, paragraphs: [st.label], role: "heading", base: this.sz("statLabel") * (rows > 1 ? 0.85 : 1), bold: true, lineHeight: 1.2 }).node);
        });
        bottom = rowTop + contentH + 2 * pad;
      }
      return { nodes: out, height: bottom - y0 };
    };
    // Two rows of figures with icons and labels can outgrow the page; the
    // figures step down until the grid fits above the footer, and if that is
    // not enough the row gap and the panel padding tighten too.
    let h = build(0).height;
    while (h > bodyH && figureH > u * 4) {
      figureH -= u;
      h = build(0).height;
    }
    this.nodes.push(...build(bodyTop + Math.min(u * 8, Math.max(0, Math.round((bodyH - h) / 2)))).nodes);
    this.furniture();
  }

  /** A dated sequence: markers on one line, the time above each, the label
   *  and detail beneath. Segments are drawn between the markers, never
   *  through them. */
  private timeline(): void {
    const steps = (this.item.steps ?? []).slice(0, 5);
    const u = this.ds.unit;
    const { bodyTop, bodyH } = this.headed();
    // With an icon on every step the markers are the icons; otherwise dots.
    const glyphs = steps.map((st) => iconGlyphFor(st.icon));
    const withIcons = glyphs.length > 0 && glyphs.every((g) => !!g);
    const dot = withIcons ? Math.round(this.sz("icon")) : Math.round(u * 2.2);
    const lineColor = mix(this.ds.colors.ink, this.ds.colors.paper, 0.8);
    const build = (y0: number) => {
      const out: Node[] = [];
      const cellsR = this.cells(steps.length, 0, 0);
      // The time markers share one height so every dot sits on one line.
      let whenH = 0;
      steps.forEach((st, i) => {
        if (st.when) whenH = Math.max(whenH, this.text({ name: "When", rect: { x: cellsR[i].x, y: 0, width: cellsR[i].width, height: u * 6 }, paragraphs: [st.when], role: "heading", base: this.sz("timelineWhen"), bold: true, color: this.muted, align: "center", lineHeight: 1.2, mono: this.look.monoLabels }).height);
      });
      const lineY = y0 + (whenH ? whenH + u * 2 : 0);
      // Labels share one height too, so every detail starts on the same row
      // even when one label wraps.
      const labelH = Math.max(0, ...steps.map((st, i) => this.text({ name: "Label", rect: { x: cellsR[i].x, y: 0, width: cellsR[i].width, height: u * 8 }, paragraphs: [st.label], role: "heading", base: this.sz("stepLabel"), bold: true, align: "center", lineHeight: 1.15 }).height));
      let bottom = lineY + dot;
      steps.forEach((st, i) => {
        const c = cellsR[i];
        const cx = c.x + c.width / 2;
        if (st.when) out.push(this.text({ name: "When", rect: { x: c.x, y: y0, width: c.width, height: whenH }, paragraphs: [st.when], role: "heading", base: this.sz("timelineWhen"), bold: true, color: this.muted, align: "center", lineHeight: 1.2, mono: this.look.monoLabels, exactSize: Math.round(this.sz("timelineWhen")) }).node);
        if (withIcons) {
          const ic = this.icon(glyphs[i]!, Math.round(cx - dot / 2), lineY, dot, this.accent);
          if (ic) { (ic as unknown as { name: string }).name = "Marker"; out.push(ic); }
        } else {
          out.push(this.rect("Marker", { x: cx - dot / 2, y: lineY, width: dot, height: dot }, this.accent, Math.round(dot / 2)));
        }
        if (i < steps.length - 1) {
          const nx = cellsR[i + 1].x + cellsR[i + 1].width / 2;
          const x0 = cx + dot / 2 + u;
          const x1 = nx - dot / 2 - u;
          if (x1 > x0) out.push(this.rect("Sequence", { x: x0, y: lineY + Math.round(dot / 2) - Math.round(this.ds.rule / 2), width: x1 - x0, height: this.ds.rule }, lineColor));
        }
        const ly = lineY + dot + u * 2;
        const label = this.text({ name: "Label", rect: { x: c.x, y: ly, width: c.width, height: u * 8 }, paragraphs: [st.label], role: "heading", base: this.sz("stepLabel"), bold: true, align: "center", lineHeight: 1.15 });
        out.push(label.node);
        let b = ly + Math.max(label.height, labelH);
        if (st.detail) {
          const dy = b + u;
          const det = this.text({ name: "Detail", rect: { x: c.x, y: dy, width: c.width, height: Math.max(u * 4, this.bodyBottom - dy) }, paragraphs: [st.detail], role: "body", base: this.sz("detail"), color: this.muted, align: "center", lineHeight: 1.4 });
          out.push(det.node);
          b = dy + det.height;
        }
        bottom = Math.max(bottom, b);
      });
      return { nodes: out, height: bottom - y0 };
    };
    const h = build(0).height;
    this.nodes.push(...build(bodyTop + Math.min(u * 8, Math.max(0, Math.round((bodyH - h) / 2)))).nodes);
    this.furniture();
  }

  /** A small table of real values: a tinted header row, rules between rows,
   *  numbers set flush right. Type steps up until a short table fills most of
   *  the body and down until a long one fits. */
  private table(): void {
    const tb = this.item.table!;
    const u = this.ds.unit;
    const { bodyTop, bodyH } = this.headed();
    const rows = tb.rows.length + 1;
    const cols = tb.columns.length;
    const width = this.W - 2 * this.m;
    // A cell wraps like a paragraph in every renderer, six in from each
    // edge and set in the system face, which the estimate does not know,
    // hence the allowance. Each row is as tall as its longest cell needs:
    // one line sits in 2.6 em, every further line adds 1.25 em.
    const colW = Math.round(width / cols);
    const avail = colW - 12 - colW * 0.06;
    const cellLines = (text: string, size: number, role: "heading" | "body") => this.lines(text, size, avail, role);
    const rowHeightsAt = (size: number) => {
      const head = Math.max(1, ...tb.columns.map((c) => cellLines(c, size, "heading")));
      const body = tb.rows.map((row) => Math.max(1, ...row.map((c) => cellLines(c ?? "", size, "body"))));
      return [head, ...body].map((n) => Math.round(size * 2.6 + (n - 1) * size * 1.25));
    };
    const total = (size: number) => rowHeightsAt(size).reduce((a, b) => a + b, 0);
    // A word no line can hold runs past the cell; the type steps down first.
    const longest = this.longestChunk([...tb.columns, ...tb.rows.flat()]);
    const wordFits = (size: number) => longest * ADVANCE.body * size <= avail;
    let size = Math.round(this.sz("tableCell"));
    // The type steps up until a short table fills most of the body, capped,
    // and down until a long one fits above the footer.
    const cap = Math.round(this.sz("tableCell") * 1.35);
    while (size < cap && total(size + 1) <= bodyH * 0.9 && wordFits(size + 1)) size += 1;
    while (size > 12 && (total(size) > bodyH || !wordFits(size))) size -= 1;
    const rowHeights = rowHeightsAt(size);
    const height = rowHeights.reduce((a, b) => a + b, 0);
    const r = this.mirror({ x: this.m, y: bodyTop + Math.min(u * 8, Math.max(0, Math.round((bodyH - height) / 2))), width, height });
    // A column is set flush right when every one of its values is a number
    // (a unit or currency mark allowed), and the header follows its column;
    // the first column is the row's label and always reads from the left.
    const numeric = /^[\s\d.,%+\-$€£]+(?:\s?[a-zA-Z%]{1,3})?$/;
    const rightAligned = tb.columns.map((_, ci) => ci > 0 && tb.rows.every((row) => numeric.test(row[ci] ?? "") && (row[ci] ?? "").trim() !== ""));
    const cells: unknown[] = [];
    const push = (row: number, col: number, text: string, header: boolean) => {
      cells.push({
        row, col, rowSpan: 1, colSpan: 1,
        align: rightAligned[col] ? "right" : "left",
        content: [{ text, fontId: "system", fontSize: size, weight: header ? 700 : 400, color: structuredClone(this.ink) }],
      });
    };
    tb.columns.forEach((c, i) => push(0, i, c, true));
    tb.rows.forEach((row, ri) => row.forEach((c, ci) => push(ri + 1, ci, c, false)));
    this.nodes.push(createNode("table", {
      name: "Table",
      transform: { x: r.x, y: r.y, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: r.width, height: r.height },
      rows, cols,
      colWidths: Array.from({ length: cols }, () => colW),
      rowHeights,
      cells,
      headerStyle: { enabled: true, fill: { type: "solid", color: structuredClone(this.ds.colors.tint) }, textColor: structuredClone(this.ink), bold: true },
      borderStyle: { show: true, color: structuredClone(mix(this.ds.colors.ink, this.ds.colors.paper, 0.8)), width: Math.max(1, Math.round(u * 0.12)) },
    } as never) as Node);
    void u;
    this.furniture();
  }

  /** The people on a team: a monogram in the accent on its own rule, the
   *  name and the role beneath. No portraits are generated for named people. */
  private team(): void {
    const people = (this.item.people ?? []).slice(0, 4);
    const u = this.ds.unit;
    const { bodyTop, bodyH } = this.headed();
    const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((w) => Array.from(w)[0]?.toUpperCase() ?? "").join("");
    const monoH = Math.round(this.sz("monogram") * 1.15);
    const build = (y0: number) => {
      const out: Node[] = [];
      const cellsR = this.cells(people.length, 0, 0);
      let bottom = y0;
      const pad = u * 3;
      const cards: Node[][] = [];
      // Names share one height so every role starts on the same row.
      const nameH = Math.max(0, ...people.map((per, i) => this.text({ name: "Name", rect: { x: cellsR[i].x + pad, y: 0, width: cellsR[i].width - 2 * pad, height: u * 8 }, paragraphs: [per.name], role: "heading", base: this.sz("personName"), bold: true, lineHeight: 1.15 }).height));
      people.forEach((per, i) => {
        const c = cellsR[i];
        const card: Node[] = [];
        const cx = c.x + pad;
        const cw = c.width - 2 * pad;
        const cy = y0 + pad;
        card.push(this.accentRule(cx, cy));
        card.push(this.text({ name: "Monogram", rect: { x: cx, y: cy + u * 2, width: cw, height: monoH }, paragraphs: [initials(per.name)], role: "heading", base: this.sz("monogram"), bold: true, color: this.accentInk, exactSize: Math.round(this.sz("monogram")), lineHeight: 1.15, tracking: 0.04 }).node);
        const ny = cy + u * 2 + monoH + u * 1.5;
        const name = this.text({ name: "Name", rect: { x: cx, y: ny, width: cw, height: u * 8 }, paragraphs: [per.name], role: "heading", base: this.sz("personName"), bold: true, lineHeight: 1.15 });
        card.push(name.node);
        let b = ny + Math.max(name.height, nameH);
        if (per.role) {
          const ry = b + u * 0.5;
          const role = this.text({ name: "Role", rect: { x: cx, y: ry, width: cw, height: u * 8 }, paragraphs: [per.role], role: "body", base: this.sz("personRole"), color: this.muted, lineHeight: 1.35 });
          card.push(role.node);
          b = ry + role.height;
        }
        bottom = Math.max(bottom, b);
        cards.push(card);
      });
      // Every card is as tall as the tallest, on its own panel.
      const panelH = bottom - y0 + pad;
      cards.forEach((card, i) => out.push(this.panel({ x: cellsR[i].x, y: y0, width: cellsR[i].width, height: panelH }), ...card));
      return { nodes: out, height: panelH };
    };
    const h = build(0).height;
    this.nodes.push(...build(bodyTop + Math.min(u * 8, Math.max(0, Math.round((bodyH - h) / 2)))).nodes);
    this.furniture();
  }

  /** A bespoke page: the model's cells on a 12-column by 6-row grid, each
   *  set in the deck's own type and colour, with arrows where it asked for
   *  them. The grid keeps it honest: the normalizer dropped anything that
   *  overlapped or left the grid, so nothing here collides or leaves the
   *  page. A cell with a tone sits on its own panel and takes that panel's
   *  inks. */
  private composition(): void {
    const comp = this.item.composition!;
    const u = this.ds.unit;
    const g = this.ds.gutter;
    const c = this.ds.colors;
    const bodyTop = this.top;
    const bodyH = this.bodyBottom - bodyTop;
    const colW = (this.W - 2 * this.m - g * 11) / 12;
    const rowH = (bodyH - g * 5) / 6;
    const rects: Rect[] = comp.cells.map((cell) => ({
      x: this.m + cell.col * (colW + g),
      y: bodyTop + cell.row * (rowH + g),
      width: cell.span * colW + (cell.span - 1) * g,
      height: cell.rows * rowH + (cell.rows - 1) * g,
    }));
    // A link is drawn only between cells that touch on the grid, to the
    // right or below, so an arrow never crosses a third cell. The source
    // cell gives up four units on the side that faces its target, and the
    // arrow takes that room.
    const links = comp.links ?? [];
    const arrows: { from: number; to: number; dir: "right" | "down" }[] = [];
    for (const [from, to] of links) {
      const a = comp.cells[from];
      const b = comp.cells[to];
      if (!a || !b) continue;
      const rowsTouch = a.row < b.row + b.rows && a.row + a.rows > b.row;
      const colsTouch = a.col < b.col + b.span && a.col + a.span > b.col;
      if (b.col === a.col + a.span && rowsTouch) {
        rects[from] = { ...rects[from], width: Math.max(u * 4, rects[from].width - u * 4) };
        arrows.push({ from, to, dir: "right" });
      } else if (b.row === a.row + a.rows && colsTouch) {
        rects[from] = { ...rects[from], height: Math.max(u * 4, rects[from].height - u * 4) };
        arrows.push({ from, to, dir: "down" });
      }
    }
    const pad = u * 2.5;
    const inkOn = (ground: Color) => (contrastRatio(WHITE_INK, ground) >= contrastRatio(BLACK_INK, ground) ? WHITE_INK : BLACK_INK);
    comp.cells.forEach((cell, i) => {
      const r = rects[i];
      const tone = cell.tone ?? "plain";
      let ink = this.ink;
      let muted = this.muted;
      let accentInk = this.accentInk;
      let accent = this.accent;
      if (tone === "deep") {
        this.nodes.push(this.rect("Panel", r, c.deep, Math.round(this.ds.radius * 3), { panel: true }));
        ink = c.inkOnDeep; muted = c.mutedOnDeep; accentInk = c.accentInkOnDeep; accent = c.accentOnDeep;
      } else if (tone === "accent") {
        this.nodes.push(this.rect("Panel", r, accent, Math.round(this.ds.radius * 3), { panel: true }));
        ink = inkOn(accent); muted = mix(ink, accent, 0.25); accentInk = ink;
      } else if (tone === "tint") {
        this.nodes.push(this.panel(r));
      }
      const inner: Rect = tone === "plain" ? r : { x: r.x + pad, y: r.y + pad, width: r.width - 2 * pad, height: r.height - 2 * pad };
      const large = cell.span >= 6 && cell.rows >= 2;
      switch (cell.kind) {
        case "heading":
          this.nodes.push(this.text({ name: "Heading", rect: inner, paragraphs: [cell.text ?? ""], role: "heading", base: large ? this.sz("statement") : this.sz("colHead"), bold: !large, color: ink, lineHeight: 1.1 }).node);
          break;
        case "body":
          this.nodes.push(this.text({ name: "Body", rect: inner, paragraphs: [cell.text ?? ""], role: "body", base: this.sz("point"), color: ink, lineHeight: 1.4 }).node);
          break;
        case "list":
          this.nodes.push(this.text({ name: "Points", rect: inner, paragraphs: cell.points ?? [], role: "body", base: this.sz("point"), color: ink, lineHeight: 1.35, paraGap: 0.5, list: "bullet" }).node);
          break;
        case "label":
          this.nodes.push(this.text({ name: "Label", rect: inner, paragraphs: [cell.text ?? ""], role: "body", base: this.sz("eyebrow"), color: accentInk, exactSize: Math.round(this.sz("eyebrow")), tracking: 0.18, lineHeight: 1.2 }).node);
          break;
        case "figure": {
          // The numeral's box is the room it was offered (its glyphs sit on
          // the box's bottom edge), so the label starts under that box.
          const figH = Math.round(cell.text ? inner.height * 0.6 : inner.height);
          const fig = this.numeral({ x: inner.x, y: inner.y, width: inner.width, height: figH }, cell.value ?? "", cell.unit, accentInk, Math.min(this.sz("numeral"), figH));
          this.nodes.push(fig.node);
          if (cell.text) this.nodes.push(this.text({ name: "Label", rect: { x: inner.x, y: inner.y + figH + u, width: inner.width, height: Math.max(u * 2, inner.height - figH - u) }, paragraphs: [cell.text], role: "heading", base: this.sz("statLabel"), bold: true, color: ink, lineHeight: 1.2 }).node);
          break;
        }
        case "icon": {
          const glyph = iconGlyphFor(cell.icon);
          if (!glyph) break;
          const size = Math.round(Math.min(inner.width, inner.height, this.sz("icon") * 2));
          const ic = this.icon(glyph, Math.round(inner.x + (inner.width - size) / 2), Math.round(inner.y + (inner.height - size) / 2), size, accent);
          if (ic) this.nodes.push(ic);
          break;
        }
        case "picture": {
          const drawing = this.namedIllustration;
          const ill = drawing ? this.illustration(drawing, inner) : null;
          if (ill) this.nodes.push(ill);
          else this.nodes.push(this.imageSlot(r, this.imagePrompt(), Math.round(this.ds.radius * 3)));
          break;
        }
      }
    });
    // Arrows in the room the source cells gave up.
    const lineColor = mix(this.ink, this.ground, 0.5);
    for (const ar of arrows) {
      const a = rects[ar.from];
      const b = rects[ar.to];
      if (ar.dir === "right") {
        const y = Math.round(Math.max(a.y, b.y) + (Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)) / 2);
        const x0 = a.x + a.width + u * 0.5;
        const x1 = b.x - u * 0.5;
        if (x1 - x0 > u) {
          this.nodes.push(this.rect("Sequence", { x: x0, y: y - Math.round(this.ds.rule / 2), width: x1 - x0 - u, height: this.ds.rule }, lineColor));
          this.nodes.push(this.arrowHead(x1, y, u * 1.2, "right", lineColor));
        }
      } else {
        const x = Math.round(Math.max(a.x, b.x) + (Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) / 2);
        const y0 = a.y + a.height + u * 0.5;
        const y1 = b.y - u * 0.5;
        if (y1 - y0 > u) {
          this.nodes.push(this.rect("Sequence", { x: x - Math.round(this.ds.rule / 2), y: y0, width: this.ds.rule, height: y1 - y0 - u }, lineColor));
          this.nodes.push(this.arrowHead(x, y1, u * 1.2, "down", lineColor));
        }
      }
    }
    this.furniture();
  }

  /** A small filled triangle at the tip of a connector. Ornament to the
   *  quality loop, like a decor disc: it sits in a gutter and never counts
   *  as an overlap. */
  private arrowHead(x: number, y: number, size: number, dir: "right" | "down", color: Color): Node {
    const s = Math.round(size);
    const pts = dir === "right" ? [{ x: 0, y: 0 }, { x: s, y: s / 2 }, { x: 0, y: s }] : [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s / 2, y: s }];
    const r = this.mirror(dir === "right" ? { x: x - s, y: y - s / 2, width: s, height: s } : { x: x - s / 2, y: y - s, width: s, height: s });
    return createNode("path", {
      name: "Arrow",
      transform: { x: r.x, y: r.y, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: s, height: s },
      segments: pts,
      closed: true,
      fills: [{ type: "solid", color: structuredClone(color) }],
      data: { decor: true },
    } as never) as Node;
  }

  private closing(): void {
    const drawing = this.namedIllustration;
    const hasImage = !!this.item.image && !drawing;
    if (this.portrait && (drawing || hasImage)) {
      this.cluster(this.stackedPicture(drawing, hasImage), [
        ...this.eyebrowBlock(),
        { kind: "rule" },
        this.titleBlock(this.sz("sectionTitle")),
        ...this.subheadBlock(this.sz("coverSub"), this.item.subhead ?? this.item.points[0], this.ink),
      ], 3, false);
      this.furniture();
      return;
    }
    if (this.look.cover === "typographic" && !hasImage) { this.typographicImpact("closing", drawing); return; }
    if (this.look.cover === "field") { this.fieldImpact("closing", drawing, hasImage); return; }
    if (drawing) {
      const s = this.span(7, 5);
      const u = this.ds.unit;
      const ill = this.illustration(drawing, { x: s.x, y: this.m + u * 2, width: s.width, height: this.H - 2 * this.m - u * 4 });
      if (ill) this.nodes.push(ill);
    } else if (hasImage) {
      const s = this.span(8, 4);
      this.nodes.push(this.imageSlot({ x: s.x, y: 0, width: this.W - s.x, height: this.H }, this.imagePrompt()));
    }
    if (!hasImage && !drawing) this.decor(this.span(8, 4));
    const region = this.span(0, hasImage ? 7 : drawing ? 6 : 8);
    this.cluster(region, [
      ...this.eyebrowBlock(),
      { kind: "rule" },
      this.titleBlock(this.sz("sectionTitle")),
      ...this.subheadBlock(this.sz("coverSub"), this.item.subhead ?? this.item.points[0], this.ink),
    ], 3);
    this.furniture(hasImage ? { x: region.x, width: region.width } : undefined);
  }
}

const WHITE_INK: Color = { srgb: { r: 1, g: 1, b: 1, a: 1 } };
const BLACK_INK: Color = { srgb: { r: 0, g: 0, b: 0, a: 1 } };

function mix(a: Color, b: Color, t: number): Color {
  const l = (x: number, y: number) => x + (y - x) * t;
  return { srgb: { r: l(a.srgb.r, b.srgb.r), g: l(a.srgb.g, b.srgb.g), b: l(a.srgb.b, b.srgb.b), a: 1 } };
}

/** Compose one outline page in its archetype's form. */
export function composeArchetypePage(item: OutlineItem, ds: DesignSystem, ctx: ComposeContext): ComposedPage {
  const a = (item.archetype ?? "bullets") as Archetype;
  return new Composer(ds, item, ctx, archetypeIsImpact(a)).compose();
}
