// Fullscreen presentation: renders each page to a centered, letterboxed canvas
// and steps through pages with arrows/space/click. Esc exits. Engine-rendered,
// so it matches the editor exactly. Playback: per-slide entrance/exit/
// emphasis animations, page transitions, photo motion (ken-burns/parallax), and
// pointer interactions all run off the shared @hc/engine patch math, mirroring
// the editor "Play" composition in the store's playAnimations.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  X,
  Play,
  Pause,
  Repeat,
  PanelRightOpen,
  MousePointer2,
  Pencil,
  Lightbulb,
  ZoomIn,
  LayoutGrid,
  Square,
  HelpCircle,
  Undo2,
  Trash2,
} from "lucide-react";
import {
  createScene,
  renderScene,
  entrancePatch,
  exitPatch,
  emphasisPatch,
  imageMotionPatch,
  customPatch,
  clipEnd,
  transitionProgress,
  appliedOpacity,
  type AnimPatch,
  type CanvasLike,
  type Viewport,
} from "@hc/engine";
import type {
  DesignFile,
  Node,
  Transform,
  NodeAnimation,
  Interaction,
  ImageMotion,
  PageTransition,
  ElementLink,
} from "@hc/schema";
import { useEditor } from "@/store/editor";
import { imageAssets } from "@/lib/assetProvider";
import {
  adjustSpotlightRadius,
  DEFAULT_AUTO_ADVANCE_MS,
  dwellMs,
  firstVisibleIndex,
  fitZoom,
  formatClock,
  nextVisibleIndex,
  prevVisibleIndex,
  RehearsalTimer,
  seekVisible,
  SPOTLIGHT_DEFAULT_RADIUS,
  spotlightGeom,
  stepZoom,
  visibleIndices,
  visiblePosition,
  ZOOM_STEP,
  type SlideLike,
  type ZoomTransform,
} from "@/lib/present";

// The active presenter magic tool (FR-8). At most one pointer tool is active at a
// time so they cannot fight over the cursor: entering pen disables laser, etc.
// "none" is the default (clicks advance / hit-test interactions as before).
type PresentTool = "none" | "laser" | "pen" | "spotlight";

// Full-surface blanking (FR-8 black/white screen): a B or W overlay that pauses
// audience attention; any nav key or pressing the key again restores the slide.
type Blank = "none" | "black" | "white";

// One freehand pen stroke (FR-8 on-slide draw): a color, width, and the points it
// passed through, in OVERLAY CSS pixels. Strokes are ephemeral: held only in a
// ref keyed by slide index, cleared on slide change/exit, and never touch the
// design, the scene graph, or the undo stack.
interface PenStroke {
  color: string;
  width: number;
  points: { x: number; y: number }[];
}

// The pen color swatches offered in the toolbar (FR-8 "small color choice").
const PEN_COLORS = ["#ef4444", "#facc15", "#3b82f6", "#111111"] as const;
const PEN_WIDTHS = [3, 6, 12] as const;

// Resting state of a node we drive each frame, plus its typed playback data.
interface Driven {
  node: Node; // the node inside the clone we mutate in place each frame
  baseOpacity: number;
  baseTransform: Transform;
  anim?: NodeAnimation;
  motion?: ImageMotion;
}

// One ready-to-render slide: a single-page clone of the design plus its driven
// nodes (collected once so the hot loop only touches transforms/opacity).
interface Slide {
  doc: DesignFile;
  pageIndex: number;
  driven: Driven[];
  entranceTotal: number; // ms until every entrance has finished
  exitTotal: number; // ms until every exit has finished (0 if no exits)
  transition?: PageTransition; // played when advancing TO this slide
}

const cloneTransform = (t: Transform): Transform => ({ ...t });

// Compose an AnimPatch over a node's resting transform/opacity, writing the
// result back into the (cloned) node. Mirrors the store's applyPatch so the
// editor preview and present mode agree exactly. A null patch restores rest.
function applyPatch(node: Node, base: Transform, baseOpacity: number, patch: AnimPatch | null): void {
  if (!patch) {
    node.opacity = baseOpacity;
    node.transform = cloneTransform(base);
    return;
  }
  node.opacity = appliedOpacity(baseOpacity, patch.opacityMul);
  node.transform = {
    ...base,
    x: base.x + patch.dx,
    y: base.y + patch.dy,
    scaleX: base.scaleX * patch.scale,
    scaleY: base.scaleY * patch.scale,
    rotation: base.rotation + patch.rotate,
  };
}

// A legacy `node.link` (hyperlink) reads as a click open-link interaction.
function effectiveInteraction(node: Node): Interaction | undefined {
  const n = node as unknown as { interaction?: Interaction; link?: ElementLink; type?: string; content?: { runs: { style?: { link?: string } }[] }[] };
  if (n.interaction) return n.interaction;
  if (n.link) return { trigger: "click", action: { kind: "open-link", link: n.link } };
  // Per-range text link: the first linked run makes the whole text node a click
  // target (opens that URL). Pinpointing a specific run would need per-glyph hit
  // testing; one link per text node is the common case.
  if (n.type === "text" && n.content) {
    for (const p of n.content) {
      for (const r of p.runs) {
        const url = r.style?.link;
        if (url) return { trigger: "click", action: { kind: "open-link", link: { kind: "url", target: url } } };
      }
    }
  }
  return undefined;
}

// Resolve a navigate action to a target page index for the current index and
// page list. Returns -1 when the target cannot be resolved (e.g. a `to:"page"`
// referencing a deleted/unknown page id), so the caller can fall through to the
// default advance instead of dead-ending the click. Pure: unit-tested.
export function navigateTargetIndex(
  action: { to: "next" | "prev" | "first" | "last" | "page"; pageId?: string },
  idx: number,
  pages: { id: string }[],
): number {
  switch (action.to) {
    case "next":
      return idx + 1;
    case "prev":
      return idx - 1;
    case "first":
      return 0;
    case "last":
      return pages.length - 1;
    case "page":
      return action.pageId ? pages.findIndex((pg) => pg.id === action.pageId) : -1;
    default:
      return -1;
  }
}

// The playback phase while one slide is leaving and another is arriving, decided
// purely from the leaving slide's transition + exit timing and elapsed time:
//  - "transition": a real page transition is in flight (it plays exits itself).
//  - "exit": no page transition, but the leaving slide has exit clips, so we play
//    them in a brief exit window before showing the arriving slide.
//  - "settled": the leaving slide is done; show the arriving slide.
// `reduced` skips all motion (transition and exit windows collapse immediately).
export function presentLeavePhase(
  opts: { transitionType?: string; transitionDurationMs?: number; exitTotal: number; elapsedMs: number; reduced: boolean },
): "transition" | "exit" | "settled" {
  if (opts.reduced) return "settled";
  const hasTransition = !!opts.transitionType && opts.transitionType !== "none";
  if (hasTransition) {
    return opts.elapsedMs < (opts.transitionDurationMs ?? 0) ? "transition" : "settled";
  }
  if (opts.exitTotal > 0 && opts.elapsedMs < opts.exitTotal) return "exit";
  return "settled";
}

// Collect the driven nodes of a page (those with animation or photo motion) so
// the per-frame loop is allocation-free. Walks containers depth-first.
function collectDriven(nodes: Node[], out: Driven[]): void {
  for (const n of nodes) {
    const anim = (n as unknown as { animation?: NodeAnimation }).animation;
    const motion = n.type === "image" ? (n as unknown as { motion?: ImageMotion }).motion : undefined;
    if ((anim && (anim.entrance || anim.exit || anim.emphasis || anim.custom)) || motion) {
      out.push({ node: n, baseOpacity: n.opacity, baseTransform: cloneTransform(n.transform), anim, motion });
    }
    const kids = (n as unknown as { children?: Node[] }).children;
    if (Array.isArray(kids)) collectDriven(kids, out);
  }
}

