// The inline text editor's DOM <-> model round trip, extracted from Canvas.tsx
// so it is unit-testable: the editor renders the paragraph/run model as styled
// <span>s (soft breaks injected at the ENGINE's wrap points), and parses the
// DOM back to the model on every input. A defect on either side of that round
// trip corrupts text or drops the caret somewhere else entirely, which is why
// these functions carry tests while the overlay component itself does not.
//
// Contracts:
// - Hard paragraph breaks are literal "\n" text (wrapped in a styled span so
//   the separator's line box matches its paragraph); soft breaks are
//   <br data-soft="1"> and are layout only.
// - The flat offset space (flatSelection/setFlatSelection) is the
//   concatenation of every TEXT node under the editor, in tree order. <br>
//   elements contribute nothing. Rebuilding the DOM from the same model must
//   preserve that space, or the caret jumps on every rewrap.

import type { CharStyle, Color, Paragraph, TextNode } from "@hc/schema";
import { fontFamilyStack, weightFromFontStyle } from "@hc/engine";
import { layoutText } from "@hc/text";
import { canvasMeasure } from "@/lib/textFit";

export function srgbCss(c: Color): string {
  const s = c.srgb;
  const f = (x: number) => Math.round(x * 255);
  return `rgba(${f(s.r)},${f(s.g)},${f(s.b)},${s.a})`;
}

export type EditRun = { text: string; style: CharStyle };
export type EditPara = { runs: EditRun[]; style: { align?: string } & Record<string, unknown> };

export const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const stylesEqual = (a: CharStyle, b: CharStyle) => JSON.stringify(a) === JSON.stringify(b);

// The engine's line advance for a run style (mirrors layoutText's
// lineHeightPx: an explicit multiple/absolute, else fontSize * 1.2). The
// browser's font-metric default varies per family, so every piece of editor
// text (runs AND the container, whose "\n" separators form their own inline
// boxes) must carry this explicitly or lines visibly shift between edit mode
// and the canvas render.
export function lineAdvancePx(style: CharStyle | undefined): number {
  const fs = style?.fontSize ?? 16;
  const lh = style?.lineHeight as number | { mode: "auto" | "multiple" | "absolute"; value: number } | undefined;
  if (lh === undefined) return fs * 1.2;
  if (typeof lh === "number") return fs * lh;
  if (lh.mode === "absolute") return lh.value;
  if (lh.mode === "multiple") return fs * lh.value;
  return fs * 1.2;
}

export function charCss(style: CharStyle, zoom: number): string {
  const weight = style.axes?.wght ?? weightFromFontStyle(style.fontStyle);
  const italic = /italic|oblique/i.test(style.fontStyle ?? "");
  const color = style.fill?.type === "solid" ? srgbCss(style.fill.color) : "#111827";
  const tt = style.case === "upper" ? "uppercase" : style.case === "lower" ? "lowercase" : style.case === "title" ? "capitalize" : "none";
  // Preview decoration, links, and sub/superscript so the editor matches the
  // canvas. Script shrinks the glyph (matching the engine's 0.66) and shifts the
  // baseline; the engine-driven wrap is character-based so this stays in sync.
  const script = style.script;
  const sizeMul = script === "super" || script === "sub" ? 0.66 : 1;
  const fs = style.fontSize ?? 16;
  const lhPx = lineAdvancePx(style);
  const decos: string[] = [];
  if (style.decoration?.includes("underline")) decos.push("underline");
  if (style.decoration?.includes("strikethrough")) decos.push("line-through");
  if (style.link && !decos.includes("underline")) decos.push("underline");
  const out = [
    `font-family:${fontFamilyStack(style.fontFamily)}`,
    `font-size:${fs * sizeMul * zoom}px`,
    `line-height:${lhPx * zoom}px`,
    `font-weight:${weight}`,
    `font-style:${italic ? "italic" : "normal"}`,
    `color:${color}`,
    `letter-spacing:${(style.letterSpacing ?? 0) * zoom}px`,
    `text-transform:${tt}`,
    `text-decoration:${decos.length ? decos.join(" ") : "none"}`,
  ];
  if (script === "super") out.push("vertical-align:super");
  else if (script === "sub") out.push("vertical-align:sub");
  return out.join(";");
}

// A soft (engine-computed) line break inside a paragraph. Marked so htmlToContent
// strips it back out (it is layout, not a real paragraph break like "\n"/<br>).
export const softBr = '<br data-soft="1">';

