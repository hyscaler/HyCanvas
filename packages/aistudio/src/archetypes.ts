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

import { createNode, type Color, type Fill, type Node } from "@hc/schema";
import type { Archetype, OutlineItem } from "./outline";
import type { DesignSystem } from "./designSystem";
import type { PageVariant } from "./measure";
import { ladderFrom } from "./deckStyle";

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
  coverTitle: 0.1,
  coverSub: 0.036,
  sectionTitle: 0.075,
  statement: 0.068,
  statementSub: 0.03,
  numeral: 0.3,
  unit: 0.09,
  statLabel: 0.036,
  title: 0.058,
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
} as const;

// Average glyph advance as a fraction of the em, per role. Headings are set
// in a display face and wider; body in a text face.
const ADVANCE = { heading: 0.55, body: 0.5 } as const;

/** The list marker gutter the text engine reserves, in ems (layoutText). */
const LIST_GUTTER_EM = 1.6;

/** Join a heading's last two words with a no-break space so the final word
 *  never sits alone on the last line. Only when there are enough words that
 *  the join cannot force one overlong line: a two-word title is left as is. */
export function keepLastWordCompany(text: string): string {
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
  return text.slice(0, gap) + "\u00A0" + text.slice(word, end);
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

  private get ground(): Color {
    return this.impact ? this.ds.colors.deep : this.ds.colors.paper;
  }
  private get ink(): Color {
    return this.impact ? this.ds.colors.inkOnDeep : this.ds.colors.ink;
  }
  private get muted(): Color {
    return this.impact ? this.ds.colors.mutedOnDeep : this.ds.colors.mutedOnPaper;
  }
  private get accent(): Color {
    return this.impact ? this.ds.colors.accentOnDeep : this.ds.colors.accentOnPaper;
  }

  // --- measurement -----------------------------------------------------------

  private lines(text: string, size: number, width: number, role: "heading" | "body"): number {
    const perLine = Math.max(1, Math.floor(width / (size * ADVANCE[role])));
    let n = 0;
    for (const seg of text.split("\n")) n += Math.max(1, Math.ceil(Array.from(seg).length / perLine));
    return n;
  }

  /** The largest ladder size at which the paragraphs fit the region.
   *  gutterEm is the list marker gutter, in ems, taken off the wrap width. */
  private fit(paragraphs: string[], width: number, height: number, base: number, lineHeight: number, role: "heading" | "body", paraGap: number, gutterEm = 0): number {
    for (const size of ladderFrom(base, this.ds.size)) {
      if (this.measure(paragraphs, width, size, lineHeight, role, paraGap, gutterEm) <= height) return size;
    }
    const ladder = ladderFrom(base, this.ds.size);
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
  }): { node: Node; height: number; size: number } {
    const lineHeight = opts.lineHeight ?? (opts.role === "heading" ? 1.1 : 1.4);
    const paraGap = opts.paraGap ?? (opts.role === "heading" ? 0.2 : 0.45);
    // A heading never leaves its last word alone on the final line.
    const paragraphs = (opts.paragraphs.length ? opts.paragraphs : [""]).map((p) => (opts.role === "heading" ? keepLastWordCompany(p) : p));
    const gutterEm = opts.list ? LIST_GUTTER_EM : 0;
    const size = opts.exactSize ?? this.fit(paragraphs, opts.rect.width, opts.rect.height, opts.base, lineHeight, opts.role, paraGap, gutterEm);
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
      fontFamily: opts.role === "heading" ? this.ds.fonts.heading : this.ds.fonts.body,
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
  private numeral(rect: Rect, value: string, unit: string | undefined, color: Color): { node: Node; height: number } {
    const base = this.H * T.numeral;
    const size = this.fit([value + (unit ? " " + unit : "")], rect.width, rect.height, base, 1.0, "heading", 0);
    const r = this.mirror(rect);
    const runStyle = (fontSize: number) => ({
      fontFamily: this.ds.fonts.heading,
      fontStyle: "Bold",
      fontSize,
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
    return { node, height: Math.ceil(size * 1.0) };
  }

  private rect(name: string, r0: Rect, fill: Color, radius = 0, data?: Record<string, unknown>): Node {
    const r = this.mirror(r0);
    return createNode("shape", {
      name,
      shape: "rect",
      transform: { x: r.x, y: r.y, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: r.width, height: r.height },
      fills: [{ type: "solid", color: structuredClone(fill) }],
      cornerRadius: radius,
      ...(data ? { data } : {}),
    } as never) as Node;
  }

  /** The accent rule: the deck's one repeated mark. Short, above a heading. */
  private accentRule(x: number, y: number): Node {
    const w = this.ds.unit * 8;
    return this.rect("Accent", { x, y, width: w, height: this.ds.rule }, this.accent, Math.round(this.ds.rule / 2));
  }

  /** A picture region: the same neutral stand-in the editor materializes for
   *  a picture slot, tagged so the image pipeline finds it by placeholder id
   *  and replaces it wholesale when the picture lands. */
  private imageSlot(r: Rect, prompt: string, radius = 0): Node {
    this.slotSeq += 1;
    const id = `img-${this.ctx.index + 1}-${this.slotSeq}`;
    this.prompts[id] = prompt;
    // On the deep ground a slightly lifted panel; on paper the system's tint.
    const fill = this.impact ? mix(this.ds.colors.deep, this.ds.colors.inkOnDeep, 0.1) : this.ds.colors.tint;
    return this.rect("Image", r, fill, radius, { placeholderId: id, aiImagePrompt: prompt });
  }

  /** What the picture should show, in the deck's treatment. Falls back to the
   *  slide's own subject when the outline named no image, so a form that
   *  needs a picture (cover, imageCaption) always gets a usable prompt. */
  private imagePrompt(): string {
    const im = this.item.image;
    const treatment = im?.treatment ?? "photo";
    const subject = im?.subject || this.item.title;
    const style =
      treatment === "illustration" ? "flat editorial illustration, limited palette, no text" :
      treatment === "abstract" ? "abstract composition, soft forms, no text" :
      "clean professional photography, natural light, no text";
    return `${subject}, ${style}`;
  }

  /** Reading-page furniture: the deck title small at the top, the page number
   *  small at the bottom. Impact pages stay quiet. */
  private furniture(region?: { x: number; width: number }): void {
    const u = this.ds.unit;
    const x0 = region?.x ?? this.m;
    const w0 = region?.width ?? this.W - 2 * this.m;
    if (!this.impact && this.ds.kicker) {
      const kicker = this.text({
        name: "Kicker", rect: { x: x0, y: u * 2.5, width: w0, height: u * 3 },
        paragraphs: [this.ds.kicker], role: "body", base: this.H * T.kicker, color: this.muted, exactSize: Math.round(this.H * T.kicker),
      });
      this.nodes.push(kicker.node);
    }
    if (this.item.archetype !== "cover") {
      const n = this.text({
        name: "Page number", rect: { x: x0 + w0 - u * 8, y: this.H - u * 4.5, width: u * 8, height: u * 3 },
        paragraphs: [String(this.ctx.index + 1)], role: "body", base: this.H * T.pageNumber, color: this.muted,
        align: this.ds.dir === "rtl" ? "left" : "right", exactSize: Math.round(this.H * T.pageNumber),
      });
      this.nodes.push(n.node);
    }
  }

  /** Measure-then-place a vertical cluster of text blocks inside a region,
   *  centered when it is shorter than the region. Each block is measured at
   *  the size it fits at, so the cluster's height is honest before anything
   *  is placed. */
  private cluster(region: Rect, blocks: Array<{ kind: "rule" } | { kind: "text"; make: (rect: Rect) => { node: Node; height: number } ; maxFrac: number }>, gapUnits = 2, center = true): void {
    const u = this.ds.unit;
    // First pass: measure with each block offered its share of the region.
    const measured = blocks.map((b) => {
      if (b.kind === "rule") return { b, height: this.ds.rule, node: null as Node | null };
      const probe = b.make({ x: region.x, y: region.y, width: region.width, height: Math.max(u * 2, region.height * b.maxFrac) });
      return { b, height: probe.height, node: null as Node | null };
    });
    const total = measured.reduce((s, m) => s + m.height, 0) + gapUnits * u * (blocks.length - 1);
    let y = region.y + (center ? Math.max(0, Math.round((region.height - total) / 2)) : 0);
    for (const mrow of measured) {
      if (mrow.b.kind === "rule") {
        this.nodes.push(this.accentRule(region.x, y));
      } else {
        const made = mrow.b.make({ x: region.x, y, width: region.width, height: mrow.height });
        this.nodes.push(made.node);
      }
      y += mrow.height + gapUnits * u;
    }
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
      default: this.bullets(); break;
    }
    return {
      background: structuredClone(this.impact ? this.ds.impactBackground : this.ds.paperBackground),
      nodes: this.nodes,
      imagePrompts: this.prompts,
      impact: this.impact,
      archetype: a,
      overfull: Array.from(new Set(this.overfull)),
    };
  }

  private titleBlock(base: number, bold = true) {
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
    const hasImage = !!this.item.image;
    const textCols = hasImage ? 6 : 8;
    const region = this.span(0, textCols);
    if (hasImage) {
      // Half-bleed picture on the trailing side: to the page edges, not the
      // margins, so it reads as the ground the words sit against.
      const s = this.span(7, 5);
      this.nodes.push(this.imageSlot({ x: s.x, y: 0, width: this.W - s.x, height: this.H }, this.imagePrompt()));
    }
    this.cluster(region, [
      { kind: "rule" },
      this.titleBlock(this.H * T.coverTitle),
      ...this.subheadBlock(this.H * T.coverSub, this.item.subhead ?? this.item.points[0]),
    ], 3);
    this.furniture();
  }

  private section(): void {
    const hasImage = !!this.item.image;
    if (hasImage) {
      const s = this.span(8, 4);
      this.nodes.push(this.imageSlot({ x: s.x, y: 0, width: this.W - s.x, height: this.H }, this.imagePrompt()));
    }
    const region = this.span(0, hasImage ? 7 : 8);
    this.cluster(region, [
      { kind: "rule" },
      this.titleBlock(this.H * T.sectionTitle),
      ...this.subheadBlock(this.H * T.statementSub, this.item.subhead),
    ], 3);
    this.furniture(hasImage ? { x: region.x, width: region.width } : undefined);
  }

  private statement(): void {
    // One idea, set large, with room around it. The type is the visual.
    this.cluster(this.span(0, 10), [
      { kind: "rule" },
      { kind: "text", maxFrac: 0.6, make: (r) => this.text({ name: "Statement", rect: r, paragraphs: [this.item.title], role: "heading", base: this.H * T.statement, bold: true, lineHeight: 1.12 }) },
      ...this.subheadBlock(this.H * T.statementSub, this.item.subhead),
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
    const labelProbe = this.text({ name: "Label", rect: { x: left.x, y: 0, width: left.width, height: u * 12 }, paragraphs: [stat.label], role: "heading", base: this.H * T.statLabel, bold: true, lineHeight: 1.2 });
    const blockH = u * 3 + figureH + u * 2 + labelProbe.height;
    const areaTop = this.m + u * 4;
    const top = areaTop + u * 3 + Math.max(0, Math.round((this.H - this.m - areaTop - blockH) / 2));
    const figureRect = { x: left.x, y: top, width: left.width, height: figureH };
    const fig = this.numeral(figureRect, stat.value, stat.unit, this.ds.colors.accentOnPaper);
    this.nodes.push(this.accentRule(left.x, top - u * 3));
    this.nodes.push(fig.node);
    const labelY = top + figureRect.height + u * 2;
    const label = this.text({ name: "Label", rect: { x: left.x, y: labelY, width: left.width, height: u * 12 }, paragraphs: [stat.label], role: "heading", base: this.H * T.statLabel, bold: true, lineHeight: 1.2 });
    this.nodes.push(label.node);
    if (hasImage) {
      this.nodes.push(this.imageSlot({ x: rightCols.x, y: top, width: rightCols.width, height: labelY + label.height - top }, this.imagePrompt(), this.ds.radius * 2));
      if (this.item.subhead) {
        const ctxText = this.text({ name: "Context", rect: { x: left.x, y: labelY + label.height + u * 2, width: left.width, height: this.H - this.m - (labelY + label.height + u * 2) }, paragraphs: [this.item.subhead], role: "body", base: this.H * T.detail, color: this.muted });
        this.nodes.push(ctxText.node);
      }
    } else if (this.item.subhead) {
      const ctxText = this.text({ name: "Context", rect: { x: rightCols.x, y: top, width: rightCols.width, height: labelY + label.height - top }, paragraphs: [this.item.subhead], role: "body", base: this.H * T.caption, color: this.muted, valign: "bottom", lineHeight: 1.45 });
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
    const content = { ...region, y: this.m + u * 4, height: this.H - 2 * this.m - u * 4 };
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
      const title = this.text({ name: "Title", rect: { ...this.span(0, 12), y: content.y, height: this.H * 0.2 }, paragraphs: [this.item.title], role: "heading", base: this.H * T.title, bold: true, lineHeight: 1.08 });
      const bodyTop = content.y + title.height + u2 * 4;
      const avail = this.H - this.m - bodyTop;
      const make = (span: Rect, pts: string[], y0: number) => this.text({ name: "Points", rect: { x: span.x, y: y0, width: span.width - this.ds.gutter, height: avail }, paragraphs: pts, role: "body", base: this.H * T.point, lineHeight: 1.35, paraGap: 0.55, list: "bullet" });
      const tallest = Math.max(make(l, points.slice(0, half), 0).height, make(r, points.slice(half), 0).height);
      const y0 = bodyTop + Math.max(0, Math.round((avail - tallest) / 2));
      // Re-anchor the title so the whole cluster is centered, as cluster() does.
      const total = title.height + u2 * 4 + tallest;
      const shift = Math.max(0, Math.round((content.height - total) / 2));
      this.nodes.push(this.text({ name: "Title", rect: { ...this.span(0, 12), y: content.y + shift, height: this.H * 0.2 }, paragraphs: [this.item.title], role: "heading", base: this.H * T.title, bold: true, lineHeight: 1.08 }).node);
      this.nodes.push(make(l, points.slice(0, half), y0 - (bodyTop - (content.y + shift + title.height + u2 * 4))).node);
      this.nodes.push(make(r, points.slice(half), y0 - (bodyTop - (content.y + shift + title.height + u2 * 4))).node);
      this.furniture();
      return;
    }
    const pointBase = variant === "large" ? this.H * T.agendaItem : this.H * T.point;
    this.cluster(content, [
      this.titleBlock(this.H * T.title),
      { kind: "text", maxFrac: 0.7, make: (r) => this.text({ name: "Points", rect: r, paragraphs: points, role: "body", base: pointBase, lineHeight: 1.35, paraGap: 0.55, list: "bullet" }) },
    ], 3, true);
    this.furniture();
  }

  private agenda(): void {
    const u = this.ds.unit;
    const content = { y: this.m + u * 4, height: this.H - 2 * this.m - u * 4 };
    // Title on the leading third, the numbered list on the trailing two thirds:
    // an agenda IS a sequence, so the numbers carry information.
    const left = { ...this.span(0, 4), ...content };
    const right = { ...this.span(5, 7), ...content };
    this.cluster(left, [{ kind: "rule" }, this.titleBlock(this.H * T.title)], 3);
    this.cluster(right, [{ kind: "text", maxFrac: 1, make: (r) => this.text({ name: "Agenda", rect: r, paragraphs: this.item.points, role: "body", base: this.H * T.agendaItem, lineHeight: 1.35, paraGap: 0.7, list: "number" }) }], 0);
    this.furniture();
  }

  private columns(n: 2 | 3): void {
    const cols = (this.item.columns ?? []).slice(0, n);
    const u = this.ds.unit;
    const top = this.m + u * 4;
    const title = this.text({ name: "Title", rect: { ...this.span(0, 12), y: top, height: this.H * 0.2 }, paragraphs: [this.item.title], role: "heading", base: this.H * T.title, bold: true, lineHeight: 1.08 });
    this.nodes.push(title.node);
    const bodyTop = top + title.height + u * 4;
    const bodyH = this.H - this.m - bodyTop;
    const spans = n === 2 ? [this.span(0, 5), this.span(7, 5)] : [this.span(0, 4), this.span(4, 4), this.span(8, 4)];
    const inners = cols.map((_, i) => (n === 3 ? { x: spans[i].x, width: spans[i].width - this.ds.gutter } : spans[i]));
    // Two passes: measure each column at y=0 to learn the tallest, then place
    // every column so that block is centered in what remains under the title.
    // A short comparison used to sit under the title with a void beneath it.
    const build = (c: { heading: string; points: string[] }, inner: { x: number; width: number }, y0: number) => {
      const out: Node[] = [];
      out.push(this.accentRule(inner.x, y0));
      const head = this.text({ name: "Heading", rect: { x: inner.x, y: y0 + u * 2.5, width: inner.width, height: u * 10 }, paragraphs: [c.heading], role: "heading", base: this.H * T.colHead, bold: true, lineHeight: 1.15 });
      out.push(head.node);
      let bottom = y0 + u * 2.5 + head.height;
      const pts = c.points;
      if (pts.length) {
        const py = bottom + u * 2;
        const body = this.text({ name: "Points", rect: { x: inner.x, y: py, width: inner.width, height: Math.max(u * 4, this.H - this.m - py) }, paragraphs: pts, role: "body", base: this.H * T.point * (n === 3 ? 0.92 : 1), lineHeight: 1.35, paraGap: 0.5, list: "bullet" });
        out.push(body.node);
        bottom = py + body.height;
      }
      return { nodes: out, height: bottom - y0 };
    };
    const tallest = Math.max(...cols.map((c, i) => build(c, inners[i], 0).height));
    const y0 = bodyTop + Math.max(0, Math.round((bodyH - tallest) / 2));
    if (n === 2) {
      // The rule between the columns is the comparison: it says "versus", and
      // it runs the height of the content, not of the page.
      const gap = this.span(5, 2);
      const x = gap.x + gap.width / 2 - this.ds.rule / 2;
      this.nodes.push(this.rect("Divider", { x, y: y0, width: this.ds.rule, height: tallest }, mix(this.ds.colors.ink, this.ds.colors.paper, 0.8)));
    }
    cols.forEach((c, i) => this.nodes.push(...build(c, inners[i], y0).nodes));
    this.furniture();
  }

  private process(): void {
    const steps = this.item.steps ?? [];
    const u = this.ds.unit;
    const top = this.m + u * 4;
    const title = this.text({ name: "Title", rect: { ...this.span(0, 12), y: top, height: this.H * 0.2 }, paragraphs: [this.item.title], role: "heading", base: this.H * T.title, bold: true, lineHeight: 1.08 });
    this.nodes.push(title.node);
    const bodyTop = top + title.height + u * 5;
    const n = steps.length;
    if (n <= 4) {
      // A row: numerals on a shared line, drawn as segments between them, and
      // measured first so the row sits in the middle of the space under the
      // title rather than pressed up against it.
      const perCols = Math.floor(12 / n);
      const numSize = Math.round(this.H * T.stepNumber);
      const numBox = Math.round(numSize * 1.15);
      const lineColor = mix(this.ds.colors.ink, this.ds.colors.paper, 0.8);
      const build = (y0: number) => {
        const out: Node[] = [];
        let bottom = y0;
        const lineY = y0 + Math.round(numBox / 2) - Math.round(this.ds.rule / 2);
        steps.forEach((st, i) => {
          const s = this.span(i * perCols, perCols);
          const inner = { x: s.x, width: s.width - this.ds.gutter };
          out.push(this.text({ name: "Step", rect: { x: inner.x, y: y0, width: numBox, height: numBox }, paragraphs: [String(i + 1)], role: "heading", base: numSize, bold: true, color: this.ds.colors.accentOnPaper, exactSize: numSize, valign: "middle", align: "left", lineHeight: 1 }).node);
          if (i < n - 1) {
            const next = this.span((i + 1) * perCols, perCols);
            const x0 = inner.x + numBox + u;
            const x1 = next.x - u;
            if (x1 > x0) out.push(this.rect("Sequence", { x: x0, y: lineY, width: x1 - x0, height: this.ds.rule }, lineColor));
          }
          const ly = y0 + numBox + u * 2;
          const label = this.text({ name: "Label", rect: { x: inner.x, y: ly, width: inner.width, height: u * 8 }, paragraphs: [st.label], role: "heading", base: this.H * T.stepLabel, bold: true, lineHeight: 1.15 });
          out.push(label.node);
          let b = ly + label.height;
          if (st.detail) {
            const dy = b + u;
            const det = this.text({ name: "Detail", rect: { x: inner.x, y: dy, width: inner.width, height: Math.max(u * 4, this.H - this.m - dy) }, paragraphs: [st.detail], role: "body", base: this.H * T.detail, color: this.muted, lineHeight: 1.4 });
            out.push(det.node);
            b = dy + det.height;
          }
          bottom = Math.max(bottom, b);
        });
        return { nodes: out, height: bottom - y0 };
      };
      const rowH = build(0).height;
      const avail = this.H - this.m - bodyTop;
      this.nodes.push(...build(bodyTop + Math.max(0, Math.round((avail - rowH) / 2))).nodes);
    } else {
      // Five steps: a numbered list down the page.
      const items = steps.map((st) => `${st.label}${st.detail ? `: ${st.detail}` : ""}`);
      this.nodes.push(this.text({ name: "Steps", rect: { ...this.span(0, 10), y: bodyTop, height: this.H - this.m - bodyTop }, paragraphs: items, role: "body", base: this.H * T.point, lineHeight: 1.35, paraGap: 0.7, list: "number" }).node);
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
      { kind: "text", maxFrac: 0.55, make: (r) => this.text({ name: "Quote", rect: r, paragraphs: [q.text], role: "heading", base: this.H * T.quote, lineHeight: 1.2 }) },
      ...(q.attribution ? [{ kind: "text" as const, maxFrac: 0.15, make: (r: Rect) => this.text({ name: "Attribution", rect: r, paragraphs: [q.attribution!], role: "body", base: this.H * T.attribution, color: this.muted }) }] : []),
    ], 2.5);
    void u;
    this.furniture();
  }

  private imageCaption(): void {
    // The picture carries the slide: it bleeds to three edges on the leading
    // side and the words take the trailing column on paper.
    const imageLeading = this.ctx.index % 2 === 0;
    const imgCols = 7;
    const s = imageLeading ? this.span(0, imgCols) : this.span(12 - imgCols, imgCols);
    const imgRect = imageLeading
      ? { x: 0, y: 0, width: s.x + s.width - this.ds.gutter / 2, height: this.H }
      : { x: s.x - this.ds.gutter / 2, y: 0, width: this.W - s.x + this.ds.gutter / 2, height: this.H };
    this.nodes.push(this.imageSlot(imgRect, this.imagePrompt()));
    const textSpan = imageLeading ? this.span(8, 4) : this.span(0, 4);
    const u = this.ds.unit;
    this.cluster({ ...textSpan, y: this.m + u * 4, height: this.H - 2 * this.m - u * 4 }, [
      { kind: "rule" },
      this.titleBlock(this.H * T.title * 0.95),
      ...this.subheadBlock(this.H * T.caption, this.item.subhead ?? this.item.points[0]),
    ], 2.5);
    // Kicker and page number stay in the text column, off the picture.
    this.furniture({ x: textSpan.x, width: textSpan.width });
  }

  private chart(): void {
    const c = this.item.chart!;
    const u = this.ds.unit;
    const top = this.m + u * 4;
    const title = this.text({ name: "Title", rect: { ...this.span(0, 8), y: top, height: this.H * 0.18 }, paragraphs: [this.item.title], role: "heading", base: this.H * T.title, bold: true, lineHeight: 1.08 });
    this.nodes.push(title.node);
    let y = top + title.height + u * 1.5;
    if (this.item.subhead) {
      const take = this.text({ name: "Takeaway", rect: { ...this.span(0, 8), y, height: u * 8 }, paragraphs: [this.item.subhead], role: "body", base: this.H * T.caption, color: this.muted });
      this.nodes.push(take.node);
      y += take.height + u * 3;
    } else {
      y += u * 2;
    }
    const r = this.mirror({ ...this.span(0, 12), y, height: this.H - this.m - y });
    const palette = [this.ds.colors.accentOnPaper, this.ds.colors.primary, this.ds.colors.deep];
    this.nodes.push(createNode("chart", {
      name: "Chart",
      chartType: c.kind,
      categories: [...c.categories],
      series: c.series.map((s, i) => ({ name: s.name, values: [...s.values], color: structuredClone(palette[i % palette.length]) })),
      options: {},
      transform: { x: r.x, y: r.y, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: r.width, height: r.height },
    } as never) as Node);
    this.furniture();
  }

  private closing(): void {
    const hasImage = !!this.item.image;
    if (hasImage) {
      const s = this.span(8, 4);
      this.nodes.push(this.imageSlot({ x: s.x, y: 0, width: this.W - s.x, height: this.H }, this.imagePrompt()));
    }
    const region = this.span(0, hasImage ? 7 : 8);
    this.cluster(region, [
      { kind: "rule" },
      this.titleBlock(this.H * T.sectionTitle),
      ...this.subheadBlock(this.H * T.coverSub, this.item.subhead ?? this.item.points[0], this.ink),
    ], 3);
    this.furniture(hasImage ? { x: region.x, width: region.width } : undefined);
  }
}

function mix(a: Color, b: Color, t: number): Color {
  const l = (x: number, y: number) => x + (y - x) * t;
  return { srgb: { r: l(a.srgb.r, b.srgb.r), g: l(a.srgb.g, b.srgb.g), b: l(a.srgb.b, b.srgb.b), a: 1 } };
}

/** Compose one outline page in its archetype's form. */
export function composeArchetypePage(item: OutlineItem, ds: DesignSystem, ctx: ComposeContext): ComposedPage {
  const a = (item.archetype ?? "bullets") as Archetype;
  return new Composer(ds, item, ctx, archetypeIsImpact(a)).compose();
}
