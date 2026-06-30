// The editor canvas surface: renders the design via @hc/engine and handles
// pointer interaction, click/shift-click selection, marquee, move-drag (one
// gesture = one undo step), and wheel pan / ctrl-wheel zoom about the cursor.

import { useEffect, useRef, useState } from "react";
import { MousePointer2, PenTool, Pencil, Minus, MoveUpRight, Square, Circle, Type, MessageSquarePlus, Copy, ClipboardPaste, CopyPlus, Trash2, Group, Ungroup, ArrowUp, ArrowDown, ChevronsUp, ChevronsDown, FlipHorizontal2, FlipVertical2, Paintbrush, PaintBucket, Lock, LockOpen, Eye, EyeOff, BoxSelect } from "lucide-react";
import type { CharStyle, Color, Paragraph, TextNode, Transform } from "@hc/schema";
import { locate, moveTransform, marqueeSelect, parentSpaceDelta, worldMatrix, worldAABB, unionAABB, snap, type EditCommand } from "@hc/editor";
import { fitStickyFontScale, routeConnector } from "@hc/whiteboard";
import { layoutText } from "@hc/text";
import { canvasFontString, fontFamilyStack, weightFromFontStyle, type Rect } from "@hc/engine";
import { useCallbackRef } from "@/lib/useCallbackRef";
import { overlay } from "@/lib/theme.generated";
import { useEditorCanvas, type CanvasApi } from "@/lib/useEditorCanvas";
import { useEditor, OC_CLIP_PREFIX } from "@/store/editor";
import { commandForEvent } from "@/lib/shortcuts";
import { Gizmo } from "./Gizmo";
import { SelectionToolbar } from "./SelectionToolbar";
import { MiniMap } from "./MiniMap";
import { PageOverlays } from "./PageOverlays";
import { PathEditor } from "./PathEditor";
import { CropOverlay } from "./CropOverlay";
import { PresenceOverlay } from "./PresenceOverlay";
import { CommentPins } from "./CommentPins";
import { getRealtimeClient } from "@/lib/useRealtime";
import { serverNow } from "@/lib/realtime";
import { usePresence } from "@/store/presence";
import { useBrand } from "@/store/brand";
import { useComments } from "@/store/comments";

function srgbCss(c: Color): string {
  const s = c.srgb;
  const f = (x: number) => Math.round(x * 255);
  return `rgba(${f(s.r)},${f(s.g)},${f(s.b)},${s.a})`;
}

// The crop overlay assumes an axis-aligned, unit-scaled node (it positions an
// HTML <img> in screen space). Only allow crop when the image is unrotated,
// unscaled, and unskewed; otherwise the overlay would not match the render.
const RULER = 22; // ruler strip thickness in px

/** Page-unit tick spacing so marks sit ~60px apart on screen at the current zoom. */
function niceStep(zoom: number): number {
  const target = 60 / Math.max(0.01, zoom);
  return [5, 10, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find((c) => c >= target) ?? 10000;
}

/** Tick marks + labels inside a ruler strip (coordinates relative to the strip). */
function Ruler({ axis, api, page }: { axis: "x" | "y"; api: CanvasApi; page: { width: number; height: number } }) {
  useEditor((s) => s.viewport);
  useEditor((s) => s.rev);
  const step = niceStep(api.viewport().zoom);
  const dim = axis === "x" ? page.width : page.height;
  const ticks: React.ReactElement[] = [];
  for (let p = 0; p <= dim + 0.5; p += step) {
    if (axis === "x") {
      const s = api.toScreen({ x: p, y: 0 }).x - RULER;
      ticks.push(<line key={p} x1={s} y1={RULER - 6} x2={s} y2={RULER} stroke={overlay.ruler} strokeWidth={1} />);
      ticks.push(<text key={`t${p}`} x={s + 2} y={9} fontSize={8} fill={overlay.ruler}>{Math.round(p)}</text>);
    } else {
      const s = api.toScreen({ x: 0, y: p }).y - RULER;
      ticks.push(<line key={p} x1={RULER - 6} y1={s} x2={RULER} y2={s} stroke={overlay.ruler} strokeWidth={1} />);
      ticks.push(<text key={`t${p}`} x={2} y={s + 3} fontSize={8} fill={overlay.ruler}>{Math.round(p)}</text>);
    }
  }
  return <svg className="absolute inset-0 h-full w-full overflow-hidden">{ticks}</svg>;
}

type ToolName = "select" | "pen" | "pencil" | "ink" | "laser" | "eraser" | "line" | "arrow" | "rect" | "ellipse" | "text" | "comment";

// Canvas tool palette (top-left). "sep" draws a divider.
const TOOLBAR: ({ tool: ToolName; title: string; icon: typeof MousePointer2 } | "sep")[] = [
  { tool: "select", title: "Select (V)", icon: MousePointer2 },
  "sep",
  { tool: "text", title: "Text (T)", icon: Type },
  { tool: "rect", title: "Rectangle (R) - drag to draw", icon: Square },
  { tool: "ellipse", title: "Ellipse (E) - drag to draw", icon: Circle },
  { tool: "line", title: "Line (L)", icon: Minus },
  { tool: "arrow", title: "Arrow (A)", icon: MoveUpRight },
  { tool: "pen", title: "Pen (P)", icon: PenTool },
  { tool: "pencil", title: "Pencil (B) - drag to draw freehand", icon: Pencil },
];

// Single-key canvas tool shortcuts.
const TOOL_KEYS: Record<string, ToolName> = {
  v: "select",
  p: "pen",
  b: "pencil",
  t: "text",
  r: "rect",
  e: "ellipse",
  l: "line",
  a: "arrow",
};

// Remappable command shortcuts: the canvas keydown resolves an event to a command
// id via the active scheme (@hc/shortcuts, user-customizable) and runs the action
// here. `edit` gates the action behind edit permission (viewers keep copy/select).
// Non-remappable keys (zoom, layer order, nudge, tool keys) stay hardcoded below.
type EditorState = ReturnType<typeof useEditor.getState>;
const COMMAND_ACTIONS: Record<string, { edit: boolean; run: (s: EditorState) => void }> = {
  "history.undo": { edit: true, run: (s) => s.undo() },
  "history.redo": { edit: true, run: (s) => s.redo() },
  "clipboard.copy": { edit: false, run: (s) => s.copySelection() },
  "clipboard.cut": { edit: true, run: (s) => s.cutSelection() },
  "selection.duplicate": { edit: true, run: (s) => s.duplicateSelection() },
  "selection.selectAll": { edit: false, run: (s) => s.selectAll() },
  "selection.group": { edit: true, run: (s) => s.group() },
  "selection.ungroup": { edit: true, run: (s) => s.ungroupSelection() },
};

// Resolve a hit node to its outermost ancestor on the page, so a single click on
// grouped content selects the GROUP as a unit (double-click enters to a child).
function topAncestorId(doc: Parameters<typeof locate>[0], id: string): string {
  let cur = id;
  for (let i = 0; i < 64; i++) {
    const loc = locate(doc, cur);
    if (!loc || !loc.parent) return cur;
    cur = loc.parent.id;
  }
  return cur;
}

// Top-level, keyboard-reachable nodes of a page: skip locked and hidden ones so
// Tab-cycling only lands on objects a keyboard user can actually select and act
// on (mirrors the visible, selectable set). Order matches paint/child order.
function tabbableIds(page: { children: { id: string; locked?: boolean; hidden?: boolean }[] } | undefined): string[] {
  if (!page) return [];
  return page.children.filter((n) => !n.locked && !n.hidden).map((n) => n.id);
}

function canCrop(t: Transform): boolean {
  return (
    t.rotation === 0 &&
    Math.abs(t.scaleX) === 1 &&
    Math.abs(t.scaleY) === 1 &&
    !t.skewX &&
    !t.skewY
  );
}

// ---- Rich text inline editor (contentEditable) ---------------------------
// The editor renders the paragraph/run model as styled <span>s inside a single
// pre-wrap contentEditable, so the browser lays out the real fonts/sizes and the
// caret aligns exactly (mixed sizes included). Paragraph breaks are literal "\n"
// text (Enter and paste are intercepted to keep the DOM text-only, no <br>/<div>
// quirks). On commit the DOM is parsed back to the model, so per-range styling
// applied via the toolbar survives editing.

type EditRun = { text: string; style: CharStyle };
type EditPara = { runs: EditRun[]; style: { align?: string } & Record<string, unknown> };

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const stylesEqual = (a: CharStyle, b: CharStyle) => JSON.stringify(a) === JSON.stringify(b);

function charCss(style: CharStyle, zoom: number): string {
  const weight = style.axes?.wght ?? weightFromFontStyle(style.fontStyle);
  const italic = /italic|oblique/i.test(style.fontStyle ?? "");
  const color = style.fill?.type === "solid" ? srgbCss(style.fill.color) : "#111827";
  const tt = style.case === "upper" ? "uppercase" : style.case === "lower" ? "lowercase" : style.case === "title" ? "capitalize" : "none";
  // Preview decoration, links, and sub/superscript so the editor matches the
  // canvas. Script shrinks the glyph (matching the engine's 0.66) and shifts the
  // baseline; the engine-driven wrap is character-based so this stays in sync.
  const script = style.script;
  const sizeMul = script === "super" || script === "sub" ? 0.66 : 1;
  const decos: string[] = [];
  if (style.decoration?.includes("underline")) decos.push("underline");
  if (style.decoration?.includes("strikethrough")) decos.push("line-through");
  if (style.link && !decos.includes("underline")) decos.push("underline");
  const out = [
    `font-family:${fontFamilyStack(style.fontFamily)}`,
    `font-size:${(style.fontSize ?? 16) * sizeMul * zoom}px`,
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
const SOFT_BR = '<br data-soft="1">';

const runSpan = (text: string, style: CharStyle, zoom: number) =>
  `<span data-st="${encodeURIComponent(JSON.stringify(style))}" style="${charCss(style, zoom)}">${escHtml(text)}</span>`;

// Single shared offscreen context for measuring text exactly as @hc/engine's
// render path does (same canvasFontString + letter-spacing), so the editor wraps
// at the same points the canvas and export will.
let _measureCanvas: HTMLCanvasElement | null = null;
const canvasMeasure = (text: string, style: CharStyle): number => {
  if (typeof document === "undefined") return text.length * (style.fontSize ?? 16) * 0.55;
  if (!_measureCanvas) _measureCanvas = document.createElement("canvas");
  const ctx = _measureCanvas.getContext("2d");
  if (!ctx) return text.length * (style.fontSize ?? 16) * 0.55;
  const lctx = ctx as unknown as { letterSpacing?: string };
  ctx.font = canvasFontString(style);
  if ("letterSpacing" in ctx) lctx.letterSpacing = `${style.letterSpacing ?? 0}px`;
  return ctx.measureText(text).width;
};

// For each paragraph, the character offsets (within that paragraph's text) where
// the engine starts a new visual line. Derived from layoutText so the editor's
// soft wrapping is byte-for-byte the canvas wrapping.
function computeBreaks(lines: { paragraph: number; segments: { text: string }[] }[]): Map<number, number[]> {
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
// paragraph, runs are split at break offsets with a SOFT_BR between pieces.
function layoutToHtml(content: EditPara[], breaks: Map<number, number[]>, zoom: number): string {
  return content
    .map((p, pi) => {
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
            out += SOFT_BR;
            local = cut;
          }
          bi++;
        }
        out += runSpan(r.text.slice(local), r.style, zoom);
        pos += r.text.length;
      }
      if (!p.runs.length) out += runSpan("", DEFAULT_CHAR, zoom);
      return out;
    })
    .join("\n");
}

// Build editor HTML for a text node + (possibly edited) model: lay the model out
// with the engine to find wrap points, then emit HTML with matching soft breaks.
// `sig` lets callers skip a DOM rebuild when the wrap points are unchanged.
function buildEditorHtml(node: TextNode, model: EditPara[], zoom: number): { html: string; sig: string } {
  const tempNode = { ...node, content: model as unknown as Paragraph[] } as TextNode;
  const { lines } = layoutText(tempNode, { measure: canvasMeasure });
  const breaks = computeBreaks(lines);
  return { html: layoutToHtml(model, breaks, zoom), sig: JSON.stringify(Array.from(breaks.entries())) };
}

const DEFAULT_CHAR: CharStyle = {
  fontFamily: "system",
  fontStyle: "Regular",
  fontSize: 16,
  fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } },
};