export const runSpan = (text: string, style: CharStyle, zoom: number) =>
  // The CSS contains double quotes (font-family stacks quote names like
  // "Segoe UI"), which would terminate the style attribute at the first one
  // and silently drop the run's whole inline style - every run then inherits
  // the container's (first run's) font and size while editing. Escape them.
  `<span data-st="${encodeURIComponent(JSON.stringify(style))}" style="${charCss(style, zoom).replace(/"/g, "&quot;")}">${escHtml(text)}</span>`;

// For each paragraph, the character offsets (within that paragraph's text) where
// the engine starts a new visual line. Derived from layoutText so the editor's
// soft wrapping is byte-for-byte the canvas wrapping.
export function computeBreaks(lines: { paragraph: number; segments: { text: string }[] }[]): Map<number, number[]> {
  const breaks = new Map<number, number[]>();
  const acc = new Map<number, number>();
  for (const line of lines) {
    const prev = acc.get(line.paragraph) ?? 0;
    if (prev > 0) {
      const arr = breaks.get(line.paragraph) ?? [];
      arr.push(prev);
      breaks.set(line.paragraph, arr);
    }
    acc.set(line.paragraph, prev + line.segments.reduce((s, seg) => s + seg.text.length, 0));
  }
  return breaks;
}

// Render the model to editor HTML with the engine's soft breaks injected at the
// computed offsets. Paragraphs are joined by "\n" (hard breaks); within a
// paragraph, runs are split at break offsets with a softBr between pieces.
export function layoutToHtml(content: EditPara[], breaks: Map<number, number[]>, zoom: number): string {
  const parts = content.map((p, pi) => {
    const cuts = (breaks.get(pi) ?? []).slice().sort((a, b) => a - b);
    let pos = 0;
    let bi = 0;
    let out = "";
    for (const r of p.runs) {
      let local = 0;
      while (bi < cuts.length && cuts[bi] <= pos + r.text.length) {
        const cut = cuts[bi] - pos;
        if (cut >= local) {
          const piece = r.text.slice(local, cut);
          if (piece) out += runSpan(piece, r.style, zoom);
          out += softBr;
          local = cut;
        }
        bi++;
      }
      out += runSpan(r.text.slice(local), r.style, zoom);
      pos += r.text.length;
    }
    if (!p.runs.length) out += runSpan("", defaultChar(), zoom);
    return out;
  });
  // Join paragraphs with a hard "\n", each wrapped in a span styled like the
  // paragraph it terminates: a bare newline would take the container's style
  // and could inflate that paragraph's last line box past the engine's
  // advance. htmlToContent splits text on "\n" regardless of the span.
  let joined = "";
  for (let i = 0; i < parts.length; i++) {
    joined += parts[i];
    if (i < parts.length - 1) joined += runSpan("\n", content[i].runs[0]?.style ?? defaultChar(), zoom);
  }
  // A trailing EMPTY paragraph (Enter just pressed at the end) needs a
  // placeholder <br>: under white-space:pre a trailing "\n" renders NO final
  // line box, so the caret has nowhere to sit and Chrome shoves it (and the
  // next typed character) back up into line 1. The placeholder is data-soft,
  // so htmlToContent strips it and it counts zero flat characters; it exists
  // purely to give the empty last line height and a stable caret anchor -
  // exactly the browser's own representation of an empty editable line.
  // Middle empty paragraphs need none: their "\n\n" already renders a line.
  const last = content[content.length - 1];
  if (last && last.runs.reduce((n, r) => n + r.text.length, 0) === 0) {
    joined = joined.endsWith("></span>")
      ? `${joined.slice(0, -"</span>".length)}${softBr}</span>`
      : joined + softBr;
  }
  return joined;
}

// Build editor HTML for a text node + (possibly edited) model: lay the model out
// with the engine to find wrap points, then emit HTML with matching soft breaks.
// `sig` lets callers skip a DOM rebuild when the wrap points are unchanged.
export function buildEditorHtml(node: TextNode, model: EditPara[], zoom: number): { html: string; sig: string } {
  const tempNode = { ...node, content: model as unknown as Paragraph[] } as TextNode;
  const { lines } = layoutText(tempNode, { measure: canvasMeasure });
  const breaks = computeBreaks(lines);
  // The signature gates the "leave the browser's DOM in place" fast path, so
  // it must change whenever the DOM needs renormalizing. Soft-wrap offsets
  // alone are blind to PARAGRAPH structure: a browser-generated paragraph
  // insert (IME or dictation newlines arrive as <div>/<br> blocks, not through
  // the intercepted Enter) can leave every wrap offset identical while the DOM
  // diverges from the "\n" representation. Including the paragraph count
  // forces the rebuild exactly then, and never on ordinary typing.
  return { html: layoutToHtml(model, breaks, zoom), sig: JSON.stringify([model.length, ...breaks.entries()]) };
}

