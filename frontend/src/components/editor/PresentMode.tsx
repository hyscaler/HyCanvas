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
  MonitorPlay,
  MonitorX,
  MousePointer2,
  Pencil,
  Lightbulb,
  ZoomIn,
  LayoutGrid,
  Square,
  HelpCircle,
  Undo2,
  Trash2,
  Disc,
  MessageSquare,
  ThumbsUp,
  CheckCircle2,
  EyeOff,
  BarChart3,
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
  sequenceStarts,
  revealEntranceText,
  renderTransition,
  renderTransitionPair,
  transitionPairDurationMs,
  pairEnterTransition,
  morphPlan,
  morphDesignAt,
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
import { nextSectionStart, prevSectionStart } from "@hc/schema";
import { useEditor } from "@/store/editor";
import { prefersReducedMotion } from "@/lib/theme";
import { imageAssets } from "@/lib/assetProvider";
import { useBrand } from "@/store/brand";
import { oc } from "@/lib/sdk";
import { designSurfaceDir } from "@/lib/locale";
import { onAudienceEvent } from "@/lib/realtime";
import { useToast } from "@/components/ui/Toast";
import type { AudienceState } from "@hc/sdk";
import { AudienceLink, openAudienceWindow } from "@/lib/audienceWindow";
import {
  adjustSpotlightRadius,
  defaultAutoAdvanceMs,
  dwellMs,
  firstVisibleIndex,
  fitZoom,
  formatClock,
  nextVisibleIndex,
  prevVisibleIndex,
  RehearsalTimer,
  seekVisible,
  liveHeartbeatMs,
  spotlightDefaultRadius,
  spotlightGeom,
  stepZoom,
  visibleIndices,
  visiblePosition,
  zoomStep,
  type SlideLike,
  type ZoomTransform,
} from "@/lib/present";
import { tr } from "@/lib/i18n";

/** Composite the webcam bubble onto the recording canvas: 16:9 at one sixth of
 *  the canvas width, positioned by the draggable preview's normalized offset,
 *  cover-cropped into a rounded rect with a white border. The cover-crop and
 *  rounded-rect clip math is closely adapted from an MIT-licensed reference
 *  (see THIRD_PARTY.md). Drawn AFTER the slide and the ink overlay, so the
 *  bubble records exactly where the presenter sees it (F28 T22). */