function htmlToContent(el: HTMLElement, prev: EditPara[]): EditPara[] {
  // Always a concrete style so typed text is never dropped and we never persist
  // a paragraph with zero runs (downstream code assumes runs[0] exists).
  const fallback: CharStyle = prev[0]?.runs?.[0]?.style ?? DEFAULT_CHAR;
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

/** Flat [start,end) selection over the editor text (paragraphs joined by "\n"). */
function flatSelection(el: HTMLElement): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) return null;
  if (!el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return null;
  const off = (n: Node, o: number) => {
    const r = document.createRange();
    r.setStart(el, 0);
    r.setEnd(n, o);
    return r.toString().length;
  };
  const a = off(sel.anchorNode, sel.anchorOffset);
  const b = off(sel.focusNode, sel.focusOffset);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

function setFlatSelection(el: HTMLElement, start: number, end: number) {
  const pointAt = (pos: number) => {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let acc = 0;
    let n: Node | null;
    let last: Node | null = null;
    while ((n = walk.nextNode())) {
      last = n;
      const len = (n.textContent || "").length;
      if (pos <= acc + len) return { node: n, off: pos - acc };
      acc += len;
    }
    return last ? { node: last, off: (last.textContent || "").length } : { node: el, off: 0 };
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
function styleRange(content: EditPara[], start: number, end: number, char: Partial<CharStyle>): EditPara[] {
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

function TextEditOverlay({ api, id, onClose }: { api: CanvasApi; id: string; onClose: () => void }) {
  useEditor((s) => s.rev);
  useEditor((s) => s.viewport);
  const ref = useRef<HTMLDivElement>(null);
  const modelRef = useRef<EditPara[] | null>(null);
  // Last non-empty selection, so a toolbar action still works if focus left the
  // editor (e.g. the OS color picker dialog clears the live DOM selection).
  const selRef = useRef<{ start: number; end: number } | null>(null);
  // Signature of the current engine soft-break layout; lets onInput skip a DOM
  // rebuild (and caret restore) on keystrokes that don't move a wrap point.
  const breakSigRef = useRef<string>("");
  // True mid-IME composition: defer re-wrapping until the composition commits.
  const composingRef = useRef(false);
  // Suppress the blur-commit while a modal prompt (e.g. the link dialog) steals
  // focus, so applying a link doesn't tear the editor down mid-action.
  const suppressCommitRef = useRef(false);
  // The node's box height when editing began; the undo baseline so transient
  // live-grow updates while typing don't leak into the undo stack.
  const startHeightRef = useRef<number | null>(null);
  const [hasSel, setHasSel] = useState(false);

  // Build the DOM from the model once per edited node, then select all.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const n = locate(useEditor.getState().doc, id)?.node;
    if (!n || n.type !== "text") return;
    const content = (n as unknown as { content: EditPara[] }).content;
    modelRef.current = content;
    startHeightRef.current = (n as unknown as { size: { height: number } }).size.height;
    const built = buildEditorHtml(n as unknown as TextNode, content, api.viewport().zoom);
    el.innerHTML = built.html;
    breakSigRef.current = built.sig;
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const doc = useEditor.getState().doc;
  const loc = locate(doc, id);
  const wm = worldMatrix(doc, id);
  if (!loc || loc.node.type !== "text" || !wm) return null;
  const node = loc.node as unknown as {
    size: { width: number; height: number };
    box?: { padding?: { t: number; r: number; b: number; l: number } };
    content: EditPara[];
  };
  const pad = node.box?.padding ?? { t: 0, r: 0, b: 0, l: 0 };
  const zoom = api.viewport().zoom;
  const tl = api.toScreen({ x: wm.e, y: wm.f });
  // Rotation + scale embedded in the world matrix, so the editor box matches a
  // rotated/scaled text node (it rotates about the node's local top-left, the
  // same pivot the gizmo uses). Most text nodes are unrotated, unit-scale.
  const rot = (Math.atan2(wm.b, wm.a) * 180) / Math.PI;
  const sx = Math.hypot(wm.a, wm.b) || 1;
  const sy = Math.hypot(wm.c, wm.d) || 1;
  const cs = node.content[0]?.runs[0]?.style;
  const align = node.content[0]?.style.align;
  const dir = (node.content[0]?.style as { direction?: string } | undefined)?.direction ?? "ltr";
  const baseColor = cs?.fill?.type === "solid"
    ? srgbCss(cs.fill.color)
    : cs?.fill?.type === "gradient" && cs.fill.stops[0]
      ? srgbCss(cs.fill.stops[0].color)
      : "#111827";

  // The model currently in the editor DOM (captures live typing).
  const currentModel = (): EditPara[] => {
    const el = ref.current;
    return el ? htmlToContent(el, modelRef.current ?? node.content) : (modelRef.current ?? node.content);
  };
  // Auto-grow (Canva-style): the box height the engine would render for `model`,
  // measured with the SAME layout + canvas measurer the canvas/export use, in page
  // units. This is the source of truth, so the selection box fits the rendered
  // text exactly rather than approximating from the DOM's scrollHeight.
  const measuredHeight = (model: EditPara[]): number => {
    const real = locate(useEditor.getState().doc, id)?.node as unknown as TextNode | undefined;
    if (!real) return startHeightRef.current ?? 1;
    const laid = layoutText(
      { ...real, content: model as unknown as Paragraph[], box: { ...real.box, mode: "autoHeight" } } as TextNode,
      { measure: canvasMeasure },
    );
    return Math.max(1, Math.round(laid.height));
  };
  // Live auto-grow: track the box height to the content as the user types, so the
  // selection box and surrounding layout follow line wraps immediately (the final
  // height is recorded undoably on commit). Transient: no undo entry per keystroke.
  const growLive = () => {
    if (ref.current) useEditor.getState().growTextBoxLive(id, measuredHeight(currentModel()));
  };
  const commit = () => {
    if (suppressCommitRef.current) return; // a modal (link prompt) has focus; don't tear down
    const el = ref.current;
    if (el) {
      const model = currentModel();
      useEditor.getState().setContent(
        id,
        model as unknown as Paragraph[],
        measuredHeight(model),
        startHeightRef.current ?? undefined,
      );
    }
    onClose();
  };
  const trackSel = () => {
    const el = ref.current;
    const r = el ? flatSelection(el) : null;
    if (r && r.end > r.start) selRef.current = r;
    setHasSel(!!r && r.end > r.start);
  };
  // Re-flow the editor to the engine's wrap points after a content change. Only
  // touches the DOM when a wrap point actually moved (most keystrokes don't), so
  // typing stays smooth and the caret only ever jumps on a genuine re-wrap.
  const rewrap = () => {
    const el = ref.current;
    if (!el) return;
    const model = htmlToContent(el, modelRef.current ?? node.content);
    modelRef.current = model;
    const real = locate(useEditor.getState().doc, id)?.node as unknown as TextNode | undefined;
    if (!real) return;
    const built = buildEditorHtml(real, model, api.viewport().zoom);
    if (built.sig === breakSigRef.current) return; // wrap unchanged: leave the browser's DOM in place
    const caret = flatSelection(el);
    el.innerHTML = built.html;
    breakSigRef.current = built.sig;
    if (caret) setFlatSelection(el, caret.start, caret.end);
  };
  // Apply a char patch to the selection: re-derive the model from the DOM
  // (capturing any typing), style the range, write it back, and re-render with
  // the engine's wrapping. Falls back to the last cached selection if the live
  // one was cleared.
  const applyRange = (char: Partial<CharStyle>) => {
    const el = ref.current;
    if (!el) return;
    const range = flatSelection(el) ?? selRef.current;
    if (!range || range.end <= range.start) return;
    const styled = styleRange(htmlToContent(el, modelRef.current ?? node.content), range.start, range.end, char);
    modelRef.current = styled;
    useEditor.getState().setContent(id, styled as unknown as Paragraph[]);
    const real = (locate(useEditor.getState().doc, id)?.node as unknown as TextNode | undefined) ?? (loc.node as unknown as TextNode);
    const built = buildEditorHtml(real, styled, zoom);
    el.innerHTML = built.html;
    breakSigRef.current = built.sig;
    el.focus();
    setFlatSelection(el, range.start, range.end);
    setHasSel(true);
  };

  return (
    <>
      <div
        ref={ref}
        contentEditable
        dir={dir as "ltr" | "rtl" | "auto"}
        lang={(node as { data?: { lang?: string } }).data?.lang || undefined}
        spellCheck
        suppressContentEditableWarning
        onBlur={commit}
        onInput={() => {
          if (!composingRef.current) {
            rewrap();
            growLive();
          }
          trackSel();
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          rewrap();
          growLive();
          trackSel();
        }}
        onKeyUp={trackSel}
        onMouseUp={trackSel}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            ref.current?.blur();
          } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            // Insert a literal newline (hard paragraph break), then re-flow so the
            // engine's wrapping is reflected immediately. Skip while an IME is
            // composing so Enter can commit the candidate.
            e.preventDefault();
            document.execCommand("insertText", false, "\n");
            rewrap();
            growLive();
          } else if (e.key === "Tab") {
            // Insert a tab character (advances to the next tab stop on canvas)
            // rather than moving focus out of the editor.
            e.preventDefault();
            document.execCommand("insertText", false, "\t");
            rewrap();
          }
        }}
        onPaste={(e) => {
          e.preventDefault();
          document.execCommand("insertText", false, e.clipboardData?.getData("text/plain") ?? "");
          rewrap();
          growLive();
        }}
        style={{
          position: "absolute",
          left: tl.x,
          top: tl.y,
          width: node.size.width * sx * zoom,
          // Fixed width, auto-sizing height (Canva-style): the editor grows/shrinks
          // with the content (floored at ~one line); the box height is fitted to
          // the rendered content on commit. height stays unset so it tracks content.
          minHeight: ((cs?.fontSize ?? 16) * 1.6 + pad.t + pad.b) * sy * zoom,
          transform: rot ? `rotate(${rot}deg)` : undefined,
          transformOrigin: "0 0",
          color: baseColor,
          // The engine owns wrapping: we inject soft breaks at its exact points,
          // so the browser must NOT line-break on its own (pre, not pre-wrap).
          whiteSpace: "pre",
          textAlign: (align === "justify" ? "left" : align) as React.CSSProperties["textAlign"],
          background: "transparent",
          outline: `2px solid ${overlay.selection}`,
          border: "none",
          paddingTop: pad.t * zoom,
          paddingRight: pad.r * zoom,
          paddingBottom: pad.b * zoom,
          paddingLeft: pad.l * zoom,
          boxSizing: "border-box",
          overflow: "visible",
          zIndex: 20,
          // Sensible defaults so the caret has a size before any text is typed.
          fontFamily: fontFamilyStack(cs?.fontFamily),
          fontSize: (cs?.fontSize ?? 16) * zoom,
        }}
      />
      {hasSel && (
        <div
          className="absolute z-30 flex items-center gap-1 rounded-lg border border-neutral-200 bg-white px-1.5 py-1 shadow-lg"
          style={{ left: tl.x, top: tl.y - 44 }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button onClick={() => applyRange({ axes: { ...(cs?.axes ?? {}), wght: 700 } })} className="h-7 w-7 rounded text-sm font-bold text-neutral-700 hover:bg-neutral-100" title="Bold">B</button>
          <button onClick={() => applyRange({ fontStyle: "Italic" })} className="h-7 w-7 rounded text-sm italic text-neutral-700 hover:bg-neutral-100" title="Italic">I</button>
          <span className="mx-0.5 h-5 w-px bg-neutral-200" />
          {[12, 16, 24, 36, 48].map((s) => (
            <button key={s} onClick={() => applyRange({ fontSize: s })} className="h-7 rounded px-1 text-xs text-neutral-600 hover:bg-neutral-100" title={`${s}px`}>{s}</button>
          ))}
          <span className="mx-0.5 h-5 w-px bg-neutral-200" />
          <input
            type="color"
            defaultValue={baseColor.startsWith("#") ? baseColor : "#111827"}
            onChange={(e) => applyRange({ fill: { type: "solid", color: { srgb: { ...hexToRgb(e.target.value), a: 1 } } } })}
            className="h-6 w-7 cursor-pointer rounded border border-neutral-300"
            title="Color"
          />
          <span className="mx-0.5 h-5 w-px bg-neutral-200" />
          <button
            onClick={() => {
              suppressCommitRef.current = true;
              const url = window.prompt("Link URL (leave empty to remove):", "");
              suppressCommitRef.current = false;
              if (url !== null) applyRange({ link: url.trim() || undefined });
              ref.current?.focus();
            }}
            className="h-7 w-7 rounded text-sm text-neutral-700 hover:bg-neutral-100"
            title="Link selected text"
          >🔗</button>
        </div>
      )}
    </>
  );
}

// ---- Sticky-note plain-text editor ---------------------------------------
// A whiteboard sticky holds a single plain-text string drawn as a
// word-wrapped block (engine render2d "sticky" case: base font 20*fontScale,
// padding 12). Editing is a plain <textarea> floated over the sticky's screen
// rect; on commit we write the text and a freshly-fit fontScale through the
// store's setStickyText (undoable, no-op for read-only callers).
const STICKY_PAD = 12;
const STICKY_BASE_FONT = 20;

function StickyEditOverlay({ api, id, onClose, onAdvance }: { api: CanvasApi; id: string; onClose: (id: string) => void; onAdvance: (id: string) => void }) {
  useEditor((s) => s.rev);
  useEditor((s) => s.viewport);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Seed the textarea with the current text and select all, once per sticky.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const n = locate(useEditor.getState().doc, id)?.node;
    if (!n || n.type !== "sticky") return;
    el.value = (n as unknown as { text: string }).text ?? "";
    el.focus();
    el.select();
  }, [id]);

  const doc = useEditor.getState().doc;
  const loc = locate(doc, id);
  const wm = worldMatrix(doc, id);
  if (!loc || loc.node.type !== "sticky" || !wm) return null;
  const node = loc.node as unknown as {
    size: { width: number; height: number };
    textColor: Color;
    fontFamily?: string;
    align?: "left" | "center" | "right";
    fontScale: number;
  };
  const zoom = api.viewport().zoom;
  const tl = api.toScreen({ x: wm.e, y: wm.f });
  const w = node.size.width;
  const h = node.size.height;

  const commit = () => {
    const el = ref.current;
    if (el) useEditor.getState().setStickyText(id, el.value, fitStickyFontScale(el.value, w, h));
    onClose(id);
  };

  return (
    <textarea
      ref={ref}
      onBlur={commit}
      onKeyDown={(e) => {
        // Enter commits (a single-line gesture like the sticky toolbar). Shift+Enter
        // inserts a newline. Escape commits too (matches the text overlay's blur).
        if (e.key === "Escape") {
          e.preventDefault();
          ref.current?.blur();
        } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          ref.current?.blur();
        } else if (e.key === "Tab" && !e.nativeEvent.isComposing) {
          // Tab commits this note and spawns the next one in flow, moving the
          // editor to it (F30 sticky speed). The unmount-blur of this textarea is
          // a no-op because onClose is keyed to the closing sticky id.
          e.preventDefault();
          const el = ref.current;
          if (el) useEditor.getState().setStickyText(id, el.value, fitStickyFontScale(el.value, w, h));
          onAdvance(id);
        }
      }}
      style={{
        position: "absolute",
        left: tl.x,
        top: tl.y,
        width: w * zoom,
        height: h * zoom,
        padding: STICKY_PAD * zoom,
        boxSizing: "border-box",
        resize: "none",
        border: "none",
        outline: `2px solid ${overlay.selection}`,
        background: "transparent",
        color: srgbCss(node.textColor),
        textAlign: node.align ?? "left",
        fontFamily: node.fontFamily ?? "sans-serif",
        fontSize: STICKY_BASE_FONT * (node.fontScale || 1) * zoom,
        lineHeight: 1.25,
        overflow: "hidden",
        zIndex: 20,
      }}
    />
  );
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