export const defaultChar = (): CharStyle => ({
  fontFamily: "system",
  fontStyle: "Regular",
  fontSize: 16,
  fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } },
});

export function htmlToContent(el: HTMLElement, prev: EditPara[]): EditPara[] {
  // Always a concrete style so typed text is never dropped and we never persist
  // a paragraph with zero runs (downstream code assumes runs[0] exists).
  const fallback: CharStyle = prev[0]?.runs?.[0]?.style ?? defaultChar();
  const paras: { runs: EditRun[] }[] = [{ runs: [] }];
  const push = (text: string, style: CharStyle) => {
    const cur = paras[paras.length - 1].runs;
    const last = cur[cur.length - 1];
    if (last && stylesEqual(last.style, style)) last.text += text;
    else cur.push({ text, style });
  };
  // Nearest block-level ancestor of a node within the editor. On Enter the
  // browser frequently wraps the new line in its own <div>/<p> instead of
  // inserting a literal "\n", so a change of block container is a hard
  // paragraph break too (otherwise the two lines silently merge into one).
  const blockOf = (n: Node): Element => {
    let p = n.parentElement;
    while (p && p !== el) {
      const tag = p.nodeName;
      if (tag === "DIV" || tag === "P" || tag === "LI" || tag === "SECTION") return p;
      p = p.parentElement;
    }
    return el;
  };
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let node: Node | null;
  let prevBlock: Element | null = null;
  while ((node = walk.nextNode())) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if ((node as Element).nodeName === "BR" && !(node as Element).hasAttribute("data-soft")) {
        // A real (browser-inserted) break is a hard paragraph break. Engine soft
        // breaks (data-soft) are layout only and are dropped here.
        paras.push({ runs: [] });
        prevBlock = null; // the BR already broke; don't double-break on the next text node
      }
      continue;
    }
    // A different block container means the browser split content into separate
    // line boxes (Enter handled as a <div> split): treat it as a paragraph break.
    const block = blockOf(node);
    if (prevBlock && block !== prevBlock) paras.push({ runs: [] });
    prevBlock = block;
    const sp = (node.parentElement as HTMLElement | null)?.closest("[data-st]");
    let style = fallback;
    if (sp) {
      try {
        style = JSON.parse(decodeURIComponent(sp.getAttribute("data-st") || "")) as CharStyle;
      } catch {
        /* keep fallback */
      }
    }
    const segs = (node.textContent || "").split("\n");
    segs.forEach((seg, i) => {
      if (i > 0) paras.push({ runs: [] });
      if (seg) push(seg, style);
    });
  }
  return paras.map((p, i) => ({
    runs: p.runs.length
      ? p.runs.map((r) => ({ text: r.text, style: structuredClone(r.style) }))
      : [{ text: "", style: structuredClone(fallback) }],
    // Clamp the source-paragraph index so paragraphs added past the end (e.g.
    // Enter at the end of a list) inherit the last paragraph's style - keeping
    // the list/alignment - rather than snapping back to paragraph 0's.
    style: structuredClone(prev[Math.min(i, prev.length - 1)]?.style ?? { align: "left", direction: "auto" }),
  }));
}

/** Flat [start,end) selection over the editor text (paragraphs joined by "\n").
 *
 *  A hard line break has TWO DOM representations that must count the same: the
 *  rebuilt DOM stores it as a literal "\n" text node (one character), but the
 *  break the BROWSER just typed is a <br> element (zero characters in
 *  toString/textContent). Counting a non-soft <br> as one flat character keeps
 *  the offset space stable across the rebuild that swaps one representation
 *  for the other. Measured with Range.toString() alone, every hard break typed
 *  since the last rebuild shifted the restored caret one character left, so
 *  fast typing after Enter scrambled the word ("adopted" -> "dopteda") and the
 *  caret "jumped to the first line". */
