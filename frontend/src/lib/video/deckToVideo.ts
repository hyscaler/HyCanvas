// Deck / presentation -> video conversion (P5.3). Turns a multi-page design (a
// deck) into a footage-free video: each page becomes a contiguous SCENE whose
// background and top-level nodes become element clips (Clip.element), carrying
// each node's own animation so entrances/emphasis play in the video. A page's
// slide transition maps to the scene's clip transition. The result is a new video
// DesignFile (meta.kind = "video", meta.video = the project); the deck is untouched.
//
// Per-node conversion (one clip per top-level page node) is deliberate: it reuses
// the single-node pose path that both the browser preview and the Go server export
// agree on. Animations nested inside a group node still render, but their per-child
// timing is only fully posed in the browser (a documented limit, like custom
// keyframe tracks); most deck elements are top-level, so this is rare.

import { currentSchemaVersion, type DesignFile, type Node, type Page, type PageTransition } from "@hc/schema";
import { pageAnimationDuration } from "@hc/engine";
import { newProject, newTrack, type Clip, type Track, type VideoProject, type ClipTransition } from "@hc/timeline";
import { tr } from "@/lib/i18n";

/** A solid rect element filling the stage with a page's background color (solid
 *  fills only; gradients/images fall back to white so the scene is never empty). */
function backgroundNode(page: Page, w: number, h: number): Node {
  let srgb = { r: 1, g: 1, b: 1, a: 1 };
  const bg = page.background as { type?: string; color?: { srgb?: { r: number; g: number; b: number; a?: number } } } | undefined;
  if (bg?.type === "solid" && bg.color?.srgb) {
    const c = bg.color.srgb;
    srgb = { r: c.r, g: c.g, b: c.b, a: c.a ?? 1 };
  }
  return {
    id: `bg_${page.id}`,
    type: "shape",
    name: tr("app.background"),
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: w, height: h },
    opacity: 1,
    blendMode: "normal",
    shape: "rect",
    fills: [{ type: "solid", color: { srgb } }],
  } as unknown as Node;
}

/** Map a page slide transition to the scene's clip entrance transition. */
function clipTransitionFor(t: PageTransition | undefined, fps: number): ClipTransition | undefined {
  if (!t || t.type === "none") return undefined;
  const durationFrames = Math.max(1, Math.round((t.durationMs || 400) / 1000 * fps));
  const map: Record<string, ClipTransition["type"]> = {
    fade: "fade",
    dissolve: "crossDissolve",
    slide: "slide",
    push: "slide",
    wipe: "wipe",
    // flip / zoom / morph have no direct clip-transition; fade is the safe fallback.
    flip: "fade",
    zoom: "fade",
    morph: "fade",
    "morph-lite": "fade",
  };
  return { type: map[t.type] ?? "fade", durationFrames };
}

export interface DeckToVideoOpts {
  /** Seconds a page holds after its animations finish (default 2s). */
  holdSeconds?: number;
  /** Minimum seconds per scene (default 3s). */
  minSeconds?: number;
  fps?: number;
}

/** Build a VideoProject from a deck's pages (one contiguous scene per page). */
export function deckToVideoProject(doc: DesignFile, opts: DeckToVideoOpts = {}): VideoProject {
  const fps = opts.fps ?? 30;
  const hold = opts.holdSeconds ?? 2;
  const minS = opts.minSeconds ?? 3;
  const pages = (doc.pages ?? []).filter((p) => !p.hidden);
  const w = pages[0]?.width ?? 1920;
  const h = pages[0]?.height ?? 1080;

  // Enough overlay tracks for the busiest page (background + its top-level nodes).
  const maxLayers = Math.max(1, ...pages.map((p) => 1 + p.children.length));
  const tracks: Track[] = Array.from({ length: maxLayers }, (_, i) => newTrack("overlay", `Layer ${i + 1}`));

  let run = 0;
  pages.forEach((page, pi) => {
    const animMs = pageAnimationDuration(doc, doc.pages.indexOf(page));
    // Honor the deck's authored per-slide dwell (autoAdvanceMs) when present, with
    // only a tiny floor so a deliberately short slide is respected; else fall back
    // to "animations + a hold", floored at the default minimum scene length.
    const durFrames = page.autoAdvanceMs && page.autoAdvanceMs > 0
      ? Math.max(Math.round(0.3 * fps), Math.round((page.autoAdvanceMs / 1000) * fps))
      : Math.max(Math.round(minS * fps), Math.round((animMs / 1000 + hold) * fps));
    const sceneId = `scene_${page.id}`;
    const transition = clipTransitionFor(page.transition, fps);
    // Layer 0: the page background. Layers 1..N: the page's top-level nodes, in
    // z-order, each carrying its own animation.
    const layers: Node[] = [backgroundNode(page, w, h), ...page.children];
    layers.forEach((node, li) => {
      const clip: Clip = {
        id: `clip_${page.id}_${li}`,
        name: li === 0 ? tr("app.background") : (node as { name?: string }).name || `Element ${li}`,
        startFrame: run,
        inFrame: 0,
        outFrame: durFrames,
        speed: 1,
        element: node,
        sceneId,
        // The scene's entrance transition rides on every layer (matches the
        // scene-transition model), except the very first page which has nothing
        // to transition from.
        ...(transition && pi > 0 ? { transitionIn: transition } : {}),
      };
      tracks[li] = { ...tracks[li], clips: [...tracks[li].clips, clip] };
    });
    run += durFrames;
  });

  // Drop unused overlay tracks (pages with fewer nodes leave higher layers empty).
  const used = tracks.filter((t) => t.clips.length > 0);
  return newProject({ stage: { width: w, height: h }, fps: fps as VideoProject["fps"], tracks: used, durationFrames: run });
}

/** A new video DesignFile built from a deck, ready to createDesign(). */
export function deckToVideoFile(doc: DesignFile, opts: DeckToVideoOpts = {}): DesignFile {
  const project = deckToVideoProject(doc, opts);
  return {
    format: "hycanvas.design",
    schemaVersion: currentSchemaVersion,
    id: `video_${doc.id}`,
    title: `${doc.title || tr("app.design")} (video)`,
    unit: doc.unit ?? "px",
    dpi: doc.dpi ?? 96,
    // A single stage-sized page keeps the file valid for scene-backed tooling; the
    // timeline lives in meta.video (like any video document).
    pages: [{ id: "p", name: "Stage", width: project.stage.width, height: project.stage.height, background: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }, children: [] }],
    assets: doc.assets ?? [],
    fonts: doc.fonts ?? [],
    meta: { kind: "video", video: project },
  };
}