function drawCameraBubble(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  cw: number,
  ch: number,
  pos: { x: number; y: number },
): void {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
  const bw = Math.round(cw / 6);
  const bh = Math.round((bw * 9) / 16);
  const margin = Math.round(cw * 0.02);
  const x = Math.round(margin + pos.x * Math.max(0, cw - bw - margin * 2));
  const y = Math.round(margin + pos.y * Math.max(0, ch - bh - margin * 2));
  const r = Math.round(bh * 0.15);
  // Cover-crop: center-crop the camera frame to the bubble's aspect.
  const videoAspect = video.videoWidth / video.videoHeight;
  const targetAspect = bw / bh;
  let sx = 0;
  let sy = 0;
  let sw = video.videoWidth;
  let sh = video.videoHeight;
  if (videoAspect > targetAspect) {
    sw = video.videoHeight * targetAspect;
    sx = (video.videoWidth - sw) / 2;
  } else {
    sh = video.videoWidth / targetAspect;
    sy = (video.videoHeight - sh) / 2;
  }
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + bw - r, y);
    ctx.quadraticCurveTo(x + bw, y, x + bw, y + r);
    ctx.lineTo(x + bw, y + bh - r);
    ctx.quadraticCurveTo(x + bw, y + bh, x + bw - r, y + bh);
    ctx.lineTo(x + r, y + bh);
    ctx.quadraticCurveTo(x, y + bh, x, y + bh - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  };
  ctx.save();
  path();
  ctx.clip();
  ctx.drawImage(video, sx, sy, sw, sh, x, y, bw, bh);
  ctx.restore();
  path();
  ctx.lineWidth = Math.max(2, Math.round(cw / 640));
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
}


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
  /** Effective entrance start (ms) after cross-element sequencing resolution. */
  entStart?: number;
  /** Original text content for a typewriter/word-wipe reveal, restored each frame
   *  before re-truncating (the reveal helper mutates in place). */
  baseContent?: unknown;
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
  opts: { transitionType?: string; transitionDurationMs?: number; exitTransitionDurationMs?: number; exitTotal: number; elapsedMs: number; reduced: boolean },
): "transition" | "exit" | "settled" {
  if (opts.reduced) return "settled";
  // The composite window opens when EITHER side has a transition: the
  // arriving page's own, or the leaving page's exit (v22) - an exit-only
  // page must still play. The window is the longer of the two.
  const enterMs = opts.transitionType && opts.transitionType !== "none" ? (opts.transitionDurationMs ?? 0) : 0;
  const exitMs = opts.exitTransitionDurationMs ?? 0;
  const windowMs = Math.max(enterMs, exitMs);
  if (windowMs > 0) {
    return opts.elapsedMs < windowMs ? "transition" : "settled";
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
  // Resolve cross-element sequencing (with/after previous) across top-level
  // children so the live presentation matches the poser/export.
  const starts = sequenceStarts(page.children);
  let entranceTotal = 0;
  let exitTotal = 0;
  for (const d of driven) {
    const ent = d.anim?.entrance;
    if (ent) {
      d.entStart = starts.get(d.node.id) ?? ent.delayMs;
      entranceTotal = Math.max(entranceTotal, d.entStart + ent.durationMs);
      // Snapshot the original content so a typewriter/word-wipe reveal can be
      // re-applied from scratch each frame (the reveal truncates in place).
      if ((ent.preset === "typewriter" || ent.preset === "word-wipe") && d.node.type === "text") {
        d.baseContent = structuredClone((d.node as unknown as { content: unknown }).content);
      }
    }
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
    // Effective entrance honors cross-element sequencing (the resolved start).
    const ent = d.anim?.entrance ? { ...d.anim.entrance, delayMs: d.entStart ?? d.anim.entrance.delayMs } : undefined;
    const emp = d.anim?.emphasis;
    if (ent && tMs <= clipEnd(ent)) {
      patch = reduced ? entrancePatch(ent, clipEnd(ent)) : entrancePatch(ent, tMs);
    } else if (emp && !reduced) {
      patch = emphasisPatch(emp, tMs - slide.entranceTotal);
    } else if (ent) {
      patch = entrancePatch(ent, clipEnd(ent)); // settle at resting pose
    }
    // Typewriter / word-wipe content reveal: restore the full text, then truncate
    // for the current time (skip when reduced-motion: show it all at once).
    if (ent && d.baseContent !== undefined) {
      (d.node as unknown as { content: unknown }).content = structuredClone(d.baseContent);
      if (!reduced) revealEntranceText(d.node, ent, tMs);
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

  // Present-and-record (doc 28 FR-19): capture a composite of the slide canvas
  // + the presenter ink/laser overlay at 30fps, mix in mic narration when the
  // user grants it (declining still records video-only), and save a .webm on
  // stop. Everything is client-side MediaRecorder; nothing uploads.
  const [recording, setRecording] = useState(false);
  const recRef = useRef<{ rec: MediaRecorder; raf: number; stream: MediaStream; audio: MediaStream | null; cam: MediaStream | null } | null>(null);
  // Camera bubble (T22): the visible draggable preview doubles as the
  // compositing source. Its position is normalized (0..1 of the slide's free
  // area) so the preview and the recorded bubble stay in lockstep.
  const [camStream, setCamStream] = useState<MediaStream | null>(null);
  const camPreviewRef = useRef<HTMLVideoElement>(null);
  const camPosRef = useRef({ x: 1, y: 1 }); // default: bottom-right
  const positionCamPreview = useCallback(() => {
    const v = camPreviewRef.current;
    const cv = canvasRef.current;
    const wrap = wrapRef.current;
    if (!v || !cv || !wrap) return;
    const c = cv.getBoundingClientRect();
    const w0 = wrap.getBoundingClientRect();
    const bw = c.width / 6;
    const bh = (bw * 9) / 16;
    const margin = c.width * 0.02;
    v.style.width = `${bw}px`;
    v.style.height = `${bh}px`;
    v.style.left = `${c.left - w0.left + margin + camPosRef.current.x * Math.max(0, c.width - bw - margin * 2)}px`;
    v.style.top = `${c.top - w0.top + margin + camPosRef.current.y * Math.max(0, c.height - bh - margin * 2)}px`;
  }, []);
  // Attach the stream once the preview element exists, and keep it placed
  // through window resizes.
  useEffect(() => {
    const v = camPreviewRef.current;
    if (!v || !camStream) return;
    v.srcObject = camStream;
    void v.play().catch(() => {});
    positionCamPreview();
    const onResize = () => positionCamPreview();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [camStream, positionCamPreview]);
  const onCamDragStart = useCallback((e: React.PointerEvent<HTMLVideoElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const cv = canvasRef.current;
      if (!cv) return;
      const c = cv.getBoundingClientRect();
      const bw = c.width / 6;
      const bh = (bw * 9) / 16;
      const margin = c.width * 0.02;
      camPosRef.current = {
        x: Math.max(0, Math.min(1, (ev.clientX - c.left - margin - bw / 2) / Math.max(1, c.width - bw - margin * 2))),
        y: Math.max(0, Math.min(1, (ev.clientY - c.top - margin - bh / 2) / Math.max(1, c.height - bh - margin * 2))),
      };
      positionCamPreview();
    };
    const done = (ev: PointerEvent) => {
      // pointerup, pointercancel (gesture takeover, OS interruption), and a
      // lost capture all end the drag - without the cancel paths a hovering
      // cursor would keep dragging the bubble with no button held.
      if (ev.type === "pointerup" && el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", done);
      el.removeEventListener("pointercancel", done);
      el.removeEventListener("lostpointercapture", done);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", done);
    el.addEventListener("pointercancel", done);
    el.addEventListener("lostpointercapture", done);
  }, [positionCamPreview]);
  // Set while start-up is in flight (the mic permission prompt can sit open for
  // as long as the user ignores it) and cleared on unmount. Without it a second
  // click starts a second pipeline that the first recRef write orphans, and an
  // exit during the prompt leaves a live mic and a rAF loop with no UI to stop
  // them.
  const recStartingRef = useRef(false);
  const presentAliveRef = useRef(true);
  const toggleRecording = useCallback(async () => {
    const active = recRef.current;
    if (active) {
      active.rec.stop();
      return;
    }
    if (recStartingRef.current) return;
    const slide = canvasRef.current;
    if (!slide || typeof MediaRecorder === "undefined") return;
    recStartingRef.current = true;
    const comp = document.createElement("canvas");
    comp.width = slide.width || 1920;
    comp.height = slide.height || 1080;
    const cctx = comp.getContext("2d");
    if (!cctx) {
      recStartingRef.current = false;
      return;
    }
    let raf = 0;
    const draw = () => {
      cctx.fillStyle = "#000";
      cctx.fillRect(0, 0, comp.width, comp.height);
      const sl = canvasRef.current;
      const ov = overlayRef.current;
      if (sl) cctx.drawImage(sl, 0, 0, comp.width, comp.height);
      // The ink overlay covers the whole WRAP while the comp is the slide
      // canvas, so map only the overlay's slide-covering sub-rect - stretching
      // the full overlay recorded every stroke shrunk toward center by the
      // letterbox margins.
      if (ov && ov.width > 0 && sl) {
        const wrapEl = wrapRef.current;
        const cvRect = sl.getBoundingClientRect();
        const wrapRect = wrapEl ? wrapEl.getBoundingClientRect() : null;
        if (wrapRect && wrapRect.width > 0 && wrapRect.height > 0 && cvRect.width > 0) {
          const kx = ov.width / wrapRect.width;
          const ky = ov.height / wrapRect.height;
          cctx.drawImage(
            ov,
            (cvRect.left - wrapRect.left) * kx,
            (cvRect.top - wrapRect.top) * ky,
            cvRect.width * kx,
            cvRect.height * ky,
            0,
            0,
            comp.width,
            comp.height,
          );
        } else {
          cctx.drawImage(ov, 0, 0, comp.width, comp.height);
        }
      }
      // Camera bubble last, so it records over slide + ink (T22).
      const camEl = camPreviewRef.current;
      if (camEl) drawCameraBubble(cctx, camEl, comp.width, comp.height, camPosRef.current);
      raf = requestAnimationFrame(draw);
    };
    draw();
    let audio: MediaStream | null = null;
    try {
      audio = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      audio = null; // no mic permission: record the slides silently
    }
    // Present mode may have closed while the MIC prompt was open; bail before
    // popping a camera prompt over whatever screen the user is on now.
    if (!presentAliveRef.current) {
      recStartingRef.current = false;
      cancelAnimationFrame(raf);
      audio?.getTracks().forEach((t) => t.stop());
      return;
    }
    // Optional camera (T22): granting it puts a draggable bubble on the
    // recording; declining keeps today's slides+ink+narration behavior.
    let cam: MediaStream | null = null;
    try {
      cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
    } catch {
      cam = null;
    }
    recStartingRef.current = false;
    // Present mode may have closed while the permission prompt was open. Drop
    // everything we just acquired rather than recording into a dead component.
    if (!presentAliveRef.current) {
      cancelAnimationFrame(raf);
      audio?.getTracks().forEach((t) => t.stop());
      cam?.getTracks().forEach((t) => t.stop());
      return;
    }
    if (cam) setCamStream(cam);
    // From here to rec.start() any throw (a tainted canvas failing
    // captureStream, a browser with no webm encoder failing the MediaRecorder
    // ctor) would otherwise leak the mic, the camera, and the rAF loop with
    // recRef never set - nothing in the UI could stop them.
    let stream: MediaStream;
    let rec: MediaRecorder;
    try {
      stream = comp.captureStream(30);
      if (audio) for (const t of audio.getAudioTracks()) stream.addTrack(t);
      const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
    } catch {
      cancelAnimationFrame(raf);
      audio?.getTracks().forEach((t) => t.stop());
      cam?.getTracks().forEach((t) => t.stop());
      setCamStream(null);
      return;
    }
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      cancelAnimationFrame(raf);
      audio?.getTracks().forEach((t) => t.stop());
      cam?.getTracks().forEach((t) => t.stop());
      setCamStream(null);
      stream.getTracks().forEach((t) => t.stop());
      recRef.current = null;
      setRecording(false);
      if (!chunks.length) return;
      const container = (rec.mimeType || "video/webm").split(";")[0];
      const ext = container.includes("mp4") ? "mp4" : container.includes("webm") ? "webm" : (container.split("/")[1] ?? "webm");
      const blob = new Blob(chunks, { type: container });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      const base = (useEditor.getState().doc.title || "presentation").replace(/[^\w.-]+/g, "-") || "presentation";
      a.download = `${base}-recording.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    try {
      rec.start(1000);
    } catch {
      cancelAnimationFrame(raf);
      audio?.getTracks().forEach((t) => t.stop());
      cam?.getTracks().forEach((t) => t.stop());
      setCamStream(null);
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    recRef.current = { rec, raf, stream, audio, cam };
    setRecording(true);
  }, []);
  // Leaving present mode stops (and saves) an in-flight recording, and tells a
  // start-up still waiting on the mic prompt to abandon itself.
  useEffect(() => {
    presentAliveRef.current = true;
    return () => {
      presentAliveRef.current = false;
      recRef.current?.rec.stop();
    };
  }, []);

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
  const spotRadiusRef = useRef(spotlightDefaultRadius);
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
  // Second-display presenter view (doc 28 FR-15): an audience window mirrors
  // the slide over a BroadcastChannel while this window keeps the HUD. Popups
  // can be blocked, so this only gates the affordance; the same-window overlay
  // keeps working either way (AC-3).
  const designId = useBrand((s) => s.designId);

  // Live audience (doc 28): questions/polls arrive over the realtime socket
  // (the editor session stays connected beneath present mode); reactions float
  // as ephemeral emoji. The drawer refetches on events and on open.
  const [qaOpen, setQaOpen] = useState(false);
  const [audState, setAudState] = useState<AudienceState | null>(null);
  const [unseen, setUnseen] = useState(0);
  const [floaters, setFloaters] = useState<{ id: number; emoji: string; left: number }[]>([]);
  const qaOpenRef = useRef(false);
  useEffect(() => {
    qaOpenRef.current = qaOpen;
  }, [qaOpen]);
  const floaterSeq = useRef(0);
  // Slide-follow (doc 28): publish the current slide so share-link viewers
  // can follow along; -1 on exit ends the live session. Best-effort.
  useEffect(() => {
    if (!designId) return;
    void oc.presenterSetLiveSlide(designId, idx).catch(() => {});
    // Republish on a heartbeat, not only on slide change. Followers treat the
    // live position as stale after liveStaleMs so a presenter who closed the tab stops
    // dragging the audience around, and talking over one slide for longer than
    // that is the normal case, not the exception: without this the banner and
    // slide-follow drop out mid-presentation and flap back on the next slide.
    const beat = setInterval(() => {
      void oc.presenterSetLiveSlide(designId, idx).catch(() => {});
    }, liveHeartbeatMs);
    return () => clearInterval(beat);
  }, [designId, idx]);
  useEffect(() => {
    if (!designId) return;
    return () => void oc.presenterSetLiveSlide(designId, -1).catch(() => {});
  }, [designId]);

  const refreshAudience = useCallback(async () => {
    if (!designId) return;
    try {
      setAudState(await oc.presenterAudienceState(designId));
    } catch {
      // best-effort; the drawer shows the last known state
    }
  }, [designId]);
  useEffect(() => {
    if (!designId) return;
    return onAudienceEvent((e) => {
      if (e.kind === "reaction" && e.emoji) {
        const id = ++floaterSeq.current;
        setFloaters((f) => [...f.slice(-11), { id, emoji: e.emoji!, left: 8 + Math.random() * 84 }]);
        setTimeout(() => setFloaters((f) => f.filter((x) => x.id !== id)), 2600);
        return;
      }
      // "live" is this presenter's own slide publish echoing back; refetching
      // the whole board on every heartbeat would be pure churn.
      if (e.kind === "live") return;
      if (e.kind === "question" && !qaOpenRef.current) setUnseen((n) => n + 1);
      void refreshAudience();
    });
  }, [designId, refreshAudience]);

  const [audienceOpen, setAudienceOpen] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const audienceLink = useRef<AudienceLink | null>(null);
  const audienceWin = useRef<Window | null>(null);

  // Visible-slide bookkeeping (skips hidden slides for nav + the n-of-N count).
  const visIdxs = useMemo(() => visibleIndices(pages as SlideLike[]), [pages, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const pos = visiblePosition(pages as SlideLike[], idx);

  // Through the preference-aware helper, so the in-app Settings override
  // (not just the OS setting) also skips slide transitions.
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);

  /** Open (or focus) the audience display. Returns false when popups are blocked. */
  const openAudience = useCallback((): boolean => {
    if (!designId) return false;
    const win = openAudienceWindow(designId, idx);
    if (!win) return false;
    audienceWin.current = win;
    setPopupBlocked(false);
    if (!audienceLink.current) audienceLink.current = new AudienceLink(designId);
    audienceLink.current.post({ index: idx, blank: blank === "none" ? null : blank });
    setAudienceOpen(true);
    return true;
  }, [designId, idx, blank]);

  const closeAudience = useCallback(() => {
    audienceLink.current?.close();
    audienceLink.current = null;
    try {
      audienceWin.current?.close();
    } catch {
      /* already closed by the user */
    }
    audienceWin.current = null;
    setAudienceOpen(false);
  }, []);

  // Mirror slide + blanking to the audience display whenever either changes.
  useEffect(() => {
    if (!audienceOpen) return;
    audienceLink.current?.post({ index: idx, blank: blank === "none" ? null : blank });
  }, [audienceOpen, idx, blank]);

  // Leaving present mode closes the projection with it.
  useEffect(() => () => closeAudience(), [closeAudience]);

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
        // Second display (FR-15): mirror the slide to an audience window.
        // `E` for "extend"; D/P/L/O/B/W/Z/G/S are already taken by tools.
        case "e": case "E":
          e.preventDefault();
          if (audienceOpen) closeAudience();
          else if (designId && !openAudience()) setPopupBlocked(true);
          return;
        case "p": case "P": e.preventDefault(); setAutopilot((v) => !v); return; // autopilot (FR-14)
        case "l": case "L": e.preventDefault(); selectTool("laser"); return; // laser pointer
        case "d": case "D": e.preventDefault(); selectTool("pen"); return; // on-slide draw (P is autopilot)
        case "o": case "O": e.preventDefault(); selectTool("spotlight"); return; // spotlight
        case "b": case "B": e.preventDefault(); setBlank((v) => (v === "black" ? "none" : "black")); return; // black screen
        case "w": case "W": e.preventDefault(); setBlank((v) => (v === "white" ? "none" : "white")); return; // white screen
        case "g": case "G": case "/": e.preventDefault(); setPaletteOpen(true); return; // jump-to-slide palette
        // Section-aware navigation (doc 28 FR-5): jump to the start of the
        // next/previous section, skipping the rest of the current one. A deck
        // with no sections has nothing to jump to, so these are no-ops.
        case "]":
        case "[": {
          // The spotlight tool owns the brackets for its radius, so only jump
          // sections when it is not the active tool.
          if (tool === "spotlight") break;
          e.preventDefault();
          const to = e.key === "]" ? nextSectionStart(doc, idx) : prevSectionStart(doc, idx);
          if (to >= 0) navigate(to);
          return;
        }
        case "z": case "Z": e.preventDefault(); setZoom((z) => stepZoom(z, zoomStep * 2, 0.5, 0.5)); return; // zoom in (center)
        case "=": case "+": e.preventDefault(); setZoom((z) => stepZoom(z, zoomStep, z.originX, z.originY)); return;
        case "-": case "_": e.preventDefault(); setZoom((z) => stepZoom(z, -zoomStep, z.originX, z.originY)); return;
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
  }, [guardedNext, guardedPrev, onClose, paletteOpen, showHelp, blank, tool, selectTool, audienceOpen, closeAudience, openAudience, designId, doc, idx, navigate]);

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
      // v22: the leaving page's exit transition (if any) opens/extends the
      // composite window, so an exit-only page still plays.
      const exitT = tr ? (pages[tr.from.pageIndex] as { transitionOut?: PageTransition } | undefined)?.transitionOut : undefined;
      const windowDur = reducedMotion ? 0 : transitionPairDurationMs(arrivingTransition, exitT);
      const phase = tr
        ? presentLeavePhase({
            transitionType: arrivingTransition?.type,
            transitionDurationMs: arrivingTransition?.durationMs,
            exitTransitionDurationMs: exitT && exitT.type !== "none" ? exitT.durationMs : 0,
            exitTotal: tr.from.exitTotal,
            elapsedMs: elapsed,
            reduced: reducedMotion,
          })
        : "settled";

      if (phase === "transition" && tr) {
        // Each layer runs on its OWN clock: the arriving transition's
        // duration/easing for the arriving slide, the exit's for the leaving.
        const enterT = pairEnterTransition(arrivingTransition);
        const enterDur = enterT.type === "none" ? windowDur : enterT.durationMs;
        const p = transitionProgress(elapsed, enterDur, enterT.easing);
        const pExit = exitT ? transitionProgress(elapsed, exitT.durationMs, exitT.easing) : p;
        // Un-eased clock for per-element morph easing (C07).
        const pLinear = enterDur > 0 ? Math.min(1, Math.max(0, elapsed / enterDur)) : 1;
        const { from } = tr;
        // Pose both slides: the leaving slide plays its exit, the arriving slide
        // begins its entrance (from the start of the transition window).
        poseExit(from, elapsed, reducedMotion);
        poseEnter(slide, tSlide, reducedMotion);
        compositeTransition(ctx.canvas, ctx, vp, from, slide, enterT, exitT, p, pExit, pLinear, bufA, bufB, drawSlide);
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
    const wait = entranceMs + Math.max(AUTOPILOT_MIN_DWELL_MS, dwellMs(pages as SlideLike[], idx, defaultAutoAdvanceMs));
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
      setZoom((z) => stepZoom(z, e.deltaY < 0 ? zoomStep : -zoomStep, fx, fy));
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
    <div className="light fixed inset-0 z-[100] flex flex-col bg-neutral-900" dir={designSurfaceDir}>
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
        {/* Camera bubble preview (T22): visible only while recording with a
            granted camera; dragging it repositions the recorded bubble live.
            The element itself is the compositing source. */}
        {camStream && (
          <video
            ref={camPreviewRef}
            muted
            playsInline
            title={tr("editor.drag_to_move_the_camera_bubble")}
            aria-label={tr("editor.drag_to_move_the_camera_bubble")}
            className={`absolute z-[107] touch-none cursor-move rounded-lg border-2 border-white object-cover shadow-lg ${zoom.scale > 1 ? "hidden" : ""}`}
            style={{ left: "-9999px", top: "-9999px" }}
            onPointerDown={onCamDragStart}
            onClick={(e) => e.stopPropagation()}
          />
        )}
        {/* Black/white blanking screen (FR-8): full-surface attention pause. Any
            nav key or pressing B/W again restores; clicking it also restores. */}
        {blank !== "none" && (
          <div
            className="absolute inset-0 z-[106]"
            style={{ background: blank === "black" ? "#000" : "#fff" }}
            onClick={(e) => { e.stopPropagation(); setBlank("none"); }}
            title={tr("editor.click_or_press_a_key_to_resume")}
          />
        )}
      </div>
      <button onClick={onClose} className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20" title={tr("editor.exit_esc")}>
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
          <button onClick={undoStroke} disabled={inkCount === 0} className="grid h-7 w-7 place-items-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30" title={tr("editor.undo_last_stroke")}>
            <Undo2 size={15} />
          </button>
          <button onClick={clearStrokes} disabled={inkCount === 0} className="grid h-7 w-7 place-items-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30" title={tr("editor.clear_slide_ink")}>
            <Trash2 size={15} />
          </button>
        </div>
      )}

      <div className="flex items-center justify-center gap-3 py-3 text-white" onClick={(e) => e.stopPropagation()}>
        <button onClick={guardedPrev} disabled={!hasPrev} className="grid h-9 w-9 place-items-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30" title={tr("editor.previous_left_arrow")}>
          <ChevronLeft size={18} />
        </button>
        <span className="text-sm tabular-nums text-white/70">{pos.position} / {pos.total}</span>
        <button onClick={guardedNext} disabled={!hasNext} className="grid h-9 w-9 place-items-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30" title={tr("editor.next_right_arrow")}>
          <ChevronRight size={18} />
        </button>
        <span className="mx-1 h-5 w-px bg-white/15" />
        {/* Magic tools toolbar (FR-8). Each is also a keyboard shortcut. */}
        <ToolButton active={tool === "laser"} onClick={() => selectTool("laser")} title={tr("editor.laser_pointer_l")}><MousePointer2 size={16} /></ToolButton>
        <ToolButton active={tool === "pen"} onClick={() => selectTool("pen")} title={tr("editor.pen_draw_d")}><Pencil size={16} /></ToolButton>
        <ToolButton active={tool === "spotlight"} onClick={() => selectTool("spotlight")} title={tr("editor.spotlight_o")}><Lightbulb size={16} /></ToolButton>
        <ToolButton active={zoom.scale > 1} onClick={() => setZoom((z) => (z.scale > 1 ? fitZoom() : stepZoom(z, zoomStep * 2, 0.5, 0.5)))} title={tr("editor.present_zoom_hint")}><ZoomIn size={16} /></ToolButton>
        <ToolButton active={blank === "black"} onClick={() => setBlank((v) => (v === "black" ? "none" : "black"))} title={tr("editor.black_screen_b")}><Square size={16} fill="currentColor" /></ToolButton>
        <ToolButton active={blank === "white"} onClick={() => setBlank((v) => (v === "white" ? "none" : "white"))} title={tr("editor.white_screen_w")}><Square size={16} /></ToolButton>
        <ToolButton active={paletteOpen} onClick={() => setPaletteOpen(true)} title={tr("editor.jump_to_slide_g_or")}><LayoutGrid size={16} /></ToolButton>
        <span className="mx-1 h-5 w-px bg-white/15" />
        <ToolButton active={autopilot} onClick={() => setAutopilot((v) => !v)} title={autopilot ? tr("editor.pause_autopilot_p") : tr("editor.play_autopilot_p")}>{autopilot ? <Pause size={16} /> : <Play size={16} />}</ToolButton>
        <ToolButton active={loop} onClick={() => setLoop((v) => !v)} title={loop ? tr("editor.loop_on") : tr("editor.loop_off")}><Repeat size={16} /></ToolButton>
        <ToolButton active={showHud} onClick={() => setShowHud((v) => !v)} title={tr("editor.presenter_view_s")}><PanelRightOpen size={16} /></ToolButton>
        {designId && (
          <ToolButton
            active={audienceOpen}
            onClick={() => {
              if (audienceOpen) { closeAudience(); return; }
              if (!openAudience()) setPopupBlocked(true);
            }}
            title={audienceOpen ? tr("editor.close_audience_display_e") : tr("editor.open_audience_display_on_a_second_screen_e")}
          >
            {audienceOpen ? <MonitorX size={16} /> : <MonitorPlay size={16} />}
          </ToolButton>
        )}
        <ToolButton active={recording} onClick={() => void toggleRecording()} title={recording ? tr("editor.stop_recording_and_save_the_file") : tr("editor.record_the_presentation_slides_ink_narration")}>
          <Disc size={16} className={recording ? "animate-pulse text-red-400" : undefined} />
        </ToolButton>
        {designId && (
          <ToolButton
            active={qaOpen}
            onClick={() => {
              const next = !qaOpen;
              setQaOpen(next);
              if (next) {
                setUnseen(0); // opening marks everything seen
                void refreshAudience();
              }
            }}
            title={tr("editor.audience_q_a_and_polls")}
          >
            <span className="relative">
              <MessageSquare size={16} />
              {unseen > 0 && (
                <span className="absolute -right-2 -top-2 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-0.5 text-[9px] font-bold text-white">{unseen > 9 ? "9+" : unseen}</span>
              )}
            </span>
          </ToolButton>
        )}
        <ToolButton active={showHelp} onClick={() => setShowHelp((v) => !v)} title={tr("editor.shortcuts")}><HelpCircle size={16} /></ToolButton>
      </div>

      {recording && (
        <div className="pointer-events-none absolute left-4 top-4 z-50 flex items-center gap-1.5 rounded-full bg-red-600/90 px-2.5 py-1 text-[11px] font-semibold text-white shadow-lg">
          <span className="h-2 w-2 animate-pulse rounded-full bg-white" /> REC
        </div>
      )}

      {/* Audience reactions float up from the bottom edge (ephemeral). */}
      {floaters.length > 0 && (
        <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden" aria-hidden>
          {floaters.map((f) => (
            <span key={f.id} className="absolute bottom-16 animate-bounce text-3xl drop-shadow-lg" style={{ left: `${f.left}%` }}>
              {f.emoji}
            </span>
          ))}
        </div>
      )}

      {qaOpen && designId && (
        <PresenterAudience
          designId={designId}
          state={audState}
          onRefresh={() => void refreshAudience()}
          onClose={() => setQaOpen(false)}
        />
      )}

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

      {/* Popups blocked: AC-3 requires falling back to the same-window overlay,
          so we explain rather than fail silently. */}
      {popupBlocked && (
        <div className="pointer-events-auto absolute left-1/2 top-4 z-50 -translate-x-1/2 rounded-lg bg-amber-500/95 px-3 py-2 text-xs font-medium text-black shadow-lg">
          {tr("editor.allow_pop_ups_for_this_site_to_open_the_audi")}
          <button onClick={() => setPopupBlocked(false)} className="ml-3 underline">{tr("editor.dismiss")}</button>
        </div>
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
    [tr("editor.right_space_pagedown"), tr("editor.next_slide")],
    [tr("editor.left_pageup"), tr("editor.previous_slide")],
    ["L", tr("editor.laser_pointer")],
    ["D", tr("editor.pen_draw_ephemeral")],
    ["O", "Spotlight (wheel or [ ] adjusts radius)"],
    [tr("editor.z_wheel"), tr("editor.zoom_0_resets_to_fit")],
    ["B", tr("editor.black_screen")],
    ["W", tr("editor.white_screen")],
    [tr("editor.g_or"), tr("editor.jump_to_slide_palette")],
    ["S", tr("editor.presenter_view")],
    ["E", tr("editor.audience_display_2nd_screen")],
    ["[ / ]", tr("editor.previous_next_section")],
    ["P", tr("editor.autopilot_play_pause")],
    ["?", tr("editor.toggle_this_help")],
    [tr("editor.esc"), tr("editor.close_tool_overlay_then_exit")],
  ];
  return (
    <div className="absolute inset-0 z-[120] grid place-items-center bg-black/40" onClick={onClose}>
      <div
        className="w-[440px] max-w-[90vw] rounded-2xl border border-white/10 bg-neutral-950/95 p-5 text-white shadow-2xl backdrop-blur"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold">{tr("editor.presenter_shortcuts")}</span>
          <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-full bg-white/10 hover:bg-white/20" title={tr("editor.close_esc")}>
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
          <span className="text-sm font-semibold">{tr("editor.jump_to_slide")}</span>
          <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-full bg-white/10 hover:bg-white/20" title={tr("editor.close_esc")}>
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
                  <span className="absolute left-1 top-1 rounded bg-brand-500/90 px-1.5 py-0.5 text-[10px] font-medium">{tr("editor.current")}</span>
                )}
              </div>
              <div className="mt-1 truncate text-xs text-white/70">
                {`${n + 1}. ${doc.pages[full]?.name ?? tr("editor.slide")}`}
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
/** Speaker notes as a teleprompter (doc 28 FR-15): resizable type and an
 *  optional steady auto-scroll, so a presenter can read from across a lectern.
 *  Scrolling resets when the slide's notes change. */
function Teleprompter({ notes }: { notes: string }) {
  const [fontPx, setFontPx] = useState(14);
  const [speed, setSpeed] = useState(0); // px/sec; 0 = off
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [notes]);

  useEffect(() => {
    if (!speed) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const el = ref.current;
      const dt = (now - last) / 1000;
      last = now;
      if (el) {
        el.scrollTop = Math.min(el.scrollTop + speed * dt, el.scrollHeight - el.clientHeight);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [speed]);

  const has = notes.trim().length > 0;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-white/40">
        <span>{tr("editor.speaker_notes")}</span>
        {has && (
          <div className="flex items-center gap-2 normal-case">
            <button
              onClick={() => setFontPx((v) => Math.max(11, v - 2))}
              className="rounded px-1.5 py-0.5 text-white/60 hover:bg-white/10"
              aria-label={tr("editor.smaller_notes_text")}
              title={tr("editor.smaller")}
            >
              A-
            </button>
            <button
              onClick={() => setFontPx((v) => Math.min(30, v + 2))}
              className="rounded px-1.5 py-0.5 text-white/60 hover:bg-white/10"
              aria-label={tr("editor.larger_notes_text")}
              title={tr("editor.larger")}
            >
              A+
            </button>
            <button
              onClick={() => setSpeed((v) => (v ? 0 : 18))}
              className={`rounded px-1.5 py-0.5 hover:bg-white/10 ${speed ? "text-brand-300" : "text-white/60"}`}
              aria-pressed={speed > 0}
              title={tr("editor.auto_scroll_the_notes")}
            >
              {tr("editor.scroll")}
            </button>
            {speed > 0 && (
              <input
                type="range"
                min={6}
                max={60}
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                className="h-1 w-16 accent-white/70"
                aria-label={tr("editor.scroll_speed")}
              />
            )}
          </div>
        )}
      </div>
      <div
        ref={ref}
        data-testid="teleprompter"
        style={{ fontSize: `${fontPx}px` }}
        className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-white/5 p-2.5 leading-relaxed text-white/85"
      >
        {has ? notes : <span className="text-white/30">{tr("editor.no_notes_for_this_slide")}</span>}
      </div>
    </div>
  );
}

/** The presenter's wall clock (doc 28 FR-15): real time of day, distinct from
 *  the rehearsal timer, so a presenter can pace against the room's schedule. */
function WallClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span data-testid="wall-clock" className="tabular-nums text-white/70">
      {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </span>
  );
}

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
        <span className="text-xs font-semibold uppercase tracking-wide text-white/50">{tr("editor.presenter_view")}</span>
        <span className="flex items-center gap-2 text-xs tabular-nums text-white/60">
          <WallClock />
          <span className="text-white/25">|</span>
          <span>{position} of {total}</span>
        </span>
      </div>

      <div className="flex gap-2">
        <div className="flex-1">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">{tr("editor.current")}</div>
          <div className="grid aspect-video place-items-center overflow-hidden rounded-lg border border-white/10 bg-white/5">
            <SlideThumb doc={doc} index={curIdx} w={200} h={120} />
          </div>
        </div>
        <div className="w-[42%]">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">{tr("editor.next")}</div>
          <div className="grid aspect-video place-items-center overflow-hidden rounded-lg border border-white/10 bg-white/5">
            {nextIdx >= 0 ? <SlideThumb doc={doc} index={nextIdx} w={140} h={84} /> : <span className="text-[10px] text-white/30">{tr("editor.end")}</span>}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <button onClick={onPrev} disabled={!hasPrev} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20 disabled:opacity-30">{tr("editor.prev")}</button>
        <select
          value={curIdx}
          onChange={(e) => onJump(Number(e.target.value))}
          className="flex-1 rounded-lg border border-white/10 bg-neutral-900 px-2 py-1.5 text-xs outline-none"
          title={tr("editor.jump_to_slide")} aria-label={tr("editor.jump_to_slide")}
        >
          {visIdxs.map((i, n) => (
            <option key={i} value={i}>{`Slide ${n + 1}${doc.pages[i]?.name ? ` - ${doc.pages[i].name}` : ""}`}</option>
          ))}
        </select>
        <button onClick={onNext} disabled={!hasNext} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20 disabled:opacity-30">{tr("editor.next")}</button>
      </div>

      <Teleprompter notes={notes} />

      <div className="rounded-lg border border-white/10 bg-white/5 p-3">
        <div className="flex items-center justify-between">
          <div className={`text-3xl font-semibold tabular-nums ${timerOver ? "text-red-400" : ""}`}>{timerDisplay}</div>
          <div className="flex gap-1.5">
            <button onClick={onToggleTimer} className="rounded-lg bg-white/10 px-2.5 py-1 text-xs hover:bg-white/20">{timerRunning ? tr("editor.stop") : tr("editor.start")}</button>
            <button onClick={onResetTimer} className="rounded-lg bg-white/10 px-2.5 py-1 text-xs hover:bg-white/20">{tr("editor.reset")}</button>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs">
          <div className="inline-flex overflow-hidden rounded-lg border border-white/10">
            <button onClick={() => onSetMode("up")} className={`px-2.5 py-1 ${timerMode === "up" ? "bg-brand-500/80" : "bg-white/5 hover:bg-white/10"}`}>{tr("editor.count_up")}</button>
            <button onClick={() => onSetMode("down")} className={`px-2.5 py-1 ${timerMode === "down" ? "bg-brand-500/80" : "bg-white/5 hover:bg-white/10"}`}>{tr("editor.count_down")}</button>
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
              {tr("editor.min")}
            </label>
          )}
        </div>
      </div>

      {breakdown && breakdown.length > 0 && (
        <div className="rounded-lg border border-white/10 bg-white/5 p-3">
          <div className="mb-1.5 text-[10px] uppercase tracking-wide text-white/40">{tr("editor.per_slide_time_rehearsal")}</div>
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

      <button onClick={onClose} className="mt-auto rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20">{tr("editor.close_presenter_view_s")}</button>
    </div>
  );
}

// Composite the leaving and arriving slides into `dest` for the given transition
// at eased progress `p` (0..1). Uses two offscreen buffers (sized to the canvas)
// so each slide renders once per frame and is then blended/translated cheaply.
//
// This is a thin browser adapter: it owns the offscreen buffers and the morph
// overlay (which needs a scene render), while the compositing math lives in the
// pure `@hc/engine` helper (doc 28 FR-13), so present mode, the web player, and
// headless export all render transitions identically.
function compositeTransition(
  dest: HTMLCanvasElement,
  destCtx: CanvasRenderingContext2D,
  vp: Viewport,
  from: Slide,
  to: Slide,
  transition: PageTransition,
  exitTransition: PageTransition | undefined,
  p: number,
  pExit: number,
  pLinear: number,
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
  // Morph (Magic Move): elements shared by id between the two slides are drawn
  // tweened on top, so they must NOT appear in the cross-faded buffers. Hide them
  // in both clones for the buffer draws, then restore.
  const morph = transition.type === "morph" ? morphPlan(from.doc, from.pageIndex, to.doc, to.pageIndex) : null;
  const restoreHidden: { node: Node; prev: boolean | undefined }[] = [];
  if (morph) {
    for (const n of morph.fromNodes.values()) { restoreHidden.push({ node: n, prev: n.hidden }); (n as { hidden?: boolean }).hidden = true; }
    for (const n of morph.toNodes.values()) { restoreHidden.push({ node: n, prev: n.hidden }); (n as { hidden?: boolean }).hidden = true; }
  }
  draw(from, ca, vp);
  draw(to, cb, vp);
  for (const h of restoreHidden) (h.node as { hidden?: boolean }).hidden = h.prev;

  renderTransitionPair(destCtx as unknown as CanvasLike, transition, exitTransition, {
    from: bufA,
    to: bufB,
    width: W,
    height: H,
    progress: p,
    exitProgress: pExit,
  });

  // The morphed layer needs a scene render, so it stays with the caller: the
  // engine helper has already cross-faded the shared-element-free buffers.
  if (morph && morph.ids.length) {
    const tempDoc = morphDesignAt(morph, to.doc, to.pageIndex, p, { linearProgress: pLinear });
    try {
      renderScene(createScene(tempDoc, to.pageIndex), destCtx as unknown as CanvasLike, vp, { assets: imageAssets });
    } catch { /* a cross-origin image can throw; skip the morphed layer */ }
  }
}

// Presenter-side audience drawer (doc 28): moderate viewer questions (answer /
// dismiss), launch and close live polls, and clear the board between sessions.
// Renders over present mode but never over the audience display (that window
// only mirrors the slide canvas).
function PresenterAudience({ designId, state, onRefresh, onClose }: {
  designId: string;
  state: AudienceState | null;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [pollQ, setPollQ] = useState("");
  const [pollOpts, setPollOpts] = useState("");
  const [busy, setBusy] = useState(false);

  async function createPoll() {
    const options = pollOpts.split("\n").map((o) => o.trim()).filter(Boolean);
    if (!pollQ.trim() || options.length < 2 || busy) return;
    // The server accepts 2..6 options; say so here rather than letting the
    // request 422 with nothing shown to the presenter.
    if (options.length > 6) {
      toast.error(tr("editor.a_poll_takes_at_most_6_options"));
      return;
    }
    setBusy(true);
    try {
      await oc.presenterCreatePoll(designId, { question: pollQ.trim(), options });
      setPollQ("");
      setPollOpts("");
      onRefresh();
    } catch {
      toast.error(tr("editor.could_not_launch_that_poll"));
    } finally {
      setBusy(false);
    }
  }

  const questions = state?.questions ?? [];
  const polls = state?.polls ?? [];
  return (
    <aside className="light pointer-events-auto absolute bottom-16 right-4 top-4 z-50 flex w-80 flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl">
      <header className="flex items-center justify-between border-b border-neutral-100 px-3 py-2">
        <span className="text-sm font-semibold text-neutral-800">{tr("editor.audience")}</span>
        <span className="flex items-center gap-1">
          <button
            onClick={() => { void oc.presenterClearAudience(designId).then(onRefresh).catch(() => {}); }}
            title={tr("editor.clear_all_questions_and_polls_new_session")}
            className="rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
          >
            {tr("editor.clear")}
          </button>
          <button onClick={onClose} aria-label={tr("editor.close")} className="rounded p-1 text-neutral-400 hover:bg-neutral-100"><X size={16} /></button>
        </span>
      </header>
      <div className="oc-scroll flex-1 overflow-y-auto p-3">
        {/* Poll launcher */}
        <div className="mb-3 rounded-xl border border-neutral-200 p-2.5">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400"><BarChart3 size={12} /> {tr("editor.new_poll")}</p>
          <input
            value={pollQ}
            onChange={(e) => setPollQ(e.target.value)}
            placeholder={tr("editor.poll_question")}
            className="mb-1.5 w-full rounded-lg border border-neutral-200 px-2 py-1.5 text-xs outline-none focus:border-brand-400"
          />
          <textarea
            value={pollOpts}
            onChange={(e) => setPollOpts(e.target.value)}
            placeholder={tr("editor.one_option_per_line_2_6")}
            rows={2}
            className="mb-1.5 w-full resize-none rounded-lg border border-neutral-200 px-2 py-1.5 text-xs outline-none focus:border-brand-400"
          />
          <button
            onClick={() => void createPoll()}
            disabled={busy || !pollQ.trim() || pollOpts.split("\n").filter((o) => o.trim()).length < 2}
            className="w-full rounded-lg bg-neutral-900 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            {tr("editor.launch_poll")}
          </button>
        </div>

        {polls.map((p) => {
          const total = p.counts.reduce((s, n) => s + n, 0);
          return (
            <div key={p.id} className="mb-3 rounded-xl border border-neutral-200 p-2.5">
              <p className="mb-1 flex items-center justify-between text-sm font-medium text-neutral-800">
                <span className="truncate">{p.question}</span>
                <button
                  onClick={() => { void oc.presenterSetPollOpen(designId, p.id, !p.open).then(onRefresh).catch(() => {}); }}
                  className={`ml-2 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${p.open ? "bg-emerald-100 text-emerald-700" : "bg-neutral-100 text-neutral-500"}`}
                >
                  {p.open ? tr("editor.open") : tr("editor.closed")}
                </button>
              </p>
              {p.options.map((opt, i) => {
                const pct = total ? Math.round((p.counts[i] / total) * 100) : 0;
                return (
                  <div key={i} className="relative mb-1 overflow-hidden rounded-lg border border-neutral-100 px-2 py-1 text-xs text-neutral-700">
                    <span className="absolute inset-y-0 left-0 bg-brand-100/70" style={{ width: `${pct}%` }} aria-hidden />
                    <span className="relative flex justify-between">
                      <span className="truncate">{opt}</span>
                      <span className="ml-2 shrink-0 tabular-nums text-neutral-500">{p.counts[i]} · {pct}%</span>
                    </span>
                  </div>
                );
              })}
              <p className="text-right text-[10px] text-neutral-400">{total} vote{total === 1 ? "" : "s"}</p>
            </div>
          );
        })}

        {/* Questions, hottest first (server orders by votes). */}
        {questions.map((q) => (
          <div key={q.id} className={`mb-1.5 rounded-lg px-2 py-1.5 ${q.dismissed ? "bg-neutral-50 opacity-60" : "bg-neutral-50"}`}>
            <p className="text-xs text-neutral-800">{q.text}</p>
            <p className="mt-0.5 flex items-center gap-2 text-[10px] text-neutral-400">
              <span className="flex items-center gap-0.5"><ThumbsUp size={10} /> {q.votes}</span>
              <span className="truncate">{q.authorName || tr("editor.anonymous")}</span>
              <span className="ml-auto flex gap-1">
                <button
                  onClick={() => { void oc.presenterModerateQuestion(designId, q.id, { answered: !q.answered }).then(onRefresh).catch(() => {}); }}
                  title={q.answered ? tr("editor.mark_unanswered") : tr("editor.mark_answered")}
                  className={`rounded p-0.5 ${q.answered ? "text-emerald-600" : "text-neutral-400 hover:text-neutral-600"}`}
                >
                  <CheckCircle2 size={12} />
                </button>
                <button
                  onClick={() => { void oc.presenterModerateQuestion(designId, q.id, { dismissed: !q.dismissed }).then(onRefresh).catch(() => {}); }}
                  title={q.dismissed ? tr("editor.restore") : tr("editor.dismiss_hides_from_the_audience")}
                  className="rounded p-0.5 text-neutral-400 hover:text-neutral-600"
                >
                  <EyeOff size={12} />
                </button>
              </span>
            </p>
          </div>
        ))}
        {questions.length === 0 && <p className="py-3 text-center text-xs text-neutral-400">{tr("editor.no_questions_yet_share_the_link_and_ask_the")}</p>}
      </div>
    </aside>
  );
}