export function flatSelection(el: HTMLElement): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) return null;
  if (!el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return null;
  const off = (n: Node, o: number) => {
    const r = document.createRange();
    r.setStart(el, 0);
    r.setEnd(n, o);
    const frag = r.cloneContents();
    const brs = frag.querySelectorAll ? frag.querySelectorAll('br:not([data-soft])').length : 0;
    return (frag.textContent ?? "").length + brs;
  };
  const a = off(sel.anchorNode, sel.anchorOffset);
  const b = off(sel.focusNode, sel.focusOffset);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

export function setFlatSelection(el: HTMLElement, start: number, end: number) {
  // A flat position at the exact END of a text node is ambiguous: it is also
  // the START of the next one. The two render differently around line breaks
  // (end of line 1 vs start of line 2), and worse, Chrome refuses to TYPE at
  // some upstream spots - a caret placed inside a "\n" span after the newline
  // gets silently relocated into the previous line, which is how typing on
  // line 2 ended up editing line 1. Resolve boundaries DOWNSTREAM: place the
  // caret at offset 0 of the next text node, unless a hard <br> intervenes
  // (crossing it would move a flat character). A trailing placeholder
  // <br data-soft> (empty last paragraph) anchors as its parent element.
  const pointAt = (pos: number): { node: Node; off: number } => {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let acc = 0;
    let n: Node | null;
    let pending: Text | null = null; // node whose END equals pos; kept while a downstream start may exist
    let last: Text | null = null;
    while ((n = walk.nextNode())) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        const eln = n as Element;
        if (eln.nodeName !== "BR") continue;
        if (eln.hasAttribute("data-soft")) {
          // Two kinds of soft br: an ordinary WRAP break sits as a direct
          // child of the editor between run spans - skip it, so a boundary
          // position resolves downstream into the next line's styled text node
          // (anchoring before the wrap br would sit at the editor root, where
          // typed text lands as a bare unstyled node). The trailing
          // PLACEHOLDER of an empty last paragraph lives INSIDE that
          // paragraph's span; a boundary position that reaches it anchors
          // before it, on the empty line.
          if (pending && eln.parentElement && eln.parentElement !== el && eln.parentElement.hasAttribute("data-st")) {
            return { node: eln.parentElement, off: Array.prototype.indexOf.call(eln.parentElement.childNodes, eln) };
          }
          continue;
        }
        // A hard <br> is one flat character; a boundary before it stays put.
        if (pending) return { node: pending, off: pending.length };
        acc += 1;
        continue;
      }
      const t = n as Text;
      if (pending) return { node: t, off: 0 };
      last = t;
      const len = t.length;
      if (pos < acc + len) return { node: t, off: Math.max(0, pos - acc) };
      if (pos === acc + len) {
        pending = t;
        acc += len;
        continue;
      }
      acc += len;
    }
    if (pending) return { node: pending, off: pending.length };
    return last ? { node: last, off: last.length } : { node: el, off: 0 };
  };
  const s = pointAt(start);
  const e = pointAt(end);
  const r = document.createRange();
  r.setStart(s.node, s.off);
  r.setEnd(e.node, e.off);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

/** Apply a char patch to the [start,end) range, splitting runs at boundaries. */
export function styleRange(content: EditPara[], start: number, end: number, patch: Partial<CharStyle> | ((s: CharStyle) => Partial<CharStyle>)): EditPara[] {
  let offset = 0;
  return content.map((p) => {
    const runs: EditRun[] = [];
    let rOff = offset;
    for (const run of p.runs) {
      const len = run.text.length;
      const s = Math.max(start, rOff);
      const e = Math.min(end, rOff + len);
      if (e <= s) {
        runs.push(run);
      } else {
        const a = s - rOff;
        const b = e - rOff;
        if (a > 0) runs.push({ text: run.text.slice(0, a), style: run.style });
        const char = typeof patch === "function" ? patch(run.style) : patch;
        const merged = Object.assign(structuredClone(run.style), char);
        if (char.axes) merged.axes = { ...run.style.axes, ...char.axes };
        runs.push({ text: run.text.slice(a, b), style: merged });
        if (b < len) runs.push({ text: run.text.slice(b), style: run.style });
      }
      rOff += len;
    }
    offset += p.runs.map((r) => r.text).join("").length + 1; // +1 for "\n"
    const kept = runs.filter((r) => r.text.length > 0);
    return { runs: kept.length ? kept : p.runs, style: p.style };
  });
}