// Build a self-contained single-page slide clone for a page index. Cloning the
// whole doc would be wasteful; we keep every page but only ever render/mutate
// this one, so a structural clone of the doc (cheap relative to a render) is fine.
function buildSlide(doc: DesignFile, pageIndex: number): Slide {
  const clone: DesignFile = structuredClone(doc);
  const page = clone.pages[pageIndex];
  const driven: Driven[] = [];
  // The schema allows a 0-page deck (or a stale/out-of-range index after pages
  // shrank). Without a page there is nothing to drive, so return a benign empty
  // slide; the caller (PresentMode) bails to onClose when there are no pages.
  if (!page) {
    return { doc: clone, pageIndex, driven, entranceTotal: 0, exitTotal: 0, transition: undefined };
  }
  collectDriven(page.children, driven);
  let entranceTotal = 0;
  let exitTotal = 0;
  for (const d of driven) {
    if (d.anim?.entrance) entranceTotal = Math.max(entranceTotal, clipEnd(d.anim.entrance));
    if (d.anim?.exit) exitTotal = Math.max(exitTotal, clipEnd(d.anim.exit));
  }
  return {
    doc: clone,
    pageIndex,
    driven,
    entranceTotal,
    exitTotal,
    transition: (page as unknown as { transition?: PageTransition }).transition,
  };
}

// Pose a slide's driven nodes for present time `tMs` (since the slide became
// active). reduced => skip motion, snap entrances to their finished pose.
function poseEnter(slide: Slide, tMs: number, reduced: boolean): void {
  for (const d of slide.driven) {
    let patch: AnimPatch | null = null;
    const ent = d.anim?.entrance;
    const emp = d.anim?.emphasis;
    if (ent && tMs <= clipEnd(ent)) {
      patch = reduced ? entrancePatch(ent, clipEnd(ent)) : entrancePatch(ent, tMs);
    } else if (emp && !reduced) {
      patch = emphasisPatch(emp, tMs - slide.entranceTotal);
    } else if (ent) {
      patch = entrancePatch(ent, clipEnd(ent)); // settle at resting pose
    }
    // Custom keyframe timeline (F25): composes over the entrance/emphasis pose,
    // playing from when the entrance finishes (loops if the track loops).
    if (d.anim?.custom && !reduced) {
      const c = customPatch(d.anim.custom, tMs - slide.entranceTotal);
      const base = patch ?? { dx: 0, dy: 0, scale: 1, rotate: 0, opacityMul: 1 };
      patch = {
        dx: base.dx + c.dx,
        dy: base.dy + c.dy,
        scale: base.scale * c.scale,
        rotate: base.rotate + c.rotate,
        opacityMul: base.opacityMul * c.opacityMul,
      };
    }
    // Photo motion composes additively onto whatever pose we have (it only
    // touches scale/translation), applied over the entrance/emphasis result.
    if (d.motion && !reduced) {
      const m = imageMotionPatch(d.motion, tMs);
      const base = patch ?? { dx: 0, dy: 0, scale: 1, rotate: 0, opacityMul: 1 };
      patch = {
        dx: base.dx + m.dx,
        dy: base.dy + m.dy,
        scale: base.scale * m.scale,
        rotate: base.rotate + m.rotate,
        opacityMul: base.opacityMul * m.opacityMul,
      };
    }
    applyPatch(d.node, d.baseTransform, d.baseOpacity, patch);
  }
}

// Pose a slide's driven nodes for its exit, `tMs` into the exit (used while the
// outgoing slide transitions away). Nodes without an exit stay at rest.
function poseExit(slide: Slide, tMs: number, reduced: boolean): void {
  for (const d of slide.driven) {
    const ex = d.anim?.exit;
    const patch = ex && !reduced ? exitPatch(ex, tMs) : null;
    applyPatch(d.node, d.baseTransform, d.baseOpacity, patch);
  }
}