type Gesture =
  | { type: "none" }
  | { type: "move"; startX: number; startY: number; before: Map<string, Transform> }
  | { type: "marquee"; startX: number; startY: number };

// Node types that can be the endpoint of a whiteboard connector (anything with
// a meaningful box; connectors/masks/lines are excluded).
const CONNECTABLE_TYPES = new Set([
  "sticky",
  "shape",
  "frame",
  "text",
  "image",
  "group",
  "qr",
  "chart",
  "table",
]);

// Outward screen offset (px) for each anchor's connection nub, so the nubs sit
// just outside the node and never collide with the Gizmo's resize handles.
const NUB_DIR: Record<string, { x: number; y: number }> = {
  top: { x: 0, y: -16 },
  right: { x: 16, y: 0 },
  bottom: { x: 0, y: 16 },
  left: { x: -16, y: 0 },
};

/**
 * Whiteboard drag-to-connect. For the single selected connectable
 * node it renders four connection nubs at the edge midpoints; dragging from a
 * nub draws a rubber-band line and, when released over another node, creates an
 * arrowed connector between them (via the store's connectNodes, one undo step).
 * Self-contained overlay: it owns its own pointer-capture drag and never touches
 * the main canvas gesture machine.
 */
function ConnectorDragLayer({
  api,
  clientToPage,
}: {
  api: CanvasApi;
  clientToPage: (clientX: number, clientY: number) => { x: number; y: number };
}): React.ReactElement | null {
  const selection = useEditor((s) => s.selection);
  useEditor((s) => s.rev); // re-render when geometry changes
  useEditor((s) => s.viewport); // re-render on pan/zoom
  const [drag, setDrag] = useState<
    null | { fromId: string; anchor: string; startPage: { x: number; y: number }; curPage: { x: number; y: number }; over: string | null }
  >(null);

  const doc = useEditor.getState().doc;
  const selId = selection.length === 1 ? selection[0] : null;
  const selNode = selId ? locate(doc, selId)?.node : null;
  const canEdit = usePresence.getState().canEdit() && !useEditor.getState().readonlyPreview();
  const connectable =
    !!selNode &&
    !!selId &&
    canEdit &&
    CONNECTABLE_TYPES.has(selNode.type) &&
    !selNode.locked &&
    !usePresence.getState().collabLockedByOther(selId) &&
    !useBrand.getState().isLockedRegion(selId) &&
    !usePresence.getState().protectedByOther(selId);

  // Keep rendering during a drag even if the selection box updates.
  const sourceId = drag?.fromId ?? (connectable ? selId! : null);
  if (!sourceId) return null;
  const box = worldAABB(doc, sourceId);
  if (!box) return null;

  const mids: { anchor: string; p: { x: number; y: number } }[] = [
    { anchor: "top", p: { x: box.x + box.width / 2, y: box.y } },
    { anchor: "right", p: { x: box.x + box.width, y: box.y + box.height / 2 } },
    { anchor: "bottom", p: { x: box.x + box.width / 2, y: box.y + box.height } },
    { anchor: "left", p: { x: box.x, y: box.y + box.height / 2 } },
  ];

  const onNubDown = (anchor: string, p: { x: number; y: number }) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ fromId: sourceId, anchor, startPage: p, curPage: p, over: null });
  };
  const onNubMove = (e: React.PointerEvent) => {
    setDrag((cur) => {
      if (!cur) return cur;
      const page = clientToPage(e.clientX, e.clientY);
      const hit = api.scene()?.hitTest(page);
      let over: string | null = null;
      if (hit) {
        const top = topAncestorId(useEditor.getState().doc, hit.id);
        const n = locate(useEditor.getState().doc, top)?.node;
        if (top !== cur.fromId && n && n.type !== "connector") over = top;
      }
      return { ...cur, curPage: page, over };
    });
  };
  const onNubUp = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    setDrag((cur) => {
      if (!cur) return null;
      if (cur.over) {
        // Released over a node: connect the two (connect-on-hover).
        useEditor.getState().connectNodes(cur.fromId, cur.over, cur.anchor, "auto");
      } else {
        // Released in empty space: spawn a connected shape at the cursor and keep
        // the chain going (FR-7 spawn-shape-from-handle), but only past a small
        // drag threshold so an accidental click on a nub does nothing.
        const moved = Math.hypot(cur.curPage.x - cur.startPage.x, cur.curPage.y - cur.startPage.y);
        if (moved > 16) useEditor.getState().spawnConnectedShape(cur.fromId, cur.anchor, cur.curPage);
      }
      return null;
    });
  };

  const overBox = drag?.over ? worldAABB(useEditor.getState().doc, drag.over) : null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      {drag && (() => {
        const a = api.toScreen(drag.startPage);
        const b = api.toScreen(drag.curPage);
        return (
          <svg className="absolute inset-0 h-full w-full overflow-visible">
            {overBox && (() => {
              const tl = api.toScreen({ x: overBox.x, y: overBox.y });
              const br = api.toScreen({ x: overBox.x + overBox.width, y: overBox.y + overBox.height });
              return (
                <rect
                  x={tl.x}
                  y={tl.y}
                  width={br.x - tl.x}
                  height={br.y - tl.y}
                  fill="none"
                  stroke="#4f46e5"
                  strokeWidth={2}
                  rx={6}
                />
              );
            })()}
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#4f46e5" strokeWidth={2} strokeDasharray="6 4" />
            <circle cx={b.x} cy={b.y} r={4} fill="#4f46e5" />
          </svg>
        );
      })()}
      {mids.map((m) => {
        const s = api.toScreen(m.p);
        const d = NUB_DIR[m.anchor];
        return (
          <button
            key={m.anchor}
            type="button"
            title="Drag to connect to another node"
            aria-label={`Connect from ${m.anchor}`}
            className="pointer-events-auto absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[color:var(--color-selection)] shadow ring-1 ring-[color:var(--color-selection)] transition hover:scale-125"
            style={{ left: s.x + d.x, top: s.y + d.y, touchAction: "none" }}
            onPointerDown={onNubDown(m.anchor, m.p)}
            onPointerMove={onNubMove}
            onPointerUp={onNubUp}
          />
        );
      })}
    </div>
  );
}

// Inline editor for a connector's label (F30 FR-8): a small input centered on the
// connector's routed bounds. Enter/blur commits via the store (undoable); Escape
// cancels. Reused look from the sticky overlay.
function ConnectorLabelOverlay({ api, id, onClose }: { api: CanvasApi; id: string; onClose: () => void }) {
  useEditor((s) => s.rev);
  useEditor((s) => s.viewport);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    const n = locate(useEditor.getState().doc, id)?.node as unknown as { label?: { text?: string } } | undefined;
    if (el) {
      el.value = n?.label?.text ?? "";
      el.focus();
      el.select();
    }
  }, [id]);
  const b = api.scene()?.connectorBounds(id);
  if (!b) return null;
  const c = api.toScreen({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  const commit = () => {
    const el = ref.current;
    if (el) useEditor.getState().setConnectorLabel(id, el.value);
    onClose();
  };
  return (
    <input
      ref={ref}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); onClose(); }
        else if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); commit(); }
      }}
      placeholder="Label"
      aria-label="Connector label"
      className="absolute z-30 rounded-md border-2 border-[color:var(--color-selection)] bg-white px-1.5 py-0.5 text-center text-xs text-neutral-800 shadow outline-none"
      style={{ left: c.x, top: c.y, width: 120, transform: "translate(-50%, -50%)" }}
    />
  );
}

/**
 * Connector waypoint editor (F30 FR-8). For a single selected connector it shows
 * a draggable handle at each bend waypoint (drag to move, double-click to remove)
 * plus a "+" at the routed-line center to add a bend. Each edit commits as one
 * undo step via the store; the engine re-routes the line on commit.
 */
function ConnectorEditLayer({
  api,
  clientToPage,
}: {
  api: CanvasApi;
  clientToPage: (clientX: number, clientY: number) => { x: number; y: number };
}): React.ReactElement | null {
  const selection = useEditor((s) => s.selection);
  useEditor((s) => s.rev);
  useEditor((s) => s.viewport);
  const [drag, setDrag] = useState<{ index: number; page: { x: number; y: number } } | null>(null);

  const canEdit = usePresence.getState().canEdit() && !useEditor.getState().readonlyPreview();
  const doc = useEditor.getState().doc;
  const loc = selection.length === 1 ? locate(doc, selection[0]) : null;
  if (!canEdit || !loc || loc.node.type !== "connector" || loc.node.locked || usePresence.getState().collabLockedByOther(loc.node.id) || usePresence.getState().protectedByOther(loc.node.id)) {
    return null;
  }
  const conn = loc.node as unknown as {
    id: string;
    route: "straight" | "elbow" | "curved";
    start: { point?: { x: number; y: number }; attach?: { nodeId: string; anchor: string } };
    end: { point?: { x: number; y: number }; attach?: { nodeId: string; anchor: string } };
    waypoints?: { x: number; y: number }[];
  };
  const wps = conn.waypoints ?? [];
  const commit = (pts: { x: number; y: number }[]) => useEditor.getState().setConnectorWaypoints(conn.id, pts);

  const onHandleDown = (index: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ index, page: wps[index] });
  };
  const onHandleMove = (e: React.PointerEvent) => {
    setDrag((cur) => (cur ? { ...cur, page: clientToPage(e.clientX, e.clientY) } : cur));
  };
  const onHandleUp = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    setDrag((cur) => {
      if (cur) commit(wps.map((w, i) => (i === cur.index ? cur.page : w)));
      return null;
    });
  };
  const removeAt = (index: number) => commit(wps.filter((_, i) => i !== index));
  const addBend = () => {
    // Place the new bend ON the routed line: the midpoint of its middle segment
    // (always on the polyline, unlike the bounding-box center for elbow/curved).
    const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
    for (const ep of [conn.start, conn.end]) {
      const nid = ep?.attach?.nodeId;
      if (nid) {
        const bb = worldAABB(doc, nid);
        if (bb) boxes[nid] = bb;
      }
    }
    const pts = routeConnector({ route: conn.route, start: conn.start, end: conn.end, waypoints: wps }, boxes);
    let mid: { x: number; y: number };
    if (pts.length >= 2) {
      const s = Math.floor((pts.length - 1) / 2); // middle segment
      mid = { x: (pts[s].x + pts[s + 1].x) / 2, y: (pts[s].y + pts[s + 1].y) / 2 };
    } else {
      const b = api.scene()?.connectorBounds(conn.id);
      if (!b) return;
      mid = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
    const at = Math.floor(wps.length / 2);
    commit([...wps.slice(0, at), mid, ...wps.slice(at)]);
  };

  const bounds = api.scene()?.connectorBounds(conn.id);
  const addPt = bounds ? api.toScreen({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }) : null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      {wps.map((w, i) => {
        const p = api.toScreen(drag && drag.index === i ? drag.page : w);
        return (
          <button
            key={`wp-${i}`}
            type="button"
            title="Drag to bend; double-click to remove"
            aria-label={`Connector bend ${i + 1}`}
            className="pointer-events-auto absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-amber-500 shadow ring-1 ring-amber-300 transition hover:scale-125"
            style={{ left: p.x, top: p.y, touchAction: "none" }}
            onPointerDown={onHandleDown(i)}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); removeAt(i); }}
          />
        );
      })}
      {addPt && !drag && (
        <button
          type="button"
          title="Add a bend"
          aria-label="Add connector bend"
          className="pointer-events-auto absolute grid h-4 w-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white bg-amber-400/80 text-[10px] font-bold text-white shadow hover:scale-125"
          style={{ left: addPt.x, top: addPt.y, touchAction: "none" }}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); addBend(); }}
        >
          +
        </button>
      )}
    </div>
  );
}