export function PresentMode({ onClose }: { onClose: () => void }) {
  // Subscribe to rev so the slideshow reflects live edits and page add/remove.
  const rev = useEditor((s) => s.rev);
  const doc = useEditor.getState().doc;
  const pages = doc.pages;
  // Hidden slides are skipped while presenting (FR-1): start on the active page if
  // it is visible, else the first visible slide (fall back to the active page if
  // every slide is hidden, so presenting never dead-ends on an empty deck).
  const [rawIdx, setIdx] = useState(() => {
    const active = Math.min(useEditor.getState().activePage, pages.length - 1);
    if (!pages[active]?.hidden) return active;
    const first = firstVisibleIndex(pages as SlideLike[]);
    return first >= 0 ? first : active;
  });
  const idx = Math.max(0, Math.min(rawIdx, pages.length - 1)); // clamp if pages shrank
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null); // presenter-only tools layer
  const [interactiveCursor, setInteractiveCursor] = useState(false);

  // Presenter magic tools (FR-8). All of this is presenter-only and ephemeral: it
  // overlays the slide, never mutates the design, the scene graph, or undo stack,
  // and is gone on exit. Drawing happens on a separate overlay canvas so the slide
  // animation loop is never stalled.
  const [tool, setTool] = useState<PresentTool>("none");
  const [blank, setBlank] = useState<Blank>("none");
  const [zoom, setZoom] = useState<ZoomTransform>(() => fitZoom());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [penColor, setPenColor] = useState<string>(PEN_COLORS[0]);
  const [penWidth, setPenWidth] = useState<number>(PEN_WIDTHS[1]);
  // Spotlight radius (CSS px), adjustable via wheel / +- keys.
  const spotRadiusRef = useRef(SPOTLIGHT_DEFAULT_RADIUS);
  // Cursor position over the wrapper in CSS px (drives laser + spotlight paint).
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  // Ephemeral pen ink, keyed by full-list slide index. Cleared on slide change &
  // exit; never persisted. A ref (not state) so high-frequency stroke points do
  // not re-render React; the overlay paints from it each frame.
  const strokesRef = useRef<Map<number, PenStroke[]>>(new Map());
  const drawingRef = useRef<PenStroke | null>(null); // the stroke in progress
  // Number of committed strokes on the CURRENT slide (state, so the Undo/Clear
  // buttons re-render without reading the ref during render). Ink ops keep it in
  // sync; it resets when the slide changes.
  const [inkCount, setInkCount] = useState(0);

  // Autopilot (FR-14) + presenter HUD (FR-4/FR-5) UI state. Autopilot auto-advances
  // each slide after its dwell once entrances finish; the HUD is presenter-only.
  const [autopilot, setAutopilot] = useState(false);
  const [loop, setLoop] = useState(false);
  const [showHud, setShowHud] = useState(false);

  // Visible-slide bookkeeping (skips hidden slides for nav + the n-of-N count).
  const visIdxs = useMemo(() => visibleIndices(pages as SlideLike[]), [pages, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const pos = visiblePosition(pages as SlideLike[], idx);

  const reducedMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
    [],
  );

  // Build the slide clone for the current page; rebuilt on page/edit change. The
  // store mutates `doc` in place, so `rev` (not `doc`'s identity) signals edits.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const slide = useMemo(() => buildSlide(doc, idx), [doc, idx, rev]);

  // A scene over the RESTING current slide for pointer hit-testing (rebuilt with
  // the slide). createScene reads the (unanimated) clone's transforms.
  const restingScene = useMemo(() => {
    try {
      return createScene(slide.doc, slide.pageIndex);
    } catch {
      return null;
    }
  }, [slide]);

  // Transition state: the slide we are leaving and when the transition started.
  // When `from` is set we crossfade/translate from it to the current slide.
  const transitionRef = useRef<{ from: Slide; startedAt: number } | null>(null);
  // The fit/layout for the current frame (page-space -> css scale), recomputed
  // on resize/slide; used by both rendering and pointer hit-testing.
  const fitRef = useRef<{ scale: number; cssW: number; cssH: number; dpr: number }>({ scale: 1, cssW: 0, cssH: 0, dpr: 1 });
  // The node id the pointer is currently over, so a hover-trigger interaction
  // fires once on enter and does not re-fire while still over the same node.
  const hoveredIdRef = useRef<string | null>(null);

  const navigate = useCallback(
    (target: number) => {
      setIdx((cur) => {
        const clamped = Math.max(0, Math.min(pages.length - 1, target));
        // If the jump target is itself hidden, snap forward (then backward) to the
        // nearest visible slide so an interaction/jump never lands on a hidden one.
        let dest = clamped;
        if (pages[dest]?.hidden) {
          const fwd = seekVisible(pages as SlideLike[], dest, 1);
          dest = fwd >= 0 ? fwd : seekVisible(pages as SlideLike[], dest, -1);
          if (dest < 0) dest = clamped; // every slide hidden: fall back
        }
        if (dest === cur) return cur;
        // Capture the slide we are leaving so the transition can render it.
        transitionRef.current = { from: buildSlide(doc, cur), startedAt: performance.now() };
        return dest;
      });
    },
    [pages, doc],
  );

  // Next/prev step over visible slides only (FR-1); at the deck ends they no-op
  // (navigate clamps), except autopilot loop which jumps to the first slide.
  const next = useCallback(() => {
    const n = nextVisibleIndex(pages as SlideLike[], idx);
    if (n >= 0) navigate(n);
  }, [navigate, idx, pages]);
  const prev = useCallback(() => {
    const p = prevVisibleIndex(pages as SlideLike[], idx);
    if (p >= 0) navigate(p);
  }, [navigate, idx, pages]);

  // Toggle a pointer tool. Tools are mutually exclusive (FR-8): selecting one
  // while it is already active turns it off; selecting a different one replaces
  // it (so entering pen disables laser/spotlight, etc). Finishes any in-progress
  // pen stroke so switching tools never leaves a dangling stroke.
  const selectTool = useCallback((t: PresentTool) => {
    drawingRef.current = null;
    setTool((cur) => (cur === t ? "none" : t));
  }, []);

  // Clear blanking (B/W screen) on any navigation, matching the standard "press
  // any key to resume" behavior. Wrapped around next/prev below.
  const guardedNext = useCallback(() => {
    if (blank !== "none") { setBlank("none"); return; }
    next();
  }, [blank, next]);
  const guardedPrev = useCallback(() => {
    if (blank !== "none") { setBlank("none"); return; }
    prev();
  }, [blank, prev]);

  // Ephemeral pen ink ops (FR-8). Undo removes the last stroke on THIS slide;
  // Clear wipes this slide's ink. Both touch only the per-slide ref, never the
  // design or the undo stack. The strokeCount bump re-renders the toolbar so the
  // Undo/Clear button enabled state stays accurate.
  const slideStrokes = useCallback((): PenStroke[] => {
    let arr = strokesRef.current.get(idx);
    if (!arr) { arr = []; strokesRef.current.set(idx, arr); }
    return arr;
  }, [idx]);
  const undoStroke = useCallback(() => {
    const arr = strokesRef.current.get(idx);
    if (arr && arr.length) { arr.pop(); setInkCount(arr.length); }
  }, [idx]);
  const clearStrokes = useCallback(() => {
    const arr = strokesRef.current.get(idx);
    if (arr && arr.length) { arr.length = 0; setInkCount(0); }
  }, [idx]);

  // Ink is ephemeral per slide (FR-8): drop the just-left slide's strokes and any
  // in-progress stroke whenever the slide changes, and sync the live ink count to
  // the slide we land on. The whole map is dropped on unmount (exit) below.
  useEffect(() => {
    const strokes = strokesRef.current; // stable Map we own; safe to use in cleanup
    drawingRef.current = null;
    setInkCount(strokes.get(idx)?.length ?? 0);
    return () => {
      strokes.delete(idx);
    };
  }, [idx]);
  useEffect(() => {
    const strokes = strokesRef.current;
    return () => { strokes.clear(); };
  }, []);

  // A 0-page deck has nothing to present (schema allows it). Bail out to the
  // caller rather than white-screening; the render below also returns null so no
  // slide hooks touch a missing page. Calling the onClose prop from an effect is a
  // side-effect to an external system, not a setState-in-effect cascade.
  useEffect(() => {
    if (pages.length === 0) onClose();
  }, [pages.length, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore keys while typing in the HUD jump box / notes (let the field handle them).
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        if (e.key === "Escape") (t as HTMLElement).blur();
        return;
      }
      // The jump-to-slide palette captures its own keys (handled in the palette).
      if (paletteOpen) return;
      // Escape closes the most recent transient layer first, else exits.
      if (e.key === "Escape") {
        if (showHelp) { setShowHelp(false); return; }
        if (blank !== "none") { setBlank("none"); return; }
        if (tool !== "none") { selectTool("none"); return; }
        onClose();
        return;
      }
      // Navigation also dismisses a blanking screen (standard "resume" behavior).
      if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") { e.preventDefault(); guardedNext(); return; }
      if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); guardedPrev(); return; }
      switch (e.key) {
        case "s": case "S": e.preventDefault(); setShowHud((v) => !v); return; // presenter view (FR-4)
        case "p": case "P": e.preventDefault(); setAutopilot((v) => !v); return; // autopilot (FR-14)
        case "l": case "L": e.preventDefault(); selectTool("laser"); return; // laser pointer
        case "d": case "D": e.preventDefault(); selectTool("pen"); return; // on-slide draw (P is autopilot)
        case "o": case "O": e.preventDefault(); selectTool("spotlight"); return; // spotlight
        case "b": case "B": e.preventDefault(); setBlank((v) => (v === "black" ? "none" : "black")); return; // black screen
        case "w": case "W": e.preventDefault(); setBlank((v) => (v === "white" ? "none" : "white")); return; // white screen
        case "g": case "G": case "/": e.preventDefault(); setPaletteOpen(true); return; // jump-to-slide palette
        case "z": case "Z": e.preventDefault(); setZoom((z) => stepZoom(z, ZOOM_STEP * 2, 0.5, 0.5)); return; // zoom in (center)
        case "=": case "+": e.preventDefault(); setZoom((z) => stepZoom(z, ZOOM_STEP, z.originX, z.originY)); return;
        case "-": case "_": e.preventDefault(); setZoom((z) => stepZoom(z, -ZOOM_STEP, z.originX, z.originY)); return;
        case "0": e.preventDefault(); setZoom(fitZoom()); return; // reset to fit
        case "?": e.preventDefault(); setShowHelp((v) => !v); return; // shortcut help
        default:
          // While the spotlight is active, [ and ] shrink/grow its radius too.
          if (tool === "spotlight" && (e.key === "[" || e.key === "]")) {
            e.preventDefault();
            spotRadiusRef.current = adjustSpotlightRadius(spotRadiusRef.current, e.key === "]" ? 20 : -20);
          }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [guardedNext, guardedPrev, onClose, paletteOpen, showHelp, blank, tool, selectTool]);

  // Compute and store the fit for the current slide whenever it/size changes.
  const layout = useCallback((): { ctx: CanvasRenderingContext2D; vp: Viewport } | null => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const pg = slide.doc.pages[slide.pageIndex];
    if (!canvas || !wrap || !pg) return null;
    const dpr = window.devicePixelRatio || 1;
    const avail = { w: wrap.clientWidth * 0.92, h: wrap.clientHeight * 0.92 };
    const scale = Math.min(avail.w / pg.width, avail.h / pg.height);
    const cssW = Math.round(pg.width * scale);
    const cssH = Math.round(pg.height * scale);
    if (canvas.style.width !== `${cssW}px`) canvas.style.width = `${cssW}px`;
    if (canvas.style.height !== `${cssH}px`) canvas.style.height = `${cssH}px`;
    const pxW = Math.round(cssW * dpr);
    const pxH = Math.round(cssH * dpr);
    if (canvas.width !== pxW) canvas.width = pxW;
    if (canvas.height !== pxH) canvas.height = pxH;
    fitRef.current = { scale, cssW, cssH, dpr };
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    return { ctx, vp: { zoom: scale, panX: 0, panY: 0, dpr, width: canvas.width, height: canvas.height } };
  }, [slide]);

  // Render one slide's posed scene into a destination context with a viewport.
  const drawSlide = useCallback((target: Slide, ctx: CanvasRenderingContext2D, vp: Viewport) => {
    try {
      renderScene(createScene(target.doc, target.pageIndex), ctx as unknown as CanvasLike, vp, { assets: imageAssets });
    } catch {
      /* a cross-origin image can throw; the slide just shows white */
    }
  }, []);

  // The animation loop: drives entrance/emphasis/photo-motion on the active
  // slide, plays the leaving slide's exit + the page transition, and settles.
  useEffect(() => {
    let raf = 0;
    const fit = layout();
    if (!fit) return;
    const slideStart = performance.now();
    const { ctx } = fit;
    const canvas = canvasRef.current;
    // Offscreen buffers reused for transition compositing (avoid per-frame alloc).
    const bufA = document.createElement("canvas");
    const bufB = document.createElement("canvas");

    const frame = () => {
      const f = layout();
      if (!f || !canvas) return;
      const vp = f.vp;
      const now = performance.now();
      const tSlide = now - slideStart;

      const tr = transitionRef.current;
      const elapsed = tr ? now - tr.startedAt : 0;
      // FR-2: a page's transition plays when advancing TO it, so the transition
      // type/duration come from the ARRIVING slide (`slide`), not the leaving one.
      // `tr.from` is kept only as the outgoing image composited during the blend.
      const arrivingTransition = slide.transition;
      const dur = reducedMotion ? 0 : arrivingTransition?.durationMs ?? 0;
      const phase = tr
        ? presentLeavePhase({
            transitionType: arrivingTransition?.type,
            transitionDurationMs: arrivingTransition?.durationMs,
            exitTotal: tr.from.exitTotal,
            elapsedMs: elapsed,
            reduced: reducedMotion,
          })
        : "settled";

      if (phase === "transition" && tr) {
        const p = transitionProgress(elapsed, dur);
        const { from } = tr;
        // Pose both slides: the leaving slide plays its exit, the arriving slide
        // begins its entrance (from the start of the transition window).
        poseExit(from, elapsed, reducedMotion);
        poseEnter(slide, tSlide, reducedMotion);
        renderTransition(ctx.canvas, ctx, vp, from, slide, arrivingTransition!, p, bufA, bufB, drawSlide);
      } else if (phase === "exit" && tr) {
        // No page transition, but the leaving slide has exit clips: play them in a
        // brief exit window so a configured exit always shows on slide-leave.
        poseExit(tr.from, elapsed, reducedMotion);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.restore();
        drawSlide(tr.from, ctx, vp);
      } else {
        if (tr) transitionRef.current = null; // leave window finished; settle in
        poseEnter(slide, tSlide, reducedMotion);
        // Fresh white background, then the posed current slide.
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.restore();
        drawSlide(slide, ctx, vp);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [slide, layout, drawSlide, reducedMotion]);

  // Presenter overlay paint loop (FR-8). A SEPARATE rAF + canvas above the slide,
  // so laser/spotlight/pen never touch or stall the slide animation loop. Each
  // frame it sizes the overlay to the wrapper, clears it, and paints whatever the
  // active tool needs from refs (cursor position, this slide's ephemeral ink).
  useEffect(() => {
    // Nothing to paint unless a pointer tool is active or this slide has ink.
    let raf = 0;
    const paint = () => {
      const overlay = overlayRef.current;
      const wrap = wrapRef.current;
      if (overlay && wrap) {
        const dpr = window.devicePixelRatio || 1;
        const cw = wrap.clientWidth;
        const ch = wrap.clientHeight;
        const pxW = Math.max(1, Math.round(cw * dpr));
        const pxH = Math.max(1, Math.round(ch * dpr));
        if (overlay.width !== pxW) overlay.width = pxW;
        if (overlay.height !== pxH) overlay.height = pxH;
        if (overlay.style.width !== `${cw}px`) overlay.style.width = `${cw}px`;
        if (overlay.style.height !== `${ch}px`) overlay.style.height = `${ch}px`;
        const ctx = overlay.getContext("2d");
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, cw, ch);

          // Spotlight: dim the surface, punch a soft radial hole at the cursor.
          const cur = cursorRef.current;
          if (tool === "spotlight" && cur) {
            const g = spotlightGeom(cur.x, cur.y, spotRadiusRef.current);
            ctx.save();
            // Dim the whole surface, then punch a soft-edged hole at the cursor so
            // the lit disc center is fully clear and the rim fades back to dim.
            ctx.fillStyle = "rgba(0,0,0,0.72)";
            ctx.fillRect(0, 0, cw, ch);
            ctx.globalCompositeOperation = "destination-out";
            const hole = ctx.createRadialGradient(g.cx, g.cy, 0, g.cx, g.cy, g.outer);
            hole.addColorStop(0, "rgba(0,0,0,1)");
            hole.addColorStop(g.radius / g.outer, "rgba(0,0,0,1)");
            hole.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = hole;
            ctx.beginPath();
            ctx.arc(g.cx, g.cy, g.outer, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }

          // Pen ink for this slide (committed strokes + the in-progress one).
          const committed = strokesRef.current.get(idx);
          const drawing = drawingRef.current;
          if ((committed && committed.length) || drawing) {
            ctx.save();
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            const strokeOne = (s: PenStroke) => {
              if (s.points.length === 0) return;
              ctx.strokeStyle = s.color;
              ctx.lineWidth = s.width;
              ctx.beginPath();
              ctx.moveTo(s.points[0].x, s.points[0].y);
              for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
              if (s.points.length === 1) ctx.lineTo(s.points[0].x + 0.01, s.points[0].y); // dot
              ctx.stroke();
            };
            if (committed) for (const s of committed) strokeOne(s);
            if (drawing) strokeOne(drawing);
            ctx.restore();
          }

          // Laser pointer: a soft glowing red dot at the cursor.
          if (tool === "laser" && cur) {
            ctx.save();
            const glow = ctx.createRadialGradient(cur.x, cur.y, 0, cur.x, cur.y, 26);
            glow.addColorStop(0, "rgba(255,40,40,0.55)");
            glow.addColorStop(1, "rgba(255,40,40,0)");
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(cur.x, cur.y, 26, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "rgba(255,70,70,0.95)";
            ctx.beginPath();
            ctx.arc(cur.x, cur.y, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "rgba(255,210,210,0.95)";
            ctx.beginPath();
            ctx.arc(cur.x, cur.y, 2.4, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }
      }
      raf = requestAnimationFrame(paint);
    };
    // Idle (no active pointer tool and no ink on this slide): clear the overlay
    // once and do NOT run a per-frame loop, so present mode keeps just the one
    // slide rAF at steady state. Re-runs when tool/slide/ink changes.
    const hasInk = (strokesRef.current.get(idx)?.length ?? 0) > 0;
    if (tool === "none" && !hasInk) {
      const overlay = overlayRef.current;
      const ctx = overlay?.getContext("2d");
      if (overlay && ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);
      return;
    }
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [tool, idx, inkCount]);

  // Autopilot (FR-14): once the current slide's entrances finish, wait its dwell
  // (per-slide `autoAdvanceMs`, else a default) then advance. Re-runs whenever the
  // slide changes (so manual nav resets the dwell) or autopilot toggles. At the
  // last visible slide it loops to the first when Loop is on, else stops.
  useEffect(() => {
    if (!autopilot) return;
    const entranceMs = reducedMotion ? 0 : slide.entranceTotal;
    // Floor the per-slide dwell so a slide configured with autoAdvanceMs:0 (and no
    // entrance) cannot spin the timer in a tight zero-delay loop.
    const AUTOPILOT_MIN_DWELL_MS = 600;
    const wait = entranceMs + Math.max(AUTOPILOT_MIN_DWELL_MS, dwellMs(pages as SlideLike[], idx, DEFAULT_AUTO_ADVANCE_MS));
    const timer = window.setTimeout(() => {
      // Autopilot advances directly (not via guardedNext), so clear any active
      // black/white blank itself so the next slide is actually visible.
      setBlank("none");
      const n = nextVisibleIndex(pages as SlideLike[], idx);
      if (n >= 0) {
        navigate(n);
      } else if (loop) {
        // End of deck with loop on: jump back to the first visible slide. (With a
        // single visible slide this is a no-op; the slide simply stays up.)
        const first = firstVisibleIndex(pages as SlideLike[]);
        if (first >= 0 && first !== idx) navigate(first);
      } else {
        setAutopilot(false); // reached the end, no loop: stop autopilot
      }
    }, Math.max(0, wait));
    return () => window.clearTimeout(timer);
  }, [autopilot, loop, slide, idx, pages, navigate, reducedMotion]);

  // Presenter rehearsal timer (FR-5): a wall clock for count-up/count-down and a
  // per-slide breakdown surfaced when stopped. Driven by a 1s interval (display
  // only; the per-slide accounting uses real deltas so it stays accurate).
  const rehearsalRef = useRef<RehearsalTimer>(new RehearsalTimer());
  const [timerRunning, setTimerRunning] = useState(true);
  const [timerMode, setTimerMode] = useState<"up" | "down">("up");
  const [targetMs, setTargetMs] = useState(5 * 60 * 1000); // count-down target (5 min default)
  const [elapsedMs, setElapsedMs] = useState(0);
  const [stoppedBreakdown, setStoppedBreakdown] = useState<ReturnType<RehearsalTimer["breakdown"]> | null>(null);
  const lastTickRef = useRef<number>(0); // set to performance.now() when timing starts

  // Attribute elapsed wall time to the current slide as it changes.
  useEffect(() => {
    rehearsalRef.current.enter(idx);
  }, [idx]);

  // The 1s display tick + per-slide accounting (only while running).
  useEffect(() => {
    if (!timerRunning) return;
    lastTickRef.current = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      const delta = now - lastTickRef.current;
      lastTickRef.current = now;
      rehearsalRef.current.tick(delta);
      setElapsedMs((e) => e + delta);
    }, 1000);
    return () => window.clearInterval(id);
  }, [timerRunning]);

  const toggleTimer = useCallback(() => {
    setTimerRunning((run) => {
      if (run) setStoppedBreakdown(rehearsalRef.current.breakdown()); // surface per-slide on stop (FR-5)
      else setStoppedBreakdown(null);
      return !run;
    });
  }, []);

  const resetTimer = useCallback(() => {
    rehearsalRef.current.reset();
    rehearsalRef.current.enter(idx);
    setElapsedMs(0);
    setStoppedBreakdown(null);
    lastTickRef.current = performance.now();
  }, [idx]);

  // Map a pointer event to a page-space point for the current fit. Uses the
  // canvas's on-screen rect so it stays correct under the magic-tool zoom CSS
  // transform (the rect reflects the transformed box); page-space is the rect
  // fraction times the page size.
  const toPagePoint = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const pg = slide.doc.pages[slide.pageIndex];
    if (!canvas || !pg) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * pg.width,
      y: ((clientY - rect.top) / rect.height) * pg.height,
    };
  }, [slide]);

  // Map a pointer event to a point in OVERLAY CSS pixels (relative to the
  // wrapper), used by the laser/spotlight/pen overlay. The overlay sits over the
  // whole wrapper, untransformed, so client coords map straight through.
  const toOverlayPoint = useCallback((clientX: number, clientY: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const rect = wrap.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  // Perform a node's interaction action. Returns true if it consumed the click
  // (so the default "advance" is suppressed).
  const runInteraction = useCallback(
    (interaction: Interaction): boolean => {
      const a = interaction.action;
      if (a.kind === "open-link") {
        if (a.link.kind === "url" || a.link.kind === "email") {
          const href = a.link.kind === "email" ? `mailto:${a.link.target}` : a.link.target;
          // Refuse unsafe schemes (links can carry arbitrary strings from
          // per-range text links, templates, or AI output).
          if (/^\s*(javascript|data|vbscript):/i.test(href)) return true;
          window.open(href, "_blank", "noopener,noreferrer");
          return true;
        }
        if (a.link.kind === "page") {
          const t = pages.findIndex((pg) => pg.id === a.link.target);
          if (t < 0) return false; // deleted/invalid page: fall through to default advance
          navigate(t);
          return true;
        }
        return false; // unhandled link kind (e.g. anchor): let the default advance happen
      }
      if (a.kind === "navigate") {
        const target = navigateTargetIndex(a, idx, pages);
        if (target < 0) return false; // unresolvable (e.g. deleted page id): fall through
        navigate(target);
        return true;
      }
      return false; // kind === "none" leaves the default behavior alone
    },
    [pages, idx, navigate],
  );

  // Click on the canvas: hit-test for an interactive node, else advance.
  const onCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const pt = toPagePoint(e.clientX, e.clientY);
      const hitNode = pt && restingScene ? restingScene.hitTest(pt) : null;
      if (hitNode) {
        const interaction = effectiveInteraction(hitNode);
        if (interaction && interaction.trigger === "click" && runInteraction(interaction)) return;
      }
      next(); // empty space (or a non-interactive node) advances
    },
    [toPagePoint, restingScene, runInteraction, next],
  );

  // Pointer move: manage the pointer cursor over interactive nodes and fire any
  // hover-trigger interaction once, on enter. We track the node id the pointer is
  // over (hoveredIdRef); a hover interaction runs the first frame the pointer is
  // over its node and does not re-fire until the pointer leaves and re-enters.
  const onPointerMove = useCallback(
    (e: React.MouseEvent) => {
      const pt = toPagePoint(e.clientX, e.clientY);
      const hitNode = pt && restingScene ? restingScene.hitTest(pt) : null;
      const interaction = hitNode ? effectiveInteraction(hitNode) : undefined;
      const interactive = !!interaction && interaction.action.kind !== "none";
      if (interactive !== interactiveCursor) setInteractiveCursor(interactive);

      const hoveredId = hitNode ? hitNode.id : null;
      if (hoveredId !== hoveredIdRef.current) {
        hoveredIdRef.current = hoveredId; // record the enter/leave before acting
        if (hitNode && interaction && interaction.trigger === "hover") runInteraction(interaction);
      }
    },
    [toPagePoint, restingScene, interactiveCursor, runInteraction],
  );

  // Tool overlay pointer handling (FR-8). When a pointer tool is active the
  // overlay intercepts the pointer (so a laser/spotlight move or a pen drag never
  // advances the slide). Updates cursorRef for laser/spotlight; the paint loop
  // reads it. For the pen it appends points to the in-progress stroke.
  const onOverlayMove = useCallback(
    (e: React.MouseEvent) => {
      const pt = toOverlayPoint(e.clientX, e.clientY);
      if (!pt) return;
      cursorRef.current = pt;
      const drawing = drawingRef.current;
      if (tool === "pen" && drawing && (e.buttons & 1) === 1) {
        drawing.points.push(pt);
      }
    },
    [tool, toOverlayPoint],
  );
  const onOverlayDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (tool !== "pen") return;
      const pt = toOverlayPoint(e.clientX, e.clientY);
      if (!pt) return;
      drawingRef.current = { color: penColor, width: penWidth, points: [pt] };
    },
    [tool, toOverlayPoint, penColor, penWidth],
  );
  const commitStroke = useCallback(() => {
    const drawing = drawingRef.current;
    drawingRef.current = null;
    if (drawing && drawing.points.length) {
      const arr = slideStrokes();
      arr.push(drawing);
      setInkCount(arr.length);
    }
  }, [slideStrokes]);
  // Wheel over the slide: adjust the spotlight radius (when active) or zoom level
  // toward the cursor. Neither mutates the design; both are bounded by the pure
  // helpers (adjustSpotlightRadius / stepZoom).
  const onWrapWheel = useCallback(
    (e: React.WheelEvent) => {
      if (tool === "spotlight") {
        spotRadiusRef.current = adjustSpotlightRadius(spotRadiusRef.current, e.deltaY < 0 ? 16 : -16);
        return;
      }
      const wrap = wrapRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / Math.max(1, rect.width);
      const fy = (e.clientY - rect.top) / Math.max(1, rect.height);
      setZoom((z) => stepZoom(z, e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP, fx, fy));
    },
    [tool],
  );

  const hasNext = nextVisibleIndex(pages as SlideLike[], idx) >= 0;
  const hasPrev = prevVisibleIndex(pages as SlideLike[], idx) >= 0;
  const nextIdx = nextVisibleIndex(pages as SlideLike[], idx);
  // Count-down readout goes negative past the target (formatClock shows the sign).
  const timerDisplay = timerMode === "down" ? formatClock(targetMs - elapsedMs) : formatClock(elapsedMs);
  const timerOver = timerMode === "down" && elapsedMs > targetMs;

  // Nothing to present on a 0-page deck: render nothing (the effect above closes
  // present mode). All hooks have already run, so this conditional return is safe.
  if (pages.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-neutral-900">
      {/* Audience-facing render path: only the slide canvas. Presenter-only UI
          (HUD, controls, magic-tool overlays) lives outside this surface so a
          captured/mirrored slide area never shows presenter chrome. */}
      <div ref={wrapRef} className="relative flex flex-1 items-center justify-center overflow-hidden" onClick={next} onWheel={onWrapWheel}>
        <canvas
          ref={canvasRef}
          className="shadow-2xl"
          style={{
            cursor: interactiveCursor ? "pointer" : "default",
            // Magic-tool zoom (FR-8): a CSS transform on the slide only, so the
            // engine render and animation loop are untouched. transform-origin is
            // the focus fraction so zooming homes on the cursor.
            transform: zoom.scale > 1 ? `scale(${zoom.scale})` : undefined,
            transformOrigin: `${zoom.originX * 100}% ${zoom.originY * 100}%`,
            transition: "transform 120ms ease-out",
            willChange: zoom.scale > 1 ? "transform" : undefined,
          }}
          onClick={onCanvasClick}
          onMouseMove={onPointerMove}
        />
        {/* Presenter tools overlay (FR-8): laser / spotlight / pen ink. Always
            mounted so the paint loop can size it; only intercepts the pointer
            (and hides the OS cursor) while a pointer tool is active. */}
        <canvas
          ref={overlayRef}
          className="pointer-events-none absolute inset-0 z-[105]"
          style={{
            pointerEvents: tool === "none" ? "none" : "auto",
            cursor: tool === "laser" || tool === "spotlight" ? "none" : tool === "pen" ? "crosshair" : "default",
          }}
          onMouseDown={onOverlayDown}
          onMouseMove={onOverlayMove}
          onMouseUp={commitStroke}
          onMouseLeave={() => {
            // Pointer left the slide: commit any in-progress stroke AND drop the
            // laser/spotlight cursor so its indicator does not freeze on-screen.
            commitStroke();
            cursorRef.current = null;
          }}
          onClick={(e) => { if (tool !== "none") e.stopPropagation(); }}
        />
        {/* Black/white blanking screen (FR-8): full-surface attention pause. Any
            nav key or pressing B/W again restores; clicking it also restores. */}
        {blank !== "none" && (
          <div
            className="absolute inset-0 z-[106]"
            style={{ background: blank === "black" ? "#000" : "#fff" }}
            onClick={(e) => { e.stopPropagation(); setBlank("none"); }}
            title="Click or press a key to resume"
          />
        )}
      </div>
      <button onClick={onClose} className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20" title="Exit (Esc)">
        <X size={18} />
      </button>
      {/* Pen options sub-bar (FR-8): color + width + undo/clear, shown only while
          the pen is active. Ephemeral ink ops; never touch the design/undo stack. */}
      {tool === "pen" && (
        <div
          className="absolute bottom-16 left-1/2 z-[108] flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-neutral-950/85 px-3 py-2 text-white shadow-xl backdrop-blur"
          onClick={(e) => e.stopPropagation()}
        >
          {PEN_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setPenColor(c)}
              className={`h-6 w-6 rounded-full ring-2 ${penColor === c ? "ring-white" : "ring-transparent"}`}
              style={{ background: c }}
              title={`Ink ${c}`}
            />
          ))}
          <span className="mx-1 h-5 w-px bg-white/15" />
          {PEN_WIDTHS.map((w) => (
            <button
              key={w}
              onClick={() => setPenWidth(w)}
              className={`grid h-7 w-7 place-items-center rounded-full hover:bg-white/20 ${penWidth === w ? "bg-white/25" : "bg-white/10"}`}
              title={`Stroke ${w}px`}
            >
              <span className="rounded-full bg-current" style={{ width: w, height: w }} />
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-white/15" />
          <button onClick={undoStroke} disabled={inkCount === 0} className="grid h-7 w-7 place-items-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30" title="Undo last stroke">
            <Undo2 size={15} />
          </button>
          <button onClick={clearStrokes} disabled={inkCount === 0} className="grid h-7 w-7 place-items-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30" title="Clear slide ink">
            <Trash2 size={15} />
          </button>
        </div>
      )}

      <div className="flex items-center justify-center gap-3 py-3 text-white" onClick={(e) => e.stopPropagation()}>
        <button onClick={guardedPrev} disabled={!hasPrev} className="grid h-9 w-9 place-items-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30" title="Previous (left arrow)">
          <ChevronLeft size={18} />
        </button>
        <span className="text-sm tabular-nums text-white/70">{pos.position} / {pos.total}</span>
        <button onClick={guardedNext} disabled={!hasNext} className="grid h-9 w-9 place-items-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30" title="Next (right arrow)">
          <ChevronRight size={18} />
        </button>
        <span className="mx-1 h-5 w-px bg-white/15" />
        {/* Magic tools toolbar (FR-8). Each is also a keyboard shortcut. */}
        <ToolButton active={tool === "laser"} onClick={() => selectTool("laser")} title="Laser pointer (L)"><MousePointer2 size={16} /></ToolButton>
        <ToolButton active={tool === "pen"} onClick={() => selectTool("pen")} title="Pen draw (D)"><Pencil size={16} /></ToolButton>
        <ToolButton active={tool === "spotlight"} onClick={() => selectTool("spotlight")} title="Spotlight (O)"><Lightbulb size={16} /></ToolButton>
        <ToolButton active={zoom.scale > 1} onClick={() => setZoom((z) => (z.scale > 1 ? fitZoom() : stepZoom(z, ZOOM_STEP * 2, 0.5, 0.5)))} title="Zoom (Z, +/-, wheel; 0 resets)"><ZoomIn size={16} /></ToolButton>
        <ToolButton active={blank === "black"} onClick={() => setBlank((v) => (v === "black" ? "none" : "black"))} title="Black screen (B)"><Square size={16} fill="currentColor" /></ToolButton>
        <ToolButton active={blank === "white"} onClick={() => setBlank((v) => (v === "white" ? "none" : "white"))} title="White screen (W)"><Square size={16} /></ToolButton>
        <ToolButton active={paletteOpen} onClick={() => setPaletteOpen(true)} title="Jump to slide (G or /)"><LayoutGrid size={16} /></ToolButton>
        <span className="mx-1 h-5 w-px bg-white/15" />
        <ToolButton active={autopilot} onClick={() => setAutopilot((v) => !v)} title={autopilot ? "Pause autopilot (P)" : "Play autopilot (P)"}>{autopilot ? <Pause size={16} /> : <Play size={16} />}</ToolButton>
        <ToolButton active={loop} onClick={() => setLoop((v) => !v)} title={loop ? "Loop on" : "Loop off"}><Repeat size={16} /></ToolButton>
        <ToolButton active={showHud} onClick={() => setShowHud((v) => !v)} title="Presenter view (S)"><PanelRightOpen size={16} /></ToolButton>
        <ToolButton active={showHelp} onClick={() => setShowHelp((v) => !v)} title="Shortcuts (?)"><HelpCircle size={16} /></ToolButton>
      </div>

      {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}

      {paletteOpen && (
        <JumpPalette
          doc={doc}
          visIdxs={visIdxs}
          curIdx={idx}
          onJump={(i) => { setPaletteOpen(false); navigate(i); }}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {showHud && (
        <PresenterHud
          doc={doc}
          curIdx={idx}
          nextIdx={nextIdx}
          notes={(pages[idx] as { notes?: string } | undefined)?.notes ?? ""}
          position={pos.position}
          total={pos.total}
          visIdxs={visIdxs}
          timerDisplay={timerDisplay}
          timerOver={timerOver}
          timerRunning={timerRunning}
          timerMode={timerMode}
          targetMs={targetMs}
          breakdown={stoppedBreakdown}
          onPrev={prev}
          onNext={next}
          hasPrev={hasPrev}
          hasNext={hasNext}
          onJump={(i) => navigate(i)}
          onToggleTimer={toggleTimer}
          onResetTimer={resetTimer}
          onSetMode={setTimerMode}
          onSetTarget={setTargetMs}
          onClose={() => setShowHud(false)}
        />
      )}
    </div>
  );
}

// A round control-bar button shared by the bottom toolbar (FR-8). `active`
// highlights the current tool/state. Pointer-only chrome, never audience-facing.
function ToolButton({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`grid h-9 w-9 place-items-center rounded-full hover:bg-white/20 ${active ? "bg-brand-500/80" : "bg-white/10"}`}
      title={title}
    >
      {children}
    </button>
  );
}