export function Canvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The focusable surface wrapper (tabIndex=0, role=application). Keyboard
  // selection/cycling only fires while this element owns focus, so Tab can still
  // move focus out to the side panels when the canvas is not focused.
  const surfaceRef = useRef<HTMLDivElement>(null);
  const api = useEditorCanvas(canvasRef);
  const gesture = useRef<Gesture>({ type: "none" });
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // The inline text-edit target lives in the store (single source of truth), so
  // the renderer's "skip this node" and the HTML overlay flip in the SAME render.
  // (A deferred mirror caused a 1-frame double/missing flicker.)
  const editing = useEditor((s) => s.editingTextId);
  const setEditing = (id: string | null) => useEditor.getState().setEditingText(id);
  const [editingSticky, setEditingSticky] = useState<string | null>(null);
  // Connector whose label is being edited (F30 FR-8); opened by double-click.
  const [editingConnectorLabel, setEditingConnectorLabel] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] } | null>(null);
  // Pen rubber-band: cursor position (screen) for the preview from the last anchor.
  const [penPreview, setPenPreview] = useState<{ x: number; y: number } | null>(null);
  // Pencil (freehand): collected page-space points and a screen-space preview
  // polyline drawn live while dragging; fit to a path on release.
  const pencilStroke = useRef<{ x: number; y: number }[] | null>(null);
  const [pencilPreview, setPencilPreview] = useState<{ x: number; y: number }[] | null>(null);
  // Board ink stroke (F30): captured with optional pen pressure; committed to an
  // `ink` node on pointer-up. Reuses the pencil preview overlay for the live line.
  const inkStroke = useRef<{ x: number; y: number; p?: number }[] | null>(null);
  // Object-eraser drag (F30): true while the eraser pointer is down so move events
  // keep erasing strokes/objects swept under the cursor.
  const erasing = useRef(false);
  // Manual guide being dragged (from a ruler = index null, or an existing one).
  const [guideDrag, setGuideDrag] = useState<{ axis: "x" | "y"; index: number | null; pos: number } | null>(null);
  // True while the focusable canvas surface owns keyboard focus. Tracked in a ref
  // (read imperatively from the window keydown handler) so Tab/Enter/Escape
  // selection shortcuts only fire when the canvas is focused, and Tab still moves
  // browser focus out to the side panels when it is not. Set from focus/blur on
  // the surface wrapper, so render stays pure.
  const surfaceFocused = useRef(false);
  // Spacebar held: while true, a left-drag pans the viewport instead of selecting.
  // Tracked in a ref (set from the keydown/keyup effect) so render stays pure.
  const spaceHeld = useRef(false);
  // Active viewport pan gesture (Space-drag or middle-button drag): the screen
  // point where the drag began and the pan offset at that moment.
  const panning = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  // Active pointers by id (for multi-touch), and the live pinch gesture (FR-31):
  // two-finger pinch-zoom + pan about the fingers' midpoint.
  const pointers = useRef<Map<number, { clientX: number; clientY: number; type: string }>>(new Map());
  const pinch = useRef<{ startDist: number; startZoom: number; anchor: { x: number; y: number } } | null>(null);
  // Drives the grab/grabbing cursor while Space is held or a pan is in flight.
  const [spaceCursor, setSpaceCursor] = useState(false);
  // True when the select-tool pointer hovers a draggable node, so the canvas
  // shows a move cursor (Canva-style). The ref dedupes so we only re-render on a
  // change, not on every pointer move.
  const [hoverMove, setHoverMove] = useState(false);
  const hoverMoveRef = useRef(false);
  const tool = useEditor((s) => s.tool);
  const brush = useEditor((s) => s.brush);
  // Whiteboard surface enables drag-to-connect; harmless elsewhere (never shown).
  const isWhiteboard = useEditor((s) => (s.doc.meta as { kind?: string } | undefined)?.kind === "whiteboard");
  const canComment = useComments((s) => s.canComment);
  const selection = useEditor((s) => s.selection);
  const cropping = useEditor((s) => s.cropping);
  const viewport = useEditor((s) => s.viewport);
  const activePage = useEditor((s) => s.activePage);
  const showRulers = useEditor((s) => s.showRulers);
  const showGrid = useEditor((s) => s.showGrid);
  const gridSize = useEditor((s) => s.gridSize);
  const snapGuides = useEditor((s) => s.snapGuides);
  useEditor((s) => s.rev);
  const penDraft = useRef<{ id: string } | null>(null);
  const penDragging = useRef(false);
  const lineDraft = useRef<{ id: string; ox: number; oy: number } | null>(null);
  // Rectangle/ellipse drag-to-draw: the node id and the drag origin in page space.
  const drawDraft = useRef<{ id: string; ox: number; oy: number } | null>(null);
  // Show the node editor for a single selected path, including rotated/scaled
  // ones: PathEditor's toS and the store's editAnchor/editHandle go through the
  // node's full world matrix, so the math is correct under any transform.
  // Never mount it over a locked, brand-locked, or read-only path: the overlay
  // captures Delete in the capture phase (before the Canvas's canEdit guard),
  // so the gate has to live here too (belt-and-suspenders with the store gates).
  const singlePath = (() => {
    if (selection.length !== 1) return false;
    const id = selection[0];
    const n = locate(useEditor.getState().doc, id)?.node;
    if (n?.type !== "path") return false;
    if (n.locked || usePresence.getState().collabLockedByOther(id) || useBrand.getState().isLockedRegion(id) || usePresence.getState().protectedByOther(id)) return false;
    if (!usePresence.getState().canEdit() || useEditor.getState().readonlyPreview()) return false;
    return true;
  })();

  const finishPen = useCallbackRef(() => {
    penDraft.current = null;
    penDragging.current = false;
    lineDraft.current = null;
    drawDraft.current = null;
    pencilStroke.current = null;
    inkStroke.current = null;
    erasing.current = false;
    setPenPreview(null);
    setPencilPreview(null);
    useEditor.getState().setTool("select");
  });

  // Abandon any in-progress single-pointer gesture/draft WITHOUT changing the tool
  // or committing anything. Used when a pinch takes over (FR-31) and on pointer
  // cancel, so a leftover finger can't resume a move/marquee/erase/draw afterward.
  const cancelInteraction = useCallbackRef(() => {
    gesture.current = { type: "none" };
    penDraft.current = null;
    penDragging.current = false;
    lineDraft.current = null;
    drawDraft.current = null;
    pencilStroke.current = null;
    inkStroke.current = null;
    erasing.current = false;
    setPenPreview(null);
    setPencilPreview(null);
    setMarquee(null);
  });

  function onPenDown(e: React.PointerEvent) {
    const page = api.toPage(localPoint(e));
    const store = useEditor.getState();
    if (!penDraft.current) {
      penDraft.current = { id: store.penStart(page.x, page.y) };
    } else {
      const id = penDraft.current.id;
      const loc = locate(store.doc, id);
      if (loc?.node.type === "path") {
        const n = loc.node as unknown as { transform: { x: number; y: number }; segments: { x: number; y: number }[] };
        const first = n.segments[0];
        if (first && n.segments.length > 1) {
          const fs = api.toScreen({ x: n.transform.x + first.x, y: n.transform.y + first.y });
          const sp = localPoint(e);
          if (Math.hypot(fs.x - sp.x, fs.y - sp.y) < 12) {
            store.penClose(id);
            finishPen();
            return;
          }
        }
      }
      store.penAdd(id, page.x, page.y);
    }
    penDragging.current = true;
    canvasRef.current?.setPointerCapture(e.pointerId);
  }

  function onDoubleClick(e: React.MouseEvent) {
    if (penDraft.current) {
      finishPen();
      return;
    }
    // Activate the page under the cursor so the hit-test (which uses the live
    // active page's scene + coords) resolves on the right page in continuous scroll.
    const cp = api.pageIndexAt(localPoint(e));
    if (cp >= 0 && cp !== useEditor.getState().activePage) useEditor.getState().setActivePage(cp);
    const page = api.toPage(localPoint(e));
    const hit = api.scene()?.hitTest(page);
    if (!hit) {
      // Empty board canvas: double-click drops a sticky at the cursor and opens
      // it for immediate typing (F30 sticky speed).
      if (isWhiteboard && usePresence.getState().canEdit() && !useEditor.getState().readonlyPreview()) {
        const id = useEditor.getState().addStickyAt(page.x, page.y);
        setEditingSticky(id);
      }
      return;
    }
    const loc = locate(useEditor.getState().doc, hit.id);
    // Locked (static flag), collab-locked by another user, or a brand locked
    // region for this caller: no edit/crop entry.
    if (loc?.node.locked || usePresence.getState().collabLockedByOther(hit.id) || useBrand.getState().isLockedRegion(hit.id) || usePresence.getState().protectedByOther(hit.id)) return;
    // Double-click selects the leaf under the cursor - entering a group to grab a
    // child, and triggering text edit / image crop where applicable.
    useEditor.getState().select([hit.id]);
    if (loc?.node.type === "text") {
      setEditing(hit.id);
    } else if (loc?.node.type === "sticky") {
      // Whiteboard sticky: open a plain-text edit overlay.
      setEditingSticky(hit.id);
    } else if (loc?.node.type === "connector") {
      // Whiteboard connector: edit its label (F30 FR-8).
      setEditingConnectorLabel(hit.id);
    } else if (loc?.node.type === "image" && canCrop(loc.node.transform)) {
      useEditor.getState().setCropping(hit.id);
    }
  }

  // Drop an image dragged from the Uploads/Stock panel: into a frame under the
  // cursor, otherwise as a new image centered on the drop point.
  function onDrop(e: React.DragEvent) {
    const page = api.toPage(localPoint(e));
    const doc = useEditor.getState().doc;
    const hit = api.scene()?.hitTest(page);
    let frameId: string | null = null;
    if (hit) {
      const loc = locate(doc, hit.id);
      if (hit.type === "frame") frameId = hit.id;
      else if (loc?.parent?.type === "frame") frameId = loc.parent.id;
    }
    // OS file drop (dragged from the desktop): read each image file and place it.
    const files = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      if (!usePresence.getState().canEdit() || useEditor.getState().readonlyPreview()) return;
      files.forEach((file, i) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result !== "string") return;
          const st = useEditor.getState();
          if (i === 0 && frameId) st.setFrameImage(frameId, reader.result);
          else if (i === 0 && hit && hit.type === "shape") st.setImageFill(hit.id, reader.result);
          else st.addImage(reader.result, { x: page.x + i * 12, y: page.y + i * 12 });
        };
        reader.readAsDataURL(file);
      });
      return;
    }
    // Otherwise an in-app drag (Uploads/Stock panel) or a dragged URL.
    const url = e.dataTransfer.getData("application/x-oc-image") || e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (!url || !/^(https?:|data:|blob:|\/)/.test(url)) return;
    e.preventDefault();
    if (frameId) useEditor.getState().setFrameImage(frameId, url);
    else if (hit && hit.type === "shape") useEditor.getState().setImageFill(hit.id, url);
    else useEditor.getState().addImage(url, page);
  }

  function localPoint(e: { clientX: number; clientY: number }) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // Client (viewport) coords -> page coords, for overlays (drag-to-connect) that
  // get raw pointer events outside the canvas's own handlers.
  const clientToPage = (clientX: number, clientY: number) =>
    api.toPage(localPoint({ clientX, clientY }));

  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    const store = useEditor.getState();
    const hit = api.scene()?.hitTest(api.toPage(localPoint(e)));
    if (hit && !store.selection.includes(hit.id)) store.select([hit.id]);
    // Clamp the menu so it stays fully on-canvas even near the right/bottom edge
    // (estimate its size from whether there is a selection).
    const p = localPoint(e);
    const surf = surfaceRef.current;
    const MENU_W = 232;
    const menuH = (hit || store.selection.length > 0) ? 470 : 80;
    let { x, y } = p;
    if (surf) {
      x = Math.max(8, Math.min(x, surf.clientWidth - MENU_W - 8));
      y = Math.max(8, Math.min(y, surf.clientHeight - menuH - 8));
    }
    setCtxMenu({ x, y });
  }

  function onPointerDown(e: React.PointerEvent) {
    setCtxMenu(null);
    // Focus the canvas surface on pointer-down so keyboard shortcuts and Tab/Enter
    // selection work right after a click (a11y). Harmless when already focused;
    // overlays that mount later (text/sticky edit) re-focus their own field.
    surfaceRef.current?.focus({ preventScroll: true });

    // --- Touch / stylus input (FR-31) -------------------------------------
    pointers.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY, type: e.pointerType });
    const touchPts = [...pointers.current.values()].filter((p) => p.type === "touch");
    const penDown = [...pointers.current.values()].some((p) => p.type === "pen");
    // Palm rejection: ignore touch contacts while a pen is down (pen draws, the
    // resting palm/finger does not).
    if (e.pointerType === "touch" && penDown) {
      pointers.current.delete(e.pointerId);
      return;
    }
    // Two fingers: pinch-zoom + pan about the fingers' midpoint. Cancels any
    // single-pointer gesture (move/marquee/erase/draw/pan) so a leftover finger
    // can't resume it after the pinch ends, and clears the grab cursor.
    if (touchPts.length >= 2) {
      const [a, b] = touchPts;
      const mid = localPoint({ clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 });
      pinch.current = {
        startDist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
        startZoom: useEditor.getState().viewport.zoom,
        anchor: api.toPage(mid),
      };
      panning.current = null;
      cancelInteraction();
      setSpaceCursor(false);
      e.preventDefault();
      return;
    }
    // One finger while a DRAW/create tool is active: pan instead of drawing, so a
    // finger repositions the board while the pen draws (FR-31). Direct-manipulation
    // tools (select/comment/eraser/laser) still act on a single finger; two fingers
    // always navigate.
    if (e.pointerType === "touch" && touchPts.length === 1) {
      const dt = useEditor.getState().tool;
      const drawTool = dt === "pen" || dt === "pencil" || dt === "ink" || dt === "line" || dt === "arrow" || dt === "rect" || dt === "ellipse";
      if (drawTool) {
        const vp = useEditor.getState().viewport;
        const s = localPoint(e);
        panning.current = { startX: s.x, startY: s.y, panX: vp.panX, panY: vp.panY };
        setSpaceCursor(true);
        canvasRef.current?.setPointerCapture(e.pointerId);
        return;
      }
    }

    // Viewport pan: middle-button drag (any time) or a left-drag while Space is
    // held. Pans via setViewport, accounting for zoom (screen px / zoom = page
    // px), and works even during a read-only history preview so the user can
    // navigate. Starts before the preview/button gates so it is never swallowed.
    if (e.button === 1 || (e.button === 0 && spaceHeld.current)) {
      e.preventDefault();
      const vp = useEditor.getState().viewport;
      const s = localPoint(e);
      panning.current = { startX: s.x, startY: s.y, panX: vp.panX, panY: vp.panY };
      setSpaceCursor(true);
      canvasRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    // History preview is read-only: block selection/draw/edit
    // gestures. Wheel pan/zoom still works, so the user can navigate the preview.
    if (useEditor.getState().preview) return;
    if (e.button !== 0) return;
    // Continuous multi-page scroll: activate the clicked page first, so this
    // same gesture selects/edits/inserts on it (the coord helpers read the live
    // active page). Single-page docs always resolve to page 0, so this is a
    // no-op there. No early return - one click both focuses and selects.
    const clickedPage = api.pageIndexAt(localPoint(e));
    if (clickedPage >= 0 && clickedPage !== useEditor.getState().activePage) {
      useEditor.getState().setActivePage(clickedPage);
    }
    const t = useEditor.getState().tool;
    if (t === "comment") {
      // Drop a comment anchor at the click point: to the clicked
      // element if one is under the cursor, otherwise a freeform point on the
      // active page. The composer opens from the draft anchor; reset to select.
      const page = api.toPage(localPoint(e));
      const store = useEditor.getState();
      const hit = api.scene()?.hitTest(page);
      const pageNode = store.doc.pages[Math.min(store.activePage, store.doc.pages.length - 1)];
      const anchor = hit
        ? { kind: "element" as const, nodeId: hit.id, pageId: pageNode?.id }
        : { kind: "region" as const, pageId: pageNode?.id, x: page.x, y: page.y };
      useComments.getState().setDraftAnchor(anchor);
      store.setTool("select");
      return;
    }
    if (t === "pen") {
      onPenDown(e);
      return;
    }
    if (t === "pencil") {
      const page = api.toPage(localPoint(e));
      pencilStroke.current = [page];
      setPencilPreview([localPoint(e)]);
      canvasRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    if (t === "ink") {
      const page = api.toPage(localPoint(e));
      // Capture pen pressure only for a real stylus; mouse/touch leave it unset so
      // the stroke renders at full, even width.
      const p = e.pointerType === "pen" ? e.pressure : undefined;
      inkStroke.current = [{ ...page, p }];
      setPencilPreview([localPoint(e)]);
      canvasRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    if (t === "laser") {
      // The laser is an ephemeral pointer, not an editing tool: broadcast the
      // beam and do nothing else (no select/marquee).
      feedCursor(e);
      return;
    }
    if (t === "eraser") {
      erasing.current = true;
      eraseAtPoint(e);
      canvasRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    if (t === "stamp") {
      // Drop an emoji/vote stamp at the click point (FR-21), recording the placer
      // for dot-vote tally. Stay on the tool for rapid repeated stamping.
      const page = api.toPage(localPoint(e));
      useEditor.getState().addStampAt(page.x, page.y, usePresence.getState().self?.userId);
      return;
    }
    if (t === "line" || t === "arrow") {
      const page = api.toPage(localPoint(e));
      lineDraft.current = { id: useEditor.getState().addLine(page.x, page.y, t === "arrow"), ox: page.x, oy: page.y };
      canvasRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    if (t === "rect" || t === "ellipse") {
      const page = api.toPage(localPoint(e));
      const id = useEditor.getState().addShapeAt(page.x, page.y, t);
      drawDraft.current = { id, ox: page.x, oy: page.y };
      canvasRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    if (t === "text") {
      const page = api.toPage(localPoint(e));
      // Center the new text box on the click point, then open the editor.
      const id = useEditor.getState().addTextAt(page.x - 120, page.y - 22);
      gesture.current = { type: "none" }; // we switch to select but skip the up-gesture
      useEditor.getState().setTool("select");
      setEditing(id);
      return;
    }
    const screen = localPoint(e);
    const page = api.toPage(screen);
    const scene = api.scene();
    const store = useEditor.getState();
    const hit = scene?.hitTest(page);

    // Select-under (Cmd/Meta-click): reach a buried object by stepping down the
    // stack of items under the cursor instead of always taking the top-most.
    // Builds the stack top-most-first from the top-level nodes whose bounds cover
    // the point; if something already selected sits in that stack, picks the next
    // node below it (wrapping to the deepest). Selection is not undoable, so this
    // is a single select() with no command pushed. Meta is used (not Alt) so the
    // beloved Alt-drag-to-duplicate gesture below stays intact.
    if (hit && (e.metaKey || e.ctrlKey) && scene) {
      const a = api.toPage({ x: screen.x - 1, y: screen.y - 1 });
      const b = api.toPage({ x: screen.x + 1, y: screen.y + 1 });
      const probe = { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
      // hitTestRect returns top-level nodes in paint order (bottom-first); reverse
      // to front-first, fold to top ancestors, and dedupe while preserving order.
      const stack: string[] = [];
      for (const n of scene.hitTestRect(probe, "intersect").reverse()) {
        const id = topAncestorId(store.doc, n.id);
        if (!stack.includes(id)) stack.push(id);
      }
      if (stack.length) {
        const cur = stack.findIndex((id) => store.selection.includes(id));
        const next = cur >= 0 ? stack[(cur + 1) % stack.length] : stack[stack.length - 1];
        store.select([next]);
        const loc = locate(store.doc, next);
        const before = new Map<string, Transform>();
        if (loc && !loc.node.locked && !usePresence.getState().collabLockedByOther(next) && !useBrand.getState().isLockedRegion(next) && !usePresence.getState().protectedByOther(next)) {
          before.set(next, { ...loc.node.transform });
        }
        gesture.current = { type: "move", startX: page.x, startY: page.y, before };
        canvasRef.current?.setPointerCapture(e.pointerId);
        return;
      }
    }

    if (hit) {
      // Select the group as a unit on a single click (double-click enters it).
      const selId = topAncestorId(store.doc, hit.id);
      // Alt/Option-drag duplicates the selection and drags the copies.
      if (e.altKey) {
        if (!store.selection.includes(selId)) store.select([selId]);
        store.duplicateSelection(0, 0);
        const dup = new Map<string, Transform>();
        for (const id of useEditor.getState().selection) {
          const loc = locate(useEditor.getState().doc, id);
          if (loc) dup.set(id, { ...loc.node.transform });
        }
        gesture.current = { type: "move", startX: page.x, startY: page.y, before: dup };
        canvasRef.current?.setPointerCapture(e.pointerId);
        return;
      }
      if (e.shiftKey) store.toggle(selId);
      else if (!store.selection.includes(selId)) store.select([selId]);
      const ids = useEditor.getState().selection;
      const before = new Map<string, Transform>();
      for (const id of ids) {
        const loc = locate(store.doc, id);
        // Exclude statically-locked nodes, collab-locked-by-others,
        // and brand locked regions for this caller from the
        // move set; selection/marquee still work normally.
        if (loc && !loc.node.locked && !usePresence.getState().collabLockedByOther(id) && !useBrand.getState().isLockedRegion(id) && !usePresence.getState().protectedByOther(id)) {
          before.set(id, { ...loc.node.transform });
        }
      }
      gesture.current = { type: "move", startX: page.x, startY: page.y, before };
    } else {
      if (!e.shiftKey) store.clearSelection();
      gesture.current = { type: "marquee", startX: screen.x, startY: screen.y };
    }
    canvasRef.current?.setPointerCapture(e.pointerId);
  }

  // Push the local cursor (in PAGE coords) as realtime presence on every move.
  // The client throttles outbound frames; identity/selection/viewport are added
  // by the client/store. No-op when realtime is not connected (local doc).
  function feedCursor(e: { clientX: number; clientY: number }) {
    const store = useEditor.getState();
    const page = api.toPage(localPoint(e));
    // Laser tool (FR-17): broadcast an ephemeral, never-persisted laser position
    // and echo it locally so the sender sees their own beam. Cleared when the
    // tool is not the laser, so switching tools drops the beam at once.
    const lasering = store.tool === "laser";
    const laser = lasering ? { x: page.x, y: page.y, at: serverNow() } : null;
    usePresence.getState().setSelfLaser(laser);
    const client = getRealtimeClient();
    if (!client) return;
    client.sendPresence({
      cursor: { x: page.x, y: page.y },
      selection: store.selection,
      viewport: store.viewport,
      following: usePresence.getState().following,
      laser,
    });
  }

  // Object-eraser (F30 FR-4): remove the whole stroke/object under the cursor.
  // Hit-test the scene, resolve to the top-level ancestor (so erasing a grouped
  // child removes the object, not just a leaf), and delete it as one undo step.
  // Gated like every other board mutation.
  function eraseAtPoint(e: { clientX: number; clientY: number }) {
    if (!usePresence.getState().canEdit() || useEditor.getState().readonlyPreview()) return;
    const hit = api.scene()?.hitTest(api.toPage(localPoint(e)));
    if (!hit) return;
    const top = topAncestorId(useEditor.getState().doc, hit.id);
    if (top) useEditor.getState().eraseNode(top);
  }

  function onPointerLeave() {
    // Drop the hover-move cursor when the pointer leaves the surface.
    if (hoverMoveRef.current) {
      hoverMoveRef.current = false;
      setHoverMove(false);
    }
    // Clear our cursor (and any laser beam) for peers when the pointer leaves the
    // canvas (FR-5/FR-17).
    usePresence.getState().setSelfLaser(null);
    getRealtimeClient()?.sendPresence({
      cursor: null,
      selection: useEditor.getState().selection,
      viewport: useEditor.getState().viewport,
      following: usePresence.getState().following,
      laser: null,
    });
  }

  function onPointerMove(e: React.PointerEvent) {
    // Keep the multi-touch tracker current, then drive an active pinch (FR-31):
    // zoom by the finger-distance ratio and pan so the start page-anchor stays
    // under the moving midpoint (the wheel-zoom-about-cursor math).
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY, type: e.pointerType });
    }
    if (pinch.current) {
      const touchPts = [...pointers.current.values()].filter((p) => p.type === "touch");
      if (touchPts.length >= 2) {
        const [a, b] = touchPts;
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
        const mid = localPoint({ clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 });
        const zoom = Math.min(64, Math.max(0.02, pinch.current.startZoom * (dist / pinch.current.startDist)));
        useEditor.getState().setViewport({ zoom, panX: pinch.current.anchor.x - mid.x / zoom, panY: pinch.current.anchor.y - mid.y / zoom });
        e.preventDefault();
        return;
      }
    }
    feedCursor(e);
    if (panning.current) {
      const s = localPoint(e);
      const store = useEditor.getState();
      const zoom = store.viewport.zoom;
      // Drag the page with the cursor: moving the pointer right reveals content
      // to the left, so pan decreases by the screen delta (converted to page px).
      store.setViewport({
        panX: panning.current.panX - (s.x - panning.current.startX) / zoom,
        panY: panning.current.panY - (s.y - panning.current.startY) / zoom,
      });
      return;
    }
    const t = useEditor.getState().tool;
    if (t === "pen") {
      if (penDragging.current && penDraft.current) {
        const page = api.toPage(localPoint(e));
        useEditor.getState().penHandle(penDraft.current.id, page.x, page.y);
      } else if (penDraft.current) {
        setPenPreview(localPoint(e)); // rubber-band preview to the cursor
      }
      return;
    }
    if (t === "pencil" && pencilStroke.current) {
      const page = api.toPage(localPoint(e));
      pencilStroke.current.push(page);
      // Live raw-stroke preview in screen space (no fitting yet).
      setPencilPreview(pencilStroke.current.map((p) => api.toScreen(p)));
      return;
    }
    if (t === "ink" && inkStroke.current) {
      const page = api.toPage(localPoint(e));
      inkStroke.current.push({ ...page, p: e.pointerType === "pen" ? e.pressure : undefined });
      setPencilPreview(inkStroke.current.map((p) => api.toScreen(p)));
      return;
    }
    if (t === "eraser" && erasing.current) {
      eraseAtPoint(e);
      return;
    }
    if ((t === "line" || t === "arrow") && lineDraft.current) {
      const page = api.toPage(localPoint(e));
      useEditor.getState().updateLineEnd(lineDraft.current.id, page.x, page.y);
      return;
    }
    if ((t === "rect" || t === "ellipse") && drawDraft.current) {
      const page = api.toPage(localPoint(e));
      const { id, ox, oy } = drawDraft.current;
      let w = Math.abs(page.x - ox);
      let h = Math.abs(page.y - oy);
      if (e.shiftKey) w = h = Math.max(w, h); // square / circle
      // Extend from the origin in the drag direction.
      const x = page.x < ox ? ox - w : ox;
      const y = page.y < oy ? oy - h : oy;
      useEditor.getState().setNodeRect(id, x, y, w, h);
      return;
    }
    const g = gesture.current;
    if (g.type === "move") {
      const page = api.toPage(localPoint(e));
      const dx = page.x - g.startX;
      const dy = page.y - g.startY;
      const store = useEditor.getState();
      const doc = store.doc;
      for (const [id, start] of g.before) {
        const loc = locate(doc, id);
        if (!loc) continue;
        // Move in the node's parent space so children of transformed groups
        // track the cursor instead of sliding along the page axes.
        const pd = parentSpaceDelta(doc, id, dx, dy);
        const axisLock = e.shiftKey ? (Math.abs(pd.dx) >= Math.abs(pd.dy) ? "x" : "y") : undefined;
        loc.node.transform = moveTransform(start, pd.dx, pd.dy, axisLock);
      }
      // Snapping (top-level nodes only; Shift or snap-off = free move): grid when
      // the grid is shown, otherwise smart guides to other objects/page edges,
      // plus snapping to manual ruler guides on top of either.
      const movedIds = [...g.before.keys()];
      const pageNode = doc.pages[Math.min(store.activePage, doc.pages.length - 1)];
      const allTop = movedIds.every((id) => locate(doc, id)?.parent == null);
      if (allTop && store.snapEnabled && !e.shiftKey && pageNode) {
        const box = unionAABB(doc, movedIds);
        if (box) {
          const zoom = api.viewport().zoom;
          const threshold = 8 / zoom;
          let dx = 0, dy = 0;
          const gx2: number[] = [];
          const gy2: number[] = [];
          if (showGrid && gridSize > 0) {
            const tx = Math.round(box.x / gridSize) * gridSize;
            const ty = Math.round(box.y / gridSize) * gridSize;
            if (Math.abs(tx - box.x) <= threshold) dx = tx - box.x;
            if (Math.abs(ty - box.y) <= threshold) dy = ty - box.y;
          } else {
            const movingSet = new Set(movedIds);
            const statics = pageNode.children
              .filter((node) => !movingSet.has(node.id) && !node.hidden)
              .map((node) => worldAABB(doc, node.id))
              .filter((b): b is Rect => !!b);
            const res = snap(box, statics, { threshold, pageRect: { x: 0, y: 0, width: pageNode.width, height: pageNode.height } });
            dx = res.dx; dy = res.dy;
            gx2.push(...res.guidesX); gy2.push(...res.guidesY);
          }
          // Snap edges/center to manual ruler guides.
          const mg = store.guides[pageNode.id];
          const nearest = (lines: number[], edges: number[]) => {
            let best: { d: number; line: number } | null = null;
            for (const line of lines) for (const ed of edges) {
              const d = line - ed;
              if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line };
            }
            return best;
          };
          const rx = mg ? nearest(mg.x, [box.x + dx, box.x + dx + box.width / 2, box.x + dx + box.width]) : null;
          if (rx) { dx += rx.d; gx2.push(rx.line); }
          const ry = mg ? nearest(mg.y, [box.y + dy, box.y + dy + box.height / 2, box.y + dy + box.height]) : null;
          if (ry) { dy += ry.d; gy2.push(ry.line); }
          if (dx !== 0 || dy !== 0) {
            for (const id of movedIds) {
              const loc = locate(doc, id);
              if (loc) loc.node.transform = { ...loc.node.transform, x: loc.node.transform.x + dx, y: loc.node.transform.y + dy };
            }
          }
          setGuides(gx2.length || gy2.length ? { x: gx2, y: gy2 } : null);
        }
      } else {
        setGuides(null);
      }
      store.setTransforming(true);
      store.tick();
    } else if (g.type === "marquee") {
      const s = localPoint(e);
      setMarquee({
        x: Math.min(g.startX, s.x),
        y: Math.min(g.startY, s.y),
        w: Math.abs(s.x - g.startX),
        h: Math.abs(s.y - g.startY),
      });
    } else if (t === "select" && !spaceHeld.current) {
      // Idle hover: show a move cursor over a draggable node (Canva-style).
      const over = !!api.scene()?.hitTest(api.toPage(localPoint(e)));
      if (over !== hoverMoveRef.current) {
        hoverMoveRef.current = over;
        setHoverMove(over);
      }
    }
  }

  // Pointer cancelled (OS gesture takeover, palm rejection): forget it and tear
  // down EVERY in-progress interaction (pinch, pan, and any draw/select/erase
  // draft) and release capture, so nothing is left half-built or stuck (FR-31).
  function onPointerCancel(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if ([...pointers.current.values()].filter((p) => p.type === "touch").length < 2) pinch.current = null;
    panning.current = null;
    cancelInteraction();
    useEditor.getState().setTransforming(false);
    setSpaceCursor(spaceHeld.current);
    canvasRef.current?.releasePointerCapture?.(e.pointerId);
  }

  function onPointerUp(e: React.PointerEvent) {
    // End any live-transform fade (a move gesture just ended or never started).
    useEditor.getState().setTransforming(false);
    // Multi-touch bookkeeping: drop the lifted pointer and end the pinch once
    // fewer than two fingers remain (FR-31).
    const wasPinching = !!pinch.current;
    pointers.current.delete(e.pointerId);
    if (pinch.current) {
      const remaining = [...pointers.current.values()].filter((p) => p.type === "touch");
      if (remaining.length < 2) {
        pinch.current = null;
      } else {
        // A finger lifted but 2+ remain: re-baseline to the current first-two so
        // the surviving pair doesn't jump (their start distance/zoom/anchor reset).
        const [a, b] = remaining;
        const mid = localPoint({ clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 });
        pinch.current = {
          startDist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
          startZoom: useEditor.getState().viewport.zoom,
          anchor: api.toPage(mid),
        };
      }
    }
    if (wasPinching) {
      setSpaceCursor(false);
      return;
    }
    if (panning.current) {
      panning.current = null;
      // Keep the grab cursor only if Space is still held; otherwise restore it.
      setSpaceCursor(spaceHeld.current);
      canvasRef.current?.releasePointerCapture(e.pointerId);
      return;
    }
    const t = useEditor.getState().tool;
    if (t === "pen") {
      penDragging.current = false;
      canvasRef.current?.releasePointerCapture(e.pointerId);
      return;
    }
    if (t === "pencil") {
      const stroke = pencilStroke.current;
      pencilStroke.current = null;
      setPencilPreview(null);
      // Fit the freehand stroke to a smooth path (one undo step) and select it.
      // Keep the pencil tool active (like the pen tool) so multiple freehand
      // strokes can be drawn without reselecting the tool each time.
      if (stroke && stroke.length >= 2) useEditor.getState().addPencilPath(stroke);
      canvasRef.current?.releasePointerCapture(e.pointerId);
      return;
    }
    if (t === "ink") {
      const stroke = inkStroke.current;
      inkStroke.current = null;
      setPencilPreview(null);
      // Commit the stroke as an ink node (one undo step); keep the ink tool active
      // so consecutive strokes draw without reselecting it.
      if (stroke && stroke.length >= 1) useEditor.getState().addInkStroke(stroke);
      canvasRef.current?.releasePointerCapture(e.pointerId);
      return;
    }
    if (t === "eraser") {
      erasing.current = false;
      canvasRef.current?.releasePointerCapture(e.pointerId);
      return;
    }
    if (t === "line" || t === "arrow") {
      const draft = lineDraft.current;
      lineDraft.current = null;
      // A click without a drag leaves a zero-length line; give it a default span.
      if (draft) {
        const n = locate(useEditor.getState().doc, draft.id)?.node;
        if (n && n.size.width <= 1 && n.size.height <= 1) {
          useEditor.getState().updateLineEnd(draft.id, n.transform.x + 160, n.transform.y);
        }
      }
      useEditor.getState().setTool("select");
      canvasRef.current?.releasePointerCapture(e.pointerId);
      return;
    }
    if (t === "rect" || t === "ellipse") {
      const draft = drawDraft.current;
      drawDraft.current = null;
      // A click without a drag gives a sensible default-sized shape at the point.
      if (draft) {
        const n = locate(useEditor.getState().doc, draft.id)?.node;
        if (n && n.size.width <= 1 && n.size.height <= 1) {
          const dw = 200;
          const dh = t === "ellipse" ? 200 : 150;
          // Center the default shape on the click point.
          useEditor.getState().setNodeRect(draft.id, draft.ox - dw / 2, draft.oy - dh / 2, dw, dh);
        }
      }
      useEditor.getState().setTool("select");
      canvasRef.current?.releasePointerCapture(e.pointerId);
      return;
    }
    const g = gesture.current;
    const store = useEditor.getState();
    if (g.type === "move") {
      const after: Transform[] = [];
      const nodes: string[] = [];
      let moved = false;
      for (const [id, start] of g.before) {
        const loc = locate(store.doc, id);
        if (!loc) continue;
        nodes.push(id);
        after.push(loc.node.transform);
        if (loc.node.transform.x !== start.x || loc.node.transform.y !== start.y) moved = true;
      }
      if (moved && nodes.length) {
        const cmd: EditCommand = {
          kind: "transform",
          nodes,
          before: nodes.map((id) => g.before.get(id)!),
          after,
        };
        store.pushApplied([cmd]);
      }
    } else if (g.type === "marquee" && marquee && (marquee.w > 2 || marquee.h > 2)) {
      const scene = api.scene();
      if (scene) {
        const a = api.toPage({ x: marquee.x, y: marquee.y });
        const b = api.toPage({ x: marquee.x + marquee.w, y: marquee.y + marquee.h });
        const rect = { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
        const ids = marqueeSelect(scene, rect, "intersect");
        if (e.altKey) {
          // Alt-marquee subtracts the enclosed nodes from the current selection.
          const drop = new Set(ids);
          store.select(useEditor.getState().selection.filter((id) => !drop.has(id)));
        } else if (e.shiftKey) store.addToSelection(ids);
        else store.select(ids);
      }
    }
    gesture.current = { type: "none" };
    setMarquee(null);
    setGuides(null);
    canvasRef.current?.releasePointerCapture(e.pointerId);
  }

  // Wheel pan / ctrl-wheel zoom about the cursor. Attached as a NON-passive
  // native listener (below) so preventDefault actually suppresses the browser's
  // page zoom/scroll; React's onWheel is passive and cannot.
  const onWheel = useCallbackRef((e: WheelEvent) => {
    const store = useEditor.getState();
    const vp = store.viewport;
    if (e.ctrlKey || e.metaKey) {
      const screen = localPoint(e);
      // Gentle, incremental zoom about the cursor (~12% per notch, Canva-like)
      // instead of one coarse jump. Normalize line/page wheel deltas to pixels and
      // clamp the step so a single fast notch can't leap 50%->200%.
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16; // lines -> px
      else if (e.deltaMode === 2) dy *= 100; // pages -> px
      dy = Math.max(-60, Math.min(60, dy));
      const z = vp.zoom;
      const zoom = Math.min(64, Math.max(0.02, z * Math.exp(-dy * 0.0022)));
      // Keep the GLOBAL stacked page point under the cursor fixed (panX/panY are in
      // global space; using it directly also stops zoom from jumping off-page).
      const gx = vp.panX + screen.x / z;
      const gy = vp.panY + screen.y / z;
      store.setViewport({ zoom, panX: gx - screen.x / zoom, panY: gy - screen.y / zoom });
    } else {
      store.setViewport({ panX: vp.panX + e.deltaX / vp.zoom, panY: vp.panY + e.deltaY / vp.zoom });
    }
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      onWheel(e);
    };
    canvas.addEventListener("wheel", handler, { passive: false });
    return () => canvas.removeEventListener("wheel", handler);
  }, [onWheel]);

  // Keyboard: delete / undo / redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // Don't fire canvas shortcuts while typing in a field OR the rich-text
      // editor (a contentEditable div), or Backspace/arrows/Cmd+C would also
      // delete/nudge/copy the node behind the editor.
      if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable) return;
      // Hold-Space to pan: arm the grab cursor and let onPointerDown route a
      // left-drag to the viewport. Swallow Space so it doesn't scroll/activate a
      // focused control. Ignored above while typing in a field/editor.
      if (e.code === "Space" || e.key === " ") {
        if (!e.repeat) {
          e.preventDefault();
          spaceHeld.current = true;
          if (!panning.current) setSpaceCursor(true);
        }
        return;
      }
      const store = useEditor.getState();
      // The crop overlay and present mode own the keyboard; don't let canvas
      // shortcuts (delete/undo/nudge/...) mutate the doc underneath them. A
      // history preview is read-only too, so the same gate applies.
      if (store.cropping || store.presenting || store.preview) return;
      // Collab access gate (FR-9): a comment/view user (or a
      // design locked by an approval) is read-only, so every document-mutating
      // shortcut is refused here, mirroring the disabled Save button and the
      // pointer path's per-node guards. Navigation, selection, copy, tool
      // switching, undo/redo of the read-only session, and zoom stay available;
      // the server also rejects a viewer's mutations over the realtime gateway.
      // Per-node collab locks (a peer holding a node) are enforced inside the
      // store ops invoked here (deleteSelection/nudge/... skip locked nodes), so
      // the keyboard path inherits that guard without re-checking each node.
      const canEdit = usePresence.getState().canEdit();
      // Resolve modifier chords against the (possibly customized) shortcut scheme
      // for the remappable command set; non-command modifier keys fall through.
      const remapCmd = e.metaKey || e.ctrlKey || e.altKey ? commandForEvent(e) : null;
      const remapAction = remapCmd ? COMMAND_ACTIONS[remapCmd] : null;
      // Keyboard selection (a11y): when the canvas surface is focused, Tab /
      // Shift+Tab cycle the top-level selectable objects on the active page, and
      // Enter opens text-edit on a single text/sticky selection. These run before
      // the tool/edit branches so Tab is intercepted (preventDefault) rather than
      // moving browser focus, and only while the canvas is focused so Tab can
      // still escape to the side panels otherwise. Selection is view-only safe;
      // Enter mirrors the double-click lock gating (commit no-ops for viewers).
      if (e.key === "Tab" && surfaceFocused.current) {
        const ids = tabbableIds(store.doc.pages[Math.min(store.activePage, store.doc.pages.length - 1)]);
        // Nothing to cycle: let Tab move browser focus out to the panels.
        if (ids.length) {
          e.preventDefault();
          const cur = store.selection.length === 1 ? ids.indexOf(store.selection[0]) : -1;
          let next: string;
          if (cur < 0) next = e.shiftKey ? ids[ids.length - 1] : ids[0];
          else next = ids[(cur + (e.shiftKey ? -1 : 1) + ids.length) % ids.length];
          store.select([next]);
          return;
        }
      }
      if (e.key === "Enter" && surfaceFocused.current && !penDraft.current && store.selection.length === 1) {
        const id = store.selection[0];
        const node = locate(store.doc, id)?.node;
        const reachable =
          node &&
          !node.locked &&
          !usePresence.getState().collabLockedByOther(id) &&
          !useBrand.getState().isLockedRegion(id) &&
          !usePresence.getState().protectedByOther(id);
        if (reachable && node.type === "text") {
          e.preventDefault();
          setEditing(id);
          return;
        }
        if (reachable && node.type === "sticky") {
          e.preventDefault();
          setEditingSticky(id);
          return;
        }
      }
      if ((e.key === "Escape" || e.key === "Enter") && penDraft.current) {
        e.preventDefault();
        finishPen();
      } else if (e.key === "Escape" && store.selection.length) {
        e.preventDefault();
        store.clearSelection();
      } else if (
        !e.metaKey && !e.ctrlKey && !e.altKey && TOOL_KEYS[e.key.toLowerCase()] &&
        // On a whiteboard, P/L/T are owned by the board surface (P = ink pen,
        // L = laser, T = add text); skip them here so the design pen/line/text tools
        // don't double-fire with WhiteboardSurface's own handler (both are window-
        // level listeners). Read meta.kind live (the effect closure is created once).
        !((store.doc.meta as { kind?: string } | undefined)?.kind === "whiteboard" && ["p", "l", "t"].includes(e.key.toLowerCase()))
      ) {
        // Single-key tool shortcuts (Canva-style): V select, P pen, T text,
        // R rectangle, E ellipse, L line, A arrow. A read-only user may still
        // switch tools (the actual draw/mutate is refused at pointer/store level),
        // but never enter a content-creating draw tool that implies an edit.
        const next = TOOL_KEYS[e.key.toLowerCase()];
        if (next === "select") finishPen();
        else if (canEdit) store.setTool(next);
      } else if ((e.key === "Delete" || e.key === "Backspace") && store.selection.length) {
        if (!canEdit) return;
        e.preventDefault();
        store.deleteSelection();
      } else if (remapAction) {
        // Undo/redo, copy/cut, duplicate, select-all, group/ungroup, resolved
        // through the active (user-customizable) shortcut scheme.
        if (remapAction.edit && !canEdit) return;
        e.preventDefault();
        remapAction.run(store);
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "]" || e.key === "[")) {
        if (!canEdit) return;
        e.preventDefault();
        store.orderSelection(e.key === "]" ? "forward" : "backward");
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0")) {
        e.preventDefault();
        if (e.key === "0") store.fitToScreen();
        else {
          const { zoom, panX, panY } = store.viewport;
          const vs = store.viewportSize;
          const z2 = zoom * (e.key === "-" ? 1 / 1.2 : 1.2);
          const cx = panX + vs.width / 2 / zoom;
          const cy = panY + vs.height / 2 / zoom;
          store.setViewport({ zoom: z2, panX: cx - vs.width / 2 / z2, panY: cy - vs.height / 2 / z2 });
        }
      } else if (e.key.startsWith("Arrow") && store.selection.length) {
        if (!canEdit) return;
        e.preventDefault();
        const s = e.shiftKey ? 10 : 1;
        const d: Record<string, [number, number]> = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] };
        const v = d[e.key];
        if (v) store.nudge(v[0], v[1]);
      } else if (e.shiftKey && e.code === "Digit1") {
        e.preventDefault();
        store.fitToScreen();
      } else if (e.shiftKey && e.code === "Digit2") {
        e.preventDefault();
        store.zoomToSelection();
      }
    };
    // Release Space: drop the pan arming and restore the cursor (unless a pan
    // gesture is still mid-drag, which clears itself on pointer-up).
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.key === " ") {
        spaceHeld.current = false;
        if (!panning.current) setSpaceCursor(false);
      }
    };
    // System-clipboard paste (Canva-style): paste an image/screenshot or text
    // copied from anywhere, or our own copied elements (cross-tab/refresh). Runs
    // on the native paste event because that is the only place clipboard files
    // are exposed. Fields/the rich-text editor handle their own paste.
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement | null;
      const active = document.activeElement as HTMLElement | null;
      const editable = (n: HTMLElement | null) => !!n && (n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.isContentEditable);
      if (editable(el) || editable(active)) return;
      const store = useEditor.getState();
      if (store.cropping || store.presenting || store.preview) return;
      if (!usePresence.getState().canEdit() || store.readonlyPreview()) return;
      const dt = e.clipboardData;
      if (!dt) return;
      // 1) Image(s) on the clipboard -> image node(s).
      const images = Array.from(dt.items).filter((it) => it.kind === "file" && it.type.startsWith("image/"));
      if (images.length) {
        e.preventDefault();
        for (const it of images) {
          const file = it.getAsFile();
          if (!file) continue;
          const reader = new FileReader();
          reader.onload = () => { if (typeof reader.result === "string") useEditor.getState().addImage(reader.result); };
          reader.readAsDataURL(file);
        }
        return;
      }
      // 2) Text: our own copied elements (marker) -> nodes; else a text box.
      const text = dt.getData("text/plain");
      if (text && text.startsWith(OC_CLIP_PREFIX)) {
        e.preventDefault();
        try {
          const nodes = JSON.parse(text.slice(OC_CLIP_PREFIX.length));
          if (Array.isArray(nodes) && nodes.length) store.pasteNodes(nodes);
        } catch { /* ignore malformed clipboard JSON */ }
        return;
      }
      // A bare image URL pastes as an image (Canva-style); other text as a box.
      const trimmed = text?.trim() ?? "";
      if (/^https?:\/\/\S+\.(png|jpe?g|gif|webp|svg|avif)(\?\S*)?$/i.test(trimmed)) {
        e.preventDefault();
        store.addImage(trimmed);
        return;
      }
      if (trimmed) {
        e.preventDefault();
        store.addTextBox(text);
        return;
      }
      // 3) Nothing usable on the OS clipboard: fall back to the in-memory copy.
      store.paste();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("paste", onPaste);
    };
  }, [finishPen]);

  // Drag a guide out of a ruler (index null) or move an existing one. Dropping
  // an existing guide back onto its ruler removes it.
  function beginGuide(e: React.PointerEvent, axis: "x" | "y", index: number | null) {
    e.preventDefault();
    e.stopPropagation();
    // Capture so a release outside the window still ends the drag (no stuck guide).
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const toPos = (ev: PointerEvent | React.PointerEvent) => {
      const p = api.toPage(localPoint(ev));
      return axis === "x" ? p.x : p.y;
    };
    setGuideDrag({ axis, index, pos: toPos(e) });
    const move = (ev: PointerEvent) => setGuideDrag({ axis, index, pos: toPos(ev) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      const lp = localPoint(ev);
      const onRuler = axis === "x" ? lp.y < RULER : lp.x < RULER;
      const pos = toPos(ev);
      const st = useEditor.getState();
      if (index === null) {
        if (!onRuler) st.addGuide(axis, pos); // dropped on canvas -> create
      } else if (onRuler) {
        st.setGuide(axis, index, null); // dragged back to ruler -> delete
      } else {
        st.setGuide(axis, index, pos);
      }
      setGuideDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  // Page artboard rect in screen space (drives the drop-shadow behind the page).
  const apg = useEditor.getState().doc.pages[Math.min(activePage, useEditor.getState().doc.pages.length - 1)];
  // First-run hint: show a centered, non-interactive prompt while the page has no
  // nodes, the caller can edit, and we are not in a read-only history preview.
  // Pointer-events-none keeps the canvas fully usable underneath; it vanishes the
  // moment any node exists. (rev is already subscribed above, so this re-evaluates.)
  const showEmptyHint =
    !!apg &&
    apg.children.length === 0 &&
    usePresence.getState().canEdit() &&
    !useEditor.getState().readonlyPreview();
  const pageTL = api.toScreen({ x: 0, y: 0 });
  const pageFrame = apg
    ? { left: pageTL.x, top: pageTL.y, width: apg.width * viewport.zoom, height: apg.height * viewport.zoom }
    : null;

  const ctxItem = (
    icon: React.ReactNode,
    label: string,
    fn: () => void,
    shortcut?: string,
    danger?: boolean,
  ) => (
    <button
      onClick={() => { fn(); setCtxMenu(null); }}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] ${danger ? "text-red-600 hover:bg-red-50" : "text-neutral-700 hover:bg-neutral-100"}`}
    >
      <span className={`grid h-4 w-4 shrink-0 place-items-center ${danger ? "text-red-500" : "text-neutral-400"}`}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {shortcut && <span className="shrink-0 text-[11px] tabular-nums text-neutral-400">{shortcut}</span>}
    </button>
  );

  return (
    <div
      ref={surfaceRef}
      id="oc-canvas-surface"
      // Focusable, labelled region so a keyboard user can reach and operate the
      // design (a11y): role "application" (it owns its own arrow/Tab/Enter keys),
      // tabIndex 0 to enter the tab order, and a label describing how to drive it.
      tabIndex={0}
      role="application"
      aria-label={
        apg
          ? `Design canvas - page ${Math.min(activePage, useEditor.getState().doc.pages.length - 1) + 1} of ${useEditor.getState().doc.pages.length}; use Tab to cycle objects, Enter to edit, Delete to remove`
          : "Design canvas"
      }
      className="relative h-full w-full overflow-hidden bg-neutral-200 outline-none"
      // onFocus/onBlur bubble from children, so only treat focus as "on the
      // canvas" when the wrapper itself is the target. Focusing a child control
      // (a toolbar button, a text-edit overlay) reports a different target and
      // clears the flag, so Tab/Enter shortcuts do not hijack those controls.
      onFocus={(e) => { surfaceFocused.current = e.target === e.currentTarget; }}
      onBlur={(e) => { if (e.target === e.currentTarget) surfaceFocused.current = false; }}
      onContextMenu={onContextMenu}
      onDragOver={(e) => { const t = e.dataTransfer.types; if (t.includes("application/x-oc-image") || t.includes("Files")) e.preventDefault(); }}
      onDrop={onDrop}
    >
      {pageFrame && (
        <div
          className="pointer-events-none absolute"
          style={{
            left: pageFrame.left,
            top: pageFrame.top,
            width: pageFrame.width,
            height: pageFrame.height,
            background: "#fff",
            boxShadow: "0 10px 40px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.10)",
          }}
        />
      )}
      {showEmptyHint && (
        <div className="pointer-events-none absolute inset-0 z-[5] grid place-items-center">
          <div className="rounded-2xl border border-dashed border-neutral-300 bg-white/70 px-6 py-5 text-center backdrop-blur-sm">
            <p className="text-sm font-medium text-neutral-700">Start designing</p>
            <p className="mt-1 text-xs text-neutral-500">
              Pick a tool from the left, drag to draw, or press Cmd+K.
            </p>
          </div>
        </div>
      )}
      <div className="absolute left-3 top-3 z-10 flex flex-col gap-1 rounded-xl border border-neutral-200 bg-white p-1 shadow-md">
        {TOOLBAR.map((b, i) =>
          b === "sep" ? (
            <div key={`sep${i}`} className="my-0.5 h-px w-7 self-center bg-neutral-200" />
          ) : (
            <button
              key={b.tool}
              onClick={() => (b.tool === "select" ? finishPen() : useEditor.getState().setTool(b.tool))}
              title={b.title}
              className={`grid h-9 w-9 place-items-center rounded-lg ${tool === b.tool ? "bg-brand-50 text-brand-700" : "text-neutral-500 hover:bg-neutral-100"}`}
            >
              <b.icon size={18} />
            </button>
          ),
        )}
        {/* Comment tool: shown when the caller can comment. Drops a
            pin on the next canvas click (to the element or a freeform point). */}
        {canComment && (
          <>
            <div className="my-0.5 h-px w-7 self-center bg-neutral-200" />
            <button
              onClick={() => useEditor.getState().setTool("comment")}
              title="Comment (C) - click the canvas to drop a pin"
              className={`grid h-9 w-9 place-items-center rounded-lg ${tool === "comment" ? "bg-brand-50 text-brand-700" : "text-neutral-500 hover:bg-neutral-100"}`}
            >
              <MessageSquarePlus size={18} />
            </button>
          </>
        )}
      </div>
      {/* Brush options: shown for the pencil and board ink tools. Width / opacity /
          color feed addPencilPath / addInkStroke via the store's brush settings. */}
      {(tool === "pencil" || tool === "ink") && (
        <div className="absolute left-16 top-3 z-10 flex items-center gap-3 rounded-xl border border-neutral-200 bg-white px-3 py-2 shadow-md">
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-500">
            Size
            <input type="range" min={1} max={40} value={brush.width} onChange={(e) => useEditor.getState().setBrush({ width: Number(e.target.value) })} className="w-20 accent-brand-600" />
            <span className="w-6 text-neutral-400">{brush.width}</span>
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-neutral-500">
            Opacity
            <input type="range" min={10} max={100} value={Math.round(brush.opacity * 100)} onChange={(e) => useEditor.getState().setBrush({ opacity: Number(e.target.value) / 100 })} className="w-20 accent-brand-600" />
          </label>
          <input type="color" value={brush.colorHex} onChange={(e) => useEditor.getState().setBrush({ colorHex: e.target.value })} className="oc-color h-7 w-8 shrink-0" title="Brush color" />
        </div>
      )}
      <canvas
        ref={canvasRef}
        // relative z-0 keeps the canvas above the absolutely-positioned white
        // page backdrop (a static canvas would paint BEHIND it, hiding content).
        className={`relative z-0 h-full w-full touch-none ${spaceCursor ? (panning.current ? "cursor-grabbing" : "cursor-grab") : tool === "text" ? "cursor-text" : tool !== "select" ? "cursor-crosshair" : hoverMove ? "cursor-move" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
      />
      {/* Artboard outline: a crisp 1px page edge drawn ON TOP of the canvas so the
          canvas bounds stay visible even when an element covers or overflows the
          page (pairs with the engine's faded-overflow ghost, Canva-style). */}
      {pageFrame && (
        <div
          aria-hidden
          className="pointer-events-none absolute z-[1]"
          style={{
            left: pageFrame.left,
            top: pageFrame.top,
            width: pageFrame.width,
            height: pageFrame.height,
            boxShadow: "0 0 0 1px rgba(0,0,0,0.18)",
          }}
        />
      )}
      {/* Grid overlay (page-bounded, subtle, on top of content as a guide). */}
      {showGrid && apg && gridSize > 0 && apg.width / gridSize < 400 && apg.height / gridSize < 400 && (() => {
        const x0 = api.toScreen({ x: 0, y: 0 });
        const x1 = api.toScreen({ x: apg.width, y: apg.height });
        const lines: React.ReactElement[] = [];
        for (let gx = 0; gx <= apg.width + 0.5; gx += gridSize) {
          const sx = api.toScreen({ x: gx, y: 0 }).x;
          lines.push(<line key={`vg${gx}`} x1={sx} y1={x0.y} x2={sx} y2={x1.y} stroke={overlay.guideSubtle} strokeOpacity={0.12} strokeWidth={1} />);
        }
        for (let gy = 0; gy <= apg.height + 0.5; gy += gridSize) {
          const sy = api.toScreen({ x: 0, y: gy }).y;
          lines.push(<line key={`hg${gy}`} x1={x0.x} y1={sy} x2={x1.x} y2={sy} stroke={overlay.guideSubtle} strokeOpacity={0.12} strokeWidth={1} />);
        }
        return <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">{lines}</svg>;
      })()}
      {/* Manual guides (draggable; drop on a ruler to delete). */}
      {apg && (() => {
        const g = useEditor.getState().guides[apg.id];
        const vp = api.viewport();
        const lines: React.ReactElement[] = [];
        g?.x.forEach((gx, i) => {
          const sx = api.toScreen({ x: gx, y: 0 }).x;
          lines.push(
            <g key={`mgx${i}`}>
              <line x1={sx} y1={0} x2={sx} y2={vp.height} stroke={overlay.guideActive} strokeWidth={1} />
              <line x1={sx} y1={0} x2={sx} y2={vp.height} stroke="transparent" strokeWidth={7} className="pointer-events-auto cursor-ew-resize" onPointerDown={(e) => beginGuide(e, "x", i)} />
            </g>,
          );
        });
        g?.y.forEach((gy, i) => {
          const sy = api.toScreen({ x: 0, y: gy }).y;
          lines.push(
            <g key={`mgy${i}`}>
              <line x1={0} y1={sy} x2={vp.width} y2={sy} stroke={overlay.guideActive} strokeWidth={1} />
              <line x1={0} y1={sy} x2={vp.width} y2={sy} stroke="transparent" strokeWidth={7} className="pointer-events-auto cursor-ns-resize" onPointerDown={(e) => beginGuide(e, "y", i)} />
            </g>,
          );
        });
        if (guideDrag) {
          if (guideDrag.axis === "x") { const sx = api.toScreen({ x: guideDrag.pos, y: 0 }).x; lines.push(<line key="gpv" x1={sx} y1={0} x2={sx} y2={vp.height} stroke={overlay.guideActive} strokeWidth={1} strokeDasharray="3 3" />); }
          else { const sy = api.toScreen({ x: 0, y: guideDrag.pos }).y; lines.push(<line key="gph" x1={0} y1={sy} x2={vp.width} y2={sy} stroke={overlay.guideActive} strokeWidth={1} strokeDasharray="3 3" />); }
        }
        return lines.length ? <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">{lines}</svg> : null;
      })()}
      {/* Rulers (drag from a ruler onto the canvas to create a guide). */}
      {showRulers && apg && (
        <>
          <div className="absolute left-0 top-0 z-10 bg-white" style={{ width: RULER, height: RULER, borderRight: "1px solid #e5e5e5", borderBottom: "1px solid #e5e5e5" }} />
          <div
            className="absolute top-0 z-10 cursor-ew-resize bg-white"
            style={{ left: RULER, right: 0, height: RULER, borderBottom: "1px solid #e5e5e5" }}
            onPointerDown={(e) => beginGuide(e, "x", null)}
            title="Drag down to add a vertical guide"
          >
            <Ruler axis="x" api={api} page={apg} />
          </div>
          <div
            className="absolute left-0 z-10 cursor-ns-resize bg-white"
            style={{ top: RULER, bottom: 0, width: RULER, borderRight: "1px solid #e5e5e5" }}
            onPointerDown={(e) => beginGuide(e, "y", null)}
            title="Drag right to add a horizontal guide"
          >
            <Ruler axis="y" api={api} page={apg} />
          </div>
        </>
      )}
      {marquee && (
        <div
          className="pointer-events-none absolute border border-[color:var(--color-selection)] bg-[color:var(--color-selection)]/10"
          style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
        />
      )}
      {(guides ?? snapGuides) && (() => {
        const live = guides ?? snapGuides!;
        const vp = api.viewport();
        return (
          <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
            {live.x.map((gx, i) => {
              const sx = api.toScreen({ x: gx, y: 0 }).x;
              return <line key={`gx${i}`} x1={sx} y1={0} x2={sx} y2={vp.height} stroke={overlay.guideConflict} strokeWidth={1} />;
            })}
            {live.y.map((gy, i) => {
              const sy = api.toScreen({ x: 0, y: gy }).y;
              return <line key={`gy${i}`} x1={0} y1={sy} x2={vp.width} y2={sy} stroke={overlay.guideConflict} strokeWidth={1} />;
            })}
          </svg>
        );
      })()}
      {tool === "pen" && penDraft.current && penPreview && (() => {
        const n = locate(useEditor.getState().doc, penDraft.current.id)?.node;
        if (!n || n.type !== "path") return null;
        const segs = (n as unknown as { transform: { x: number; y: number }; segments: { x: number; y: number }[] });
        const last = segs.segments[segs.segments.length - 1];
        if (!last) return null;
        const a = api.toScreen({ x: segs.transform.x + last.x, y: segs.transform.y + last.y });
        return (
          <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
            <line x1={a.x} y1={a.y} x2={penPreview.x} y2={penPreview.y} stroke={overlay.penPreview} strokeWidth={1.5} strokeDasharray="4 3" />
          </svg>
        );
      })()}
      {(tool === "pencil" || tool === "ink") && pencilPreview && pencilPreview.length > 1 && (
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          style={{ mixBlendMode: tool === "ink" && brush.mode === "highlighter" ? "multiply" : undefined }}
        >
          <polyline
            points={pencilPreview.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            // Reflect the actual brush so the live stroke looks like what commits
            // (color, on-screen width = brush width x zoom, and opacity), instead of
            // a thin placeholder line that reads as "nothing is being drawn".
            stroke={brush.colorHex}
            strokeOpacity={brush.opacity}
            strokeWidth={Math.max(1, brush.width * (viewport.zoom || 1))}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      )}
      {cropping ? (
        <CropOverlay api={api} id={cropping} />
      ) : editingConnectorLabel ? (
        <ConnectorLabelOverlay api={api} id={editingConnectorLabel} onClose={() => setEditingConnectorLabel(null)} />
      ) : editingSticky ? (
        <StickyEditOverlay
          api={api}
          id={editingSticky}
          // Keyed to the closing id so a stale unmount-blur (after Tab advanced to
          // a new sticky) does not clear the new editor.
          onClose={(closingId) => setEditingSticky((cur) => (cur === closingId ? null : cur))}
          onAdvance={(fromId) => {
            const st = useEditor.getState();
            const ln = locate(st.doc, fromId)?.node;
            const gap = 24;
            const cx = ln ? ln.transform.x + ln.size.width + gap + 90 : 0;
            const cy = ln ? ln.transform.y + ln.size.height / 2 : 0;
            const newId = st.addStickyAt(cx, cy);
            setEditingSticky(newId);
          }}
        />
      ) : editing ? (
        <TextEditOverlay api={api} id={editing} onClose={() => setEditing(null)} />
      ) : tool !== "select" ? (
        // While a draw tool is active, show no interactive overlay - the Gizmo's
        // resize handles would otherwise intercept pen clicks / draw drags.
        null
      ) : singlePath ? (
        <PathEditor api={api} />
      ) : (
        <>
          <Gizmo api={api} />
          <SelectionToolbar api={api} />
          {isWhiteboard && <ConnectorDragLayer api={api} clientToPage={clientToPage} />}
          {isWhiteboard && <ConnectorEditLayer api={api} clientToPage={clientToPage} />}
        </>
      )}
      {/* Per-page headers (title + tools) for continuous-scroll mode. */}
      <PageOverlays api={api} />
      {/* Zoom overview: a corner thumbnail with a draggable viewport rectangle. */}
      <MiniMap />
      {/* Remote collaborators' cursors and selections. */}
      <PresenceOverlay api={api} />
      {/* Comment pins anchored to nodes/regions, tracking pan/zoom. */}
      <CommentPins api={api} />
      {ctxMenu && (() => {
        const st = useEditor.getState();
        // Edit gate (mirrors the canvas/keyboard gate): view/comment users and a
        // read-only history preview get no editing actions at all - suppress the
        // whole menu rather than offer Copy/Delete/Arrange they cannot use.
        const canEdit = usePresence.getState().canEdit() && !st.readonlyPreview();
        if (!canEdit) return null;
        const hasSel = selection.length > 0;
        const sel = selection.map((id) => locate(st.doc, id)?.node).filter(Boolean);
        const allLocked = hasSel && sel.every((n) => n!.locked);
        const allHidden = hasSel && sel.every((n) => n!.hidden);
        const isGroup = selection.length === 1 && locate(st.doc, selection[0])?.node.type === "group";
        return (
          <div
            role="menu"
            className="oc-scroll absolute z-30 max-h-[80vh] w-56 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl ring-1 ring-black/5"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* With nothing selected only Paste / Select all make sense; the
                editing actions below are gated behind a selection. */}
            {!hasSel && ctxItem(<ClipboardPaste size={15} />, "Paste", () => st.paste(), "⌘V")}
            {!hasSel && ctxItem(<BoxSelect size={15} />, "Select all", () => st.selectAll(), "⌘A")}
            {!hasSel && ctxItem(<Lock size={15} />, "Lock all on page", () => st.lockAllOnPage(true))}
            {!hasSel && ctxItem(<LockOpen size={15} />, "Unlock all on page", () => st.lockAllOnPage(false))}
            {hasSel && (
              <>
                {ctxItem(<Copy size={15} />, "Copy", () => st.copySelection(), "⌘C")}
                {ctxItem(<ClipboardPaste size={15} />, "Paste", () => st.paste(), "⌘V")}
                {ctxItem(<CopyPlus size={15} />, "Duplicate", () => st.duplicateSelection(), "⌘D")}
                {ctxItem(<Trash2 size={15} />, "Delete", () => st.deleteSelection(), "⌫", true)}
                <div className="my-1 h-px bg-neutral-100" />
                {ctxItem(<BoxSelect size={15} />, "Select all of type", () => st.selectSameType())}
                {selection.length > 1 && ctxItem(<Group size={15} />, "Group", () => st.group(), "⌘G")}
                {isGroup && ctxItem(<Ungroup size={15} />, "Ungroup", () => st.ungroupSelection(), "⇧⌘G")}
                {ctxItem(<ArrowUp size={15} />, "Bring forward", () => st.orderSelection("forward"), "⌘]")}
                {ctxItem(<ArrowDown size={15} />, "Send backward", () => st.orderSelection("backward"), "⌘[")}
                {ctxItem(<ChevronsUp size={15} />, "Bring to front", () => st.orderSelection("front"))}
                {ctxItem(<ChevronsDown size={15} />, "Send to back", () => st.orderSelection("back"))}
                <div className="my-1 h-px bg-neutral-100" />
                {ctxItem(<FlipHorizontal2 size={15} />, "Flip horizontal", () => st.flipSelection("h"))}
                {ctxItem(<FlipVertical2 size={15} />, "Flip vertical", () => st.flipSelection("v"))}
                <div className="my-1 h-px bg-neutral-100" />
                {ctxItem(<Paintbrush size={15} />, "Copy style", () => st.copyStyle())}
                {ctxItem(<PaintBucket size={15} />, "Paste style", () => st.pasteStyle())}
                {/* Lock/Hide are two-way: show the inverse action when the
                    selection is already locked/hidden so it can be reversed. */}
                {allLocked
                  ? ctxItem(<LockOpen size={15} />, "Unlock", () => st.setLockedSel(false))
                  : ctxItem(<Lock size={15} />, "Lock", () => st.setLockedSel(true))}
                {allHidden
                  ? ctxItem(<Eye size={15} />, "Show", () => st.setHiddenSel(false))
                  : ctxItem(<EyeOff size={15} />, "Hide", () => st.setHiddenSel(true))}
              </>
            )}
          </div>
        );
      })()}
    </div>
  );
}