// The shortcut help card (FR-8 "?"): lists the presenter magic-tool keys. Pure
// presenter chrome.
function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ["Right / Space / PageDown", "Next slide"],
    ["Left / PageUp", "Previous slide"],
    ["L", "Laser pointer"],
    ["D", "Pen draw (ephemeral)"],
    ["O", "Spotlight (wheel or [ ] adjusts radius)"],
    ["Z / + / - / wheel", "Zoom (0 resets to fit)"],
    ["B", "Black screen"],
    ["W", "White screen"],
    ["G or /", "Jump-to-slide palette"],
    ["S", "Presenter view"],
    ["P", "Autopilot play/pause"],
    ["?", "Toggle this help"],
    ["Esc", "Close tool / overlay, then exit"],
  ];
  return (
    <div className="absolute inset-0 z-[120] grid place-items-center bg-black/40" onClick={onClose}>
      <div
        className="w-[440px] max-w-[90vw] rounded-2xl border border-white/10 bg-neutral-950/95 p-5 text-white shadow-2xl backdrop-blur"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold">Presenter shortcuts</span>
          <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-full bg-white/10 hover:bg-white/20" title="Close (Esc)">
            <X size={15} />
          </button>
        </div>
        <ul className="space-y-1.5 text-sm">
          {rows.map(([k, label]) => (
            <li key={k} className="flex items-center justify-between gap-4">
              <span className="text-white/70">{label}</span>
              <kbd className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-xs tabular-nums text-white/85">{k}</kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// Jump-to-slide palette (FR-8): a grid of engine-rendered thumbnails of the
// visible slides, with the current one marked. Click or arrow+Enter to jump,
// Escape closes. Reuses the SlideThumb render path (same as the HUD). The grid
// indexes into `visIdxs` (visible slides only); jumps map back to full indices.
function JumpPalette({
  doc,
  visIdxs,
  curIdx,
  onJump,
  onClose,
}: {
  doc: DesignFile;
  visIdxs: number[];
  curIdx: number;
  onJump: (fullIndex: number) => void;
  onClose: () => void;
}) {
  // Selection within visIdxs; start on the current slide if it is visible.
  const startSel = Math.max(0, visIdxs.indexOf(curIdx));
  const [sel, setSel] = useState(startSel);
  const cols = 4;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "Enter") { e.preventDefault(); if (visIdxs[sel] !== undefined) onJump(visIdxs[sel]); return; }
      let next = sel;
      if (e.key === "ArrowRight") next = sel + 1;
      else if (e.key === "ArrowLeft") next = sel - 1;
      else if (e.key === "ArrowDown") next = sel + cols;
      else if (e.key === "ArrowUp") next = sel - cols;
      else return;
      e.preventDefault();
      e.stopPropagation();
      if (next >= 0 && next < visIdxs.length) setSel(next);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sel, visIdxs, onJump, onClose]);

  return (
    <div className="absolute inset-0 z-[120] grid place-items-center bg-black/60" onClick={onClose}>
      <div
        className="max-h-[80vh] w-[760px] max-w-[92vw] overflow-y-auto rounded-2xl border border-white/10 bg-neutral-950/95 p-5 text-white shadow-2xl backdrop-blur"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold">Jump to slide</span>
          <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-full bg-white/10 hover:bg-white/20" title="Close (Esc)">
            <X size={15} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {visIdxs.map((full, n) => (
            <button
              key={full}
              onClick={() => onJump(full)}
              className={`group rounded-lg border p-1.5 text-left transition ${
                n === sel ? "border-brand-400 bg-brand-500/15" : "border-white/10 bg-white/5 hover:border-white/30"
              }`}
              title={`Slide ${n + 1}`}
            >
              <div className="relative grid aspect-video place-items-center overflow-hidden rounded bg-white/5">
                <SlideThumb doc={doc} index={full} w={180} h={110} />
                {full === curIdx && (
                  <span className="absolute left-1 top-1 rounded bg-brand-500/90 px-1.5 py-0.5 text-[10px] font-medium">Current</span>
                )}
              </div>
              <div className="mt-1 truncate text-xs text-white/70">
                {`${n + 1}. ${doc.pages[full]?.name ?? "Slide"}`}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Render a single page to a small thumbnail canvas via @hc/engine, exactly like
// the PagesBar thumbnails, so the presenter HUD's current/next previews match the
// editor. Presenter-only: this never touches the audience-facing slide canvas.
function SlideThumb({ doc, index, w, h }: { doc: DesignFile; index: number; w: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const pg = doc.pages[index];
    if (!pg) return;
    const scale = Math.min(w / pg.width, h / pg.height);
    const cw = Math.max(1, Math.round(pg.width * scale));
    const ch = Math.max(1, Math.round(pg.height * scale));
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cw, ch);
    const vp: Viewport = { zoom: scale, panX: 0, panY: 0, dpr: 1, width: cw, height: ch };
    try {
      renderScene(createScene(doc, index), ctx as unknown as CanvasLike, vp, { assets: imageAssets });
    } catch {
      /* a tainted/cross-origin image can throw; the thumbnail just shows white */
    }
  }, [doc, index, w, h]);
  return <canvas ref={ref} className="max-h-full max-w-full rounded" />;
}

// Presenter HUD (FR-4/FR-5): a single-window overlay (a true second display via
// window.open + BroadcastChannel is a deferred enhancement). Shows the current
// slide, the next-slide thumbnail, speaker notes, n-of-N, prev/next + a jump
// control, and a rehearsal/count-down timer with a per-slide breakdown on stop.
function PresenterHud(props: {
  doc: DesignFile;
  curIdx: number;
  nextIdx: number;
  notes: string;
  position: number;
  total: number;
  visIdxs: number[];
  timerDisplay: string;
  timerOver: boolean;
  timerRunning: boolean;
  timerMode: "up" | "down";
  targetMs: number;
  breakdown: { index: number; elapsedMs: number; visits: number }[] | null;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  onJump: (i: number) => void;
  onToggleTimer: () => void;
  onResetTimer: () => void;
  onSetMode: (m: "up" | "down") => void;
  onSetTarget: (ms: number) => void;
  onClose: () => void;
}) {
  const {
    doc, curIdx, nextIdx, notes, position, total, visIdxs, timerDisplay, timerOver,
    timerRunning, timerMode, targetMs, breakdown, onPrev, onNext, hasPrev, hasNext,
    onJump, onToggleTimer, onResetTimer, onSetMode, onSetTarget, onClose,
  } = props;
  const targetMin = Math.round(targetMs / 60000);
  return (
    <div
      className="absolute right-4 top-16 bottom-20 z-[110] flex w-[360px] flex-col gap-3 overflow-y-auto rounded-2xl border border-white/10 bg-neutral-950/90 p-4 text-white shadow-2xl backdrop-blur"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-white/50">Presenter view</span>
        <span className="text-xs tabular-nums text-white/60">{position} of {total}</span>
      </div>

      <div className="flex gap-2">
        <div className="flex-1">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">Current</div>
          <div className="grid aspect-video place-items-center overflow-hidden rounded-lg border border-white/10 bg-white/5">
            <SlideThumb doc={doc} index={curIdx} w={200} h={120} />
          </div>
        </div>
        <div className="w-[42%]">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">Next</div>
          <div className="grid aspect-video place-items-center overflow-hidden rounded-lg border border-white/10 bg-white/5">
            {nextIdx >= 0 ? <SlideThumb doc={doc} index={nextIdx} w={140} h={84} /> : <span className="text-[10px] text-white/30">End</span>}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <button onClick={onPrev} disabled={!hasPrev} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20 disabled:opacity-30">Prev</button>
        <select
          value={curIdx}
          onChange={(e) => onJump(Number(e.target.value))}
          className="flex-1 rounded-lg border border-white/10 bg-neutral-900 px-2 py-1.5 text-xs outline-none"
          title="Jump to slide"
        >
          {visIdxs.map((i, n) => (
            <option key={i} value={i}>{`Slide ${n + 1}${doc.pages[i]?.name ? ` - ${doc.pages[i].name}` : ""}`}</option>
          ))}
        </select>
        <button onClick={onNext} disabled={!hasNext} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20 disabled:opacity-30">Next</button>
      </div>

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">Speaker notes</div>
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-white/5 p-2.5 text-sm leading-relaxed text-white/85">
          {notes.trim() ? notes : <span className="text-white/30">No notes for this slide.</span>}
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-white/5 p-3">
        <div className="flex items-center justify-between">
          <div className={`text-3xl font-semibold tabular-nums ${timerOver ? "text-red-400" : ""}`}>{timerDisplay}</div>
          <div className="flex gap-1.5">
            <button onClick={onToggleTimer} className="rounded-lg bg-white/10 px-2.5 py-1 text-xs hover:bg-white/20">{timerRunning ? "Stop" : "Start"}</button>
            <button onClick={onResetTimer} className="rounded-lg bg-white/10 px-2.5 py-1 text-xs hover:bg-white/20">Reset</button>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs">
          <div className="inline-flex overflow-hidden rounded-lg border border-white/10">
            <button onClick={() => onSetMode("up")} className={`px-2.5 py-1 ${timerMode === "up" ? "bg-brand-500/80" : "bg-white/5 hover:bg-white/10"}`}>Count up</button>
            <button onClick={() => onSetMode("down")} className={`px-2.5 py-1 ${timerMode === "down" ? "bg-brand-500/80" : "bg-white/5 hover:bg-white/10"}`}>Count down</button>
          </div>
          {timerMode === "down" && (
            <label className="ml-auto flex items-center gap-1 text-white/60">
              <input
                type="number"
                min={1}
                value={targetMin}
                onChange={(e) => onSetTarget(Math.max(1, Number(e.target.value) || 1) * 60000)}
                className="w-14 rounded border border-white/10 bg-neutral-900 px-1.5 py-1 text-right tabular-nums outline-none"
              />
              min
            </label>
          )}
        </div>
      </div>

      {breakdown && breakdown.length > 0 && (
        <div className="rounded-lg border border-white/10 bg-white/5 p-3">
          <div className="mb-1.5 text-[10px] uppercase tracking-wide text-white/40">Per-slide time (rehearsal)</div>
          <ul className="space-y-1 text-xs text-white/75">
            {breakdown.map((b) => (
              <li key={b.index} className="flex items-center justify-between tabular-nums">
                <span className="truncate pr-2 text-white/60">{doc.pages[b.index]?.name ?? `Slide ${b.index + 1}`}{b.visits > 1 ? ` (x${b.visits})` : ""}</span>
                <span>{formatClock(b.elapsedMs)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button onClick={onClose} className="mt-auto rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20">Close presenter view (S)</button>
    </div>
  );
}

// Composite the leaving and arriving slides into `dest` for the given transition
// at eased progress `p` (0..1). Uses two offscreen buffers (sized to the canvas)
// so each slide renders once per frame and is then blended/translated cheaply.
function renderTransition(
  dest: HTMLCanvasElement,
  destCtx: CanvasRenderingContext2D,
  vp: Viewport,
  from: Slide,
  to: Slide,
  transition: PageTransition,
  p: number,
  bufA: HTMLCanvasElement,
  bufB: HTMLCanvasElement,
  draw: (s: Slide, ctx: CanvasRenderingContext2D, vp: Viewport) => void,
): void {
  const W = dest.width;
  const H = dest.height;
  if (bufA.width !== W) bufA.width = W;
  if (bufA.height !== H) bufA.height = H;
  if (bufB.width !== W) bufB.width = W;
  if (bufB.height !== H) bufB.height = H;
  const ca = bufA.getContext("2d");
  const cb = bufB.getContext("2d");
  if (!ca || !cb) return;
  for (const c of [ca, cb]) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, H);
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, W, H);
  }
  draw(from, ca, vp);
  draw(to, cb, vp);

  destCtx.setTransform(1, 0, 0, 1, 0, 0);
  destCtx.clearRect(0, 0, W, H);
  destCtx.fillStyle = "#ffffff";
  destCtx.fillRect(0, 0, W, H);

  const dir = transition.direction ?? "left";
  const sign = dir === "right" || dir === "down" ? -1 : 1;
  const horizontal = dir === "left" || dir === "right";

  switch (transition.type) {
    case "fade":
    case "dissolve": {
      destCtx.globalAlpha = 1 - p;
      destCtx.drawImage(bufA, 0, 0);
      destCtx.globalAlpha = p;
      destCtx.drawImage(bufB, 0, 0);
      destCtx.globalAlpha = 1;
      break;
    }
    case "slide": {
      // The incoming slide slides in over the (stationary) outgoing one.
      destCtx.drawImage(bufA, 0, 0);
      const dx = horizontal ? sign * (1 - p) * W : 0;
      const dy = horizontal ? 0 : sign * (1 - p) * H;
      destCtx.drawImage(bufB, dx, dy);
      break;
    }
    case "push": {
      // Both slides move together: outgoing pushed out, incoming pushed in.
      const dx = horizontal ? sign * p * W : 0;
      const dy = horizontal ? 0 : sign * p * H;
      destCtx.drawImage(bufA, -dx, -dy);
      destCtx.drawImage(bufB, horizontal ? sign * W - dx : 0, horizontal ? 0 : sign * H - dy);
      break;
    }
    case "morph-lite": {
      // A simple cross-zoom: the outgoing slide zooms out + fades, the incoming
      // zooms in from slightly small + fades in.
      const outScale = 1 + 0.12 * p;
      const inScale = 0.88 + 0.12 * p;
      destCtx.globalAlpha = 1 - p;
      drawScaled(destCtx, bufA, outScale, W, H);
      destCtx.globalAlpha = p;
      drawScaled(destCtx, bufB, inScale, W, H);
      destCtx.globalAlpha = 1;
      break;
    }
    default: {
      destCtx.drawImage(bufB, 0, 0);
    }
  }
}

// Draw a buffer scaled about its center into the destination context.
function drawScaled(ctx: CanvasRenderingContext2D, buf: HTMLCanvasElement, scale: number, W: number, H: number): void {
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(scale, scale);
  ctx.translate(-W / 2, -H / 2);
  ctx.drawImage(buf, 0, 0);
  ctx.restore();
}
