// F29 Video editor surface: a multi-track, frame-accurate timeline
// editor mounted by DocumentSurface when `doc.meta.kind === "video"`.
//
// The video project model lives in `doc.meta.video` as an @hc/timeline
// VideoProject (the open-file-format serialization). All
// timeline edits go through the pure @hc/timeline operations and are persisted
// back through `setDocMeta({ video })`, which shallow-merges into doc.meta as a
// SINGLE undoable step. The audio mixer reads its effective state through the
// pure @hc/audio helpers.
//
// BUILT:
//   - Real media binding: clips reference uploaded video/audio assets (picker
//     per track), with probed durations, filmstrip thumbnails, and waveforms.
//   - Live preview: the stage canvas composites the active video clips per
//     frame (in/out/speed/reverse mapping, crop, the five transition types)
//     and plays audio through a WebAudio mix (clip x track x master gains,
//     fade envelopes, ducking automation) - see lib/video/{compositor,playback}.
//   - Export: renders the timeline in-browser in real time (canvas capture +
//     the audio mix through MediaRecorder; MP4 where supported, else WebM).
//   - Captions: a manual cue editor, burned-in rendering on the stage and in
//     export, and SRT/VTT downloads.
// SCOPE / DEFERRED:
//   - Reverse-speed clips render by per-frame seeking and play muted (media
//     elements cannot play backwards).
//   - Auto-captions, beat detection (DSP onset analysis), and chroma-key
//     rendering are DEFERRED (AI media roadmap). Beat SNAPPING is wired
//     (snapFrameToBeats) but with an empty beat grid until detection lands.
//   - Keyframe property lanes are DEFERRED (the model carries keyframes; editing
//     them needs the animation UI).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Play,
  Pause,
  SkipBack,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Scissors,
  Trash2,
  Film,
  Music2,
  Type as TypeIcon,
  Wand2,
  Layers,
  ZoomIn,
  ZoomOut,
  Volume2,
  VolumeX,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  PanelRightClose,
  PanelRightOpen,
  Gauge,
  Download,
  Loader2,
  Palette,
  Repeat,
  PanelLeftClose,
  PanelLeftOpen,
  PanelBottomClose,
  PanelBottomOpen,
  Mic,
  MonitorUp,
  Video as WebcamIcon,
  Upload as UploadIcon,
  Magnet,
  Maximize2,
  Copy as CopyIcon,
  Camera,
  Crosshair,
  Expand,
  ImageIcon,
  PlaySquare,
  Link as LinkIcon,
  Rows3,
} from "lucide-react";
import {
  newProject,
  newTrack,
  trim,
  splitClip,
  moveClip,
  setSpeed,
  addTransition,
  snapFrameToBeats,
  clipEndFrame,
  clipDurationFrames,
  projectDurationFrames,
  clipAtFrame,
  clipsOverlap,
  sourceFrameAt,
  sortClips,
  remapFps,
  type Fps,
  type AudioMaster,
  type TitleCard,
  type ChromaKey,
  type KeyframeTrack,
  type VideoProject,
  type Track,
  type Clip,
  type ClipTransition,
} from "@hc/timeline";
import {
  soloActive,
  solveDucking,
} from "@hc/audio";
import type { UploadedAsset } from "@hc/sdk";
import { useEditor } from "@/store/editor";
import { oc, resolveAssetUrl, uploadAssetWithProgress } from "@/lib/sdk";
import {
  drawTimelineFrame,
  drawCaption,
  evalKeyframes,
  upsertPoseKeyframe,
  activeClipsAt,
  activeTitleClipsAt,
  visibleVideoClipsAt,
  titleBounds,
  COLOR_PRESETS,
  colorIsNeutral,
  MOTION_PRESETS,
  applyMotionPreset,
  setTrackEasing,
  fitRect,
} from "@/lib/video/compositor";
import { TimelinePlayer } from "@/lib/video/playback";
import { probeMedia, filmstrip, waveformDataUrl } from "@/lib/video/mediaCache";
import { pickRecorderTarget, startRecording, downloadBlob, type ExportController } from "@/lib/video/exporter";
import { captionStyleOf, cueAt, withCaptionStyle, withCues, toSrt, toVtt, type CaptionCue } from "@/lib/video/captions";
import { detectSceneSeconds } from "@/lib/video/sceneDetect";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const TRACK_HEIGHT = 56; // px per track lane
const GUTTER_WIDTH = 200; // px, the left track-header column
const RULER_HEIGHT = 28; // px, the time ruler above the lanes
// The timeline viewport caps at ~4.5 lanes; more tracks scroll vertically.
const DEFAULT_CLIP_FRAMES = 60; // length of a freshly added placeholder clip
const TRIM_STEP = 6; // frames per trim-button press
const MIN_PX_PER_FRAME = 0.25;
const MAX_PX_PER_FRAME = 12;
// Per-user persisted open/closed state for the right clip-inspector aside.
const INSPECTOR_OPEN_KEY = "oc-video-inspector-open";
const MEDIA_OPEN_KEY = "oc-video-media-open";
const TIMELINE_OPEN_KEY = "oc-video-timeline-open";
// Sidebar widths are user-adjustable (drag the inner edge) and persisted.
const MEDIA_W_KEY = "oc-video-media-w";
const INSPECTOR_W_KEY = "oc-video-inspector-w";
const MEDIA_W_DEFAULT = 208;
const INSPECTOR_W_DEFAULT = 240;
const clampSidebarW = (w: number) => Math.max(170, Math.min(480, Math.round(w)));
const storedSidebarW = (key: string, fallback: number): number => {
  if (typeof window === "undefined") return fallback;
  const v = parseInt(window.localStorage.getItem(key) ?? "", 10);
  return Number.isFinite(v) ? clampSidebarW(v) : fallback;
};
// Stage size presets (the common social/broadcast formats).
const STAGE_PRESETS: { value: string; label: string }[] = [
  { value: "1920x1080", label: "YouTube / 16:9 (1920x1080)" },
  { value: "1080x1920", label: "TikTok / Reels / Shorts (1080x1920)" },
  { value: "1080x1080", label: "Instagram square (1080x1080)" },
  { value: "1080x1350", label: "Instagram portrait 4:5 (1080x1350)" },
  { value: "1280x720", label: "720p (1280x720)" },
  { value: "2560x1440", label: "1440p (2560x1440)" },
  { value: "3840x2160", label: "4K (3840x2160)" },
];

/** Clamp a typed stage dimension to a sane, encoder-friendly (even) value. */
function clampStageDim(v: number): number {
  const n = Math.max(16, Math.min(7680, Math.round(v)));
  return n % 2 === 0 ? n : n + 1;
}

// Transition types offered in the inspector edge selectors. "" clears the edge.
const TRANSITION_TYPES: { value: "" | ClipTransition["type"]; label: string }[] = [
  { value: "", label: "None" },
  { value: "crossDissolve", label: "Cross dissolve" },
  { value: "fade", label: "Fade" },
  { value: "wipe", label: "Wipe" },
  { value: "slide", label: "Slide" },
  { value: "dipToColor", label: "Dip to color" },
];

// A clip's accent color is derived from its track kind so the timeline reads at
// a glance. Chrome only (Tailwind palette), never canvas content.
const KIND_COLOR: Record<Track["kind"], string> = {
  video: "#6366f1", // indigo
  audio: "#10b981", // emerald
  text: "#f59e0b", // amber
  effects: "#ec4899", // pink
  overlay: "#0ea5e9", // sky
};

const KIND_ICON: Record<Track["kind"], React.ComponentType<{ className?: string; size?: number }>> = {
  video: Film,
  audio: Music2,
  text: TypeIcon,
  effects: Wand2,
  overlay: Layers,
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Format an integer frame at a given fps as mm:ss:ff (frames within second). */
function formatTimecode(frame: number, fps: number): string {
  const safeFps = fps > 0 ? fps : 30;
  const f = Math.max(0, Math.round(frame));
  const totalSeconds = Math.floor(f / safeFps);
  const ff = f % safeFps;
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

/** Parse a typed timecode back to frames: "ss", "mm:ss", or "mm:ss:ff".
 *  Returns null when the text is not a time. */
function parseTimecode(text: string, fps: number): number | null {
  const parts = text.trim().split(":").map((p) => p.trim());
  if (parts.some((p) => p === "" || !/^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  const safeFps = fps > 0 ? fps : 30;
  if (nums.length === 1) return Math.round(nums[0] * safeFps); // plain seconds
  if (nums.length === 2) return Math.round((nums[0] * 60 + nums[1]) * safeFps);
  if (nums.length === 3) return Math.round((nums[0] * 60 + nums[1]) * safeFps + nums[2]);
  return null;
}

/** Live nested-sequence lookup straight from the store, for closures that
 *  outlive a render (the player's resolver, deferred path checks). */
function liveSequences(): Record<string, VideoProject> {
  return (useEditor.getState().doc.meta.videoSequences as Record<string, VideoProject> | undefined) ?? {};
}

/** The preview-proxy URL for a video asset (the content route with /proxy). */
function proxyUrlFor(a: UploadedAsset): string {
  return resolveAssetUrl(a.url).replace(/\/content$/, "/proxy");
}

/** A small, dependency-free unique id for new clips/assets (placeholder media). */
function shortId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Recompute and stamp the project's `durationFrames` from its tracks so the
 * ruler, scroll extent, and playhead clamp stay correct after every edit.
 */
function withDuration(project: VideoProject): VideoProject {
  // The user-set floor survives edits: trailing space stays put, and a longer
  // duration authored by another client is never silently shrunk.
  return {
    ...project,
    durationFrames: Math.max(projectDurationFrames(project), project.minDurationFrames ?? 0),
  };
}

/** Replace one track in the project by id (immutably), then recompute duration. */
function replaceTrack(project: VideoProject, track: Track): VideoProject {
  return withDuration({
    ...project,
    tracks: project.tracks.map((t) => (t.id === track.id ? track : t)),
  });
}

/**
 * Collect every clip-edge frame across all OTHER tracks plus the playhead, so a
 * dragged clip can snap to neighbouring cut points. Whole-second gridlines are
 * added as well (a common editing convention). Returns a sorted unique list.
 */
function snapTargets(
  project: VideoProject,
  exclude: string | ReadonlySet<string>,
  playhead: number,
): number[] {
  const excluded = typeof exclude === "string" ? new Set([exclude]) : exclude;
  const set = new Set<number>();
  set.add(0);
  set.add(playhead);
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (excluded.has(clip.id)) continue;
      set.add(clip.startFrame);
      set.add(clipEndFrame(clip));
    }
  }
  for (const m of project.markers ?? []) set.add(m);
  if (project.range) {
    set.add(project.range.startFrame);
    set.add(project.range.endFrame);
  }
  // Whole-second gridlines across the timeline extent.
  const fps = project.fps;
  for (let s = 0; s * fps <= project.durationFrames + fps; s++) set.add(s * fps);
  return [...set].sort((a, b) => a - b);
}

/**
 * Find a start frame for a clip of `durationFrames` on `track` that does not
 * overlap any OTHER clip (excluding `excludeClipId`). We try `desiredStart`
 * first; if it collides, we slot the clip into the nearest free gap at or after
 * the end of whichever occupied clip it ran into, scanning forward. The track is
 * never long enough to fail (clips can always append past the last one), so this
 * always returns a non-negative, collision-free start. Two clips on one track
 * never overlap as a result (V1).
 */
function freeStartFrame(
  track: Track,
  durationFrames: number,
  desiredStart: number,
  excludeClipId?: string,
): number {
  const others = track.clips
    .filter((c) => c.id !== excludeClipId)
    .map((c) => ({ start: c.startFrame, end: clipEndFrame(c) }))
    .sort((a, b) => a.start - b.start);
  let start = Math.max(0, Math.floor(desiredStart));
  // Walk forward past any occupied span the candidate window collides with.
  // Each bump can only move us later, so this terminates.
  let moved = true;
  while (moved) {
    moved = false;
    const end = start + durationFrames;
    for (const o of others) {
      if (start < o.end && o.start < end) {
        start = o.end; // push to just after the colliding clip
        moved = true;
        break;
      }
    }
  }
  return start;
}

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

export function VideoSurface(props: { workspaceId?: string; designId?: string }): React.ReactElement {
  const workspaceId = props.workspaceId;
  // props.designId addresses the server (fast) export job routes.
  const docTitle = useEditor((s) => s.doc.title);

  // ---------------------------------------------------------------------
  // media assets: the workspace's uploaded video/audio, for clip binding.
  // ---------------------------------------------------------------------
  const [assets, setAssets] = useState<UploadedAsset[]>([]);
  const assetsRef = useRef<Map<string, UploadedAsset>>(new Map());
  // Video assets that have a server-generated 540p preview proxy; playback
  // prefers it so heavy sources scrub smoothly (exports keep the original).
  const proxyOkRef = useRef<Map<string, boolean>>(new Map());
  // False while an exact export records: media must resolve to ORIGINALS.
  const useProxiesRef = useRef(true);
  // Manual preference: "auto" scrubs 540p proxies when available; "original"
  // always plays the full-resolution source.
  const [previewQuality, setPreviewQuality] = useState<"auto" | "original">(() => {
    if (typeof window === "undefined") return "auto";
    return window.localStorage.getItem("oc-video-quality") === "original" ? "original" : "auto";
  });
  const previewQualityRef = useRef<"auto" | "original">("auto");
  useEffect(() => {
    previewQualityRef.current = previewQuality;
    if (typeof window !== "undefined") window.localStorage.setItem("oc-video-quality", previewQuality);
  }, [previewQuality]);
  // Large videos whose 540p proxy is still encoding server-side: the panel
  // shows an "optimizing" badge and polls until the proxy answers.
  const PROXY_MIN_BYTES = 8 * 1024 * 1024;
  const [proxyPending, setProxyPending] = useState<Set<string>>(new Set());
  const loadAssets = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const all = await oc.listAssets(workspaceId);
      const media = all.filter((a) => a.kind === "video" || a.kind === "audio");
      assetsRef.current = new Map(media.map((a) => [a.id, a]));
      await Promise.all(
        media
          .filter((a) => a.kind === "video" && !proxyOkRef.current.get(a.id))
          .map(async (a) => {
            try {
              const res = await fetch(proxyUrlFor(a), { method: "HEAD", credentials: "include" });
              proxyOkRef.current.set(a.id, res.ok);
            } catch {
              proxyOkRef.current.set(a.id, false);
            }
          }),
      );
      setAssets(media);
      setProxyPending(
        new Set(
          media
            .filter(
              (a) =>
                a.kind === "video" &&
                (a.byteSize ?? 0) >= PROXY_MIN_BYTES &&
                !proxyOkRef.current.get(a.id),
            )
            .map((a) => a.id),
        ),
      );
    } catch {
      /* keep the previous list on a transient failure */
    }
  }, [workspaceId, PROXY_MIN_BYTES]);
  useEffect(() => {
    // Deferred to a microtask so the effect body itself never sets state.
    queueMicrotask(() => void loadAssets());
  }, [loadAssets]);

  // Poll pending proxies every 5s (up to ~3 minutes) so the badge clears and
  // playback switches to the proxy as soon as the encode lands.
  useEffect(() => {
    if (proxyPending.size === 0) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (attempts > 36) {
        window.clearInterval(timer);
        setProxyPending(new Set());
        return;
      }
      void Promise.all(
        [...proxyPending].map(async (id) => {
          const a = assetsRef.current.get(id);
          if (!a) return id;
          try {
            const res = await fetch(proxyUrlFor(a), { method: "HEAD", credentials: "include" });
            if (res.ok) {
              proxyOkRef.current.set(id, true);
              return null;
            }
          } catch {
            /* still encoding */
          }
          return id;
        }),
      ).then((ids) => {
        const still = new Set(ids.filter((v): v is string => v !== null));
        setProxyPending((cur) => (cur.size === still.size ? cur : still));
      });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [proxyPending]);

  // Upload media straight from the panel (direct upload with a progress
  // readout; falls back to the legacy endpoint against an older server).
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  // Transient error line under the media header (upload/delete failures were
  // previously swallowed silently, hiding quota errors entirely).
  const [panelError, setPanelError] = useState<string | null>(null);
  const [mediaQuery, setMediaQuery] = useState("");
  const [mediaSort, setMediaSort] = useState<"new" | "name" | "size">("new");
  // Hover-scrub: which filmstrip tile a hovered media row shows (per asset).
  const [hoverTile, setHoverTile] = useState<Record<string, number>>({});
  const panelErrorTimer = useRef<number | null>(null);
  const showPanelError = useCallback((msg: string) => {
    setPanelError(msg);
    if (panelErrorTimer.current) window.clearTimeout(panelErrorTimer.current);
    panelErrorTimer.current = window.setTimeout(() => setPanelError(null), 8000);
  }, []);
  const onUploadFiles = useCallback(
    async (files: FileList | File[] | null) => {
      if (!workspaceId || !files || Array.from(files).length === 0) return;
      setUploadPct(0);
      try {
        for (const file of Array.from(files)) {
          // Base64 JSON upload (the direct-upload pipeline lands with the
          // feat/direct-uploads branch; switch to it once merged).
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result));
            fr.onerror = () => reject(new Error("read failed"));
            fr.readAsDataURL(file);
          });
          await uploadAssetWithProgress(
            workspaceId,
            { filename: file.name, dataBase64: dataUrl.split(",")[1] ?? "" },
            (pct: number) => setUploadPct(pct),
          );
        }
        await loadAssets();
      } catch (err) {
        showPanelError(err instanceof Error ? `Upload failed: ${err.message}` : "Upload failed");
      } finally {
        setUploadPct(null);
        if (uploadInputRef.current) uploadInputRef.current.value = "";
      }
    },
    [workspaceId, loadAssets, showPanelError],
  );

  // Drop-to-upload: the whole media panel accepts OS file drags. A depth
  // counter keeps the highlight stable while the drag crosses child elements,
  // and internal asset drags (application/x-hc-asset) are ignored.
  const [dropActive, setDropActive] = useState(false);
  const dragDepthRef = useRef(0);
  const hasFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  const onPanelDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDropActive(true);
  }, []);
  const onPanelDragOver = useCallback((e: React.DragEvent) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);
  const onPanelDragLeave = useCallback((e: React.DragEvent) => {
    if (!hasFileDrag(e)) return;
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setDropActive(false);
    }
  }, []);
  const onPanelDrop = useCallback(
    (e: React.DragEvent) => {
      if (!hasFileDrag(e)) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setDropActive(false);
      const files = Array.from(e.dataTransfer.files).filter(
        (f) => f.type.startsWith("video/") || f.type.startsWith("audio/"),
      );
      if (files.length) void onUploadFiles(files);
    },
    [onUploadFiles],
  );

  // The playback engine: media elements + the WebAudio mix. One per surface,
  // created on first use (effects/handlers only; never during render).
  const playerRef = useRef<TimelinePlayer | null>(null);
  const getPlayer = useCallback((): TimelinePlayer => {
    if (playerRef.current == null) {
      playerRef.current = new TimelinePlayer(
        (assetId) => {
          const a = assetsRef.current.get(assetId);
          if (!a) return null;
          // Preview scrubs the 540p proxy; the EXACT EXPORT must record the
          // original, so the recording path flips this ref and refreshes.
          const url =
            a.kind === "video" &&
            useProxiesRef.current &&
            previewQualityRef.current === "auto" &&
            proxyOkRef.current.get(a.id)
              ? proxyUrlFor(a)
              : resolveAssetUrl(a.url);
          return { url, kind: a.kind === "audio" ? "audio" : "video" };
        },
        (id) => liveSequences()[id] ?? null,
      );
    }
    return playerRef.current;
  }, []);
  useEffect(() => () => playerRef.current?.dispose(), []);

  // Filmstrip/waveform chrome per asset (dataURLs, generated lazily).
  const [clipArt, setClipArt] = useState<Record<string, string>>({});
  const requestClipArt = useCallback((asset: UploadedAsset) => {
    setClipArt((cur) => {
      if (cur[asset.id] !== undefined) return cur;
      const url = resolveAssetUrl(asset.url);
      void (asset.kind === "video" ? filmstrip(url) : waveformDataUrl(url))
        .then((art) => setClipArt((c) => ({ ...c, [asset.id]: art })))
        .catch(() => setClipArt((c) => ({ ...c, [asset.id]: "" })));
      return { ...cur, [asset.id]: "" };
    });
  }, []);

  // Probed media durations (seconds) + pixel dims for badges, aligned clip
  // art, and the crop tool. Video assets ALSO get a waveform of their audio.
  // Deferred to a microtask so the effect body itself never sets state.
  const [assetSeconds, setAssetSeconds] = useState<Record<string, number>>({});
  const [assetDims, setAssetDims] = useState<Record<string, { w: number; h: number }>>({});
  const [waveArt, setWaveArt] = useState<Record<string, string>>({});
  useEffect(() => {
    queueMicrotask(() => {
      for (const a of assets) {
        if (assetSeconds[a.id] !== undefined) continue;
        requestClipArt(a);
        void probeMedia(resolveAssetUrl(a.url), a.kind === "audio" ? "audio" : "video")
          .then((info) => {
            setAssetSeconds((c) => ({ ...c, [a.id]: info.durationMs / 1000 }));
            if (info.width && info.height) setAssetDims((c) => ({ ...c, [a.id]: { w: info.width!, h: info.height! } }));
          })
          .catch(() => setAssetSeconds((c) => ({ ...c, [a.id]: 0 })));
        if (a.kind === "video") {
          void waveformDataUrl(resolveAssetUrl(a.url))
            .then((art) => setWaveArt((c) => ({ ...c, [a.id]: art })))
            .catch(() => setWaveArt((c) => ({ ...c, [a.id]: "" })));
        }
      }
    });
  }, [assets, assetSeconds, requestClipArt]);

  // Delete an upload from the panel (the workspace asset itself).
  const [confirmDeleteAsset, setConfirmDeleteAsset] = useState<UploadedAsset | null>(null);
  const doDeleteAsset = useCallback(async () => {
    const a = confirmDeleteAsset;
    setConfirmDeleteAsset(null);
    if (!a) return;
    try {
      await oc.deleteAsset(a.id);
      await loadAssets();
    } catch (err) {
      showPanelError(err instanceof Error ? `Delete failed: ${err.message}` : "Delete failed");
    }
  }, [confirmDeleteAsset, loadAssets, showPanelError]);

  // ---------------------------------------------------------------------
  // in-browser export: record the stage canvas + the audio mix in realtime.
  // ---------------------------------------------------------------------
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const exportRef = useRef<{ controller: ExportController; startFrame: number; endFrame: number; extension: string } | null>(null);

  // Nested-sequence navigation: the surface edits either the top-level
  // project (doc.meta.video) or a child sequence (doc.meta.videoSequences[id])
  // chosen by the breadcrumb path. Children resolve by id at render time.
  const [seqPath, setSeqPath] = useState<string[]>([]);
  const seqId = seqPath.length ? seqPath[seqPath.length - 1] : null;
  const sequences = useEditor(
    (s) => (s.doc.meta.videoSequences as Record<string, VideoProject> | undefined) ?? undefined,
  );
  const sequenceNames = useEditor(
    (s) => (s.doc.meta.videoSequenceNames as Record<string, string> | undefined) ?? undefined,
  );
  // A deleted/unknown child id pops back to the parent scope. Deferred to a
  // microtask so the effect body itself never sets state.
  useEffect(() => {
    if (seqId && !(sequences ?? {})[seqId]) {
      queueMicrotask(() =>
        setSeqPath((p) => (p.length && !liveSequences()[p[p.length - 1]] ? p.slice(0, -1) : p)),
      );
    }
  }, [seqId, sequences]);

  // The project is read from the store (re-reading whenever rev bumps), and all
  // writes go back through setDocMeta so undo/redo is the store's single stack.
  const topProject = useEditor((s) => s.doc.meta.video as VideoProject | undefined);
  const storeProject = seqId ? (sequences ?? {})[seqId] : topProject;
  // During an in-progress gesture (clip drag, gain slider) we render from this
  // local copy WITHOUT persisting, then commit once on release so the whole
  // gesture is a single undo step. Null when no gesture is active.
  const [draftProject, setDraftProject] = useState<VideoProject | null>(null);
  const project = draftProject ?? storeProject;
  // Latest draft, readable from timers/loops without re-arming them.
  const draftRef = useRef<VideoProject | null>(null);
  useEffect(() => {
    draftRef.current = draftProject;
  }, [draftProject]);
  // `rev` is intentionally subscribed so this surface re-renders on every doc
  // mutation (including undo/redo of a timeline edit). The value itself is unused.
  useEditor((s) => s.rev);

  // Local-only editor UI state (never persisted on every frame).
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  // Multi-selection: every selected clip id (primary = selectedClipId).
  // Shift-click toggles membership; a plain click collapses to one.
  const [multiIds, setMultiIds] = useState<Set<string>>(new Set());
  const selectOnly = useCallback((id: string | null) => {
    setSelectedClipId(id);
    setMultiIds(id ? new Set([id]) : new Set());
  }, []);
  const toggleInSelection = useCallback(
    (id: string) => {
      const next = new Set(multiIds);
      if (next.has(id)) {
        next.delete(id);
        // Deselecting the primary hands primary to another member (or clears);
        // it must NOT stay on the clip the user just removed from the set.
        if (selectedClipId === id) setSelectedClipId(next.values().next().value ?? null);
      } else {
        next.add(id);
        setSelectedClipId(id);
      }
      setMultiIds(next);
    },
    [multiIds, selectedClipId],
  );
  // Mirror for the overlay-chrome paint loop (armed once).
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selectedClipId;
  }, [selectedClipId]);
  const [pxPerFrame, setPxPerFrame] = useState(2);
  // Track lane height preset (persisted): compact 40 / normal 56 / tall 80.
  const [trackH, setTrackH] = useState(() => {
    if (typeof window === "undefined") return TRACK_HEIGHT;
    const v = parseInt(window.localStorage.getItem("oc-video-track-h") ?? "", 10);
    return v === 40 || v === 80 ? v : TRACK_HEIGHT;
  });
  const cycleTrackHeight = useCallback(() => {
    setTrackH((cur) => {
      const next = cur === 40 ? 56 : cur === 56 ? 80 : 40;
      if (typeof window !== "undefined") window.localStorage.setItem("oc-video-track-h", String(next));
      return next;
    });
  }, []);
  // Magnetic snapping toggle (persisted); Alt always bypasses per-gesture.
  const [snapOn, setSnapOn] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("oc-video-snap") !== "0";
  });
  const toggleSnap = useCallback(() => {
    setSnapOn((v) => {
      const next = !v;
      if (typeof window !== "undefined") window.localStorage.setItem("oc-video-snap", next ? "1" : "0");
      return next;
    });
  }, []);
  // Which clip edge the transition control attaches to (V4: in OR out).
  const [transitionEdge, setTransitionEdge] = useState<"in" | "out">("out");
  // Right clip-inspector open/closed state, persisted per-user in localStorage.
  // Lazy initializer reads the stored value once on mount; we write on every
  // toggle (NOT via a setState-in-effect), so the panel state survives reloads.
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(INSPECTOR_OPEN_KEY) !== "0";
  });
  const toggleInspector = useCallback(() => {
    setInspectorOpen((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(INSPECTOR_OPEN_KEY, next ? "1" : "0");
      }
      return next;
    });
  }, []);
  // The media panel and the bottom timeline collapse the same way (persisted).
  const [mediaOpen, setMediaOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(MEDIA_OPEN_KEY) !== "0";
  });
  const toggleMedia = useCallback(() => {
    setMediaOpen((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") window.localStorage.setItem(MEDIA_OPEN_KEY, next ? "1" : "0");
      return next;
    });
  }, []);
  // Press-to-toggle for the collapse/reopen controls: the toggle fires on
  // pointerdown, because overlay elements injected under the cursor between
  // press and release (seen live: a screen-ruler browser extension's guide
  // line stealing the pointerup) kill the browser's click. onClick stays for
  // keyboard activation and skips right after a press.
  const railPressRef = useRef(0);

  const [timelineOpen, setTimelineOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(TIMELINE_OPEN_KEY) !== "0";
  });
  const toggleTimeline = useCallback(() => {
    setTimelineOpen((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") window.localStorage.setItem(TIMELINE_OPEN_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  // Adjustable sidebar widths: drag the inner edge, double-click to reset;
  // widths persist per user (localStorage).
  const [mediaW, setMediaW] = useState(() => storedSidebarW(MEDIA_W_KEY, MEDIA_W_DEFAULT));
  const [inspectorW, setInspectorW] = useState(() => storedSidebarW(INSPECTOR_W_KEY, INSPECTOR_W_DEFAULT));
  const resetSidebar = useCallback((side: "left" | "right") => {
    if (side === "left") setMediaW(MEDIA_W_DEFAULT);
    else setInspectorW(INSPECTOR_W_DEFAULT);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(side === "left" ? MEDIA_W_KEY : INSPECTOR_W_KEY);
    }
  }, []);
  const sideDragRef = useRef<{ side: "left" | "right"; startX: number; startW: number } | null>(null);
  // Double-press detection by timestamp: pointer capture (and some input
  // sources) suppress native dblclick synthesis, so we count presses ourselves.
  const lastSidePressRef = useRef<{ side: "left" | "right"; t: number } | null>(null);
  const onSideResizeDown = useCallback(
    (side: "left" | "right") => (e: React.PointerEvent) => {
      e.preventDefault();
      const now = performance.now();
      const last = lastSidePressRef.current;
      lastSidePressRef.current = { side, t: now };
      if ((last && last.side === side && now - last.t < 400) || e.detail >= 2) {
        lastSidePressRef.current = null;
        resetSidebar(side);
        return;
      }
      try {
        (e.target as Element).setPointerCapture?.(e.pointerId);
      } catch {
        /* synthetic pointer: capture is best-effort */
      }
      sideDragRef.current = { side, startX: e.clientX, startW: side === "left" ? mediaW : inspectorW };
    },
    [mediaW, inspectorW, resetSidebar],
  );
  const onSideResizeMove = useCallback((e: React.PointerEvent) => {
    const drag = sideDragRef.current;
    if (!drag) return;
    const delta = e.clientX - drag.startX;
    const w = clampSidebarW(drag.side === "left" ? drag.startW + delta : drag.startW - delta);
    if (drag.side === "left") setMediaW(w);
    else setInspectorW(w);
  }, []);
  const onSideResizeUp = useCallback((e: React.PointerEvent) => {
    const drag = sideDragRef.current;
    sideDragRef.current = null;
    try {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
    } catch {
      /* nothing captured */
    }
    if (!drag || typeof window === "undefined") return;
    const delta = e.clientX - drag.startX;
    // A real drag is not the first half of a double-press.
    if (Math.abs(delta) > 3) lastSidePressRef.current = null;
    const w = clampSidebarW(drag.side === "left" ? drag.startW + delta : drag.startW - delta);
    window.localStorage.setItem(drag.side === "left" ? MEDIA_W_KEY : INSPECTOR_W_KEY, String(w));
  }, []);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Refs mirrored for listeners/loops that must not re-arm per frame.
  const pxPerFrameRef = useRef(2);
  const playheadRef = useRef(0);
  const durationFramesRef = useRef(0);
  const fpsRef = useRef(30);
  useEffect(() => {
    pxPerFrameRef.current = pxPerFrame;
  }, [pxPerFrame]);

  // Anchored zoom: the timeline point under the anchor (cursor, else the
  // playhead when visible, else the viewport center) stays put on screen.
  // Content x of frame f inside the scroller = GUTTER_WIDTH + f * px.
  const pendingScrollLeftRef = useRef<number | null>(null);
  const applyZoom = useCallback(
    (nextRaw: number, anchorClientX?: number) => {
      const next = Math.max(MIN_PX_PER_FRAME, Math.min(MAX_PX_PER_FRAME, nextRaw));
      const sc = scrollRef.current;
      const prev = pxPerFrame;
      if (!sc || next === prev) {
        setPxPerFrame(next);
        return;
      }
      const rect = sc.getBoundingClientRect();
      let offset: number; // anchor's offset from the container's left edge
      let anchorFrame: number;
      if (anchorClientX !== undefined) {
        offset = anchorClientX - rect.left;
        anchorFrame = (offset - GUTTER_WIDTH + sc.scrollLeft) / prev;
      } else {
        const playheadOffset = GUTTER_WIDTH + playheadRef.current * prev - sc.scrollLeft;
        if (playheadOffset >= GUTTER_WIDTH && playheadOffset <= rect.width) {
          offset = playheadOffset;
          anchorFrame = playheadRef.current;
        } else {
          offset = GUTTER_WIDTH + (rect.width - GUTTER_WIDTH) / 2;
          anchorFrame = (offset - GUTTER_WIDTH + sc.scrollLeft) / prev;
        }
      }
      pendingScrollLeftRef.current = Math.max(0, GUTTER_WIDTH + anchorFrame * next - offset);
      setPxPerFrame(next);
    },
    [pxPerFrame],
  );
  // The anchor correction lands after React commits the re-scaled content;
  // an immediate assignment would clamp against the OLD scroll extent.
  useLayoutEffect(() => {
    if (pendingScrollLeftRef.current === null) return;
    const sc = scrollRef.current;
    if (sc) sc.scrollLeft = pendingScrollLeftRef.current;
    pendingScrollLeftRef.current = null;
  }, [pxPerFrame]);
  const applyZoomRef = useRef(applyZoom);
  useEffect(() => {
    applyZoomRef.current = applyZoom;
  }, [applyZoom]);

  // Ctrl/Cmd+wheel zooms at the cursor. Native non-passive listener: React
  // registers wheel passively, so preventDefault (stopping the browser page
  // zoom) needs a manual subscription.
  const hasProject = !!(draftProject ?? storeProject);
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      applyZoomRef.current(pxPerFrameRef.current * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX);
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    return () => sc.removeEventListener("wheel", onWheel);
  }, [hasProject]);

  // Fit the whole timeline (plus a second of slack) into the viewport.
  const zoomToFit = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const usable = Math.max(120, sc.clientWidth - GUTTER_WIDTH - 16);
    const frames = Math.max(1, durationFramesRef.current + fpsRef.current * 2);
    setPxPerFrame(Math.max(MIN_PX_PER_FRAME, Math.min(MAX_PX_PER_FRAME, usable / frames)));
    requestAnimationFrame(() => {
      sc.scrollLeft = 0;
    });
  }, []);

  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  // True while a pointer drag is scrubbing on the ruler.
  const rulerScrubRef = useRef(false);
  const playingRef = useRef(false);
  // Play only the marked range: stop (without looping) at this frame.
  const playRangeUntilRef = useRef<number | null>(null);

  // -------------------------------------------------------------------------
  // first-mount initialization: seed a VideoProject with one
  // video track and one audio track if doc.meta.video is missing.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (project) return;
    const fps = 30;
    const videoTrack = newTrack("video", "Video 1");
    const audioTrack = newTrack("audio", "Audio 1");
    const fresh = newProject({
      stage: { width: 1920, height: 1080 },
      fps,
      durationFrames: 30 * fps, // a 30s default canvas extent
      tracks: [videoTrack, audioTrack],
    });
    useEditor.getState().setDocMeta({ video: fresh });
    // The store bump re-renders this surface with the new project on the next pass.
  }, [project]);

  // -------------------------------------------------------------------------
  // persistence: write the edited scope back as one undoable step (the top
  // project, or the open child sequence inside the sequences map).
  // -------------------------------------------------------------------------
  const persist = useCallback(
    (next: VideoProject) => {
      if (seqId) {
        const all = (useEditor.getState().doc.meta.videoSequences as Record<string, VideoProject> | undefined) ?? {};
        useEditor.getState().setDocMeta({ videoSequences: { ...all, [seqId]: next } });
      } else {
        useEditor.getState().setDocMeta({ video: next });
      }
    },
    [seqId],
  );

  // Convenience: find the track holding the selected clip and the clip itself.
  // Plain derived value (the React compiler memoizes it) so no hand-written
  // useMemo blocks compilation.
  const selected = ((): { track: Track; clip: Clip } | null => {
    if (!project || !selectedClipId) return null;
    for (const track of project.tracks) {
      const clip = track.clips.find((c) => c.id === selectedClipId);
      if (clip) return { track, clip };
    }
    return null;
  })();

  // Clip edits require a selection on an UNLOCKED track. The toolbar uses this to
  // disable every edit control so a locked track's clips are read-only (V2).
  const editDisabled = !selected || !!selected.track.locked || !!selected.clip.locked;

  const durationFrames = project ? Math.max(project.durationFrames, project.fps) : 0;

  // Clamp the playhead if the project shrank (e.g. after a ripple delete). This
  // is React's sanctioned "adjust state during render" pattern, which avoids a
  // cascading setState inside an effect.
  if (playhead > durationFrames) setPlayhead(durationFrames);

  // -------------------------------------------------------------------------
  // transport: advance the playhead at the project fps (times the preview
  // rate) via rAF. At the end: stop, or wrap when looping (a marked range
  // loops just the range). The playhead is local UI state, never persisted.
  // -------------------------------------------------------------------------
  const [loop, setLoop] = useState(false);
  const [playRate, setPlayRate] = useState(1);
  const [previewMuted, setPreviewMuted] = useState(false);
  useEffect(() => {
    if (!playing || !project) return;
    const fps = project.fps;
    const loopStart = loop && project.range ? Math.min(project.range.startFrame, durationFrames) : 0;
    const loopEnd = loop && project.range ? Math.min(project.range.endFrame, durationFrames) : durationFrames;
    const step = (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const dtSec = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      setPlayhead((prev) => {
        const next = prev + dtSec * fps * playRate;
        const until = playRangeUntilRef.current;
        if (until !== null && next >= until) {
          playRangeUntilRef.current = null;
          setPlaying(false);
          return until;
        }
        if (next <= 0 && playRate < 0) {
          setPlaying(false);
          return 0;
        }
        if (next >= loopEnd) {
          if (loop && loopEnd > loopStart) return loopStart;
          // Stop at the end so the user sees a clear playback finish.
          setPlaying(false);
          return loopEnd;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      lastTsRef.current = null;
    };
  }, [playing, project, durationFrames, loop, playRate]);

  // Keep the player's mute/rate in step with the transport controls.
  useEffect(() => {
    getPlayer().setMuted(previewMuted);
  }, [previewMuted, getPlayer]);
  useEffect(() => {
    getPlayer().setRate(playRate);
  }, [playRate, getPlayer]);
  const playerLevel = useCallback(() => getPlayer().level(), [getPlayer]);

  const frame = Math.round(playhead);
  // Mirrors for listeners/loops that must not re-arm per frame.
  useEffect(() => {
    playheadRef.current = frame;
    durationFramesRef.current = durationFrames;
    fpsRef.current = project?.fps ?? 30;
    playingRef.current = playing;
  }, [frame, durationFrames, project, playing]);

  // Play/pause with end-of-timeline restart: pressing play at the end starts
  // over instead of doing nothing.
  const togglePlay = useCallback(() => {
    playRangeUntilRef.current = null;
    if (!playingRef.current && playheadRef.current >= durationFramesRef.current) setPlayhead(0);
    setPlaying((p) => !p);
  }, []);


  // Ducking automation for playback + export: voice activity comes from the
  // voice track's clip windows, solved to gain points once per project change.
  const duckPoints = useMemo(() => {
    if (!project?.master.ducking) return undefined;
    const voice = project.tracks.find((t) => t.id === project.master.ducking?.voiceTrackId);
    const windows = (voice?.clips ?? []).map((c) => ({ startFrame: c.startFrame, endFrame: clipEndFrame(c) }));
    return solveDucking(project.master, windows, project.durationFrames, project.fps);
  }, [project]);

  // -------------------------------------------------------------------------
  // stage: a continuous rAF draw loop composites the frame under the playhead
  // (cheap: one drawImage per active clip), so seeks refresh as they complete.
  // A separate sync pass aligns media elements + the audio mix per playhead
  // change. Refs carry the latest values into the loop without re-arming it.
  // -------------------------------------------------------------------------
  const stageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawStateRef = useRef<{ project: VideoProject | null; frame: number }>({ project: null, frame: 0 });
  useEffect(() => {
    drawStateRef.current = { project: project ?? null, frame };
  }, [project, frame]);
  useEffect(() => {
    let raf = 0;
    const paint = () => {
      const { project: p, frame: f } = drawStateRef.current;
      const canvas = stageCanvasRef.current;
      const player = p ? getPlayer() : null;
      if (p && canvas && player) {
        if (canvas.width !== p.stage.width || canvas.height !== p.stage.height) {
          canvas.width = p.stage.width;
          canvas.height = p.stage.height;
        }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          let loading = 0;
          drawTimelineFrame(
            ctx,
            p,
            f,
            (a) => {
              const s = player.drawSource(a);
              if (!s && a.clip.assetId) loading++;
              return s;
            },
            player.activeOptions(),
          );
          const capTrack = p.captions?.[0];
          const style = captionStyleOf(capTrack);
          const cue = cueAt(capTrack?.cues, f);
          if (cue && style.burnIn !== false) drawCaption(ctx, p, cue.text, style);
          // The loading diagnostic is chrome: skip it while an export records
          // this canvas so it can never be burned into the output.
          if (loading > 0 && !exportRef.current) {
            ctx.save();
            ctx.font = `500 ${Math.max(12, Math.round(p.stage.height * 0.02))}px system-ui, sans-serif`;
            ctx.fillStyle = "rgba(255,255,255,0.7)";
            ctx.textAlign = "left";
            ctx.fillText("loading media…", 14, Math.max(20, Math.round(p.stage.height * 0.035)));
            ctx.restore();
          }
        }
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [getPlayer]);

  // Media/audio alignment on every playhead advance or project change.
  useEffect(() => {
    if (!project) return;
    // Reverse shuttle (negative rate) plays by per-frame seeking: elements
    // cannot play backwards, so sync as if scrubbing.
    getPlayer().syncAt(project, frame, playing && playRate > 0, duckPoints);
  }, [project, frame, playing, playRate, duckPoints, getPlayer]);

  // Housekeeping when clips are deleted; pause everything when playback stops.
  useEffect(() => {
    if (project) getPlayer().prune(project);
  }, [project, getPlayer]);
  useEffect(() => {
    if (!playing) playerRef.current?.pauseAll();
    else void getPlayer().resumeAudio();
  }, [playing, getPlayer]);

  // Clips currently under the playhead (one per track at most), for the stage
  // status readout.
  const activeClips = useMemo(() => {
    if (!project) return [] as { track: Track; clip: Clip }[];
    const out: { track: Track; clip: Clip }[] = [];
    for (const track of project.tracks) {
      const clip = clipAtFrame(track, frame);
      if (clip) out.push({ track, clip });
    }
    return out;
  }, [project, frame]);

  // Render-side asset lookup (labels/art); the ref stays for the player.
  // A quality-preference change re-resolves every media element's source.
  useEffect(() => {
    playerRef.current?.refreshSources();
  }, [previewQuality]);

  const assetMap = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  // Which assets are referenced anywhere on the timeline (usage badges).
  const usedAssetIds = useMemo(() => {
    const p = draftProject ?? storeProject;
    const set = new Set<string>();
    if (p) for (const t of p.tracks) for (const c of t.clips) if (c.assetId) set.add(c.assetId);
    for (const s of Object.values(sequences ?? {})) for (const t of s.tracks) for (const c of t.clips) if (c.assetId) set.add(c.assetId);
    return set;
  }, [draftProject, storeProject, sequences]);

  // Kick filmstrip/waveform generation for every asset referenced on the
  // timeline (cheap no-op once cached).
  useEffect(() => {
    if (!project) return;
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        const asset = clip.assetId ? assetsRef.current.get(clip.assetId) : undefined;
        if (asset) requestClipArt(asset);
      }
    }
  }, [project, assets, requestClipArt]);

  // -------------------------------------------------------------------------
  // edit operations (all pure @hc/timeline ops; persisted as one undo step)
  // -------------------------------------------------------------------------

  // Delete a track. Occupied tracks confirm first; ducking references to the
  // removed track are cleared so the mix never points at a ghost track.
  const [confirmDeleteTrack, setConfirmDeleteTrack] = useState<Track | null>(null);
  const removeTrack = useCallback(
    (trackId: string) => {
      if (!project) return;
      let next: VideoProject = { ...project, tracks: project.tracks.filter((t) => t.id !== trackId) };
      const d = project.master.ducking;
      if (d && (d.musicTrackId === trackId || d.voiceTrackId === trackId)) {
        next = { ...next, master: { gainDb: project.master.gainDb } };
      }
      persist(withDuration(next));
      if (selected?.track.id === trackId) selectOnly(null);
    },
    [project, persist, selected, selectOnly],
  );

  // Duplicate a track (fresh ids for the track and every clip; groups sever).
  const duplicateTrack = useCallback(
    (trackId: string) => {
      if (!project) return;
      const idx = project.tracks.findIndex((t) => t.id === trackId);
      if (idx < 0) return;
      const t = project.tracks[idx];
      const copy: Track = {
        ...structuredClone(t),
        id: shortId("track"),
        name: `${t.name ?? t.kind} copy`,
        clips: t.clips.map((c) => ({ ...structuredClone(c), id: shortId("clip"), groupId: undefined })),
      };
      const tracks = [...project.tracks];
      tracks.splice(idx + 1, 0, copy);
      persist(withDuration({ ...project, tracks }));
    },
    [project, persist],
  );

  const addTrack = useCallback(
    (kind: Track["kind"]) => {
      if (!project) return;
      const count = project.tracks.filter((t) => t.kind === kind).length + 1;
      const label = `${kind[0].toUpperCase()}${kind.slice(1)} ${count}`;
      const track = newTrack(kind, label);
      persist(withDuration({ ...project, tracks: [...project.tracks, track] }));
    },
    [project, persist],
  );

  // Which track an asset is being picked for (opens the media picker modal).
  const [pickerTrackId, setPickerTrackId] = useState<string | null>(null);
  // Right-click context menu (clip or empty lane).
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    trackId: string;
    clipId?: string;
    atFrame: number;
    /** Right-click on the time ruler (marker/range items). */
    ruler?: boolean;
  } | null>(null);

  const addClip = useCallback(
    (trackId: string) => {
      if (!project) return;
      const track = project.tracks.find((t) => t.id === trackId);
      if (!track || track.locked) return;
      if (track.kind === "video" || track.kind === "audio" || track.kind === "overlay") {
        // Media tracks bind real uploads: open the picker.
        setPickerTrackId(trackId);
        return;
      }
      // A text track gets a 3s title card; effects keep a stub for now.
      const dur = track.kind === "text" ? (project.fps as number) * 3 : DEFAULT_CLIP_FRAMES;
      const startFrame = freeStartFrame(track, dur, frame);
      const clip: Clip = {
        id: shortId("clip"),
        startFrame,
        inFrame: 0,
        outFrame: dur,
        speed: 1,
        ...(track.kind === "text" ? { title: { text: "Title" } } : {}),
      };
      const nextTrack: Track = { ...track, clips: [...track.clips, clip] };
      persist(replaceTrack(project, nextTrack));
      selectOnly(clip.id);
    },
    [project, frame, persist],
  );

  // Bind a picked asset as a new clip at the playhead: probe the real
  // duration, size the source window to the whole file, avoid overlaps.
  const addAssetClip = useCallback(
    async (trackId: string, asset: UploadedAsset, atFrame?: number) => {
      if (!project) return;
      const track = project.tracks.find((t) => t.id === trackId);
      if (!track || track.locked) return;
      setPickerTrackId(null);
      let durFrames = DEFAULT_CLIP_FRAMES;
      try {
        const info = await probeMedia(resolveAssetUrl(asset.url), asset.kind === "audio" ? "audio" : "video");
        durFrames = Math.max(1, Math.round((info.durationMs / 1000) * project.fps));
      } catch {
        /* unprobeable media still gets a default-length clip */
      }
      const startFrame = freeStartFrame(track, durFrames, atFrame ?? frame);
      const clip: Clip = {
        id: shortId("clip"),
        assetId: asset.id,
        startFrame,
        inFrame: 0,
        outFrame: durFrames,
        speed: 1,
      };
      const nextTrack: Track = { ...track, clips: [...track.clips, clip] };
      persist(replaceTrack(project, nextTrack));
      selectOnly(clip.id);
      requestClipArt(asset);
    },
    [project, frame, persist, requestClipArt],
  );

  // -------------------------------------------------------------------------
  // export: render the timeline in-browser (realtime pass over the preview
  // engine, recorded via MediaRecorder). Stop fires when the playhead reaches
  // the end (watcher effect below) or on the button acting as Cancel.
  // -------------------------------------------------------------------------
  const finishExport = useCallback(async (cancelled: boolean) => {
    const ex = exportRef.current;
    if (!ex) return;
    exportRef.current = null;
    setPlaying(false);
    ex.controller.stop();
    // Back to proxy playback for smooth scrubbing.
    useProxiesRef.current = true;
    playerRef.current?.refreshSources();
    try {
      const blob = await ex.controller.done;
      if (cancelled) {
        setExportMsg("Export cancelled");
      } else {
        downloadBlob(blob, `${(docTitle || "video").replace(/[^\w.-]+/g, "_")}.${ex.extension}`);
        setExportMsg(`Downloaded ${ex.extension.toUpperCase()}`);
      }
    } catch (e) {
      setExportMsg(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }, [docTitle]);

  // Server (fast) export: the backend renders the timeline with ffmpeg as a
  // background job; the tab stays free. Wipe/slide render as fades, and
  // keyframe poses / chroma key are browser-only, so the exact-fidelity path
  // remains the in-browser render.
  const [serverExporting, setServerExporting] = useState(false);
  // Export history: jobId + format per design (localStorage), so a finished
  // render is still downloadable after a reload or closed tab.
  type ExportEntry = { jobId: string; format: string; at: number; status: "running" | "completed" | "failed" | "expired" };
  const exportsKey = props.designId ? `oc-video-exports-${props.designId}` : null;
  const [exportHistory, setExportHistory] = useState<ExportEntry[]>(() => {
    if (typeof window === "undefined" || !exportsKey) return [];
    try {
      return JSON.parse(window.localStorage.getItem(exportsKey) ?? "[]") as ExportEntry[];
    } catch {
      return [];
    }
  });
  // record + mark run inside ONE async export flow, so they must mutate
  // through a ref: state closures there are stale by design.
  const exportHistoryRef = useRef<ExportEntry[] | null>(null);
  const mutateExportHistory = useCallback(
    (fn: (cur: ExportEntry[]) => ExportEntry[]) => {
      const cur = exportHistoryRef.current ?? [];
      const next = fn(cur).slice(0, 12);
      exportHistoryRef.current = next;
      setExportHistory(next);
      if (exportsKey) window.localStorage.setItem(exportsKey, JSON.stringify(next));
    },
    [exportsKey],
  );
  useEffect(() => {
    if (exportHistoryRef.current === null) exportHistoryRef.current = exportHistory;
    // (seed once from the persisted initial state)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const recordExport = useCallback(
    (jobId: string, format: string) => {
      mutateExportHistory((cur) => [{ jobId, format, at: Date.now(), status: "running" as const }, ...cur]);
    },
    [mutateExportHistory],
  );
  const markExport = useCallback(
    (jobId: string, status: ExportEntry["status"]) => {
      mutateExportHistory((cur) => cur.map((e) => (e.jobId === jobId ? { ...e, status } : e)));
    },
    [mutateExportHistory],
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const doServerExport = useCallback(
    async (opts: {
      format: "mp4" | "webm" | "gif" | "mp3";
      scale: number;
      crf: number;
      useRange: boolean;
      fps?: number;
      skipCaptions?: boolean;
      stemTrackId?: string;
    }) => {
      if (!props.designId || serverExporting) return;
      setServerExporting(true);
      setExportMsg("Rendering on the server…");
      try {
        // Flush the current document first: the job renders the PERSISTED file,
        // and racing the autosave would render a stale (or empty) timeline.
        await oc.saveSnapshot(props.designId, { file: useEditor.getState().doc, kind: "checkpoint" });
        useEditor.getState().markClean();
        const { jobId } = await oc.startVideoExport(props.designId, {
          format: opts.format,
          scale: opts.scale,
          crf: opts.crf,
          fps: opts.fps,
          skipCaptions: opts.skipCaptions,
          stemTrackId: opts.stemTrackId,
          startFrame: opts.useRange ? project?.range?.startFrame : undefined,
          endFrame: opts.useRange ? project?.range?.endFrame : undefined,
        });
        recordExport(jobId, opts.stemTrackId ? `${opts.format} stem` : opts.format);
        for (let i = 0; i < 800; i++) {
          const job = await oc.getJob<{ format?: string }>(jobId);
          if (job.status === "completed") {
            markExport(jobId, "completed");
            // Fetch as a blob and download through the same object-URL path the
            // in-browser export uses (a cross-origin <a download> click is
            // unreliable: the attribute is ignored cross-origin).
            const res = await fetch(oc.videoExportDownloadUrl(props.designId, jobId), { credentials: "include" });
            if (!res.ok) throw new Error(`download failed (${res.status})`);
            // Name the file by what the server actually encoded: an older
            // backend mid-rollout ignores `format` and renders MP4, and its
            // job result says so.
            const actual = job.result?.format === "gif" || job.result?.format === "mp3" || job.result?.format === "mp4"
              ? job.result.format
              : opts.format;
            downloadBlob(await res.blob(), `${(docTitle || "video").replace(/[^\w.-]+/g, "_")}.${actual}`);
            setExportMsg(
              actual === opts.format
                ? `Downloaded ${actual.toUpperCase()} (server render)`
                : `Downloaded ${actual.toUpperCase()}: this server version does not render ${opts.format.toUpperCase()} yet`,
            );
            return;
          }
          if (job.status === "failed") {
            markExport(jobId, "failed");
            setExportMsg(job.error ? `Server export failed: ${job.error}` : "Server export failed");
            return;
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        setExportMsg("Server export timed out");
      } catch (e) {
        setExportMsg(e instanceof Error ? e.message : "Server export failed");
      } finally {
        setServerExporting(false);
      }
    },
    [props.designId, serverExporting, docTitle, project],
  );

  const doExportVideo = useCallback(
    async (useRange: boolean, preferWebm = false) => {
      if (!project) return;
      if (exportRef.current) {
        void finishExport(true); // acting as Cancel
        return;
      }
      const target = pickRecorderTarget(preferWebm);
      const canvas = stageCanvasRef.current;
      const player = getPlayer();
      if (!target || !canvas || typeof canvas.captureStream !== "function") {
        setExportMsg("This browser cannot record video (MediaRecorder unavailable).");
        return;
      }
      setExporting(true);
      setExportMsg(null);
      // The recording is a single realtime pass: it must run at 1x with the
      // mix live, and looping would wrap the playhead before the finalize
      // watcher ever sees the end frame.
      setPlayRate(1);
      setLoop(false);
      player.setRate(1);
      // Record ORIGINAL media, never the 540p preview proxies.
      useProxiesRef.current = false;
      player.refreshSources();
      await player.resumeAudio();
      const startFrame = useRange ? project.range?.startFrame ?? 0 : 0;
      const endFrame = useRange ? Math.min(project.range?.endFrame ?? durationFrames, durationFrames) : durationFrames;
      setPlayhead(startFrame);
      const controller = startRecording(canvas, player.audioStream(), project.fps, target);
      exportRef.current = { controller, startFrame, endFrame, extension: target.extension };
      setPlaying(true);
    },
    [project, durationFrames, finishExport, getPlayer],
  );

  // The export dialog: one entry point for every format/quality/range choice.
  const [exportDialog, setExportDialog] = useState(false);
  const startExport = useCallback(
    (choice: ExportChoice) => {
      setExportDialog(false);
      if (choice.method === "exact") void doExportVideo(choice.useRange, choice.preferWebm);
      else
        void doServerExport({
          format: choice.format,
          scale: choice.scale,
          crf: choice.crf,
          useRange: choice.useRange,
          fps: choice.fps,
          skipCaptions: choice.skipCaptions,
          stemTrackId: choice.stemTrackId,
        });
    },
    [doExportVideo, doServerExport],
  );

  // Watcher: the realtime pass ended (or playback stopped early) -> finalize.
  // Deferred to a microtask so the effect body itself never sets state.
  useEffect(() => {
    const ex = exportRef.current;
    if (!ex) return;
    if (frame >= ex.endFrame) queueMicrotask(() => void finishExport(false));
    else if (!playing && frame > ex.startFrame) queueMicrotask(() => void finishExport(true));
  }, [frame, playing, finishExport]);

  // -------------------------------------------------------------------------
  // stage direct manipulation: drag the SELECTED video/overlay clip on the
  // preview to reframe it (dx/dy pose keyframes), wheel to scale. While the
  // clip has a single keyframe per property the pose stays static; with an
  // animation curve the drag edits the keyframe at the playhead.
  // -------------------------------------------------------------------------
  const stageOverlayRef = useRef<HTMLCanvasElement | null>(null);
  const stageBoxRef = useRef<HTMLDivElement | null>(null);
  const [guidesOn, setGuidesOn] = useState(false);
  const guidesRef = useRef(false);
  useEffect(() => {
    guidesRef.current = guidesOn;
  }, [guidesOn]);
  const [stageActualSize, setStageActualSize] = useState(false);
  const playRange = useCallback(() => {
    const r = (draftProject ?? storeProject)?.range;
    if (!r) return;
    setPlayhead(r.startFrame);
    playRangeUntilRef.current = r.endFrame;
    setPlaying(true);
  }, [draftProject, storeProject]);
  const stageDragRef = useRef<{
    mode: "pose" | "title";
    clipId: string;
    trackId: string;
    startX: number;
    startY: number;
    base: { dx: number; dy: number; scale: number };
    localFrame: number;
  } | null>(null);
  const wheelCommitRef = useRef<number | null>(null);

  // The selected clip when it is manipulable on the stage at this frame.
  const stageTarget = useMemo(() => {
    if (!project || !selected) return null;
    const { track, clip } = selected;
    if (track.kind !== "video" && track.kind !== "overlay") return null;
    if (track.hidden || track.locked) return null;
    if (frame < clip.startFrame || frame >= clipEndFrame(clip)) return null;
    return { track, clip, localFrame: frame - clip.startFrame };
  }, [project, selected, frame]);

  const applyPose = useCallback(
    (clipId: string, trackId: string, localFrame: number, patch: Partial<{ dx: number; dy: number; scale: number }>, commit: boolean) => {
      const base = draftProject ?? storeProject;
      if (!base) return;
      const track = base.tracks.find((t) => t.id === trackId);
      const clip = track?.clips.find((c) => c.id === clipId);
      if (!track || !clip) return;
      let kf = clip.keyframes;
      for (const [prop, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        kf = upsertPoseKeyframe(kf, prop as "dx" | "dy" | "scale", localFrame, value);
      }
      const nextTrack: Track = { ...track, clips: track.clips.map((c) => (c.id === clipId ? { ...c, keyframes: kf } : c)) };
      const next = replaceTrack(base, nextTrack);
      if (commit) {
        persist(next);
        setDraftProject(null);
      } else {
        setDraftProject(next);
      }
    },
    [draftProject, storeProject, persist],
  );

  // Pointer position -> stage canvas pixel coordinates.
  const stagePointAt = useCallback((e: React.PointerEvent): { x: number; y: number } | null => {
    const overlay = stageOverlayRef.current;
    if (!overlay) return null;
    const rect = overlay.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    // object-contain letterboxing: map through the fitted content box.
    const scale = Math.min(rect.width / overlay.width, rect.height / overlay.height);
    const boxW = overlay.width * scale;
    const boxH = overlay.height * scale;
    const ox = rect.left + (rect.width - boxW) / 2;
    const oy = rect.top + (rect.height - boxH) / 2;
    return { x: (e.clientX - ox) / scale, y: (e.clientY - oy) / scale };
  }, []);

  // Topmost element under a stage point: titles first (they draw above the
  // video), then video/overlay/sequence clips. Top-level scope only (nested
  // sequence content selects its parent sequence clip via the base active).
  const stageHitTest = useCallback(
    (x: number, y: number): { track: Track; clip: Clip; kind: "title" | "clip" } | null => {
      const p = draftProject ?? storeProject;
      const ctx = stageOverlayRef.current?.getContext("2d");
      if (!p || !ctx) return null;
      const f = Math.round(playheadRef.current);
      const titles = activeTitleClipsAt(p, f);
      for (let i = titles.length - 1; i >= 0; i--) {
        const a = titles[i];
        const b = titleBounds(ctx, p, a.clip.title as TitleCard);
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
          return { track: a.track, clip: a.clip, kind: "title" };
        }
      }
      const vis = visibleVideoClipsAt(p, f, { xfade: false });
      const W = p.stage.width;
      const H = p.stage.height;
      for (let i = vis.length - 1; i >= 0; i--) {
        const a = vis[i];
        if (a.track.locked) continue;
        const pose = evalKeyframes(a.clip.keyframes, a.localFrame, a.clip);
        const media = getPlayer().drawSource(a);
        const crop = a.clip.crop;
        const sw = crop?.width ?? media?.width ?? W;
        const sh = crop?.height ?? media?.height ?? H;
        const d = fitRect(sw, sh, W, H, a.clip.fit ?? "cover");
        // Inverse of the draw transform: un-translate, un-rotate, un-scale.
        const px = x - (W / 2 + pose.dx * W);
        const py = y - (H / 2 + pose.dy * H);
        const r = (-pose.rotation * Math.PI) / 180;
        const rx = (px * Math.cos(r) - py * Math.sin(r)) / Math.max(0.01, pose.scale) + W / 2;
        const ry = (px * Math.sin(r) + py * Math.cos(r)) / Math.max(0.01, pose.scale) + H / 2;
        if (rx >= d.x && rx <= d.x + d.w && ry >= d.y && ry <= d.y + d.h) {
          return { track: a.track, clip: a.clip, kind: "clip" };
        }
      }
      return null;
    },
    [draftProject, storeProject, getPlayer],
  );

  // Live title reposition (draft while dragging, one persist on release).
  const patchTitleOffsets = useCallback(
    (trackId: string, clipId: string, offsetX: number, offsetY: number, commit: boolean) => {
      const base = draftProject ?? storeProject;
      if (!base) return;
      const track = base.tracks.find((t) => t.id === trackId);
      const clip = track?.clips.find((c) => c.id === clipId);
      if (!track || !clip?.title) return;
      const title: TitleCard = {
        ...clip.title,
        offsetX: Math.abs(offsetX) < 0.002 ? undefined : Math.max(-0.9, Math.min(0.9, offsetX)),
        offsetY: Math.abs(offsetY) < 0.002 ? undefined : Math.max(-0.9, Math.min(0.9, offsetY)),
      };
      const next = replaceTrack(base, {
        ...track,
        clips: track.clips.map((c) => (c.id === clipId ? { ...c, title } : c)),
      });
      if (commit) {
        persist(next);
        setDraftProject(null);
      } else setDraftProject(next);
    },
    [draftProject, storeProject, persist],
  );

  const onStagePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const pt = stagePointAt(e);
      // The SELECTED video clip drags its pose when grabbed directly.
      if (stageTarget && pt) {
        const hit = stageHitTest(pt.x, pt.y);
        if (hit && hit.clip.id === stageTarget.clip.id && hit.kind === "clip") {
          e.preventDefault();
          (e.target as Element).setPointerCapture?.(e.pointerId);
          const pose = evalKeyframes(stageTarget.clip.keyframes, stageTarget.localFrame);
          stageDragRef.current = {
            mode: "pose",
            clipId: stageTarget.clip.id,
            trackId: stageTarget.track.id,
            startX: e.clientX,
            startY: e.clientY,
            base: { dx: pose.dx, dy: pose.dy, scale: pose.scale },
            localFrame: stageTarget.localFrame,
          };
          return;
        }
      }
      if (!pt) return;
      const hit = stageHitTest(pt.x, pt.y);
      if (!hit) {
        selectOnly(null);
        return;
      }
      e.preventDefault();
      selectOnly(hit.clip.id);
      if (hit.kind === "title" && !hit.track.locked) {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        stageDragRef.current = {
          mode: "title",
          clipId: hit.clip.id,
          trackId: hit.track.id,
          startX: e.clientX,
          startY: e.clientY,
          base: {
            dx: hit.clip.title?.offsetX ?? 0,
            dy: hit.clip.title?.offsetY ?? 0,
            scale: 1,
          },
          localFrame: 0,
        };
      }
    },
    [stageTarget, stagePointAt, stageHitTest, selectOnly],
  );
  const onStagePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = stageDragRef.current;
      if (!d) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const fx = (e.clientX - d.startX) / rect.width;
      const fy = (e.clientY - d.startY) / rect.height;
      if (d.mode === "title") {
        patchTitleOffsets(d.trackId, d.clipId, d.base.dx + fx, d.base.dy + fy, false);
        return;
      }
      applyPose(d.clipId, d.trackId, d.localFrame, { dx: d.base.dx + fx, dy: d.base.dy + fy }, false);
    },
    [applyPose, patchTitleOffsets],
  );
  const onStagePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const d = stageDragRef.current;
      stageDragRef.current = null;
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      if (!d) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const fx = (e.clientX - d.startX) / Math.max(1, rect.width);
      const fy = (e.clientY - d.startY) / Math.max(1, rect.height);
      if (d.mode === "title") {
        patchTitleOffsets(d.trackId, d.clipId, d.base.dx + fx, d.base.dy + fy, true);
        return;
      }
      applyPose(d.clipId, d.trackId, d.localFrame, { dx: d.base.dx + fx, dy: d.base.dy + fy }, true);
    },
    [applyPose, patchTitleOffsets],
  );
  const onStageWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!stageTarget) return;
      e.preventDefault();
      const pose = evalKeyframes(stageTarget.clip.keyframes, stageTarget.localFrame);
      const scale = Math.min(10, Math.max(0.05, pose.scale * (e.deltaY < 0 ? 1.05 : 1 / 1.05)));
      applyPose(stageTarget.clip.id, stageTarget.track.id, stageTarget.localFrame, { scale }, false);
      // Commit once the wheel settles so the whole gesture is one undo step.
      if (wheelCommitRef.current) window.clearTimeout(wheelCommitRef.current);
      wheelCommitRef.current = window.setTimeout(() => {
        const draft = draftRef.current;
        if (draft) {
          persist(draft);
          setDraftProject(null);
        }
      }, 350);
    },
    [stageTarget, applyPose, persist],
  );
  // Selection outline on a SEPARATE overlay canvas: the export records the
  // stage canvas, so manipulation chrome must never draw there.
  useEffect(() => {
    let raf = 0;
    const paint = () => {
      const overlay = stageOverlayRef.current;
      const { project: p, frame: f } = drawStateRef.current;
      if (overlay && p) {
        if (overlay.width !== p.stage.width || overlay.height !== p.stage.height) {
          overlay.width = p.stage.width;
          overlay.height = p.stage.height;
        }
        const ctx = overlay.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, overlay.width, overlay.height);
          if (guidesRef.current) {
            const W = overlay.width;
            const H = overlay.height;
            ctx.save();
            ctx.strokeStyle = "rgba(255,255,255,0.35)";
            ctx.lineWidth = Math.max(1, Math.round(W / 1280));
            // rule of thirds
            for (const t of [1 / 3, 2 / 3]) {
              ctx.beginPath();
              ctx.moveTo(W * t, 0);
              ctx.lineTo(W * t, H);
              ctx.moveTo(0, H * t);
              ctx.lineTo(W, H * t);
              ctx.stroke();
            }
            // title-safe area (90%)
            ctx.strokeStyle = "rgba(56,189,248,0.55)";
            ctx.strokeRect(W * 0.05, H * 0.05, W * 0.9, H * 0.9);
            // center cross
            ctx.strokeStyle = "rgba(255,255,255,0.45)";
            ctx.beginPath();
            ctx.moveTo(W / 2 - W * 0.01, H / 2);
            ctx.lineTo(W / 2 + W * 0.01, H / 2);
            ctx.moveTo(W / 2, H / 2 - W * 0.01);
            ctx.lineTo(W / 2, H / 2 + W * 0.01);
            ctx.stroke();
            ctx.restore();
          }
          const sel = selectedRef.current;
          if (sel) {
            const active = activeClipsAt(p, f).find((a) => a.clip.id === sel);
            if (active && (active.track.kind === "video" || active.track.kind === "overlay") && !active.track.hidden) {
              // Mirror the compositor's transforms exactly: fit (cover or
              // contain), crop source dims, keyframed pose, and rotation.
              const pose = evalKeyframes(active.clip.keyframes, active.localFrame, active.clip);
              const W = p.stage.width;
              const H = p.stage.height;
              const media = getPlayer().drawSource(active);
              const crop = active.clip.crop;
              const sw = crop?.width ?? media?.width ?? W;
              const sh = crop?.height ?? media?.height ?? H;
              const d = fitRect(sw, sh, W, H, active.clip.fit ?? "cover");
              ctx.save();
              ctx.translate(W / 2 + pose.dx * W, H / 2 + pose.dy * H);
              if (pose.rotation) ctx.rotate((pose.rotation * Math.PI) / 180);
              ctx.scale(pose.scale, pose.scale);
              ctx.translate(-W / 2, -H / 2);
              ctx.strokeStyle = "rgba(255,255,255,0.85)";
              ctx.setLineDash([10, 7]);
              ctx.lineWidth = Math.max(2, Math.round(W / 640)) / Math.max(0.01, pose.scale);
              ctx.strokeRect(d.x, d.y, d.w, d.h);
              ctx.restore();
            }
          }
        }
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [getPlayer]);
  // -------------------------------------------------------------------------
  // captions: manual cue editing on the project's first caption track.
  // -------------------------------------------------------------------------
  const [captionsOpen, setCaptionsOpen] = useState(false);
  const cues: CaptionCue[] = useMemo(() => project?.captions?.[0]?.cues ?? [], [project]);
  const persistCues = useCallback(
    (next: CaptionCue[]) => {
      if (!project) return;
      persist(withCues(project, next));
    },
    [project, persist],
  );
  const captionStyle = captionStyleOf(project?.captions?.[0]);
  const patchCaptionStyle = useCallback(
    (patch: Partial<ReturnType<typeof captionStyleOf>>) => {
      if (!project) return;
      persist(withCaptionStyle(project, patch));
    },
    [project, persist],
  );
  const addCueAtPlayhead = useCallback(() => {
    if (!project) return;
    const start = frame;
    const end = Math.min(Math.max(start + 1, start + project.fps * 2), Math.max(durationFrames, start + 1));
    persistCues([...cues, { id: shortId("cue"), startFrame: start, endFrame: end, text: "Caption text" }]);
  }, [project, frame, durationFrames, cues, persistCues]);
  const downloadCaptions = useCallback(
    (format: "srt" | "vtt") => {
      if (!project || !cues.length) return;
      const text = format === "srt" ? toSrt(cues, project.fps) : toVtt(cues, project.fps);
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      downloadBlob(blob, `${(docTitle || "captions").replace(/[^\w.-]+/g, "_")}.${format}`);
    },
    [project, cues, docTitle],
  );

  // -------------------------------------------------------------------------
  // clip fades + project settings
  // -------------------------------------------------------------------------
  const setClipFades = useCallback(
    (fadeInFrames: number, fadeOutFrames: number) => {
      if (!project || !selected || selected.track.locked) return;
      const nextTrack: Track = {
        ...selected.track,
        clips: selected.track.clips.map((c) =>
          c.id === selected.clip.id
            ? { ...c, fadeInFrames: Math.max(0, Math.round(fadeInFrames)), fadeOutFrames: Math.max(0, Math.round(fadeOutFrames)) }
            : c,
        ),
      };
      persist(replaceTrack(project, nextTrack));
    },
    [project, selected, persist],
  );

  const setClipTitle = useCallback(
    (patch: Partial<TitleCard>) => {
      if (!project || !selected || selected.track.locked) return;
      const cur: TitleCard = selected.clip.title ?? { text: "" };
      const nextTrack: Track = {
        ...selected.track,
        clips: selected.track.clips.map((c) =>
          c.id === selected.clip.id ? { ...c, title: { ...cur, ...patch } } : c,
        ),
      };
      persist(replaceTrack(project, nextTrack));
    },
    [project, selected, persist],
  );

  const setClipChroma = useCallback(
    (key: ChromaKey | null) => {
      if (!project || !selected || selected.track.locked) return;
      const nextTrack: Track = {
        ...selected.track,
        clips: selected.track.clips.map((c) =>
          c.id === selected.clip.id ? { ...c, chromaKey: key ?? undefined } : c,
        ),
      };
      persist(replaceTrack(project, nextTrack));
    },
    [project, selected, persist],
  );

  const setClipKeyframes = useCallback(
    (tracks: KeyframeTrack[]) => {
      if (!project || !selected || selected.track.locked) return;
      const nextTrack: Track = {
        ...selected.track,
        clips: selected.track.clips.map((c) =>
          c.id === selected.clip.id ? { ...c, keyframes: tracks.length ? tracks : undefined } : c,
        ),
      };
      persist(replaceTrack(project, nextTrack));
    },
    [project, selected, persist],
  );

  // Select every clip on unlocked tracks (Cmd/Ctrl+A).
  const selectAllClips = useCallback(() => {
    if (!project) return;
    const ids = project.tracks.flatMap((t) => (t.locked ? [] : t.clips.map((c) => c.id)));
    if (!ids.length) return;
    setMultiIds(new Set(ids));
    setSelectedClipId(ids[0]);
  }, [project]);

  // Nudge the selection by frames (comma/period; Shift = 10). Collisions
  // clamp the whole group like a drag drop does.
  const nudgeSelection = useCallback(
    (delta: number) => {
      if (!project || multiIds.size === 0) return;
      const minStart = Math.min(
        ...project.tracks.flatMap((t) => t.clips.filter((c) => multiIds.has(c.id)).map((c) => c.startFrame)),
      );
      const d = Math.max(delta, -minStart);
      if (!d) return;
      let tracks = project.tracks.map((t) =>
        t.locked
          ? t
          : {
              ...t,
              clips: sortClips(
                t.clips.map((c) => (multiIds.has(c.id) && !c.locked ? { ...c, startFrame: c.startFrame + d } : c)),
              ),
            },
      );
      // Revert per-track when a nudge would overlap something unselected.
      tracks = tracks.map((t, i) => {
        const collide = t.clips.some((c) => multiIds.has(c.id) && t.clips.some((o) => o.id !== c.id && clipsOverlap(o, c)));
        return collide ? project.tracks[i] : t;
      });
      persist(withDuration({ ...project, tracks }));
    },
    [project, multiIds, persist],
  );

  // J/K/L shuttle: L steps 1x -> 2x -> 4x forward, J the same backwards
  // (reverse plays by seek-stepping; media elements cannot play backwards).
  const shuttle = useCallback((dir: 1 | -1) => {
    setPlayRate((cur) => {
      const sameDir = playingRef.current && Math.sign(cur) === dir;
      const mag = sameDir ? Math.min(4, Math.abs(cur) * 2) : 1;
      return dir * mag;
    });
    playRangeUntilRef.current = null;
    setPlaying(true);
  }, []);

  // Marquee (rubber-band) selection across lanes: starts on empty lane
  // space, selects every clip the rectangle touches.
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marqueeRef = useRef<{ x0: number; y0: number } | null>(null);
  const marqueePoint = useCallback((e: React.PointerEvent) => {
    const rect = laneAreaRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);
  const marqueeApply = useCallback(
    (box: { x0: number; y0: number; x1: number; y1: number }) => {
      const p = draftProject ?? storeProject;
      if (!p) return;
      const [xa, xb] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)];
      const [ya, yb] = [Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)];
      const ids: string[] = [];
      p.tracks.forEach((t, ti) => {
        const top = RULER_HEIGHT + ti * trackH;
        if (top + trackH < ya || top > yb || t.locked) return;
        for (const c of t.clips) {
          const cx0 = c.startFrame * pxPerFrame;
          const cx1 = clipEndFrame(c) * pxPerFrame;
          if (cx1 >= xa && cx0 <= xb && !c.locked) ids.push(c.id);
        }
      });
      setMultiIds(new Set(ids));
      setSelectedClipId(ids[0] ?? null);
    },
    [draftProject, storeProject, pxPerFrame, trackH],
  );
  const onLanePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.target !== e.currentTarget || e.button !== 0) return;
      const pt = marqueePoint(e);
      if (!pt) return;
      selectOnly(null);
      marqueeRef.current = { x0: pt.x, y0: pt.y };
      try {
        (e.target as Element).setPointerCapture?.(e.pointerId);
      } catch {
        /* best-effort */
      }
    },
    [marqueePoint, selectOnly],
  );
  const onLanePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const start = marqueeRef.current;
      if (!start) return;
      const pt = marqueePoint(e);
      if (!pt) return;
      const box = { x0: start.x0, y0: start.y0, x1: pt.x, y1: pt.y };
      setMarquee(box);
      marqueeApply(box);
    },
    [marqueePoint, marqueeApply],
  );
  const onLanePointerUp = useCallback((e: React.PointerEvent) => {
    marqueeRef.current = null;
    setMarquee(null);
    try {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
    } catch {
      /* nothing captured */
    }
  }, []);

  // Toggle a boolean/color field on ANY clip by ids (context-menu targets).
  const patchClipByIds = useCallback(
    (trackId: string, clipId: string, patch: Partial<Clip>) => {
      if (!project) return;
      const track = project.tracks.find((t) => t.id === trackId);
      if (!track) return;
      persist(replaceTrack(project, {
        ...track,
        clips: track.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
      }));
    },
    [project, persist],
  );

  // Replace a clip's media keeping its trim/effects; the source window is
  // clamped to the new media's probed length.
  const [replaceTarget, setReplaceTarget] = useState<{ trackId: string; clipId: string } | null>(null);
  const applyReplaceMedia = useCallback(
    (asset: UploadedAsset) => {
      const target = replaceTarget;
      setReplaceTarget(null);
      if (!project || !target) return;
      const track = project.tracks.find((t) => t.id === target.trackId);
      const clip = track?.clips.find((c) => c.id === target.clipId);
      if (!track || !clip) return;
      const secs = assetSeconds[asset.id];
      const maxSrc = secs && secs > 0 ? Math.round(secs * project.fps) : undefined;
      const outFrame = maxSrc !== undefined ? Math.min(clip.outFrame, maxSrc) : clip.outFrame;
      const inFrame = Math.min(clip.inFrame, Math.max(0, outFrame - 1));
      persist(replaceTrack(project, {
        ...track,
        clips: track.clips.map((c) =>
          c.id === clip.id ? { ...c, assetId: asset.id, inFrame, outFrame, name: undefined } : c,
        ),
      }));
    },
    [replaceTarget, project, assetSeconds, persist],
  );

  // Freeze frame: split at the playhead and insert a hold of the current
  // source frame (3s), pushing everything after it right.
  const freezeFrame = useCallback(() => {
    if (!project || !selected || selected.track.locked || selected.clip.locked) return;
    const clip = selected.clip;
    if (frame <= clip.startFrame || frame >= clipEndFrame(clip) || clip.sequenceId) return;
    const holdFrames = project.fps * 3;
    const srcF = sourceFrameAt(clip, frame);
    if (srcF === null) return;
    const splitTrack = splitClip(selected.track, clip.id, frame);
    if (splitTrack === selected.track) return;
    const holdClip: Clip = {
      id: shortId("clip"),
      assetId: clip.assetId,
      name: clip.name ? `${clip.name} (freeze)` : undefined,
      startFrame: frame,
      inFrame: srcF,
      outFrame: srcF + 1,
      speed: 1 / holdFrames, // 1 source frame stretched across the hold
      fit: clip.fit,
      color: clip.color,
      opacity: clip.opacity,
      rotationDeg: clip.rotationDeg,
      crop: clip.crop,
      audioGainDb: -60, // a still frame has no meaningful audio
    };
    const clips = splitTrack.clips.map((c) =>
      c.startFrame >= frame ? { ...c, startFrame: c.startFrame + holdFrames } : c,
    );
    persist(replaceTrack(project, { ...selected.track, clips: sortClips([...clips, holdClip]) }));
  }, [project, selected, frame, persist]);

  // Unlink a clip group (video + detached audio move independently again).
  const unlinkGroup = useCallback(
    (groupId: string) => {
      if (!project) return;
      persist({
        ...project,
        tracks: project.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => (c.groupId === groupId ? { ...c, groupId: undefined } : c)),
        })),
      });
    },
    [project, persist],
  );

  // Detach audio: a linked audio clip with the same source window lands on the
  // first unlocked audio track (created when missing) and the video clip's own
  // sound is silenced. The video asset's element still carries the audio.
  const detachAudio = useCallback(() => {
    if (!project || !selected || selected.track.kind !== "video" || !selected.clip.assetId) return;
    const srcClip = selected.clip;
    const dur = clipDurationFrames(srcClip);
    let tracks = project.tracks;
    // The detached audio must sit EXACTLY under its video. Pick an audio
    // track whose slot at that position is free; otherwise create a new one
    // instead of silently shifting the clip out of sync.
    const slotFree = (t: Track) =>
      !t.clips.some((c) => c.startFrame < srcClip.startFrame + dur && srcClip.startFrame < clipEndFrame(c));
    let audioTrack = tracks.find((t) => t.kind === "audio" && !t.locked && slotFree(t));
    if (!audioTrack) {
      audioTrack = newTrack("audio", `Audio ${tracks.filter((t) => t.kind === "audio").length + 1}`);
      tracks = [...tracks, audioTrack];
    }
    // Linked pair: the video and its audio move together from now on.
    const groupId = srcClip.groupId ?? shortId("grp");
    const audioClip: Clip = {
      id: shortId("clip"),
      assetId: srcClip.assetId,
      groupId,
      startFrame: srcClip.startFrame,
      inFrame: srcClip.inFrame,
      outFrame: srcClip.outFrame,
      speed: srcClip.speed,
      audioGainDb: srcClip.audioGainDb,
      fadeInFrames: srcClip.fadeInFrames,
      fadeOutFrames: srcClip.fadeOutFrames,
    };
    const audioId = audioTrack.id;
    const next: VideoProject = {
      ...project,
      tracks: tracks.map((t) =>
        t.id === selected.track.id
          ? { ...t, clips: t.clips.map((c) => (c.id === srcClip.id ? { ...c, audioGainDb: -60, groupId } : c)) }
          : t.id === audioId
            ? { ...t, clips: sortClips([...t.clips, audioClip]) }
            : t,
      ),
    };
    persist(withDuration(next));
    selectOnly(audioClip.id);
  }, [project, selected, persist]);

  // Scene detection: propose cuts on the selected clip's source and split at
  // each one (splitting right-to-left keeps the original id on the left piece
  // so earlier cut frames stay valid).
  const [detectingScenes, setDetectingScenes] = useState(false);
  const detectScenes = useCallback(async () => {
    if (!project || !selected || selected.track.locked || !selected.clip.assetId || detectingScenes) return;
    const asset = assetsRef.current.get(selected.clip.assetId);
    if (!asset) return;
    setDetectingScenes(true);
    try {
      const seconds = await detectSceneSeconds(resolveAssetUrl(asset.url));
      const c = selected.clip;
      const speedMag = Math.abs(c.speed) || 1;
      const cutFrames = seconds
        .map((s) => Math.round(s * project.fps)) // source frames (project-fps convention)
        .filter((sf) => sf > c.inFrame && sf < c.outFrame)
        .map((sf) => c.startFrame + Math.round((sf - c.inFrame) / speedMag))
        .filter((f) => f > c.startFrame && f < clipEndFrame(c))
        .sort((a, b) => b - a); // right-to-left
      if (!cutFrames.length) return;
      let track = selected.track;
      for (const f of cutFrames) track = splitClip(track, c.id, f);
      persist(replaceTrack(project, track));
    } catch (e) {
      // Leave the clip untouched, but surface the cause for the operator.
      console.warn("Scene detection failed:", e);
    } finally {
      setDetectingScenes(false);
    }
  }, [project, selected, detectingScenes, persist]);

  // Reorder tracks (stacking order IS track order: later draws on top).
  const moveTrack = useCallback(
    (trackId: string, dir: -1 | 1) => {
      if (!project) return;
      const idx = project.tracks.findIndex((t) => t.id === trackId);
      const to = idx + dir;
      if (idx < 0 || to < 0 || to >= project.tracks.length) return;
      const tracks = [...project.tracks];
      [tracks[idx], tracks[to]] = [tracks[to], tracks[idx]];
      persist(withDuration({ ...project, tracks }));
    },
    [project, persist],
  );

  // Ruler markers: M toggles one at the playhead (2-frame tolerance removes).
  const toggleMarker = useCallback(
    (atFrame?: number) => {
      if (!project) return;
      const f = atFrame ?? frame;
      const markers = project.markers ?? [];
      const near = markers.find((m) => Math.abs(m - f) <= 2);
      const next = near !== undefined ? markers.filter((m) => m !== near) : [...markers, f].sort((a, b) => a - b);
      persist({ ...project, markers: next });
    },
    [project, frame, persist],
  );

  // Export/preview range: I marks in, O marks out (invalid pairs collapse).
  const markRange = useCallback(
    (edge: "in" | "out", atFrame?: number) => {
      if (!project) return;
      const f = atFrame ?? frame;
      const cur = project.range;
      let startFrame = edge === "in" ? f : cur?.startFrame ?? 0;
      let endFrame = edge === "out" ? f : cur?.endFrame ?? durationFrames;
      if (endFrame <= startFrame) {
        if (edge === "in") endFrame = durationFrames;
        else startFrame = 0;
      }
      if (endFrame <= startFrame) return;
      persist({ ...project, range: { startFrame, endFrame } });
    },
    [project, frame, durationFrames, persist],
  );
  const clearRange = useCallback(() => {
    if (!project?.range) return;
    persist({ ...project, range: undefined });
  }, [project, persist]);

  // Close the gap under a lane position: everything after the gap shifts left.
  const closeGap = useCallback(
    (trackId: string, atFrame: number) => {
      if (!project) return;
      const track = project.tracks.find((t) => t.id === trackId);
      if (!track || track.locked) return;
      let prevEnd = 0;
      let nextStart: number | null = null;
      for (const c of sortClips(track.clips)) {
        if (c.startFrame <= atFrame && atFrame < clipEndFrame(c)) return; // inside a clip
        if (clipEndFrame(c) <= atFrame) prevEnd = Math.max(prevEnd, clipEndFrame(c));
        if (c.startFrame > atFrame) {
          nextStart = c.startFrame;
          break;
        }
      }
      if (nextStart === null || nextStart <= prevEnd) return;
      const delta = nextStart - prevEnd;
      const from = nextStart;
      const clips = track.clips.map((c) => (c.startFrame >= from ? { ...c, startFrame: c.startFrame - delta } : c));
      persist(replaceTrack(project, { ...track, clips: sortClips(clips) }));
    },
    [project, persist],
  );

  // Clip clipboard (Cmd/Ctrl+C / V): pastes at the playhead on the source
  // track (or the first surviving track of the same kind), new id, no overlap.
  const clipboardRef = useRef<{
    entries: { trackId: string; kind: Track["kind"]; clip: Clip }[];
    baseFrame: number;
  } | null>(null);
  const [hasClipboard, setHasClipboard] = useState(false);
  const copySelectedClip = useCallback(() => {
    if (!project || !selected) return;
    // Copy the full selection, preserving each clip's track and its offset
    // from the earliest member so a paste keeps relative timing.
    const entries: { trackId: string; kind: Track["kind"]; clip: Clip }[] = [];
    for (const t of project.tracks) {
      for (const c of t.clips) {
        if (multiIds.has(c.id) || c.id === selected.clip.id) {
          entries.push({ trackId: t.id, kind: t.kind, clip: structuredClone(c) });
        }
      }
    }
    if (!entries.length) return;
    const baseFrame = Math.min(...entries.map((x) => x.clip.startFrame));
    clipboardRef.current = { entries, baseFrame };
    setHasClipboard(true);
  }, [project, selected, multiIds]);
  const pasteClip = useCallback((atFrame?: number) => {
    if (!project || !clipboardRef.current) return;
    const { entries, baseFrame } = clipboardRef.current;
    // atFrame: the context menu pastes where the user CLICKED; the setPlayhead
    // in the same handler cannot land before this closure's `frame` is read.
    const at = atFrame ?? frame;
    let tracks = project.tracks;
    const pastedIds: string[] = [];
    for (const entry of entries) {
      const track =
        tracks.find((t) => t.id === entry.trackId && !t.locked) ?? tracks.find((t) => t.kind === entry.kind && !t.locked);
      if (!track) continue;
      const dur = clipDurationFrames(entry.clip);
      const startFrame = freeStartFrame(track, dur, at + (entry.clip.startFrame - baseFrame));
      const pasted: Clip = { ...structuredClone(entry.clip), id: shortId("clip"), groupId: undefined, startFrame };
      pastedIds.push(pasted.id);
      tracks = tracks.map((t) => (t.id === track.id ? { ...t, clips: sortClips([...t.clips, pasted]) } : t));
    }
    if (!pastedIds.length) return;
    persist(withDuration({ ...project, tracks }));
    if (pastedIds.length === 1) selectOnly(pastedIds[0]);
    else {
      setMultiIds(new Set(pastedIds));
      setSelectedClipId(pastedIds[0]);
    }
  }, [project, frame, persist]);

  // Remove every selected clip (multi-select delete; single keeps ripple).
  const deleteSelected = useCallback(() => {
    if (!project || multiIds.size === 0) return;
    const tracks = project.tracks.map((t) =>
      t.locked ? t : { ...t, clips: t.clips.filter((c) => !multiIds.has(c.id)) },
    );
    persist(withDuration({ ...project, tracks }));
    selectOnly(null);
  }, [project, multiIds, persist, selectOnly]);

  // Duplicate a clip right after itself (collision-avoided).
  const duplicateClip = useCallback(
    (trackId: string, clipId: string) => {
      if (!project) return;
      const track = project.tracks.find((t) => t.id === trackId);
      const clip = track?.clips.find((c) => c.id === clipId);
      if (!track || !clip || track.locked) return;
      const dur = clipDurationFrames(clip);
      const startFrame = freeStartFrame(track, dur, clipEndFrame(clip), clip.id);
      const dup: Clip = { ...structuredClone(clip), id: shortId("clip"), startFrame };
      persist(replaceTrack(project, { ...track, clips: sortClips([...track.clips, dup]) }));
      selectOnly(dup.id);
    },
    [project, persist, selectOnly],
  );

  // Author a true overlap cross-dissolve at the cut with the next abutting
  // clip: both edges get crossDissolve, and the compositor renders the left
  // clip's source handle THROUGH the cut under the incoming fade.
  const crossDissolveAtCut = useCallback(
    (trackId: string, clipId: string, durationFrames = 15) => {
      if (!project) return;
      const track = project.tracks.find((t) => t.id === trackId);
      const left = track?.clips.find((c) => c.id === clipId);
      if (!track || !left || track.locked) return;
      const cut = clipEndFrame(left);
      const right = track.clips.find((c) => c.startFrame === cut && c.id !== left.id);
      if (!right) return;
      const d = Math.max(1, Math.min(durationFrames, clipDurationFrames(left), clipDurationFrames(right)));
      const clips = track.clips.map((c) =>
        c.id === left.id
          ? { ...c, transitionOut: { type: "crossDissolve" as const, durationFrames: d } }
          : c.id === right.id
            ? { ...c, transitionIn: { type: "crossDissolve" as const, durationFrames: d } }
            : c,
      );
      persist(replaceTrack(project, { ...track, clips }));
    },
    [project, persist],
  );

  // Collapse the selected clips into a nested sequence: the clips move into a
  // child project (times rebased to its zero) and ONE sequence clip replaces
  // them on the first involved track. One undoable meta write.
  const nestSelection = useCallback(() => {
    if (!project || multiIds.size === 0) return;
    const involved = project.tracks
      .map((t) => ({ track: t, sel: t.clips.filter((c) => multiIds.has(c.id)) }))
      .filter((x) => x.sel.length > 0 && !x.track.locked);
    if (!involved.length) return;
    const minStart = Math.min(...involved.flatMap((x) => x.sel.map((c) => c.startFrame)));
    const span = Math.max(...involved.flatMap((x) => x.sel.map((c) => clipEndFrame(c)))) - minStart;
    if (span < 1) return;
    const childTracks: Track[] = involved.map(({ track, sel }) => ({
      ...newTrack(track.kind, track.name),
      // Mixer/visibility state rides along; without it a muted or gain-set
      // track would suddenly change loudness inside the sequence.
      gainDb: track.gainDb,
      muted: track.muted,
      solo: track.solo,
      hidden: track.hidden,
      pan: track.pan,
      clips: sortClips(sel.map((c) => ({ ...structuredClone(c), startFrame: c.startFrame - minStart }))),
    }));
    const child = withDuration(
      newProject({ stage: { ...project.stage }, fps: project.fps, durationFrames: span, tracks: childTracks }),
    );
    const newId = shortId("seq");
    const seqClip: Clip = { id: shortId("clip"), sequenceId: newId, startFrame: minStart, inFrame: 0, outFrame: span, speed: 1 };
    const firstTrackId = involved[0].track.id;
    const parentNext = withDuration({
      ...project,
      tracks: project.tracks.map((t) => {
        const remaining = t.clips.filter((c) => !multiIds.has(c.id));
        return t.id === firstTrackId ? { ...t, clips: sortClips([...remaining, seqClip]) } : { ...t, clips: remaining };
      }),
    });
    const meta = useEditor.getState().doc.meta;
    const allSeqs = { ...((meta.videoSequences as Record<string, VideoProject> | undefined) ?? {}), [newId]: child };
    const names = {
      ...((meta.videoSequenceNames as Record<string, string> | undefined) ?? {}),
      [newId]: `Sequence ${Object.keys(allSeqs).length}`,
    };
    const patch: Record<string, unknown> = { videoSequenceNames: names };
    if (seqId) patch.videoSequences = { ...allSeqs, [seqId]: parentNext };
    else {
      patch.videoSequences = allSeqs;
      patch.video = parentNext;
    }
    useEditor.getState().setDocMeta(patch);
    selectOnly(seqClip.id);
  }, [project, multiIds, seqId, selectOnly]);

  const openSequence = useCallback(
    (id: string) => {
      setSeqPath((prev) => [...prev, id]);
      selectOnly(null);
      setPlaying(false);
      setPlayhead(0);
    },
    [selectOnly],
  );

  const setStageSize = useCallback(
    (width: number, height: number) => {
      if (!project) return;
      persist({ ...project, stage: { width, height } });
    },
    [project, persist],
  );

  // Changing fps re-times every clip (and cue) so wall-clock timing holds.
  // Re-time ONE project (any scope) to a new fps, preserving wall-clock
  // timing, marker/range positions, and clip abutments (independent rounding
  // of starts and durations can otherwise open 1-frame gaps at cuts).
  const retimeProject = useCallback((p: VideoProject, from: Fps, nextFps: Fps): VideoProject => {
    const map = (f: number) => remapFps(f, from, nextFps);
    const tracks = p.tracks.map((t) => {
      // Which pairs abut BEFORE the remap (by id), so the same pairs can be
      // forced back together after rounding.
      const sorted = sortClips(t.clips);
      const abuts = new Set<string>();
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].startFrame === clipEndFrame(sorted[i - 1])) abuts.add(sorted[i].id);
      }
      let mapped: Clip[] = t.clips.map((c) => ({
        ...c,
        startFrame: map(c.startFrame),
        inFrame: map(c.inFrame),
        outFrame: Math.max(map(c.inFrame) + 1, map(c.outFrame)),
        fadeInFrames: c.fadeInFrames !== undefined ? map(c.fadeInFrames) : undefined,
        fadeOutFrames: c.fadeOutFrames !== undefined ? map(c.fadeOutFrames) : undefined,
        transitionIn: c.transitionIn ? { ...c.transitionIn, durationFrames: Math.max(1, map(c.transitionIn.durationFrames)) } : undefined,
        transitionOut: c.transitionOut ? { ...c.transitionOut, durationFrames: Math.max(1, map(c.transitionOut.durationFrames)) } : undefined,
        title: c.title?.animFrames !== undefined ? { ...c.title, animFrames: Math.max(2, map(c.title.animFrames)) } : c.title,
        keyframes: c.keyframes?.map((kt) => ({
          ...kt,
          keyframes: kt.keyframes.map((k) => ({ ...k, frame: map(k.frame) })),
        })),
      }));
      mapped = sortClips(mapped).map((c, i, arr) =>
        i > 0 && abuts.has(c.id) ? { ...c, startFrame: clipEndFrame(arr[i - 1]) } : c,
      );
      return { ...t, clips: mapped };
    });
    const captions = p.captions?.map((ct) => ({
      ...ct,
      cues: ct.cues.map((q) => ({ ...q, startFrame: map(q.startFrame), endFrame: Math.max(map(q.startFrame) + 1, map(q.endFrame)) })),
    }));
    return withDuration({
      ...p,
      fps: nextFps,
      tracks,
      captions,
      markers: p.markers?.map(map).sort((a, b) => a - b),
      range: p.range
        ? { startFrame: map(p.range.startFrame), endFrame: Math.max(map(p.range.startFrame) + 1, map(p.range.endFrame)) }
        : undefined,
      minDurationFrames: p.minDurationFrames !== undefined ? map(p.minDurationFrames) : undefined,
    });
  }, []);

  const setProjectFps = useCallback(
    (nextFps: Fps) => {
      if (!project || nextFps === project.fps) return;
      const from = project.fps;
      // The fps change cascades into every nested sequence: sequence clip
      // in/out are CHILD-frame units, so parent and children must share one
      // timebase or playback and export desync.
      const meta = useEditor.getState().doc.meta;
      const topRaw = (meta.video as VideoProject | undefined) ?? project;
      const seqsRaw = (meta.videoSequences as Record<string, VideoProject> | undefined) ?? {};
      const patch: Record<string, unknown> = {
        video: retimeProject(seqId ? topRaw : project, from, nextFps),
        videoSequences: Object.fromEntries(
          Object.entries(seqsRaw).map(([id, p]) => [
            id,
            retimeProject(id === seqId ? project : p, (p.fps as Fps) ?? from, nextFps),
          ]),
        ),
      };
      useEditor.getState().setDocMeta(patch);
    },
    [project, seqId, retimeProject],
  );

  const doSplit = useCallback(() => {
    if (!project || !selected || selected.track.locked) return;
    const next = splitClip(selected.track, selected.clip.id, frame);
    persist(replaceTrack(project, next));
  }, [project, selected, frame, persist]);

  const doRippleDelete = useCallback(() => {
    if (!project || !selected || selected.track.locked) return;
    // Ripple is MULTI-TRACK: everything at/after the removed clip's end
    // (clips on unlocked tracks, markers, the export range) shifts left by
    // the removed duration, so tracks stay in sync. A shift that would bury
    // a clip under an earlier one keeps that clip where it was.
    const dur = clipDurationFrames(selected.clip);
    const cutEnd = clipEndFrame(selected.clip);
    const shiftF = (f: number) => (f >= cutEnd ? Math.max(0, f - dur) : f);
    const tracks = project.tracks.map((t) => {
      const base = t.id === selected.track.id ? t.clips.filter((c) => c.id !== selected.clip.id) : t.clips;
      if (t.locked) return { ...t, clips: base };
      // Shift as far as the track allows: a clip spanning the ripple zone
      // blocks the ones behind it (they abut it instead of overlapping).
      let runEnd = 0;
      const shifted = sortClips(base).map((c) => {
        if (c.startFrame >= cutEnd) {
          const placed = Math.max(c.startFrame - dur, runEnd);
          runEnd = placed + clipDurationFrames(c);
          return placed === c.startFrame ? c : { ...c, startFrame: placed };
        }
        runEnd = Math.max(runEnd, clipEndFrame(c));
        return c;
      });
      return { ...t, clips: shifted };
    });
    persist(
      withDuration({
        ...project,
        tracks,
        markers: project.markers?.map(shiftF).sort((a, b) => a - b),
        range: project.range
          ? {
              startFrame: shiftF(project.range.startFrame),
              endFrame: Math.max(shiftF(project.range.startFrame) + 1, shiftF(project.range.endFrame)),
            }
          : undefined,
      }),
    );
    selectOnly(null);
  }, [project, selected, persist, selectOnly]);

  // Editor shortcuts, skipped while typing in a form field and on modifier
  // combos (except Shift, which scales the arrow step): Space play/pause,
  // S split, Delete/Backspace ripple-delete, arrows step 1 frame (Shift=10),
  // Home/End jump to the timeline start/end.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }
      // Modal dialogs own the keyboard: Escape closes the topmost one, and
      // editing shortcuts must never mutate the timeline underneath a modal.
      const modalOpen = exportDialog || !!confirmDeleteAsset || !!confirmDeleteTrack || !!pickerTrackId || !!ctxMenu || !!replaceTarget;
      if (modalOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setExportDialog(false);
          setConfirmDeleteAsset(null);
          setConfirmDeleteTrack(null);
          setPickerTrackId(null);
          setCtxMenu(null);
          setReplaceTarget(null);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        selectOnly(null); // clear the selection
        return;
      }
      // Clipboard chords first (the plain-key switch below skips modifiers).
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        if (e.key === "a" || e.key === "A") {
          e.preventDefault();
          selectAllClips();
          return;
        }
        if (e.key === "c" || e.key === "C") {
          copySelectedClip();
          return; // no preventDefault: text copy elsewhere stays intact
        }
        if (e.key === "v" || e.key === "V") {
          e.preventDefault();
          pasteClip();
          return;
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const step = (delta: number) => {
        setPlaying(false);
        setPlayhead((p) => Math.max(0, Math.min(durationFrames, Math.round(p) + delta)));
      };
      switch (e.key) {
        case " ":
          e.preventDefault();
          if (e.repeat) break; // holding Space must not strobe play/pause
          togglePlay();
          break;
        case "s":
        case "S":
          e.preventDefault();
          doSplit();
          break;
        case ",":
        case "<":
          e.preventDefault();
          nudgeSelection(e.shiftKey ? -10 : -1);
          break;
        case ".":
        case ">":
          e.preventDefault();
          nudgeSelection(e.shiftKey ? 10 : 1);
          break;
        case "k":
        case "K":
          e.preventDefault();
          playRangeUntilRef.current = null;
          setPlaying(false);
          setPlayRate(1);
          break;
        case "l":
        case "L":
          e.preventDefault();
          shuttle(1);
          break;
        case "j":
        case "J":
          e.preventDefault();
          shuttle(-1);
          break;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          // Plain delete LIFTS (leaves the gap) for one clip or many;
          // Shift+Delete ripple-deletes (closes the gap on that track).
          if (e.shiftKey && multiIds.size <= 1) doRippleDelete();
          else deleteSelected();
          break;
        case "ArrowLeft":
          e.preventDefault();
          step(e.shiftKey ? -10 : -1);
          break;
        case "ArrowRight":
          e.preventDefault();
          step(e.shiftKey ? 10 : 1);
          break;
        case "Home":
          e.preventDefault();
          setPlaying(false);
          setPlayhead(0);
          break;
        case "End":
          e.preventDefault();
          setPlaying(false);
          setPlayhead(durationFrames);
          break;
        case "m":
        case "M":
          e.preventDefault();
          toggleMarker();
          break;
        case "i":
        case "I":
          e.preventDefault();
          markRange("in");
          break;
        case "o":
        case "O":
          e.preventDefault();
          markRange("out");
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [doSplit, doRippleDelete, durationFrames, toggleMarker, markRange, copySelectedClip, pasteClip, multiIds, deleteSelected, togglePlay, exportDialog, confirmDeleteAsset, confirmDeleteTrack, pickerTrackId, ctxMenu, replaceTarget, selectOnly, selectAllClips, nudgeSelection, shuttle]);

  // Total source frames available for a clip's media (probed duration for
  // assets, child extent for sequences); undefined when unknown.
  const maxSourceFramesFor = useCallback(
    (clip: Clip): number | undefined => {
      if (clip.sequenceId) return (sequences ?? {})[clip.sequenceId]?.durationFrames;
      if (clip.assetId) {
        const s = assetSeconds[clip.assetId];
        if (s && s > 0 && project) return Math.round(s * project.fps);
      }
      return undefined;
    },
    [sequences, assetSeconds, project],
  );

  const doTrim = useCallback(
    (edge: "in" | "out", delta: number) => {
      if (!project || !selected || selected.track.locked) return;
      const next = trim(selected.track, selected.clip.id, edge, delta, {
        maxSourceFrames: maxSourceFramesFor(selected.clip),
      });
      // The nudge sticks at a neighbour instead of overlapping it (same rule
      // as edge drags).
      const trimmed = next.clips.find((c) => c.id === selected.clip.id);
      if (trimmed && next.clips.some((c) => c.id !== trimmed.id && clipsOverlap(c, trimmed))) return;
      persist(replaceTrack(project, next));
    },
    [project, selected, persist, maxSourceFramesFor],
  );

  const doSetSpeed = useCallback(
    (speed: number) => {
      if (!project || !selected || selected.track.locked) return;
      const nextClip = setSpeed(selected.clip, speed);
      // A slower speed grows the clip; push later clips right so nothing is
      // silently buried under the grown clip.
      const sorted = sortClips(selected.track.clips.map((c) => (c.id === nextClip.id ? nextClip : c)));
      let prevEnd = 0;
      const resolved = sorted.map((c) => {
        const shifted = c.startFrame < prevEnd ? { ...c, startFrame: prevEnd } : c;
        prevEnd = Math.max(prevEnd, clipEndFrame(shifted));
        return shifted;
      });
      persist(replaceTrack(project, { ...selected.track, clips: resolved }));
    },
    [project, selected, persist],
  );

  const doAddTransition = useCallback(
    (edge: "in" | "out", type: ClipTransition["type"]) => {
      if (!project || !selected || selected.track.locked) return;
      const t: ClipTransition = { type, durationFrames: Math.min(15, project.fps) };
      const next = addTransition(selected.track, selected.clip.id, edge, t);
      persist(replaceTrack(project, next));
    },
    [project, selected, persist],
  );

  // Immutably patch the selected clip on its track and persist as one undo step.
  // Used by the inspector's per-clip controls (transition clear, audio gain).
  const patchSelectedClip = useCallback(
    (patch: Partial<Clip>) => {
      if (!project || !selected || selected.track.locked) return;
      const nextTrack: Track = {
        ...selected.track,
        clips: selected.track.clips.map((c) =>
          c.id === selected.clip.id ? { ...c, ...patch } : c,
        ),
      };
      persist(replaceTrack(project, nextTrack));
    },
    [project, selected, persist],
  );

  // Inspector transition setter: choose a type (or clear), preserving the edge's
  // current duration when one already exists. Routes through addTransition (which
  // clamps the duration to the clip length); clearing removes the edge transition.
  const setTransition = useCallback(
    (edge: "in" | "out", type: "" | ClipTransition["type"]) => {
      if (!project || !selected || selected.track.locked) return;
      if (!type) {
        patchSelectedClip(
          edge === "in" ? { transitionIn: undefined } : { transitionOut: undefined },
        );
        return;
      }
      const existing =
        edge === "in" ? selected.clip.transitionIn : selected.clip.transitionOut;
      const t: ClipTransition = {
        type,
        durationFrames: existing?.durationFrames ?? Math.min(15, project.fps),
        ...(existing?.color != null ? { color: existing.color } : {}),
        ...(existing?.easing != null ? { easing: existing.easing } : {}),
      };
      const next = addTransition(selected.track, selected.clip.id, edge, t);
      persist(replaceTrack(project, next));
    },
    [project, selected, persist, patchSelectedClip],
  );

  // Inspector transition duration setter for an edge that already has a type.
  const setTransitionDuration = useCallback(
    (edge: "in" | "out", durationFrames: number) => {
      if (!project || !selected || selected.track.locked) return;
      const existing =
        edge === "in" ? selected.clip.transitionIn : selected.clip.transitionOut;
      if (!existing) return;
      const t: ClipTransition = {
        ...existing,
        durationFrames: Math.max(1, Math.floor(durationFrames || 1)),
      };
      const next = addTransition(selected.track, selected.clip.id, edge, t);
      persist(replaceTrack(project, next));
    },
    [project, selected, persist],
  );

  // Inspector per-clip audio gain (dB). The model carries `audioGainDb`; setting
  // it is one undo step. Clamped to the same range as the track gain slider.
  const setClipGainDb = useCallback(
    (db: number) => {
      const clamped = Math.max(-60, Math.min(6, Math.round(db)));
      patchSelectedClip({ audioGainDb: clamped });
    },
    [patchSelectedClip],
  );

  // -------------------------------------------------------------------------
  // audio mixer ops (per audio track gain/mute/solo; master ducking toggle)
  // -------------------------------------------------------------------------

  const patchTrack = useCallback(
    (trackId: string, patch: Partial<Track>) => {
      if (!project) return;
      const track = project.tracks.find((t) => t.id === trackId);
      if (!track) return;
      persist(replaceTrack(project, { ...track, ...patch }));
    },
    [project, persist],
  );

  // Patch a track into the LOCAL draft only (no persist) so a continuous gesture
  // such as dragging the gain slider stays visible without spamming undo steps.
  const draftPatchTrack = useCallback(
    (trackId: string, patch: Partial<Track>) => {
      if (!project) return;
      const track = project.tracks.find((t) => t.id === trackId);
      if (!track) return;
      setDraftProject(replaceTrack(project, { ...track, ...patch }));
    },
    [project],
  );

  // Commit the in-progress draft as ONE undo step on gesture release (slider
  // mouse-up / blur). A no-op when no draft gesture is in flight.
  const commitDraft = useCallback(() => {
    if (draftProject) persist(draftProject);
    setDraftProject(null);
  }, [draftProject, persist]);


  // -------------------------------------------------------------------------
  // clip drag: move (horizontal + across compatible lanes) and edge trims.
  // Every pointer step recomputes from the pointer-down snapshot, so a drag is
  // stateless and commits as ONE undo step on release.
  // -------------------------------------------------------------------------
  const dragRef = useRef<{
    mode: "move" | "trim-in" | "trim-out" | "fade-in" | "fade-out" | "cut-dur" | "slip" | "stretch-in" | "stretch-out";
    clipId: string;
    trackId: string; // source track
    startClientX: number;
    /** fade-in/out and cut-dur: the value (frames) at pointer-down. */
    origFade: number;
    orig: VideoProject;
  } | null>(null);
  // The frame a dragged clip snapped to (guide line across the lanes).
  const [snapGuide, setSnapGuide] = useState<number | null>(null);
  // The scrollable lane content (ruler + lanes); lane hit-testing for
  // cross-track drags reads its top edge.
  const laneAreaRef = useRef<HTMLDivElement | null>(null);

  // Track kinds a clip may move BETWEEN: video and overlay lanes both hold
  // video media; every other kind only moves within its own kind.
  const laneKindsFor = (kind: Track["kind"]): Track["kind"][] =>
    kind === "video" || kind === "overlay" ? ["video", "overlay"] : [kind];

  const laneIndexAt = useCallback((clientY: number): number | null => {
    const rect = laneAreaRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const y = clientY - rect.top - RULER_HEIGHT;
    if (y < 0) return null;
    return Math.floor(y / trackH);
  }, [trackH]);

  // E5: direct gain-envelope editing. Cmd/Ctrl+drag on an audio clip body
  // writes a gain keyframe under the pointer (top +6 dB, bottom -60 dB);
  // dragging an existing dot moves it; double-click on a dot removes it.
  const beginGainDrag = (
    e: React.PointerEvent,
    track: Track,
    clip: Clip,
    clipEl: HTMLElement,
    grabFrame: number | null,
  ) => {
    if (!project) return;
    e.stopPropagation();
    e.preventDefault();
    selectOnly(clip.id);
    const rect = clipEl.getBoundingClientRect();
    const dur = Math.max(1, clipEndFrame(clip) - clip.startFrame);
    const base = draftProject ?? project;
    const ktracks = clip.keyframes ?? [];
    const gainTrack = ktracks.find((t) => t.property === "gain");
    const origKfs = (gainTrack?.keyframes ?? []).filter((k) => k.frame !== grabFrame);
    const toFrame = (cx: number) => Math.max(0, Math.min(dur, Math.round((cx - rect.left) / pxPerFrame)));
    const toDb = (cy: number) => {
      const pct = Math.max(0.02, Math.min(0.98, (cy - rect.top) / Math.max(1, rect.height)));
      return Math.round((6 - pct * 66) * 10) / 10;
    };
    const grabbed = grabFrame != null ? gainTrack?.keyframes.find((k) => k.frame === grabFrame) : undefined;
    let curFrame = grabFrame ?? toFrame(e.clientX);
    let curDb = grabbed && typeof grabbed.value === "number" ? grabbed.value : toDb(e.clientY);
    const applyAt = (f: number, v: number): VideoProject => {
      const keyframes = [...origKfs.filter((k) => k.frame !== f), { frame: f, value: v }].sort(
        (a, b) => a.frame - b.frame,
      );
      const nextK = gainTrack
        ? ktracks.map((t) => (t.property === "gain" ? { ...t, keyframes } : t))
        : [...ktracks, { property: "gain", keyframes } as KeyframeTrack];
      return {
        ...base,
        tracks: base.tracks.map((t) =>
          t.id !== track.id
            ? t
            : { ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, keyframes: nextK } : c)) },
        ),
      };
    };
    const onEnvMove = (ev: PointerEvent) => {
      curFrame = toFrame(ev.clientX);
      curDb = toDb(ev.clientY);
      setDraftProject(applyAt(curFrame, curDb));
    };
    const onEnvUp = () => {
      window.removeEventListener("pointermove", onEnvMove);
      window.removeEventListener("pointerup", onEnvUp);
      persist(applyAt(curFrame, curDb));
      setDraftProject(null);
    };
    window.addEventListener("pointermove", onEnvMove);
    window.addEventListener("pointerup", onEnvUp);
    // Seed immediately so a plain click (no move) still writes the keyframe.
    setDraftProject(applyAt(curFrame, curDb));
  };

  const removeGainKeyframe = (track: Track, clip: Clip, frame: number) => {
    if (!project) return;
    const next = (clip.keyframes ?? [])
      .map((t) => (t.property === "gain" ? { ...t, keyframes: t.keyframes.filter((k) => k.frame !== frame) } : t))
      .filter((t) => t.keyframes.length > 0);
    persist({
      ...project,
      tracks: project.tracks.map((t) =>
        t.id !== track.id
          ? t
          : {
              ...t,
              clips: t.clips.map((c) => (c.id === clip.id ? { ...c, keyframes: next.length ? next : undefined } : c)),
            },
      ),
    });
  };

  const onClipPointerDown = useCallback(
    (
      e: React.PointerEvent,
      track: Track,
      clip: Clip,
      mode: "move" | "trim-in" | "trim-out" | "fade-in" | "fade-out" | "cut-dur" | "slip" | "stretch-in" | "stretch-out" = "move",
    ) => {
      e.stopPropagation();
      // Double-click opens a nested sequence. Handled here (via e.detail)
      // because the pointer capture below swallows the synthesized dblclick.
      if (e.detail >= 2 && clip.sequenceId && mode === "move") {
        openSequence(clip.sequenceId);
        return;
      }
      if (e.shiftKey && mode === "move") {
        toggleInSelection(clip.id);
        return; // shift-click only edits the selection, no drag
      }
      // Alt+drag on the body slips the source window; Cmd/Ctrl+drag on a trim
      // edge rate-stretches (retimes) instead of trimming.
      if (mode === "move" && e.altKey && clip.assetId && !clip.sequenceId) mode = "slip";
      if ((e.metaKey || e.ctrlKey) && mode === "trim-in") mode = "stretch-in";
      if ((e.metaKey || e.ctrlKey) && mode === "trim-out") mode = "stretch-out";
      if (multiIds.has(clip.id) && multiIds.size > 1) setSelectedClipId(clip.id);
      else if (mode === "move" && clip.groupId && project) {
        // Linked clips (video + detached audio) select and move as one unit.
        const group = new Set<string>();
        for (const t of project.tracks) for (const c of t.clips) if (c.groupId === clip.groupId) group.add(c.id);
        if (group.size > 1) {
          setMultiIds(group);
          setSelectedClipId(clip.id);
        } else selectOnly(clip.id);
      } else selectOnly(clip.id);
      // A locked track/clip is selectable but not draggable: select, then bail
      // out before arming the drag so no move gesture starts.
      if (track.locked || clip.locked || !project) return;
      try {
        (e.target as Element).setPointerCapture?.(e.pointerId);
      } catch {
        /* synthetic pointer without an active id: capture is best-effort */
      }
      // Fade/transition handles remember where the drag started from.
      let origFade = 0;
      if (mode === "fade-in") {
        origFade = track.kind === "audio" ? clip.fadeInFrames ?? 0 : clip.transitionIn?.durationFrames ?? 0;
      } else if (mode === "fade-out") {
        origFade = track.kind === "audio" ? clip.fadeOutFrames ?? 0 : clip.transitionOut?.durationFrames ?? 0;
      } else if (mode === "cut-dur") {
        const right = track.clips.find((c) => c.id !== clip.id && c.startFrame === clipEndFrame(clip));
        origFade = Math.max(clip.transitionOut?.durationFrames ?? 0, right?.transitionIn?.durationFrames ?? 0);
      }
      dragRef.current = {
        mode,
        clipId: clip.id,
        trackId: track.id,
        startClientX: e.clientX,
        origFade,
        orig: project,
      };
    },
    [project, multiIds, selectOnly, toggleInSelection, openSequence],
  );

  const onClipPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const orig = drag.orig;
      const srcTrack = orig.tracks.find((t) => t.id === drag.trackId);
      const clip = srcTrack?.clips.find((c) => c.id === drag.clipId);
      if (!srcTrack || !clip) return;
      const timelineDelta = (e.clientX - drag.startClientX) / pxPerFrame;

      // Edge auto-pan: dragging toward the viewport edge scrolls the lanes.
      const sc = scrollRef.current;
      if (sc) {
        const r = sc.getBoundingClientRect();
        if (e.clientX > r.right - 36) sc.scrollLeft += 14;
        else if (e.clientX < r.left + GUTTER_WIDTH + 36) sc.scrollLeft = Math.max(0, sc.scrollLeft - 14);
      }

      // Slip: shift the source window under a fixed clip position/duration.
      if (drag.mode === "slip") {
        const mag = Math.abs(clip.speed) || 1;
        const span = clip.outFrame - clip.inFrame;
        const maxSrc = maxSourceFramesFor(clip);
        let newIn = Math.round(clip.inFrame - timelineDelta * mag);
        newIn = Math.max(0, maxSrc !== undefined ? Math.min(newIn, maxSrc - span) : newIn);
        const patched = { ...clip, inFrame: newIn, outFrame: newIn + span };
        setDraftProject(
          replaceTrack(orig, { ...srcTrack, clips: srcTrack.clips.map((c) => (c.id === clip.id ? patched : c)) }),
        );
        setPlaying(false);
        setPlayhead(clip.startFrame); // preview the new first frame
        return;
      }

      // Rate-stretch: dragging an edge retimes the SAME source window.
      if (drag.mode === "stretch-in" || drag.mode === "stretch-out") {
        const span = clip.outFrame - clip.inFrame;
        const end0 = clipEndFrame(clip);
        let newStart = clip.startFrame;
        let newDur: number;
        if (drag.mode === "stretch-out") {
          newDur = Math.max(1, Math.round(end0 + timelineDelta) - clip.startFrame);
        } else {
          newStart = Math.max(0, Math.min(end0 - 1, Math.round(clip.startFrame + timelineDelta)));
          newDur = end0 - newStart;
        }
        const sign = clip.speed < 0 ? -1 : 1;
        const speed = sign * Math.min(100, Math.max(0.01, span / newDur));
        const patched = { ...clip, startFrame: newStart, speed };
        const nextTrack = { ...srcTrack, clips: srcTrack.clips.map((c) => (c.id === clip.id ? patched : c)) };
        if (nextTrack.clips.some((c) => c.id !== clip.id && clipsOverlap(c, patched))) return; // stick at neighbours
        setDraftProject(replaceTrack(orig, nextTrack));
        return;
      }

      // Fade handles: audio clips edit their fade envelope; video/text clips
      // edit the edge transition's length (created as a fade when absent,
      // removed when dragged back to zero).
      if (drag.mode === "fade-in" || drag.mode === "fade-out") {
        const dur = clipDurationFrames(clip);
        const sign = drag.mode === "fade-in" ? 1 : -1;
        const val = Math.max(0, Math.min(dur, Math.round(drag.origFade + sign * timelineDelta)));
        let patched: Clip;
        if (srcTrack.kind === "audio") {
          patched =
            drag.mode === "fade-in"
              ? { ...clip, fadeInFrames: val || undefined }
              : { ...clip, fadeOutFrames: val || undefined };
        } else if (drag.mode === "fade-in") {
          patched = {
            ...clip,
            transitionIn: val >= 1 ? { ...(clip.transitionIn ?? { type: "fade" }), durationFrames: val } : undefined,
          };
        } else {
          patched = {
            ...clip,
            transitionOut: val >= 1 ? { ...(clip.transitionOut ?? { type: "fade" }), durationFrames: val } : undefined,
          };
        }
        setDraftProject(
          replaceTrack(orig, { ...srcTrack, clips: srcTrack.clips.map((c) => (c.id === clip.id ? patched : c)) }),
        );
        return;
      }

      // Transition chip at a cut: one drag resizes BOTH edges of the cut.
      if (drag.mode === "cut-dur") {
        const cut = clipEndFrame(clip);
        const right = srcTrack.clips.find((c) => c.id !== clip.id && c.startFrame === cut);
        const maxDur = Math.min(clipDurationFrames(clip), right ? clipDurationFrames(right) : Number.MAX_SAFE_INTEGER);
        const val = Math.max(1, Math.min(maxDur, Math.round(drag.origFade + timelineDelta)));
        const clips = srcTrack.clips.map((c) => {
          if (c.id === clip.id && c.transitionOut) return { ...c, transitionOut: { ...c.transitionOut, durationFrames: val } };
          if (right && c.id === right.id && c.transitionIn) return { ...c, transitionIn: { ...c.transitionIn, durationFrames: val } };
          return c;
        });
        setDraftProject(replaceTrack(orig, { ...srcTrack, clips }));
        return;
      }

      if (drag.mode !== "move") {
        // Edge trim: the drag distance converts to SOURCE frames (the source
        // window scales by |speed|), applied by the pure trim() op. A step
        // that would overlap a neighbour is skipped, so the edge sticks at
        // the boundary instead of overlapping.
        const edge = drag.mode === "trim-in" ? "in" : "out";
        // The dragged EDGE snaps to clip boundaries/markers/playhead/grid.
        let tlDelta = timelineDelta;
        if (snapOn && !e.altKey) {
          const candidate = Math.round(
            (edge === "in" ? clip.startFrame : clipEndFrame(clip)) + timelineDelta,
          );
          const targets = snapTargets(orig, clip.id, frame);
          const tol = Math.max(1, Math.round(8 / pxPerFrame));
          const snapped = snapFrameToBeats(candidate, targets, tol);
          setSnapGuide(snapped !== candidate ? snapped : null);
          tlDelta += snapped - candidate;
        }
        const sourceDelta = Math.round(tlDelta * Math.abs(clip.speed));
        const nextTrack = trim(srcTrack, clip.id, edge, sourceDelta, {
          maxSourceFrames: maxSourceFramesFor(clip),
        });
        const trimmed = nextTrack.clips.find((c) => c.id === clip.id);
        if (!trimmed) return;
        const collides = nextTrack.clips.some((c) => c.id !== clip.id && clipsOverlap(c, trimmed));
        if (collides) return;
        setDraftProject(replaceTrack(orig, nextTrack));
        // Live trim preview: the stage scrubs to the edge being trimmed so the
        // exact in/out frame is visible while dragging.
        setPlaying(false);
        setPlayhead(edge === "in" ? trimmed.startFrame : Math.max(trimmed.startFrame, clipEndFrame(trimmed) - 1));
        return;
      }

      // Multi-selection move: every selected clip shifts by the same
      // (snapped) delta on its own track; cross-track moves stay single-clip.
      if (multiIds.size > 1 && multiIds.has(drag.clipId)) {
        const raw = Math.max(0, Math.round(clip.startFrame + timelineDelta));
        let target = raw;
        if (snapOn && !e.altKey) {
          // The whole moving selection is excluded from the targets, so
          // co-moving clips never snap against their own stale positions.
          const targets = snapTargets(orig, multiIds, frame);
          const tol = Math.max(1, Math.round(8 / pxPerFrame));
          target = snapFrameToBeats(raw, targets, tol);
        }
        setSnapGuide(target !== raw ? target : null);
        // Clamp the GROUP delta so the earliest member stops at frame 0 and
        // the selection's relative spacing never distorts.
        const minStart = Math.min(
          ...orig.tracks.flatMap((t) => t.clips.filter((c) => multiIds.has(c.id)).map((c) => c.startFrame)),
        );
        const delta = Math.max(target - clip.startFrame, -minStart);
        const tracks = orig.tracks.map((t) => ({
          ...t,
          clips: sortClips(
            t.clips.map((c) => (multiIds.has(c.id) && !t.locked ? { ...c, startFrame: c.startFrame + delta } : c)),
          ),
        }));
        setDraftProject(withDuration({ ...orig, tracks }));
        return;
      }

      // Move: horizontal target frame (snapped), plus the lane under the
      // pointer when it is a different, compatible, unlocked track.
      const raw = Math.max(0, Math.round(clip.startFrame + timelineDelta));
      let target = raw;
      if (snapOn && !e.altKey) {
        const targets = snapTargets(orig, drag.clipId, frame);
        const tol = Math.max(1, Math.round(8 / pxPerFrame)); // ~6px snap radius
        target = snapFrameToBeats(raw, targets, tol);
      }
      setSnapGuide(target !== raw ? target : null);
      let destTrack = srcTrack;
      const laneIdx = laneIndexAt(e.clientY);
      if (laneIdx !== null) {
        const cand = orig.tracks[laneIdx];
        if (cand && cand.id !== srcTrack.id && !cand.locked && laneKindsFor(srcTrack.kind).includes(cand.kind)) {
          destTrack = cand;
        }
      }
      if (destTrack.id === srcTrack.id) {
        setDraftProject(replaceTrack(orig, moveClip(srcTrack, drag.clipId, target)));
      } else {
        const moved: Clip = { ...clip, startFrame: target };
        const tracks = orig.tracks.map((t) =>
          t.id === srcTrack.id
            ? { ...t, clips: t.clips.filter((c) => c.id !== clip.id) }
            : t.id === destTrack.id
              ? { ...t, clips: sortClips([...t.clips, moved]) }
              : t,
        );
        setDraftProject(withDuration({ ...orig, tracks }));
      }
    },
    [pxPerFrame, frame, laneIndexAt, multiIds, maxSourceFramesFor, snapOn],
  );

  const onClipPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      try {
        (e.target as Element).releasePointerCapture?.(e.pointerId);
      } catch {
        /* synthetic pointer: nothing captured */
      }
      dragRef.current = null;
      setSnapGuide(null);
      if (!draftProject) {
        setDraftProject(null);
        return;
      }
      // Before committing a MOVE, ensure the dropped clip does not overlap a
      // neighbour on whichever track now holds it (cross-track included):
      // clamp its start to the nearest free gap. Trims already stick at
      // boundaries during the drag, so they commit as-is.
      let toCommit = draftProject;
      if (drag) {
        const movedIds = multiIds.size > 1 && multiIds.has(drag.clipId) ? [...multiIds] : [drag.clipId];
        for (const movedId of movedIds) {
          const track = toCommit.tracks.find((t) => t.clips.some((c) => c.id === movedId));
          const moved = track?.clips.find((c) => c.id === movedId);
          if (!track || !moved) continue;
          const collides = track.clips.some((c) => c.id !== moved.id && clipsOverlap(c, moved));
          if (collides) {
            const safeStart = freeStartFrame(track, clipDurationFrames(moved), moved.startFrame, moved.id);
            toCommit = replaceTrack(toCommit, moveClip(track, moved.id, safeStart));
          }
        }
      }
      // Commit once (single undo step), then drop the draft so we render from
      // the store again.
      persist(toCommit);
      setDraftProject(null);
    },
    [draftProject, persist, multiIds],
  );

  // Follow the playhead: while playing, page the view forward when the
  // playhead crosses the right edge (and back when it exits left); while
  // paused, stepping just keeps it visible. User drags/scrubs take priority.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    if (rulerScrubRef.current || dragRef.current || sideDragRef.current) return;
    const laneW = sc.clientWidth - GUTTER_WIDTH;
    if (laneW <= 0) return;
    const x = frame * pxPerFrame; // lane-content coords
    const viewL = sc.scrollLeft;
    const viewR = sc.scrollLeft + laneW;
    if (x > viewR - 8) {
      sc.scrollLeft = playing ? Math.max(0, x - laneW * 0.1) : Math.max(0, x - laneW + 40);
    } else if (x < viewL) {
      sc.scrollLeft = Math.max(0, x - (playing ? laneW * 0.1 : 40));
    }
  }, [frame, playing, pxPerFrame]);

  // -------------------------------------------------------------------------
  // ruler ticks: a tick per second, labelled with mm:ss.
  // -------------------------------------------------------------------------
  const rulerTicks = useMemo(() => {
    if (!project) return [] as { frame: number; label: string }[];
    const fps = project.fps;
    // Adaptive density: pick the smallest step that keeps labels ~56px apart,
    // and never emit ticks past the lane content (they would stretch the
    // scroll extent and break zoom-to-fit).
    const secPx = fps * pxPerFrame;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((s) => s * secPx >= 56) ?? 600;
    const out: { frame: number; label: string }[] = [];
    const lastFrame = durationFrames + fps * 2;
    for (let s = 0; s * fps <= lastFrame; s += step) {
      const f = s * fps;
      const mm = Math.floor(s / 60);
      const ss = s % 60;
      out.push({ frame: f, label: `${mm}:${ss.toString().padStart(2, "0")}` });
    }
    return out;
  }, [project, durationFrames, pxPerFrame]);

  if (!project) {
    return (
      <div className="grid flex-1 place-items-center bg-neutral-50 text-sm text-neutral-600">
        Preparing video project...
      </div>
    );
  }

  const fps = project.fps;
  const contentWidth = Math.max(640, (durationFrames + fps * 2) * pxPerFrame);
  const playheadX = frame * pxPerFrame;
  const anySolo = soloActive(project.tracks);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 bg-neutral-50 text-neutral-900">
      {/* ---------------------------------------------------------------- */}
      {/* MEDIA PANEL (left): workspace video/audio; drag onto a lane, or   */}
      {/* click to add at the playhead. Upload lands here too.              */}
      {/* ---------------------------------------------------------------- */}
      {mediaOpen ? (
      <aside
        className="relative flex shrink-0 flex-col border-r border-neutral-200 bg-neutral-100"
        style={{ width: mediaW }}
        onDragEnter={onPanelDragEnter}
        onDragOver={onPanelDragOver}
        onDragLeave={onPanelDragLeave}
        onDrop={onPanelDrop}
      >
        {dropActive && (
          <div className="pointer-events-none absolute inset-1 z-30 flex items-center justify-center rounded-lg border-2 border-dashed border-brand-500 bg-brand-500/10">
            <span className="rounded bg-surface px-2 py-1 text-[11px] font-medium text-brand-ink shadow">
              Drop to upload
            </span>
          </div>
        )}
        <div
          onPointerDown={onSideResizeDown("left")}
          onPointerMove={onSideResizeMove}
          onPointerUp={onSideResizeUp}
          title="Drag to resize the media panel; double-click to reset"
          className="absolute inset-y-0 -right-0.5 z-20 w-1.5 cursor-col-resize hover:bg-brand-600/60"
        />
        <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2">
          {/* The collapse control hugs the panel's OUTER edge, mirroring the
              inspector: it sits exactly where the reopen rail appears. */}
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              title="Collapse the media panel"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                railPressRef.current = performance.now();
                toggleMedia();
              }}
              onClick={() => {
                if (performance.now() - railPressRef.current < 500) return;
                toggleMedia();
              }}
              className="-ml-1.5 rounded p-1 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900"
            >
              <PanelLeftClose size={15} className="pointer-events-none" />
            </button>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-700">Media</span>
          </span>
          <input
            ref={uploadInputRef}
            type="file"
            accept="video/*,audio/*"
            multiple
            hidden
            onChange={(e) => void onUploadFiles(e.target.files)}
          />
        </div>
        {uploadPct !== null && (
          <div className="h-0.5 w-full bg-neutral-200">
            <div className="h-full bg-brand-600 transition-[width] duration-200" style={{ width: `${uploadPct}%` }} />
          </div>
        )}
        {panelError && (
          <div className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-[11px] leading-snug text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {panelError}
          </div>
        )}
        {/* search + sort + import-from-URL */}
        <div className="flex items-center gap-1 border-b border-neutral-200 px-2 py-1.5">
          <input
            type="search"
            value={mediaQuery}
            onChange={(e) => setMediaQuery(e.target.value)}
            placeholder="Search media…"
            title="Filter by filename or tag"
            onKeyDown={(e) => e.stopPropagation()}
            className="w-0 min-w-0 flex-1 rounded border border-neutral-300 bg-neutral-50 px-1.5 py-1 text-[11px] text-neutral-900 placeholder:text-neutral-400 focus:outline-none"
          />
          <select
            value={mediaSort}
            onChange={(e) => setMediaSort(e.target.value as typeof mediaSort)}
            title="Sort"
            className="rounded border border-neutral-300 bg-neutral-50 px-1 py-1 text-[10px] text-neutral-700"
          >
            <option value="new">Newest</option>
            <option value="name">Name</option>
            <option value="size">Size</option>
          </select>
          <button
            type="button"
            title="Import a video or audio file from a URL"
            disabled={!workspaceId || uploadPct !== null}
            onClick={() => {
              const url = window.prompt("Media URL (video or audio):");
              if (!url) return;
              void (async () => {
                try {
                  await oc.importAssetFromUrl(workspaceId!, url);
                  await loadAssets();
                } catch (err) {
                  showPanelError(err instanceof Error ? `Import failed: ${err.message}` : "Import failed");
                }
              })();
            }}
            className="rounded p-1 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900 disabled:opacity-40"
          >
            <LinkIcon size={12} className="pointer-events-none" />
          </button>
        </div>
        {/* record straight into the panel: voice, webcam, or this screen */}
        <div className="flex gap-1 border-b border-neutral-200 px-2 py-1.5">
          {(["audio", "video", "screen"] as const).map((m) => (
            <PanelRecorder
              key={m}
              mode={m}
              disabled={!workspaceId || uploadPct !== null}
              onCapture={(blob, filename) => {
                void onUploadFiles([new File([blob], filename, { type: blob.type })]);
              }}
            />
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {assets.length === 0 ? (
            <button
              type="button"
              disabled={!workspaceId || uploadPct !== null}
              onClick={() => uploadInputRef.current?.click()}
              className="mx-1 mt-1 flex w-[calc(100%-0.5rem)] flex-col items-center gap-2 rounded-lg border-2 border-dashed border-neutral-300 px-3 py-8 text-center text-[11px] text-neutral-500 hover:border-brand-500 hover:text-neutral-700 disabled:opacity-40"
            >
              <UploadIcon size={20} className="pointer-events-none" />
              <span className="pointer-events-none font-medium">
                {uploadPct !== null ? `Uploading… ${uploadPct}%` : "Drop video or audio here"}
              </span>
              <span className="pointer-events-none">or click to browse, or record below</span>
            </button>
          ) : (
            assets
              .filter((a) => {
                if (!mediaQuery.trim()) return true;
                const q = mediaQuery.trim().toLowerCase();
                return (a.filename ?? "").toLowerCase().includes(q) || a.tags.some((t) => t.toLowerCase().includes(q));
              })
              .sort((x, y) =>
                mediaSort === "name"
                  ? (x.filename ?? "").localeCompare(y.filename ?? "")
                  : mediaSort === "size"
                    ? (y.byteSize ?? 0) - (x.byteSize ?? 0)
                    : (y.createdAt ?? "").localeCompare(x.createdAt ?? ""),
              )
              .map((a) => (
              <div
                key={a.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-hc-asset", a.id);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => {
                  // Click adds at the playhead on the first unlocked lane of
                  // the matching kind.
                  const t = project.tracks.find((tr) =>
                    !tr.locked && (a.kind === "audio" ? tr.kind === "audio" : tr.kind === "video" || tr.kind === "overlay"));
                  if (t) void addAssetClip(t.id, a);
                }}
                title={`${a.filename ?? a.id} - drag onto a track, or click to add at the playhead`}
                className="group flex cursor-grab items-center gap-2 rounded-lg px-1.5 py-1.5 text-xs text-neutral-800 hover:bg-neutral-200 active:cursor-grabbing"
              >
                {/* thumbnail: filmstrip frame (video) or waveform (audio) */}
                <span
                  className="relative h-8 w-12 shrink-0 overflow-hidden rounded bg-black/80"
                  onPointerMove={(e) => {
                    if (a.kind !== "video" || !clipArt[a.id]) return;
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const tile = Math.max(0, Math.min(5, Math.floor(((e.clientX - r.left) / r.width) * 6)));
                    setHoverTile((c) => (c[a.id] === tile ? c : { ...c, [a.id]: tile }));
                  }}
                  onPointerLeave={() => setHoverTile((c) => ({ ...c, [a.id]: 0 }))}
                  style={
                    clipArt[a.id]
                      ? a.kind === "video"
                        ? {
                            backgroundImage: `url(${clipArt[a.id]})`,
                            // the filmstrip is 6 tiles wide; hover scrubs them
                            backgroundSize: "600% 100%",
                            backgroundPosition: `${(hoverTile[a.id] ?? 0) * 20}% 0`,
                          }
                        : { backgroundImage: `url(${clipArt[a.id]})`, backgroundSize: "cover", backgroundPosition: "center" }
                      : undefined
                  }
                >
                  {usedAssetIds.has(a.id) && (
                    <span
                      title="On the timeline"
                      className="absolute left-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-400 ring-1 ring-black/40"
                    />
                  )}
                  <span className="absolute inset-0 grid place-items-center">
                    {!clipArt[a.id] &&
                      (a.kind === "video" ? (
                        <Film size={13} className="text-white/40" />
                      ) : (
                        <Music2 size={13} className="text-emerald-400" />
                      ))}
                  </span>
                  {(assetSeconds[a.id] ?? 0) > 0 && (
                    <span className="absolute bottom-0 right-0 rounded-tl bg-black/70 px-0.5 font-mono text-[8px] tabular-nums text-white">
                      {Math.floor((assetSeconds[a.id] ?? 0) / 60)}:{String(Math.floor((assetSeconds[a.id] ?? 0) % 60)).padStart(2, "0")}
                    </span>
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{a.filename ?? a.id}</span>
                  {proxyPending.has(a.id) && (
                    <span className="flex items-center gap-1 text-[9px] text-amber-600 dark:text-amber-400">
                      <Loader2 size={9} className="animate-spin" /> optimizing preview…
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  title="Delete this upload from the workspace"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDeleteAsset(a);
                  }}
                  className="rounded p-1 text-neutral-400 opacity-0 hover:bg-neutral-300 hover:text-red-600 dark:hover:text-red-400 group-hover:opacity-100"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))
          )}
          {assets.length > 0 && (
            <button
              type="button"
              disabled={!workspaceId || uploadPct !== null}
              onClick={() => uploadInputRef.current?.click()}
              className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-neutral-300 px-2 py-2 text-[10px] text-neutral-500 hover:border-brand-500 hover:text-neutral-700 disabled:opacity-40"
            >
              <UploadIcon size={12} className="pointer-events-none" />
              <span className="pointer-events-none">
                {uploadPct !== null ? `Uploading… ${uploadPct}%` : "Drop files here or click to upload"}
              </span>
            </button>
          )}
        </div>
      </aside>
      ) : (
        <button
          type="button"
          title="Open the media panel"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            railPressRef.current = performance.now();
            toggleMedia();
          }}
          onClick={() => {
            if (performance.now() - railPressRef.current < 500) return; // already toggled on press
            toggleMedia(); // keyboard activation (Enter/Space) has no pointerdown
          }}
          className="flex w-9 shrink-0 cursor-pointer flex-col items-center gap-2 border-r border-neutral-200 bg-neutral-100 py-2 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900"
        >
          {/* children ignore the pointer so every click targets the button */}
          <PanelLeftOpen size={15} className="pointer-events-none" />
          <span className="pointer-events-none text-[9px] font-semibold uppercase tracking-wide [writing-mode:vertical-rl]">
            Media
          </span>
        </button>
      )}

      {/* stage + timeline column (everything except the right inspector) */}
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {/* sequence breadcrumb (visible while editing a nested sequence) */}
      {seqPath.length > 0 && (
        <div className="flex items-center gap-1 border-b border-neutral-200 bg-neutral-100 px-3 py-1.5 text-xs">
          <button
            type="button"
            onClick={() => { setSeqPath([]); selectOnly(null); setPlaying(false); setPlayhead(0); }}
            className="rounded px-1.5 py-0.5 text-neutral-700 hover:bg-neutral-200 hover:text-neutral-950"
          >
            Main timeline
          </button>
          {seqPath.map((id, i) => (
            <span key={id} className="flex items-center gap-1">
              <span className="text-neutral-400">/</span>
              {i === seqPath.length - 1 ? (
                <span className="rounded bg-neutral-200 px-1.5 py-0.5 font-medium text-neutral-950">
                  {sequenceNames?.[id] ?? "Sequence"}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => { setSeqPath(seqPath.slice(0, i + 1)); selectOnly(null); setPlaying(false); setPlayhead(0); }}
                  className="rounded px-1.5 py-0.5 text-neutral-700 hover:bg-neutral-200 hover:text-neutral-950"
                >
                  {sequenceNames?.[id] ?? "Sequence"}
                </button>
              )}
            </span>
          ))}
          <span className="ml-2 text-neutral-400">edits here render inside the parent&apos;s sequence clip</span>
        </div>
      )}
      {/* ---------------------------------------------------------------- */}
      {/* STAGE PREVIEW (top): the live compositor canvas.                  */}
      {/* ---------------------------------------------------------------- */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        <div className="flex h-full max-h-full w-full max-w-4xl flex-col items-center justify-center">
          <div
            ref={stageBoxRef}
            className={`relative w-full rounded-lg border border-neutral-200 bg-black shadow-inner ${
              stageActualSize ? "overflow-auto" : "flex items-center justify-center overflow-hidden"
            }`}
            style={
              stageActualSize
                ? { maxHeight: "100%" }
                : { aspectRatio: `${project.stage.width} / ${project.stage.height}`, maxHeight: "100%" }
            }
            data-stage-size={`${project.stage.width}x${project.stage.height}`}
          >
            <div
              className={stageActualSize ? "relative" : "relative h-full w-full"}
              style={stageActualSize ? { width: project.stage.width, height: project.stage.height } : undefined}
            >
            <canvas
              ref={stageCanvasRef}
              width={project.stage.width}
              height={project.stage.height}
              className="h-full w-full object-contain"
            />
            {/* manipulation overlay: outline + drag/scale for the selected clip
                (separate canvas so the export capture never sees it) */}
            <canvas
              ref={stageOverlayRef}
              width={project.stage.width}
              height={project.stage.height}
              onPointerDown={onStagePointerDown}
              onPointerMove={onStagePointerMove}
              onPointerUp={onStagePointerUp}
              onWheel={onStageWheel}
              title={stageTarget ? "Drag to reframe the selected clip; wheel to scale; click other clips or titles to select them" : "Click a clip or title to select it"}
              className={`absolute inset-0 h-full w-full object-contain ${stageTarget ? "cursor-move" : "cursor-pointer"}`}
            />
            </div>
            {/* stage tools: guides / 1:1 / snapshot / cover / fullscreen */}
            <div className="absolute right-1.5 top-1.5 z-10 flex gap-1 rounded bg-black/55 p-0.5">
              <button
                type="button"
                title={guidesOn ? "Hide safe-area guides" : "Show safe-area guides (thirds + title-safe)"}
                onClick={() => setGuidesOn((v) => !v)}
                className={`rounded p-1 ${guidesOn ? "bg-brand-600 text-white" : "text-white/75 hover:bg-white/20"}`}
              >
                <Crosshair size={13} className="pointer-events-none" />
              </button>
              <button
                type="button"
                title={stageActualSize ? "Fit the preview to the panel" : "View at 100% pixel size (scrolls)"}
                onClick={() => setStageActualSize((v) => !v)}
                className={`rounded p-1 ${stageActualSize ? "bg-brand-600 text-white" : "text-white/75 hover:bg-white/20"}`}
              >
                <Maximize2 size={13} className="pointer-events-none" />
              </button>
              <button
                type="button"
                title="Save the current frame as a PNG"
                onClick={() => {
                  stageCanvasRef.current?.toBlob((blob) => {
                    if (blob) downloadBlob(blob, `${(docTitle || "frame").replace(/[^\w.-]+/g, "_")}-${formatTimecode(frame, fps).replace(/:/g, ".")}.png`);
                  }, "image/png");
                }}
                className="rounded p-1 text-white/75 hover:bg-white/20"
              >
                <Camera size={13} className="pointer-events-none" />
              </button>
              <button
                type="button"
                title="Use the current frame as this video's cover (dashboard preview)"
                onClick={() => {
                  const stage = stageCanvasRef.current;
                  if (!stage) return;
                  const w = 640;
                  const h = Math.round((stage.height / stage.width) * w);
                  const c = document.createElement("canvas");
                  c.width = w;
                  c.height = h;
                  c.getContext("2d")?.drawImage(stage, 0, 0, w, h);
                  useEditor.getState().setDocMeta({ videoPoster: c.toDataURL("image/jpeg", 0.8) });
                  setExportMsg("Cover updated from the current frame");
                }}
                className="rounded p-1 text-white/75 hover:bg-white/20"
              >
                <ImageIcon size={13} className="pointer-events-none" />
              </button>
              <button
                type="button"
                title="Fullscreen preview (Esc exits)"
                onClick={() => {
                  if (document.fullscreenElement) void document.exitFullscreen();
                  else void stageBoxRef.current?.requestFullscreen();
                }}
                className="rounded p-1 text-white/75 hover:bg-white/20"
              >
                <Expand size={13} className="pointer-events-none" />
              </button>
            </div>
            {/* persistent size/fps readout: same-aspect size changes are
                otherwise invisible in the aspect-fitted preview */}
            <div className="pointer-events-none absolute bottom-1 right-2 rounded bg-black/55 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-white/85">
              {project.stage.width}x{project.stage.height} &middot; {fps}fps
            </div>
            {activeClips.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
                <div className="font-mono text-2xl tabular-nums tracking-wider text-neutral-600">
                  {formatTimecode(frame, fps)}
                </div>
                <div className="text-xs text-neutral-400">
                  {project.stage.width}x{project.stage.height} &middot; {fps} fps &middot; use + on a track to add media
                </div>
              </div>
            )}
          </div>

          {/* transport controls */}
          <div className="mt-3 flex items-center gap-1.5">
            <TransportButton
              title="Step back one frame"
              onClick={() => {
                setPlaying(false);
                setPlayhead((p) => Math.max(0, Math.round(p) - 1));
              }}
            >
              <ChevronLeft size={16} />
            </TransportButton>
            <TransportButton
              title={playing ? "Pause" : "Play"}
              onClick={togglePlay}
              accent
            >
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </TransportButton>
            <TransportButton
              title="Step forward one frame"
              onClick={() => {
                setPlaying(false);
                setPlayhead((p) => Math.min(durationFrames, Math.round(p) + 1));
              }}
            >
              <ChevronRight size={16} />
            </TransportButton>
            <TransportButton
              title="Rewind to start"
              onClick={() => {
                setPlaying(false);
                setPlayhead(0);
              }}
            >
              <SkipBack size={15} />
            </TransportButton>
            <TimecodeEntry
              frame={frame}
              fps={fps}
              durationFrames={durationFrames}
              onSeek={(f) => {
                setPlaying(false);
                setPlayhead(Math.max(0, Math.min(durationFrames, f)));
              }}
            />
            {project.range && (
              <TransportButton title="Play just the marked range (stops at the out point)" onClick={playRange}>
                <PlaySquare size={14} />
              </TransportButton>
            )}
            <TransportButton
              title={loop ? "Stop looping" : project.range ? "Loop the marked range" : "Loop playback"}
              accent={loop}
              onClick={() => setLoop((v) => !v)}
            >
              <Repeat size={14} />
            </TransportButton>
            <select
              value={playRate}
              onChange={(e) => setPlayRate(parseFloat(e.target.value))}
              title="Preview playback speed (exports always render at 1x)"
              className="h-8 rounded border border-neutral-300 bg-neutral-200 px-1 text-xs text-neutral-800"
            >
              {[0.25, 0.5, 1, 1.5, 2].map((r) => (
                <option key={r} value={r}>{r}x</option>
              ))}
              {(playRate < 0 || playRate === 4) && (
                <option value={playRate}>{playRate < 0 ? `◀ ${Math.abs(playRate)}x` : `${playRate}x`}</option>
              )}
            </select>
            <TransportButton
              title={previewMuted ? "Unmute the preview" : "Mute the preview (exports keep sound)"}
              onClick={() => setPreviewMuted((v) => !v)}
            >
              {previewMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </TransportButton>
            <LevelMeter getLevel={playerLevel} />
            {exportHistory.length > 0 && (
              <div className="relative">
                <TransportButton title="Export history (re-download finished renders)" onClick={() => setHistoryOpen((v) => !v)}>
                  <Download size={13} />
                </TransportButton>
                {historyOpen && (
                  <div className="absolute bottom-10 right-0 z-40 w-64 rounded-lg border border-neutral-300 bg-neutral-100 p-2 text-xs shadow-2xl">
                    <div className="mb-1 font-semibold text-neutral-800">Exports</div>
                    {exportHistory.map((h) => (
                      <div key={h.jobId} className="flex items-center gap-2 py-1">
                        <span className="w-16 shrink-0 font-mono uppercase text-neutral-700">{h.format}</span>
                        <span className={`flex-1 truncate text-[10px] ${h.status === "failed" || h.status === "expired" ? "text-red-600" : "text-neutral-500"}`}>
                          {new Date(h.at).toLocaleTimeString()} · {h.status}
                        </span>
                        {h.status === "completed" && props.designId && (
                          <button
                            type="button"
                            onClick={() => {
                              void (async () => {
                                const res = await fetch(oc.videoExportDownloadUrl(props.designId!, h.jobId), { credentials: "include" });
                                if (!res.ok) {
                                  markExport(h.jobId, "expired");
                                  return;
                                }
                                downloadBlob(await res.blob(), `${(docTitle || "video").replace(/[^\w.-]+/g, "_")}.${h.format.split(" ")[0]}`);
                              })();
                            }}
                            className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-800 hover:bg-neutral-300"
                          >
                            Download
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                if (exporting) void doExportVideo(true); // acting as Cancel
                else setExportDialog(true);
              }}
              disabled={serverExporting}
              title={exporting ? "Cancel the render" : "Choose a format and export the timeline"}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {exporting || serverExporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              {exporting
                ? `Rendering ${Math.min(100, Math.round((frame / Math.max(1, durationFrames)) * 100))}% (cancel)`
                : serverExporting
                  ? "Server render…"
                  : "Export"}
            </button>
          </div>
          {exportMsg && (
            <div className="mt-1.5 text-center text-[11px] text-neutral-600">{exportMsg}</div>
          )}
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* TOOLBAR + TIMELINE (collapsible to a slim strip, persisted).      */}
      {/* ---------------------------------------------------------------- */}
      {timelineOpen ? (
      <>
      <div className="flex flex-wrap items-center gap-2 border-t border-neutral-200 bg-neutral-100 px-3 py-2 text-xs">
        {/* clip actions (require a selection on an unlocked track) */}
        <div className="flex items-center gap-1">
          <ToolbarButton title="Split at playhead (S)" disabled={editDisabled} onClick={doSplit}>
            <Scissors size={13} /> Split
          </ToolbarButton>
          <ToolbarButton title="Ripple delete" disabled={editDisabled} onClick={doRippleDelete}>
            <Trash2 size={13} /> Ripple
          </ToolbarButton>
          <span className="flex items-center gap-0.5 rounded-md border border-neutral-200 py-0.5 pl-1.5 pr-0.5">
            <span className="pr-1 text-[9px] font-semibold uppercase tracking-wide text-neutral-400">Trim</span>
            <ToolbarButton title="Nudge the in point earlier (or drag the clip's left edge)" disabled={editDisabled} onClick={() => doTrim("in", -TRIM_STEP)}>
              In-
            </ToolbarButton>
            <ToolbarButton title="Nudge the in point later" disabled={editDisabled} onClick={() => doTrim("in", TRIM_STEP)}>
              In+
            </ToolbarButton>
            <ToolbarButton title="Nudge the out point earlier" disabled={editDisabled} onClick={() => doTrim("out", -TRIM_STEP)}>
              Out-
            </ToolbarButton>
            <ToolbarButton title="Nudge the out point later (or drag the clip's right edge)" disabled={editDisabled} onClick={() => doTrim("out", TRIM_STEP)}>
              Out+
            </ToolbarButton>
          </span>
          <ToolbarButton
            title="Collapse the selected clips into a nested sequence (double-click it to edit inside)"
            disabled={multiIds.size === 0}
            onClick={nestSelection}
          >
            <Layers size={13} /> Nest
          </ToolbarButton>
        </div>

        {/* speed */}
        <label className="flex items-center gap-1 text-neutral-600">
          Speed
          <input
            type="number"
            step={0.1}
            min={0.1}
            max={100}
            disabled={editDisabled}
            value={selected ? Number(selected.clip.speed.toFixed(2)) : 1}
            onChange={(e) => doSetSpeed(parseFloat(e.target.value))}
            className="w-16 rounded border border-neutral-300 bg-neutral-200 px-1.5 py-1 text-neutral-900 disabled:opacity-40"
          />
          x
        </label>

        {/* transition: an edge selector (in/out) plus a type select, so a
            transition can be attached to EITHER edge of the selected clip (V4). */}
        <label className="flex items-center gap-1 text-neutral-600">
          Transition
          <select
            disabled={editDisabled}
            value={transitionEdge}
            onChange={(e) => setTransitionEdge(e.target.value as "in" | "out")}
            title="Which edge the transition attaches to"
            className="rounded border border-neutral-300 bg-neutral-200 px-1.5 py-1 text-neutral-900 disabled:opacity-40"
          >
            <option value="in">In</option>
            <option value="out">Out</option>
          </select>
          <select
            disabled={editDisabled}
            value={
              (transitionEdge === "in"
                ? selected?.clip.transitionIn?.type
                : selected?.clip.transitionOut?.type) ?? ""
            }
            onChange={(e) => {
              if (e.target.value)
                doAddTransition(transitionEdge, e.target.value as ClipTransition["type"]);
            }}
            className="rounded border border-neutral-300 bg-neutral-200 px-1.5 py-1 text-neutral-900 disabled:opacity-40"
          >
            <option value="">none...</option>
            <option value="crossDissolve">Cross dissolve</option>
            <option value="fade">Fade</option>
            <option value="wipe">Wipe</option>
            <option value="slide">Slide</option>
            <option value="dipToColor">Dip to color</option>
          </select>
        </label>

        <div className="mx-1 h-5 w-px bg-neutral-300" />

        {/* add tracks */}
        <div className="flex items-center gap-1">
          <ToolbarButton title="Add video track" onClick={() => addTrack("video")}>
            <Film size={13} /> +Video
          </ToolbarButton>
          <ToolbarButton title="Add audio track" onClick={() => addTrack("audio")}>
            <Music2 size={13} /> +Audio
          </ToolbarButton>
          <ToolbarButton title="Add text track" onClick={() => addTrack("text")}>
            <TypeIcon size={13} /> +Text
          </ToolbarButton>
          <ToolbarButton title="Add overlay track (draws above video tracks)" onClick={() => addTrack("overlay")}>
            <Layers size={13} /> +Overlay
          </ToolbarButton>
        </div>

        <div className="mx-1 h-5 w-px bg-neutral-300" />

        {/* master ducking */}

        {/* captions editor toggle */}
        <button
          type="button"
          onClick={() => setCaptionsOpen((v) => !v)}
          title="Captions: edit cues, export SRT/VTT"
          className={`flex items-center gap-1 rounded px-2 py-1 ${
            captionsOpen ? "bg-brand-600 text-white" : "bg-neutral-200 text-neutral-700 hover:bg-neutral-300"
          }`}
        >
          CC{cues.length > 0 && <span className="text-[10px] opacity-80">{cues.length}</span>}
        </button>

        {project.range && (
          <button
            type="button"
            onClick={clearRange}
            title="Clear the export range (set with I and O at the playhead)"
            className="flex items-center gap-1 rounded bg-brand-600/30 px-2 py-1 text-brand-ink hover:bg-brand-600/50"
          >
            Range {formatTimecode(project.range.startFrame, fps)}-{formatTimecode(project.range.endFrame, fps)} ✕
          </button>
        )}

        {/* project settings (fps, stage size, background) live in the right
            panel when nothing is selected */}

        {/* zoom */}
        <div className="ml-auto flex items-center gap-1">
          <ToolbarButton
            title={snapOn ? "Snapping on (Alt bypasses); click to turn off" : "Snapping off; click to turn on"}
            onClick={toggleSnap}
            active={snapOn}
          >
            <Magnet size={13} />
          </ToolbarButton>
          <div className="mx-1 h-5 w-px bg-neutral-300" />
          <ToolbarButton
            title="Zoom out (anchored on the playhead); Ctrl+wheel zooms at the cursor"
            onClick={() => applyZoom(pxPerFrame / 1.4)}
          >
            <ZoomOut size={13} />
          </ToolbarButton>
          <span className="w-14 text-center font-mono text-[11px] tabular-nums text-neutral-600">
            {pxPerFrame.toFixed(2)} px/f
          </span>
          <ToolbarButton
            title="Zoom in (anchored on the playhead); Ctrl+wheel zooms at the cursor"
            onClick={() => applyZoom(pxPerFrame * 1.4)}
          >
            <ZoomIn size={13} />
          </ToolbarButton>
          <ToolbarButton title="Zoom to fit the whole timeline" onClick={zoomToFit}>
            <Maximize2 size={13} />
          </ToolbarButton>
          <ToolbarButton title={`Track height (${trackH === 40 ? "compact" : trackH === 56 ? "normal" : "tall"}); click to cycle`} onClick={cycleTrackHeight}>
            <Rows3 size={13} />
          </ToolbarButton>
          <div className="mx-1 h-5 w-px bg-neutral-300" />
          <ToolbarButton title="Hide the timeline (more room for the preview)" onClick={toggleTimeline}>
            <PanelBottomClose size={13} />
          </ToolbarButton>
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* CAPTIONS editor (toggled): cue list + SRT/VTT export. Cues render  */}
      {/* burned-in on the stage (and therefore in the export).             */}
      {/* ---------------------------------------------------------------- */}
      {captionsOpen && (
        <div className="max-h-44 overflow-y-auto border-t border-neutral-200 bg-neutral-100 px-3 py-2 text-xs">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-semibold uppercase tracking-wide text-neutral-600">Captions</span>
            <ToolbarButton title="Add a 2s cue at the playhead" onClick={addCueAtPlayhead}>
              <Plus size={12} /> Cue at playhead
            </ToolbarButton>
            <ToolbarButton title="Download SubRip subtitles" disabled={!cues.length} onClick={() => downloadCaptions("srt")}>
              <Download size={12} /> SRT
            </ToolbarButton>
            <ToolbarButton title="Download WebVTT subtitles" disabled={!cues.length} onClick={() => downloadCaptions("vtt")}>
              <Download size={12} /> VTT
            </ToolbarButton>
            <label className="flex items-center gap-1 text-neutral-500">
              <input
                type="checkbox"
                checked={captionStyle.burnIn !== false}
                onChange={(e) => patchCaptionStyle({ burnIn: e.target.checked })}
              />
              burn in
            </label>
            <label className="flex items-center gap-1 text-neutral-500">
              size
              <input
                type="number"
                min={2}
                max={15}
                value={Math.round((captionStyle.sizePct ?? 0.045) * 100)}
                onChange={(e) => patchCaptionStyle({ sizePct: Math.max(0.02, Math.min(0.15, (parseInt(e.target.value, 10) || 4.5) / 100)) })}
                className="w-12 rounded border border-neutral-300 bg-neutral-200 px-1 py-0.5 text-neutral-900"
              />
              %
            </label>
            <input
              type="color"
              title="Caption color"
              value={captionStyle.color ?? "#ffffff"}
              onChange={(e) => patchCaptionStyle({ color: e.target.value })}
              className="h-5 w-8 cursor-pointer rounded border border-neutral-300 bg-neutral-200"
            />
            <span className="text-neutral-400">SRT/VTT for players</span>
          </div>
          {cues.length === 0 ? (
            <div className="py-1 text-neutral-400">No cues yet. Move the playhead and add one.</div>
          ) : (
            cues.map((cue) => (
              <div key={cue.id} className="flex items-center gap-1.5 border-t border-neutral-200/60 py-1">
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={Number((cue.startFrame / fps).toFixed(2))}
                  onChange={(e) => {
                    const start = Math.max(0, Math.round(parseFloat(e.target.value || "0") * fps));
                    persistCues(cues.map((c) => (c.id === cue.id ? { ...c, startFrame: start, endFrame: Math.max(start + 1, c.endFrame) } : c)));
                  }}
                  title="Start (seconds)"
                  className="w-16 rounded border border-neutral-300 bg-neutral-200 px-1 py-0.5 text-neutral-900"
                />
                <span className="text-neutral-400">-</span>
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={Number((cue.endFrame / fps).toFixed(2))}
                  onChange={(e) => {
                    const end = Math.max(cue.startFrame + 1, Math.round(parseFloat(e.target.value || "0") * fps));
                    persistCues(cues.map((c) => (c.id === cue.id ? { ...c, endFrame: end } : c)));
                  }}
                  title="End (seconds)"
                  className="w-16 rounded border border-neutral-300 bg-neutral-200 px-1 py-0.5 text-neutral-900"
                />
                <input
                  value={cue.text}
                  onChange={(e) => persistCues(cues.map((c) => (c.id === cue.id ? { ...c, text: e.target.value } : c)))}
                  className="min-w-0 flex-1 rounded border border-neutral-300 bg-neutral-200 px-1.5 py-0.5 text-neutral-900"
                />
                <button
                  type="button"
                  title="Jump to cue"
                  onClick={() => { setPlaying(false); setPlayhead(cue.startFrame); }}
                  className="rounded p-1 text-neutral-500 hover:bg-neutral-300 hover:text-neutral-900"
                >
                  <SkipBack size={12} />
                </button>
                <button
                  type="button"
                  title="Delete cue"
                  onClick={() => persistCues(cues.filter((c) => c.id !== cue.id))}
                  className="rounded p-1 text-neutral-500 hover:bg-neutral-300 hover:text-red-600 dark:hover:text-red-400"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* TIMELINE (bottom): gutter + scrollable lanes with ruler/playhead. */}
      {/* ---------------------------------------------------------------- */}
      <div
        className="flex shrink-0 border-t border-neutral-200 bg-neutral-100"
        style={{ height: Math.min(RULER_HEIGHT + project.tracks.length * trackH + 12, RULER_HEIGHT + Math.round(trackH * 4.5) + 12) }}
      >
      {/* ONE scroller for both axes: the gutter sticks through horizontal
          scrolling and the ruler through vertical, so any number of tracks
          stays reachable with everything aligned. */}
      <div ref={scrollRef} className="relative flex flex-1 overflow-auto">
        {/* left gutter: track headers */}
        <div className="sticky left-0 z-40 shrink-0 border-r border-neutral-200 bg-neutral-100" style={{ width: GUTTER_WIDTH }}>
          <div
            className="sticky top-0 z-10 flex items-center bg-neutral-100 px-3 text-[10px] uppercase tracking-wide text-neutral-500"
            style={{ height: RULER_HEIGHT }}
          >
            Tracks
          </div>
          {project.tracks.map((track) => {
            const Icon = KIND_ICON[track.kind];
            const isAudio = track.kind === "audio" || track.kind === "video";
            return (
              <div
                key={track.id}
                className="flex flex-col justify-center gap-1 border-t border-neutral-200/60 px-3"
                style={{ height: trackH }}
              >
                <div className="flex items-center gap-1.5">
                  <Icon className="text-neutral-600" size={13} />
                  <input
                    type="text"
                    key={`name-${track.id}-${track.name ?? ""}`}
                    defaultValue={track.name ?? ""}
                    placeholder={track.kind}
                    title="Rename track"
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== (track.name ?? "")) patchTrack(track.id, { name: v || undefined });
                    }}
                    className="w-0 min-w-0 flex-1 truncate rounded border border-transparent bg-transparent px-0.5 text-xs text-neutral-800 hover:border-neutral-300 focus:border-neutral-400 focus:bg-neutral-50 focus:outline-none"
                  />
                  <button
                    type="button"
                    title="Move track up"
                    disabled={project.tracks[0]?.id === track.id}
                    onClick={() => moveTrack(track.id, -1)}
                    className="ml-auto rounded p-0.5 text-neutral-500 hover:bg-neutral-300 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ChevronUp size={11} />
                  </button>
                  <button
                    type="button"
                    title="Move track down (later tracks draw on top)"
                    disabled={project.tracks[project.tracks.length - 1]?.id === track.id}
                    onClick={() => moveTrack(track.id, 1)}
                    className="rounded p-0.5 text-neutral-500 hover:bg-neutral-300 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ChevronDown size={11} />
                  </button>
                  <button
                    type="button"
                    title="Duplicate track (clips included)"
                    onClick={() => duplicateTrack(track.id)}
                    className="rounded p-0.5 text-neutral-500 hover:bg-neutral-300 hover:text-neutral-900"
                  >
                    <CopyIcon size={11} />
                  </button>
                  {/* lock / hide toggles on EVERY track header. Each is a single
                      undoable patch through the normal persist path. */}
                  <button
                    type="button"
                    title={track.locked ? "Unlock track" : "Lock track (block edits)"}
                    onClick={() => patchTrack(track.id, { locked: !track.locked })}
                    className={`rounded p-0.5 ${
                      track.locked
                        ? "bg-amber-500 text-black"
                        : "text-neutral-500 hover:bg-neutral-300 hover:text-neutral-900"
                    }`}
                  >
                    {track.locked ? <Lock size={12} /> : <Unlock size={12} />}
                  </button>
                  {track.kind !== "audio" && (
                    <button
                      type="button"
                      title={track.hidden ? "Show track" : "Hide track"}
                      onClick={() => patchTrack(track.id, { hidden: !track.hidden })}
                      className={`rounded p-0.5 ${
                        track.hidden
                          ? "bg-neutral-400 text-white"
                          : "text-neutral-500 hover:bg-neutral-300 hover:text-neutral-900"
                      }`}
                    >
                      {track.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                  )}
                  <button
                    type="button"
                    title="Add clip at playhead"
                    disabled={track.locked}
                    onClick={() => addClip(track.id)}
                    className="rounded p-0.5 text-neutral-500 hover:bg-neutral-300 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Plus size={13} />
                  </button>
                  <button
                    type="button"
                    title={track.clips.length ? `Delete track (${track.clips.length} clips)` : "Delete track"}
                    disabled={track.locked}
                    onClick={() => (track.clips.length ? setConfirmDeleteTrack(track) : removeTrack(track.id))}
                    className="rounded p-0.5 text-neutral-500 hover:bg-neutral-300 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-red-400"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
                {isAudio && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      title={track.muted ? "Unmute" : "Mute"}
                      onClick={() => patchTrack(track.id, { muted: !track.muted })}
                      className={`rounded p-0.5 ${
                        track.muted ? "bg-red-600 text-white" : "text-neutral-500 hover:bg-neutral-300"
                      }`}
                    >
                      {track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                    </button>
                    <button
                      type="button"
                      title="Solo"
                      onClick={() => patchTrack(track.id, { solo: !track.solo })}
                      className={`rounded px-1 py-0.5 text-[10px] font-bold ${
                        track.solo ? "bg-amber-500 text-black" : "text-neutral-500 hover:bg-neutral-300"
                      }`}
                    >
                      S
                    </button>
                    <input
                      type="range"
                      min={-60}
                      max={6}
                      step={1}
                      value={track.gainDb ?? 0}
                      title={`Gain ${track.gainDb ?? 0} dB`}
                      // Drag the slider (or arrow-key it) against the local draft
                      // (visible live, not persisted per tick), then commit ONCE on
                      // release so the whole gesture is a single undo step. We do
                      // NOT commit on every keystroke (no onKeyUp): arrow-key runs
                      // coalesce into one undo step, committed on blur / pointer-up.
                      onChange={(e) => draftPatchTrack(track.id, { gainDb: parseInt(e.target.value, 10) })}
                      onMouseUp={commitDraft}
                      onBlur={commitDraft}
                      className="h-1 w-16 accent-emerald-500"
                    />
                    <span className="w-9 text-right font-mono text-[10px] tabular-nums text-neutral-500">
                      {(track.gainDb ?? 0) > 0 ? "+" : ""}
                      {track.gainDb ?? 0}
                    </span>
                    <input
                      type="range"
                      min={-1}
                      max={1}
                      step={0.1}
                      value={track.pan ?? 0}
                      title={`Pan ${(track.pan ?? 0) === 0 ? "center" : (track.pan ?? 0) < 0 ? "left" : "right"} (${track.pan ?? 0}); double-click to center`}
                      onChange={(e) => draftPatchTrack(track.id, { pan: parseFloat(e.target.value) || undefined })}
                      onMouseUp={commitDraft}
                      onBlur={commitDraft}
                      onDoubleClick={() => patchTrack(track.id, { pan: undefined })}
                      className="h-1 w-10 accent-violet-500"
                    />
                    <TrackMeter player={getPlayer} trackId={track.id} />
                    {/* effective audibility readout via @hc/audio */}
                    <span
                      className="ml-0.5 h-1.5 w-1.5 rounded-full"
                      title={anySolo && !track.solo ? "silenced by solo" : track.muted ? "muted" : "audible"}
                      style={{
                        backgroundColor:
                          track.muted || (anySolo && !track.solo) ? "#52525b" : "#10b981",
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* scrollable lane area */}
          <div ref={laneAreaRef} className="relative shrink-0" style={{ width: contentWidth }}>
            {/* ruler: press to scrub, keep dragging to keep scrubbing. The
                ruler spans the scrolled content, so clientX - rect.left IS the
                content x (no scrollLeft term: rect.left moves with scroll). */}
            <div
              className="sticky top-0 z-20 cursor-ew-resize border-b border-neutral-200 bg-neutral-100"
              style={{ height: RULER_HEIGHT }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                const el = e.currentTarget as HTMLElement;
                try {
                  el.setPointerCapture?.(e.pointerId);
                } catch {
                  /* synthetic pointer: capture is best-effort */
                }
                rulerScrubRef.current = true;
                const rect = el.getBoundingClientRect();
                setPlaying(false);
                setPlayhead(Math.max(0, Math.min(durationFrames, Math.round((e.clientX - rect.left) / pxPerFrame))));
              }}
              onPointerMove={(e) => {
                if (!rulerScrubRef.current) return;
                const sc = scrollRef.current;
                if (sc) {
                  const r = sc.getBoundingClientRect();
                  if (e.clientX > r.right - 36) sc.scrollLeft += 14;
                  else if (e.clientX < r.left + GUTTER_WIDTH + 36) sc.scrollLeft = Math.max(0, sc.scrollLeft - 14);
                }
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setPlayhead(Math.max(0, Math.min(durationFrames, Math.round((e.clientX - rect.left) / pxPerFrame))));
              }}
              onPointerUp={(e) => {
                rulerScrubRef.current = false;
                try {
                  (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
                } catch {
                  /* nothing captured */
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const atFrame = Math.max(0, Math.min(durationFrames, Math.round((e.clientX - rect.left) / pxPerFrame)));
                setCtxMenu({ x: e.clientX, y: e.clientY, trackId: "", atFrame, ruler: true });
              }}
            >
              {rulerTicks.map((t) => (
                <div
                  key={t.frame}
                  className="absolute top-0 flex h-full select-none items-end pb-0.5"
                  style={{ left: t.frame * pxPerFrame }}
                >
                  <div className="h-2 w-px bg-neutral-300" />
                  <span className="ml-1 font-mono text-[9px] tabular-nums text-neutral-500">{t.label}</span>
                </div>
              ))}
              {/* export/preview range band (I / O to set, button in toolbar to clear) */}
              {project.range && (
                <div
                  title={`Export range ${formatTimecode(project.range.startFrame, fps)} - ${formatTimecode(project.range.endFrame, fps)}`}
                  className="pointer-events-none absolute inset-y-0 bg-brand-500/25"
                  style={{
                    left: project.range.startFrame * pxPerFrame,
                    width: Math.max(2, (project.range.endFrame - project.range.startFrame) * pxPerFrame),
                  }}
                />
              )}
              {project.range &&
                (["start", "end"] as const).map((edge) => (
                  <div
                    key={edge}
                    title={`Drag to move the range ${edge}`}
                    className="absolute inset-y-0 z-10 w-1.5 -translate-x-1/2 cursor-ew-resize bg-brand-500/70 hover:bg-brand-500"
                    style={{
                      left: (edge === "start" ? (project.range?.startFrame ?? 0) : (project.range?.endFrame ?? 0)) * pxPerFrame,
                    }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      const rulerEl = (e.currentTarget as HTMLElement).parentElement;
                      const r0 = project.range;
                      if (!rulerEl || !r0 || !project) return;
                      let last: { startFrame: number; endFrame: number } | null = null;
                      const onMove = (ev: PointerEvent) => {
                        const rect = rulerEl.getBoundingClientRect();
                        const f = Math.max(0, Math.min(durationFrames, Math.round((ev.clientX - rect.left) / pxPerFrame)));
                        last =
                          edge === "start"
                            ? { startFrame: Math.min(f, r0.endFrame - 1), endFrame: r0.endFrame }
                            : { startFrame: r0.startFrame, endFrame: Math.max(f, r0.startFrame + 1) };
                        setDraftProject({ ...project, range: last });
                      };
                      const onUp = () => {
                        window.removeEventListener("pointermove", onMove);
                        window.removeEventListener("pointerup", onUp);
                        if (last) {
                          persist({ ...project, range: last });
                          setDraftProject(null);
                        }
                      };
                      window.addEventListener("pointermove", onMove);
                      window.addEventListener("pointerup", onUp);
                    }}
                  />
                ))}
              {/* markers (M at the playhead toggles) */}
              {(project.markers ?? []).map((m) => (
                <div
                  key={m}
                  title={`Marker ${formatTimecode(m, fps)}. Drag to move, click to jump.`}
                  className="absolute top-0 h-2.5 w-2.5 -translate-x-1/2 rotate-45 cursor-grab bg-amber-400 hover:scale-125"
                  style={{ left: m * pxPerFrame }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const rulerEl = (e.currentTarget as HTMLElement).parentElement;
                    if (!rulerEl || !project) return;
                    const others = (project.markers ?? []).filter((x) => x !== m);
                    let moved = false;
                    let cur = m;
                    const onMove = (ev: PointerEvent) => {
                      const rect = rulerEl.getBoundingClientRect();
                      const f = Math.max(0, Math.min(durationFrames, Math.round((ev.clientX - rect.left) / pxPerFrame)));
                      moved = moved || Math.abs(f - m) > 1;
                      if (moved) {
                        cur = f;
                        setDraftProject({ ...project, markers: [...others, f].sort((a, b) => a - b) });
                      }
                    };
                    const onUp = () => {
                      window.removeEventListener("pointermove", onMove);
                      window.removeEventListener("pointerup", onUp);
                      if (moved) {
                        persist({ ...project, markers: [...others, cur].sort((a, b) => a - b) });
                        setDraftProject(null);
                      } else {
                        setPlaying(false);
                        setPlayhead(m);
                      }
                    };
                    window.addEventListener("pointermove", onMove);
                    window.addEventListener("pointerup", onUp);
                  }}
                />
              ))}
            </div>

            {/* track lanes */}
            {project.tracks.map((track) => (
              <div
                key={track.id}
                className="relative border-t border-neutral-200/60"
                style={{ height: trackH, backgroundColor: "rgba(255,255,255,0.015)" }}
                onPointerDown={(e) => {
                  // Empty lane space: clear the selection and start a marquee
                  // (clips stop propagation, so only true empty space lands here).
                  onLanePointerDown(e);
                }}
                onPointerMove={(e) => {
                  onLanePointerMove(e);
                  onClipPointerMove(e);
                }}
                onPointerUp={(e) => {
                  onLanePointerUp(e);
                  onClipPointerUp(e);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setCtxMenu({
                    x: e.clientX,
                    y: e.clientY,
                    trackId: track.id,
                    atFrame: Math.max(0, Math.round((e.clientX - rect.left) / pxPerFrame)),
                  });
                }}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes("application/x-hc-asset")) e.preventDefault();
                }}
                onDrop={(e) => {
                  const assetId = e.dataTransfer.getData("application/x-hc-asset");
                  const asset = assetId ? assetsRef.current.get(assetId) : undefined;
                  if (!asset || track.locked) return;
                  // Typed lanes: video assets land on video/overlay, audio on audio.
                  const ok = asset.kind === "audio" ? track.kind === "audio" : track.kind === "video" || track.kind === "overlay";
                  if (!ok) return;
                  e.preventDefault();
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const dropFrame = Math.max(0, Math.round((e.clientX - rect.left) / pxPerFrame));
                  void addAssetClip(track.id, asset, dropFrame);
                }}
              >
                {track.clips.map((clip) => {
                  const left = clip.startFrame * pxPerFrame;
                  const width = Math.max(4, (clipEndFrame(clip) - clip.startFrame) * pxPerFrame);
                  const isPrimary = clip.id === selectedClipId;
                  const isSel = isPrimary || multiIds.has(clip.id);
                  const asset = clip.assetId ? assetMap.get(clip.assetId) : undefined;
                  const label =
                    clip.name ??
                    (clip.sequenceId
                      ? `⧉ ${sequenceNames?.[clip.sequenceId] ?? "Sequence"}`
                      : asset?.filename ?? clip.title?.text ?? clip.nodeId ?? clip.id);
                  const art = clip.assetId ? clipArt[clip.assetId] : undefined;
                  const vidWave = clip.assetId ? waveArt[clip.assetId] : undefined;
                  const gainKfs = clip.keyframes?.find((t) => t.property === "gain")?.keyframes;
                  // Align the art with the clip's source window: the strip
                  // image covers the full asset, so scale it to assetFrames
                  // and shift it left by the in-point.
                  const assetSecs = clip.assetId ? assetSeconds[clip.assetId] : undefined;
                  const srcSpan = Math.max(1, clip.outFrame - clip.inFrame);
                  const artLayers: { img: string; size: string; pos: string; repeat: string }[] = [];
                  if (art) {
                    if (assetSecs && assetSecs > 0) {
                      const assetFrames = Math.max(srcSpan, Math.round(assetSecs * fps));
                      const fullW = (width * assetFrames) / srcSpan;
                      const offX = (-fullW * clip.inFrame) / assetFrames;
                      artLayers.push({ img: art, size: `${fullW}px 100%`, pos: `${offX}px 0`, repeat: "no-repeat" });
                    } else {
                      artLayers.push({ img: art, size: "auto 100%", pos: "0 0", repeat: "repeat-x" });
                    }
                  }
                  if (vidWave && track.kind !== "audio" && assetSecs && assetSecs > 0) {
                    const assetFrames = Math.max(srcSpan, Math.round(assetSecs * fps));
                    const fullW = (width * assetFrames) / srcSpan;
                    const offX = (-fullW * clip.inFrame) / assetFrames;
                    // audio strip along the bottom third of the video clip
                    artLayers.unshift({ img: vidWave, size: `${fullW}px 34%`, pos: `${offX}px 100%`, repeat: "no-repeat" });
                  }
                  return (
                    <div
                      key={clip.id}
                      onPointerDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && track.kind === "audio" && !track.locked && !clip.locked) {
                          beginGainDrag(e, track, clip, e.currentTarget as HTMLElement, null);
                          return;
                        }
                        onClipPointerDown(e, track, clip);
                      }}
                      onDoubleClick={() => clip.sequenceId && openSequence(clip.sequenceId)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!multiIds.has(clip.id)) selectOnly(clip.id);
                        setCtxMenu({ x: e.clientX, y: e.clientY, trackId: track.id, clipId: clip.id, atFrame: clip.startFrame });
                      }}
                      title={`${label} | ${clip.startFrame}-${clipEndFrame(clip)}f${
                        clip.speed !== 1 ? ` | ${clip.speed}x` : ""
                      }`}
                      className={`absolute top-1 touch-none select-none overflow-hidden rounded text-[10px] text-white/95 ${
                        track.locked
                          ? "cursor-default"
                          : "cursor-grab active:cursor-grabbing"
                      } ${isPrimary ? "ring-2 ring-neutral-950" : isSel ? "ring-2 ring-neutral-950/50" : "ring-1 ring-black/30"}`}
                      style={{
                        left,
                        width,
                        height: trackH - 8,
                        backgroundColor: clip.colorLabel ?? (clip.sequenceId ? "#7c3aed" : KIND_COLOR[track.kind]),
                        // Filmstrip (video) / waveform (audio) chrome behind the label.
                        backgroundImage: artLayers.length ? artLayers.map((l) => `url(${l.img})`).join(", ") : undefined,
                        backgroundSize: artLayers.map((l) => l.size).join(", ") || undefined,
                        backgroundPosition: artLayers.map((l) => l.pos).join(", ") || undefined,
                        backgroundRepeat: artLayers.map((l) => l.repeat).join(", ") || undefined,
                        opacity: track.hidden || clip.disabled ? 0.4 : 1,
                      }}
                    >
                      <div className="flex items-center gap-1 truncate bg-black/35 px-1.5 py-0.5 font-medium">
                        {clip.locked && <Lock size={9} className="shrink-0" />}
                        <span className="truncate">{label}</span>
                        {clip.disabled && <span className="shrink-0 rounded bg-black/50 px-1 text-[8px] uppercase">off</span>}
                      </div>
                      {/* volume envelope (gain keyframes), drawn over the waveform */}
                      {gainKfs && gainKfs.length > 0 && (
                        <svg
                          className="pointer-events-none absolute inset-0 h-full w-full"
                          viewBox="0 0 100 100"
                          preserveAspectRatio="none"
                        >
                          <polyline
                            fill="none"
                            stroke="#fbbf24"
                            strokeWidth="2"
                            vectorEffect="non-scaling-stroke"
                            points={(() => {
                              const dur = Math.max(1, clipEndFrame(clip) - clip.startFrame);
                              const pts = [...gainKfs]
                                .filter((k) => typeof k.value === "number")
                                .sort((a, b) => a.frame - b.frame)
                                .map((k) => ({
                                  x: Math.max(0, Math.min(100, (k.frame / dur) * 100)),
                                  y: Math.max(2, Math.min(98, ((6 - (k.value as number)) / 66) * 100)),
                                }));
                              if (!pts.length) return "";
                              return [
                                `0,${pts[0].y}`,
                                ...pts.map((pt) => `${pt.x},${pt.y}`),
                                `100,${pts[pts.length - 1].y}`,
                              ].join(" ");
                            })()}
                          />
                        </svg>
                      )}
                      {/* draggable gain-keyframe dots (audio clips) */}
                      {track.kind === "audio" && !track.locked && !clip.locked && gainKfs &&
                        gainKfs
                          .filter((k) => typeof k.value === "number")
                          .map((k) => {
                            const dur = Math.max(1, clipEndFrame(clip) - clip.startFrame);
                            const xPct = Math.max(0, Math.min(100, (k.frame / dur) * 100));
                            const yPct = Math.max(4, Math.min(96, ((6 - (k.value as number)) / 66) * 100));
                            return (
                              <div
                                key={`kf-${k.frame}`}
                                title={`${k.value} dB at ${k.frame}f. Drag to edit, double-click to remove.`}
                                className="absolute z-10 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border border-black/50 bg-amber-300 hover:scale-125"
                                style={{ left: `${xPct}%`, top: `${yPct}%` }}
                                onPointerDown={(e) => {
                                  if (e.detail >= 2) {
                                    e.stopPropagation();
                                    removeGainKeyframe(track, clip, k.frame);
                                    return;
                                  }
                                  beginGainDrag(
                                    e,
                                    track,
                                    clip,
                                    (e.currentTarget as HTMLElement).parentElement as HTMLElement,
                                    k.frame,
                                  );
                                }}
                              />
                            );
                          })}
                      {clip.speed !== 1 && (
                        <div className="px-1.5 text-[9px] opacity-80">{clip.speed}x</div>
                      )}
                      {/* transition marker on the in edge */}
                      {clip.transitionIn && (
                        <div
                          className="absolute bottom-0 left-0 top-0 bg-white/25"
                          style={{ width: Math.max(2, clip.transitionIn.durationFrames * pxPerFrame) }}
                          title={`${clip.transitionIn.type} ${clip.transitionIn.durationFrames}f`}
                        />
                      )}
                      {/* transition marker on the out edge */}
                      {clip.transitionOut && (
                        <div
                          className="absolute bottom-0 right-0 top-0 bg-white/25"
                          style={{ width: Math.max(2, clip.transitionOut.durationFrames * pxPerFrame) }}
                          title={`${clip.transitionOut.type} ${clip.transitionOut.durationFrames}f`}
                        />
                      )}
                      {/* fade ramps on audio clips (the envelope actually applied) */}
                      {track.kind === "audio" && ((clip.fadeInFrames ?? 0) > 0 || (clip.fadeOutFrames ?? 0) > 0) && (
                        <svg
                          className="pointer-events-none absolute inset-0 h-full w-full"
                          viewBox="0 0 100 100"
                          preserveAspectRatio="none"
                        >
                          {(clip.fadeInFrames ?? 0) > 0 && (
                            <polygon
                              points={`0,100 ${Math.min(100, ((clip.fadeInFrames ?? 0) / clipDurationFrames(clip)) * 100)},0 0,0`}
                              fill="rgba(255,255,255,0.18)"
                            />
                          )}
                          {(clip.fadeOutFrames ?? 0) > 0 && (
                            <polygon
                              points={`100,100 ${Math.max(0, 100 - ((clip.fadeOutFrames ?? 0) / clipDurationFrames(clip)) * 100)},0 100,0`}
                              fill="rgba(255,255,255,0.18)"
                            />
                          )}
                        </svg>
                      )}
                      {/* edge trim handles: drag to trim in/out */}
                      {!track.locked && !clip.locked && (
                        <>
                          <div
                            onPointerDown={(e) => onClipPointerDown(e, track, clip, "trim-in")}
                            title="Drag to trim the in point (Cmd/Ctrl-drag retimes)"
                            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize hover:bg-white/50"
                          />
                          <div
                            onPointerDown={(e) => onClipPointerDown(e, track, clip, "trim-out")}
                            title="Drag to trim the out point (Cmd/Ctrl-drag retimes)"
                            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize hover:bg-white/50"
                          />
                        </>
                      )}
                      {/* fade handles on the top corners: drag to shape the
                          fade (audio) or the edge transition (video/text) */}
                      {!track.locked && !clip.locked && width > 36 && track.kind !== "effects" && (
                        <>
                          <div
                            onPointerDown={(e) => onClipPointerDown(e, track, clip, "fade-in")}
                            title={track.kind === "audio" ? "Drag to set the fade-in" : "Drag to set the in transition"}
                            className="absolute top-0 z-10 h-2.5 w-2.5 -translate-x-1/2 cursor-ew-resize rounded-full border border-neutral-950/80 bg-neutral-100/90 hover:scale-125 hover:bg-neutral-950"
                            style={{
                              left: Math.min(
                                (track.kind === "audio" ? clip.fadeInFrames ?? 0 : clip.transitionIn?.durationFrames ?? 0) * pxPerFrame + 2,
                                width - 10,
                              ),
                            }}
                          />
                          <div
                            onPointerDown={(e) => onClipPointerDown(e, track, clip, "fade-out")}
                            title={track.kind === "audio" ? "Drag to set the fade-out" : "Drag to set the out transition"}
                            className="absolute top-0 z-10 h-2.5 w-2.5 translate-x-1/2 cursor-ew-resize rounded-full border border-neutral-950/80 bg-neutral-100/90 hover:scale-125 hover:bg-neutral-950"
                            style={{
                              right: Math.min(
                                (track.kind === "audio" ? clip.fadeOutFrames ?? 0 : clip.transitionOut?.durationFrames ?? 0) * pxPerFrame + 2,
                                width - 10,
                              ),
                            }}
                          />
                        </>
                      )}
                    </div>
                  );
                })}
                {/* transition chips at cuts: click selects, drag resizes both edges */}
                {track.clips.map((clip) => {
                  const cut = clipEndFrame(clip);
                  const right = track.clips.find((c) => c.id !== clip.id && c.startFrame === cut);
                  const tr = clip.transitionOut ?? right?.transitionIn;
                  if (!right || !tr) return null;
                  return (
                    <button
                      key={`cut-${clip.id}`}
                      type="button"
                      onPointerDown={(e) => onClipPointerDown(e, track, clip, "cut-dur")}
                      title={`${tr.type} · ${tr.durationFrames}f — drag to resize, edit in the inspector`}
                      className="absolute top-1/2 z-20 flex h-4 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full border border-neutral-950/70 bg-neutral-100 px-1 text-[8px] leading-none text-neutral-950 shadow hover:bg-neutral-300"
                      style={{ left: cut * pxPerFrame }}
                    >
                      ⇄{tr.durationFrames}
                    </button>
                  );
                })}
                {track.clips.length === 0 && (
                  <div className="pointer-events-none flex h-full items-center px-2 text-[10px] text-neutral-300">
                    empty &middot; use + to add a clip
                  </div>
                )}
              </div>
            ))}

            {/* marquee selection rectangle */}
            {marquee && (
              <div
                className="pointer-events-none absolute z-20 rounded border border-brand-500 bg-brand-500/15"
                style={{
                  left: Math.min(marquee.x0, marquee.x1),
                  top: Math.min(marquee.y0, marquee.y1),
                  width: Math.abs(marquee.x1 - marquee.x0),
                  height: Math.abs(marquee.y1 - marquee.y0),
                }}
              />
            )}
            {/* snap guide while a clip drag is snapped to a target */}
            {snapGuide !== null && (
              <div
                className="pointer-events-none absolute top-0 z-10 w-px bg-amber-400"
                style={{ left: snapGuide * pxPerFrame, height: RULER_HEIGHT + project.tracks.length * trackH }}
              />
            )}
            {/* playhead line spanning ruler + lanes, with a real grab handle */}
            <div
              className="pointer-events-none absolute top-0 z-30 w-px bg-red-500"
              style={{
                left: playheadX,
                height: RULER_HEIGHT + project.tracks.length * trackH,
              }}
            >
              <div className="absolute -top-0.5 left-1/2 h-3 w-3 -translate-x-1/2 rounded-sm bg-red-500 [clip-path:polygon(0_0,100%_0,100%_55%,50%_100%,0_55%)]" />
            </div>
          </div>
        </div>
      </div>
      </>
      ) : (
        <div className="flex items-center justify-between border-t border-neutral-200 bg-neutral-100 px-3 py-1 text-[11px] text-neutral-600">
          <span>
            Timeline &middot; {project.tracks.length} tracks &middot; {formatTimecode(durationFrames, fps)}
          </span>
          <button
            type="button"
            title="Show the timeline"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              railPressRef.current = performance.now();
              toggleTimeline();
            }}
            onClick={() => {
              if (performance.now() - railPressRef.current < 500) return;
              toggleTimeline();
            }}
            className="rounded p-1 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900"
          >
            <PanelBottomOpen size={15} className="pointer-events-none" />
          </button>
        </div>
      )}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* RIGHT CLIP INSPECTOR: consolidates the selected clip's props.     */}
      {/* Collapses to a slim rail; state persisted per-user (localStorage).*/}
      {/* ---------------------------------------------------------------- */}
      {inspectorOpen ? (
        <aside
          className="relative flex shrink-0 flex-col border-l border-neutral-200 bg-neutral-100"
          style={{ width: inspectorW }}
        >
          <div
            onPointerDown={onSideResizeDown("right")}
            onPointerMove={onSideResizeMove}
            onPointerUp={onSideResizeUp}
            title="Drag to resize the inspector; double-click to reset"
            className="absolute inset-y-0 -left-0.5 z-20 w-1.5 cursor-col-resize hover:bg-brand-600/60"
          />
          <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-700">
              {selected ? "Clip inspector" : "Project settings"}
            </span>
            <button
              type="button"
              title="Collapse inspector"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                railPressRef.current = performance.now();
                toggleInspector();
              }}
              onClick={() => {
                if (performance.now() - railPressRef.current < 500) return;
                toggleInspector();
              }}
              className="rounded p-1 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900"
            >
              <PanelRightClose size={15} className="pointer-events-none" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {selected ? (
              <ClipInspector
                key={selected.clip.id}
                track={selected.track}
                clip={selected.clip}
                fps={fps}
                assetLabel={
                  (selected.clip.assetId ? assetMap.get(selected.clip.assetId)?.filename : undefined) ??
                  (selected.clip.sequenceId
                    ? (sequenceNames?.[selected.clip.sequenceId] ?? "Sequence")
                    : undefined) ??
                  (selected.track.kind === "text" ? "Title" : "Clip")
                }
                mediaDims={selected.clip.assetId ? assetDims[selected.clip.assetId] : undefined}
                editDisabled={editDisabled}
                onPatchClip={patchSelectedClip}
                onSetSpeed={doSetSpeed}
                onSetTransition={setTransition}
                onSetTransitionDuration={setTransitionDuration}
                onSetClipGainDb={setClipGainDb}
                onSetFades={setClipFades}
                onSetTitle={setClipTitle}
                onSetChroma={setClipChroma}
                onSetKeyframes={setClipKeyframes}
                onDetachAudio={detachAudio}
                onDetectScenes={() => void detectScenes()}
                detectingScenes={detectingScenes}
                playhead={frame}
                onSplit={doSplit}
                onRippleDelete={doRippleDelete}
              />
            ) : (
              <div className="flex flex-col gap-3 p-3 text-xs">
                <div className="text-[11px] leading-snug text-neutral-500">
                  Select a clip to edit it. These settings apply to the whole video.
                </div>
                {seqPath.length > 0 ? (
                  <InspectorSection title="Stage" icon={Film}>
                    <div className="text-[11px] leading-snug text-neutral-500">
                      A nested sequence renders inside its parent clip: it follows the main
                      timeline&apos;s stage size, background, and frame rate.
                    </div>
                  </InspectorSection>
                ) : (
                <InspectorSection title="Stage" icon={Film}>
                  <label className="flex items-center justify-between gap-2 text-neutral-600">
                    <span>Size</span>
                    <select
                      value={`${project.stage.width}x${project.stage.height}`}
                      onChange={(e) => {
                        const [w, h] = e.target.value.split("x").map(Number);
                        if (w && h) setStageSize(w, h);
                      }}
                      className="rounded border border-neutral-300 bg-neutral-200 px-1.5 py-1 text-neutral-900"
                    >
                      {STAGE_PRESETS.map((p) => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                      {!STAGE_PRESETS.some((p) => p.value === `${project.stage.width}x${project.stage.height}`) && (
                        <option value={`${project.stage.width}x${project.stage.height}`}>
                          {project.stage.width}x{project.stage.height}
                        </option>
                      )}
                    </select>
                  </label>
                  <label className="flex items-center justify-between gap-2 text-neutral-600">
                    <span>Custom</span>
                    <span className="flex items-center gap-1">
                      <input
                        key={`w-${project.stage.width}`}
                        type="number"
                        min={16}
                        max={7680}
                        defaultValue={project.stage.width}
                        title="Width (px); commits on Enter or focus-out"
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        onBlur={(e) => {
                          const w = clampStageDim(parseInt(e.target.value, 10) || project.stage.width);
                          if (w !== project.stage.width) setStageSize(w, project.stage.height);
                        }}
                        className="w-16 rounded border border-neutral-300 bg-neutral-200 px-1 py-0.5 text-right text-neutral-900"
                      />
                      <span className="text-neutral-500">x</span>
                      <input
                        key={`h-${project.stage.height}`}
                        type="number"
                        min={16}
                        max={7680}
                        defaultValue={project.stage.height}
                        title="Height (px); commits on Enter or focus-out"
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        onBlur={(e) => {
                          const h = clampStageDim(parseInt(e.target.value, 10) || project.stage.height);
                          if (h !== project.stage.height) setStageSize(project.stage.width, h);
                        }}
                        className="w-16 rounded border border-neutral-300 bg-neutral-200 px-1 py-0.5 text-right text-neutral-900"
                      />
                      <button
                        type="button"
                        title="Swap orientation (portrait/landscape)"
                        onClick={() => setStageSize(project.stage.height, project.stage.width)}
                        className="rounded bg-neutral-200 px-1.5 py-0.5 text-neutral-700 hover:bg-neutral-300"
                      >
                        &#8646;
                      </button>
                    </span>
                  </label>
                  <label className="flex items-center justify-between gap-2 text-neutral-600">
                    <span>Frame rate</span>
                    <select
                      value={fps}
                      onChange={(e) => setProjectFps(Number(e.target.value) as Fps)}
                      title="Clips re-time on change so wall-clock timing holds"
                      className="rounded border border-neutral-300 bg-neutral-200 px-1.5 py-1 text-neutral-900"
                    >
                      {[24, 25, 30, 50, 60].map((v) => (
                        <option key={v} value={v}>{v} fps</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center justify-between gap-2 text-neutral-600">
                    <span>Preview quality</span>
                    <select
                      value={previewQuality}
                      onChange={(e) => setPreviewQuality(e.target.value === "original" ? "original" : "auto")}
                      title="Auto scrubs the 540p preview proxy when one exists; exports always use originals"
                      className="rounded border border-neutral-300 bg-neutral-200 px-1.5 py-1 text-neutral-900"
                    >
                      <option value="auto">Auto (proxy)</option>
                      <option value="original">Original</option>
                    </select>
                  </label>
                  <label className="flex items-center justify-between gap-2 text-neutral-600">
                    <span>Background</span>
                    <span className="flex items-center gap-1.5">
                      <input
                        type="color"
                        value={project.background ?? "#000000"}
                        onChange={(e) =>
                          persist({ ...project, background: e.target.value === "#000000" ? undefined : e.target.value })
                        }
                        title="Shows behind clips and through letterboxed ones"
                        className="h-6 w-10 cursor-pointer rounded border border-neutral-300 bg-neutral-200"
                      />
                      {project.background && (
                        <button
                          type="button"
                          onClick={() => persist({ ...project, background: undefined })}
                          title="Back to black"
                          className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-700 hover:bg-neutral-300"
                        >
                          Reset
                        </button>
                      )}
                    </span>
                  </label>
                </InspectorSection>
                )}
                <InspectorSection title="Audio" icon={Volume2}>
                  <label className="flex items-center justify-between gap-2 text-neutral-600">
                    <span>Master volume</span>
                    <span className="flex items-center gap-2">
                      <input
                        type="range"
                        min={-24}
                        max={6}
                        step={1}
                        value={project.master.gainDb}
                        onChange={(e) =>
                          persist({ ...project, master: { ...project.master, gainDb: parseInt(e.target.value, 10) } })
                        }
                        className="h-1 w-24 accent-emerald-500"
                      />
                      <span className="w-10 text-right font-mono tabular-nums text-neutral-700">
                        {project.master.gainDb > 0 ? "+" : ""}
                        {project.master.gainDb} dB
                      </span>
                    </span>
                  </label>
                  {(() => {
                    const audioish = project.tracks.filter((t) => t.kind === "audio" || t.kind === "video");
                    const d = project.master.ducking;
                    const setDuck = (patch: Partial<NonNullable<AudioMaster["ducking"]>> | null) => {
                      if (patch === null) {
                        persist({ ...project, master: { gainDb: project.master.gainDb } });
                        return;
                      }
                      const cur = d ?? {
                        musicTrackId: audioish[0]?.id ?? "",
                        voiceTrackId: audioish[1]?.id ?? audioish[0]?.id ?? "",
                        amountDb: -12,
                        attackMs: 80,
                        releaseMs: 400,
                      };
                      persist({ ...project, master: { ...project.master, ducking: { ...cur, ...patch } } });
                    };
                    return (
                      <>
                        <label className="flex items-center justify-between gap-2 text-neutral-600">
                          <span>Auto-duck</span>
                          <input
                            type="checkbox"
                            checked={!!d}
                            disabled={audioish.length < 2}
                            title={audioish.length < 2 ? "Needs two tracks that carry audio" : "Lower the music under the voice automatically"}
                            onChange={(e) => (e.target.checked ? setDuck({}) : setDuck(null))}
                          />
                        </label>
                        {d && (
                          <>
                            <label className="flex items-center justify-between gap-2 text-neutral-600">
                              <span>Music track</span>
                              <select
                                value={d.musicTrackId}
                                onChange={(e) => setDuck({ musicTrackId: e.target.value })}
                                className="max-w-[9rem] rounded border border-neutral-300 bg-neutral-200 px-1 py-0.5 text-neutral-900"
                              >
                                {audioish.map((t) => (
                                  <option key={t.id} value={t.id}>{t.name ?? t.kind}</option>
                                ))}
                              </select>
                            </label>
                            <label className="flex items-center justify-between gap-2 text-neutral-600">
                              <span>Voice track</span>
                              <select
                                value={d.voiceTrackId}
                                onChange={(e) => setDuck({ voiceTrackId: e.target.value })}
                                className="max-w-[9rem] rounded border border-neutral-300 bg-neutral-200 px-1 py-0.5 text-neutral-900"
                              >
                                {audioish.map((t) => (
                                  <option key={t.id} value={t.id}>{t.name ?? t.kind}</option>
                                ))}
                              </select>
                            </label>
                            <label className="flex items-center justify-between gap-2 text-neutral-600">
                              <span>Duck by</span>
                              <span className="flex items-center gap-1">
                                <input
                                  type="number"
                                  min={-36}
                                  max={-1}
                                  value={d.amountDb}
                                  onChange={(e) => setDuck({ amountDb: Math.max(-36, Math.min(-1, parseInt(e.target.value, 10) || -12)) })}
                                  className="w-14 rounded border border-neutral-300 bg-neutral-200 px-1 py-0.5 text-right text-neutral-900"
                                />
                                dB
                              </span>
                            </label>
                            <label className="flex items-center justify-between gap-2 text-neutral-600">
                              <span>Attack / release</span>
                              <span className="flex items-center gap-1">
                                <input
                                  type="number"
                                  min={10}
                                  max={2000}
                                  value={d.attackMs}
                                  onChange={(e) => setDuck({ attackMs: Math.max(10, Math.min(2000, parseInt(e.target.value, 10) || 80)) })}
                                  className="w-14 rounded border border-neutral-300 bg-neutral-200 px-1 py-0.5 text-right text-neutral-900"
                                />
                                /
                                <input
                                  type="number"
                                  min={10}
                                  max={5000}
                                  value={d.releaseMs}
                                  onChange={(e) => setDuck({ releaseMs: Math.max(10, Math.min(5000, parseInt(e.target.value, 10) || 400)) })}
                                  className="w-14 rounded border border-neutral-300 bg-neutral-200 px-1 py-0.5 text-right text-neutral-900"
                                />
                                ms
                              </span>
                            </label>
                          </>
                        )}
                      </>
                    );
                  })()}
                </InspectorSection>
                <InspectorSection title="Timeline" icon={Gauge}>
                  <label className="flex items-center justify-between gap-2 text-neutral-600">
                    <span>Duration</span>
                    <span className="flex items-center gap-1">
                      <input
                        key={`dur-${durationFrames}`}
                        type="text"
                        defaultValue={formatTimecode(durationFrames, fps)}
                        title="Type a time (mm:ss or mm:ss:ff) to extend the timeline with trailing space; shorter than the clips snaps back to the clip extent"
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        onBlur={(e) => {
                          const f = parseTimecode(e.target.value, fps);
                          if (f === null) return;
                          const extent = projectDurationFrames(project);
                          persist(withDuration({ ...project, minDurationFrames: f > extent ? f : undefined }));
                        }}
                        className="w-24 rounded border border-neutral-300 bg-neutral-200 px-1 py-0.5 text-right font-mono tabular-nums text-neutral-900"
                      />
                      {project.minDurationFrames !== undefined && (
                        <span className="text-[9px] text-neutral-500" title="Trailing space after the last clip">
                          fixed
                        </span>
                      )}
                    </span>
                  </label>
                  <ReadoutRow label="Tracks" value={`${project.tracks.length}`} />
                  {project.range && (
                    <ReadoutRow
                      label="Range"
                      value={`${formatTimecode(project.range.startFrame, fps)} - ${formatTimecode(project.range.endFrame, fps)}`}
                    />
                  )}
                  {(project.markers?.length ?? 0) > 0 && (
                    <ReadoutRow label="Markers" value={`${project.markers!.length}`} />
                  )}
                </InspectorSection>
              </div>
            )}
          </div>
        </aside>
      ) : (
        <button
          type="button"
          title="Open the clip inspector"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            railPressRef.current = performance.now();
            toggleInspector();
          }}
          onClick={() => {
            if (performance.now() - railPressRef.current < 500) return;
            toggleInspector();
          }}
          className="flex w-9 shrink-0 cursor-pointer flex-col items-center gap-2 border-l border-neutral-200 bg-neutral-100 py-2 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900"
        >
          <PanelRightOpen size={15} className="pointer-events-none" />
          <span className="pointer-events-none text-[9px] font-semibold uppercase tracking-wide [writing-mode:vertical-rl]">
            Inspector
          </span>
        </button>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* DELETE-ASSET CONFIRM (removes the workspace upload, not the clip) */}
      {/* ---------------------------------------------------------------- */}
      {confirmDeleteAsset && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setConfirmDeleteAsset(null)}
          role="dialog"
          aria-label="Delete upload"
        >
          <div
            className="w-80 rounded-lg border border-neutral-300 bg-neutral-100 p-4 text-xs shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-sm font-semibold text-neutral-900">Delete upload?</div>
            <p className="mb-3 leading-snug text-neutral-600">
              &ldquo;{confirmDeleteAsset.filename ?? confirmDeleteAsset.id}&rdquo; will be removed from the
              workspace for every design that uses it. Clips referencing it will stop playing.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteAsset(null)}
                className="rounded-md bg-neutral-200 px-3 py-1.5 font-medium text-neutral-800 hover:bg-neutral-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void doDeleteAsset()}
                className="rounded-md bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* REPLACE MEDIA: pick a different asset for one clip.               */}
      {/* ---------------------------------------------------------------- */}
      {replaceTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setReplaceTarget(null)}>
          <div
            className="max-h-[70vh] w-[24rem] overflow-y-auto rounded-xl border border-neutral-300 bg-neutral-100 p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-sm font-semibold text-neutral-900">Replace media</div>
            <p className="mb-2 text-[11px] text-neutral-500">
              The clip keeps its position, trim, and effects; only the footage swaps.
            </p>
            {(() => {
              const track = project.tracks.find((t) => t.id === replaceTarget.trackId);
              const wanted = track?.kind === "audio" ? "audio" : "video";
              const options = assets.filter((a) => a.kind === wanted);
              if (!options.length) return <div className="text-xs text-neutral-500">No other {wanted} uploads yet.</div>;
              return options.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => applyReplaceMedia(a)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-neutral-800 hover:bg-neutral-200"
                >
                  {a.kind === "video" ? <Film size={13} className="shrink-0 text-violet-400" /> : <Music2 size={13} className="shrink-0 text-emerald-400" />}
                  <span className="min-w-0 flex-1 truncate">{a.filename ?? a.id}</span>
                </button>
              ));
            })()}
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* DELETE-TRACK CONFIRM (occupied tracks only).                      */}
      {/* ---------------------------------------------------------------- */}
      {confirmDeleteTrack && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setConfirmDeleteTrack(null)}
          role="dialog"
          aria-label="Delete track"
        >
          <div
            className="w-80 rounded-lg border border-neutral-300 bg-neutral-100 p-4 text-xs shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-sm font-semibold text-neutral-900">Delete track?</div>
            <p className="mb-3 leading-snug text-neutral-600">
              &ldquo;{confirmDeleteTrack.name ?? confirmDeleteTrack.kind}&rdquo; holds{" "}
              {confirmDeleteTrack.clips.length} clip{confirmDeleteTrack.clips.length === 1 ? "" : "s"}; deleting the
              track removes them from the timeline (undo brings everything back).
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteTrack(null)}
                className="rounded-md bg-neutral-200 px-3 py-1.5 font-medium text-neutral-800 hover:bg-neutral-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  removeTrack(confirmDeleteTrack.id);
                  setConfirmDeleteTrack(null);
                }}
                className="rounded-md bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700"
              >
                Delete track
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* EXPORT DIALOG (one entry point for every format).                 */}
      {/* ---------------------------------------------------------------- */}
      {exportDialog && project && (
        <ExportDialog
          hasRange={!!project.range}
          rangeFrames={project.range ? project.range.endFrame - project.range.startFrame : 0}
          durationFrames={durationFrames}
          fps={fps}
          stagePixels={project.stage.width * project.stage.height}
          captionsPresent={(project.captions?.[0]?.cues.length ?? 0) > 0}
          audioTracks={project.tracks
            .filter((t) => t.kind === "audio" || t.kind === "video")
            .map((t) => ({ id: t.id, label: t.name ?? t.kind }))}
          serverAvailable={!!props.designId}
          onStart={startExport}
          onClose={() => setExportDialog(false)}
        />
      )}

      {/* ---------------------------------------------------------------- */}
      {/* CONTEXT MENU (right-click on a clip or an empty lane spot).       */}
      {/* ---------------------------------------------------------------- */}
      {ctxMenu && (
        <div className="fixed inset-0 z-50" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}>
          <div
            className="absolute w-52 overflow-hidden rounded-lg border border-neutral-300 bg-neutral-100 py-1 text-xs shadow-2xl"
            style={{ left: Math.min(ctxMenu.x, window.innerWidth - 220), top: Math.min(ctxMenu.y, window.innerHeight - 260) }}
            onClick={(e) => e.stopPropagation()}
          >
            <CtxMenuItems
              project={project}
              menu={ctxMenu}
              frame={frame}
              multiCount={multiIds.size}
              hasClipboard={hasClipboard}
              detectingScenes={detectingScenes}
              close={() => setCtxMenu(null)}
              actions={{
                pasteAt: (f) => { setPlayhead(f); pasteClip(f); },
                addClip,
                closeGap,
                toggleMarkerAt: toggleMarker,
                setRangeEdge: markRange,
                clearRange,
                hasRange: !!project.range,
                split: doSplit,
                copy: copySelectedClip,
                duplicate: duplicateClip,
                nest: nestSelection,
                openSequence,
                crossDissolve: crossDissolveAtCut,
                detachAudio,
                detectScenes: () => void detectScenes(),
                deleteSelection: deleteSelected,
                rippleDelete: doRippleDelete,
                unlink: unlinkGroup,
                patchClip: patchClipByIds,
                replaceMedia: (trackId, clipId) => setReplaceTarget({ trackId, clipId }),
                freezeFrame,
              }}
            />
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* MEDIA PICKER: bind an uploaded video/audio asset as a new clip.   */}
      {/* ---------------------------------------------------------------- */}
      {pickerTrackId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setPickerTrackId(null)}>
          <div
            className="max-h-[70vh] w-[28rem] overflow-y-auto rounded-xl border border-neutral-300 bg-neutral-100 p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-neutral-900">Add media to track</span>
              <button
                type="button"
                onClick={() => setPickerTrackId(null)}
                className="rounded p-1 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900"
              >
                ✕
              </button>
            </div>
            {(() => {
              const track = project.tracks.find((t) => t.id === pickerTrackId);
              // Strictly typed lanes: audio tracks take audio, video/overlay
              // tracks take video (an audio file on a video lane would render
              // black frames whenever it is the top clip).
              const wanted = track?.kind === "audio" ? "audio" : "video";
              const options = assets.filter((a) => a.kind === wanted);
              if (!options.length) {
                return (
                  <div className="py-6 text-center text-xs text-neutral-500">
                    No {wanted} uploads in this workspace yet.
                    <br />
                    Upload media (or record a clip) in the design editor&apos;s Uploads panel.
                  </div>
                );
              }
              return options.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => void addAssetClip(pickerTrackId, a)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-neutral-800 hover:bg-neutral-200"
                >
                  {a.kind === "video" ? <Film size={14} className="shrink-0 text-violet-400" /> : <Music2 size={14} className="shrink-0 text-emerald-400" />}
                  <span className="min-w-0 flex-1 truncate">{a.filename ?? a.id}</span>
                  <span className="shrink-0 text-neutral-500">{a.kind}</span>
                </button>
              ));
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// small presentational helpers (chrome only)
// ---------------------------------------------------------------------------

// Context-menu item list (extracted so no render-time IIFE is needed).
function CtxMenuItems(props: {
  project: VideoProject;
  menu: { trackId: string; clipId?: string; atFrame: number; ruler?: boolean };
  frame: number;
  multiCount: number;
  hasClipboard: boolean;
  detectingScenes: boolean;
  close: () => void;
  actions: {
    pasteAt: (frame: number) => void;
    addClip: (trackId: string) => void;
    closeGap: (trackId: string, atFrame: number) => void;
    toggleMarkerAt: (frame: number) => void;
    setRangeEdge: (edge: "in" | "out", frame: number) => void;
    clearRange: () => void;
    hasRange: boolean;
    split: () => void;
    copy: () => void;
    duplicate: (trackId: string, clipId: string) => void;
    nest: () => void;
    openSequence: (id: string) => void;
    crossDissolve: (trackId: string, clipId: string) => void;
    detachAudio: () => void;
    detectScenes: () => void;
    deleteSelection: () => void;
    rippleDelete: () => void;
    unlink: (groupId: string) => void;
    patchClip: (trackId: string, clipId: string, patch: Partial<Clip>) => void;
    replaceMedia: (trackId: string, clipId: string) => void;
    freezeFrame: () => void;
  };
}): React.ReactElement | null {
  const { project, menu, frame, multiCount, actions } = props;
  const track = project.tracks.find((t) => t.id === menu.trackId);
  const clip = menu.clipId ? track?.clips.find((c) => c.id === menu.clipId) : undefined;
  if (!track && !menu.ruler) return null;
  const item = (label: string, onClick: () => void, disabled = false) => (
    <button
      key={label}
      type="button"
      disabled={disabled}
      onClick={() => { props.close(); onClick(); }}
      className="block w-full px-3 py-1.5 text-left text-neutral-800 hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );
  if (menu.ruler) {
    const nearMarker = (project.markers ?? []).some((m) => Math.abs(m - menu.atFrame) <= 2);
    return (
      <>
        {item(nearMarker ? "Remove marker" : "Add marker here", () => actions.toggleMarkerAt(menu.atFrame))}
        {item("Start export range here", () => actions.setRangeEdge("in", menu.atFrame))}
        {item("End export range here", () => actions.setRangeEdge("out", menu.atFrame))}
        {item("Clear export range", actions.clearRange, !actions.hasRange)}
      </>
    );
  }
  if (!track) return null;
  if (!clip) {
    // Is there a real gap under the pointer (clips before AND after it)?
    const sorted = sortClips(track.clips);
    const nextClip = sorted.find((c) => c.startFrame > menu.atFrame);
    const prevEnd = sorted.reduce((acc, c) => (clipEndFrame(c) <= menu.atFrame ? Math.max(acc, clipEndFrame(c)) : acc), 0);
    const inGap = !!nextClip && prevEnd > 0 && nextClip.startFrame > prevEnd;
    return (
      <>
        {item("Paste here", () => actions.pasteAt(menu.atFrame), !props.hasClipboard)}
        {item("Close gap", () => actions.closeGap(track.id, menu.atFrame), track.locked || !inGap)}
        {item("Add media…", () => actions.addClip(track.id), track.locked)}
      </>
    );
  }
  const insidePlayhead = frame > clip.startFrame && frame < clipEndFrame(clip);
  const abutting = track.clips.some((c) => c.id !== clip.id && c.startFrame === clipEndFrame(clip));
  const items = [
    item("Split at playhead", actions.split, track.locked || !insidePlayhead),
    item("Copy", actions.copy),
    item("Duplicate", () => actions.duplicate(track.id, clip.id), track.locked),
    item("Nest into sequence", actions.nest, track.locked || multiCount === 0),
  ];
  if (clip.sequenceId) items.push(item("Open sequence", () => actions.openSequence(clip.sequenceId as string)));
  if (clip.groupId) items.push(item("Unlink grouped clips", () => actions.unlink(clip.groupId as string), track.locked));
  items.push(item(clip.disabled ? "Enable clip" : "Disable clip (skip in render)", () => actions.patchClip(track.id, clip.id, { disabled: clip.disabled ? undefined : true }), track.locked));
  items.push(item(clip.locked ? "Unlock clip" : "Lock clip", () => actions.patchClip(track.id, clip.id, { locked: clip.locked ? undefined : true }), track.locked));
  if (clip.assetId && !clip.sequenceId) items.push(item("Replace media…", () => actions.replaceMedia(track.id, clip.id), track.locked || !!clip.locked));
  if (clip.assetId && track.kind === "video") items.push(item("Freeze frame here (3s)", actions.freezeFrame, track.locked || !!clip.locked || !insidePlayhead));
  if (abutting) items.push(item("Cross-dissolve at cut", () => actions.crossDissolve(track.id, clip.id), track.locked));
  if (track.kind === "video" && clip.assetId) {
    items.push(item("Detach audio", actions.detachAudio, track.locked));
    items.push(item("Detect scenes", actions.detectScenes, track.locked || props.detectingScenes));
  }
  items.push(item(multiCount > 1 ? `Delete ${multiCount} clips` : "Delete", actions.deleteSelection, track.locked));
  if (multiCount <= 1) items.push(item("Ripple delete (close the gap)", actions.rippleDelete, track.locked));
  items.push(
    <div key="labels" className="flex items-center gap-1.5 px-3 py-1.5">
      <span className="text-[10px] text-neutral-500">Label</span>
      {["", "#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#a855f7"].map((c) => (
        <button
          key={c || "none"}
          type="button"
          title={c ? "Color label" : "Clear label"}
          onClick={() => {
            props.close();
            actions.patchClip(track.id, clip.id, { colorLabel: c || undefined });
          }}
          className={`h-4 w-4 rounded-full border ${
            (clip.colorLabel ?? "") === c ? "border-neutral-900 ring-1 ring-neutral-900" : "border-neutral-400"
          }`}
          style={{ backgroundColor: c || "transparent" }}
        />
      ))}
    </div>,
  );
  return <>{items}</>;
}

// The right-side clip inspector: a controlled, read-from-live-props panel that
// consolidates the selected clip's timing, transitions, and (for audio tracks)
// gain. Every editing control calls one of the parent ops, which persist through
// the normal undoable path. Re-keyed by clip id so local input drafts reset when
// the selection changes. Chrome only (Tailwind); no canvas content here.
function ClipInspector(props: {
  track: Track;
  clip: Clip;
  fps: number;
  /** Friendly fallback label: the asset filename / sequence name / kind. */
  assetLabel: string;
  /** Probed media pixel dims (crop tool); undefined until known. */
  mediaDims?: { w: number; h: number };
  editDisabled: boolean;
  onPatchClip: (patch: Partial<Clip>) => void;
  onSetSpeed: (speed: number) => void;
  onSetTransition: (edge: "in" | "out", type: "" | ClipTransition["type"]) => void;
  onSetTransitionDuration: (edge: "in" | "out", durationFrames: number) => void;
  onSetClipGainDb: (db: number) => void;
  onSetFades: (fadeInFrames: number, fadeOutFrames: number) => void;
  onSetTitle: (patch: Partial<TitleCard>) => void;
  onSetChroma: (key: ChromaKey | null) => void;
  onSetKeyframes: (tracks: KeyframeTrack[]) => void;
  onDetachAudio: () => void;
  onDetectScenes: () => void;
  detectingScenes: boolean;
  playhead: number;
  onSplit: () => void;
  onRippleDelete: () => void;
}): React.ReactElement {
  const { track, clip, fps, editDisabled, playhead, detectingScenes } = props;
  const dur = clipDurationFrames(clip);
  const end = clipEndFrame(clip);
  const reversed = clip.speed < 0;
  const KindIcon = KIND_ICON[track.kind];
  // The audio section applies to audio tracks AND the soundtrack of video
  // tracks (gain + fades feed the same per-clip mix).
  const isAudio = track.kind === "audio" || track.kind === "video";
  const clipGain = clip.audioGainDb ?? 0;

  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      {/* header: clip identity + its track. The name is user-facing: the
          clip's own name when set, else the asset filename; never a raw id. */}
      <div className="flex flex-col gap-1">
        <input
          type="text"
          disabled={editDisabled}
          value={clip.name ?? ""}
          placeholder={props.assetLabel}
          title={`Rename clip (media: ${props.assetLabel})`}
          onChange={(e) => props.onPatchClip({ name: e.target.value || undefined })}
          className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium text-neutral-900 placeholder:text-neutral-900 hover:border-neutral-300 focus:border-neutral-400 focus:bg-neutral-200 focus:placeholder:text-neutral-500 focus:outline-none disabled:opacity-60"
        />
        <div className="flex items-center gap-1.5 text-[11px] text-neutral-600">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: KIND_COLOR[track.kind] }}
          />
          <KindIcon size={12} className="text-neutral-600" />
          <span className="truncate">{track.name ?? track.kind}</span>
          <span className="uppercase tracking-wide text-neutral-400">{track.kind}</span>
        </div>
        {editDisabled && (
          <div className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
            <Lock size={10} /> track locked &middot; read-only
          </div>
        )}
      </div>

      {/* TIMING */}
      <InspectorSection title="Timing" icon={Gauge}>
        <ReadoutRow label="In (src)" value={`${clip.inFrame}f`} />
        <ReadoutRow label="Out (src)" value={`${clip.outFrame}f`} />
        <ReadoutRow label="Start" value={`${clip.startFrame}f`} sub={formatTimecode(clip.startFrame, fps)} />
        <ReadoutRow label="End" value={`${end}f`} sub={formatTimecode(end, fps)} />
        <ReadoutRow label="Duration" value={`${dur}f`} sub={formatTimecode(dur, fps)} />
        <label className="mt-1 flex items-center justify-between gap-2 text-neutral-600">
          <span>Speed</span>
          <span className="flex items-center gap-1">
            <input
              type="number"
              step={0.1}
              min={0.1}
              max={100}
              disabled={editDisabled}
              value={Number(Math.abs(clip.speed).toFixed(2))}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (Number.isFinite(v) && v > 0) props.onSetSpeed((reversed ? -1 : 1) * v);
              }}
              className="w-16 rounded border border-neutral-300 bg-neutral-200 px-1.5 py-1 text-right text-neutral-900 disabled:opacity-40"
            />
            <span className="text-neutral-500">x</span>
          </span>
        </label>
        <label className="flex items-center justify-between gap-2 text-neutral-600">
          <span>Reverse</span>
          <input
            type="checkbox"
            disabled={editDisabled || !!clip.sequenceId}
            checked={reversed}
            title={clip.sequenceId ? "Sequences cannot play in reverse" : "Play the clip backwards (audio mutes)"}
            onChange={(e) => props.onSetSpeed((e.target.checked ? -1 : 1) * Math.abs(clip.speed))}
          />
        </label>
        {reversed && (
          <div className="text-[10px] font-medium text-pink-600 dark:text-pink-400">plays in reverse (audio muted)</div>
        )}
      </InspectorSection>

      {/* TRANSITIONS */}
      <InspectorSection title="Transitions" icon={Wand2}>
        <TransitionEdge
          label="In edge"
          edge="in"
          transition={clip.transitionIn}
          disabled={editDisabled}
          onSetTransition={props.onSetTransition}
          onSetDuration={props.onSetTransitionDuration}
        />
        <TransitionEdge
          label="Out edge"
          edge="out"
          transition={clip.transitionOut}
          disabled={editDisabled}
          onSetTransition={props.onSetTransition}
          onSetDuration={props.onSetTransitionDuration}
        />
      </InspectorSection>

      {/* AUDIO (audio tracks only) */}
      {(track.kind === "video" || track.kind === "overlay") && clip.assetId && (
        <InspectorSection title="Green screen" icon={Wand2}>
          <label className="flex items-center gap-1.5 text-neutral-600">
            <input
              type="checkbox"
              disabled={editDisabled}
              checked={!!clip.chromaKey}
              onChange={(e) =>
                props.onSetChroma(e.target.checked ? { keyColor: "#00ff00", tolerance: 0.35, spill: 0.5, edgeFeather: 6 } : null)
              }
            />
            Key out a color
          </label>
          {clip.chromaKey && (
            <>
              <label className="flex items-center justify-between gap-2 text-neutral-600">
                <span>Key color</span>
                <input
                  type="color"
                  disabled={editDisabled}
                  value={clip.chromaKey.keyColor}
                  onChange={(e) => props.onSetChroma({ ...clip.chromaKey!, keyColor: e.target.value })}
                  className="h-6 w-10 cursor-pointer rounded border border-neutral-300 bg-neutral-200"
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-neutral-600">
                <span>Tolerance</span>
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  disabled={editDisabled}
                  value={clip.chromaKey.tolerance}
                  onChange={(e) => props.onSetChroma({ ...clip.chromaKey!, tolerance: parseFloat(e.target.value) })}
                  className="h-1 w-24 accent-emerald-500"
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-neutral-600">
                <span>Spill</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  disabled={editDisabled}
                  value={clip.chromaKey.spill}
                  onChange={(e) => props.onSetChroma({ ...clip.chromaKey!, spill: parseFloat(e.target.value) })}
                  className="h-1 w-24 accent-emerald-500"
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-neutral-600">
                <span>Feather</span>
                <input
                  type="range"
                  min={0}
                  max={20}
                  step={1}
                  disabled={editDisabled}
                  value={clip.chromaKey.edgeFeather}
                  onChange={(e) => props.onSetChroma({ ...clip.chromaKey!, edgeFeather: parseInt(e.target.value, 10) })}
                  className="h-1 w-24 accent-emerald-500"
                />
              </label>
            </>
          )}
        </InspectorSection>
      )}

      {/* COLOR (media clips on video/overlay tracks) */}
      {(track.kind === "video" || track.kind === "overlay") && clip.assetId && (
        <InspectorSection title="Color" icon={Palette}>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              disabled={editDisabled}
              onClick={() => props.onPatchClip({ color: undefined })}
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                colorIsNeutral(clip.color)
                  ? "bg-neutral-800 font-semibold text-neutral-100"
                  : "bg-neutral-200 text-neutral-700 hover:bg-neutral-300"
              } disabled:opacity-40`}
            >
              None
            </button>
            {COLOR_PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                disabled={editDisabled}
                onClick={() => props.onPatchClip({ color: { ...p.color, preset: p.name } })}
                className={`rounded px-1.5 py-0.5 text-[10px] ${
                  clip.color?.preset === p.name
                    ? "bg-neutral-800 font-semibold text-neutral-100"
                    : "bg-neutral-200 text-neutral-700 hover:bg-neutral-300"
                } disabled:opacity-40`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <ColorSlider
            label="Brightness"
            min={0.5}
            max={1.5}
            neutral={1}
            value={clip.color?.brightness ?? 1}
            disabled={editDisabled}
            onChange={(v) => props.onPatchClip({ color: { ...clip.color, brightness: v, preset: undefined } })}
          />
          <ColorSlider
            label="Contrast"
            min={0.5}
            max={1.5}
            neutral={1}
            value={clip.color?.contrast ?? 1}
            disabled={editDisabled}
            onChange={(v) => props.onPatchClip({ color: { ...clip.color, contrast: v, preset: undefined } })}
          />
          <ColorSlider
            label="Saturation"
            min={0}
            max={2}
            neutral={1}
            value={clip.color?.saturation ?? 1}
            disabled={editDisabled}
            onChange={(v) => props.onPatchClip({ color: { ...clip.color, saturation: v, preset: undefined } })}
          />
          <ColorSlider
            label="Warmth"
            min={-1}
            max={1}
            neutral={0}
            value={clip.color?.temperature ?? 0}
            disabled={editDisabled}
            onChange={(v) => props.onPatchClip({ color: { ...clip.color, temperature: v, preset: undefined } })}
          />
        </InspectorSection>
      )}

      {/* CROP (media clips with known pixel dims) */}
      {(track.kind === "video" || track.kind === "overlay") && clip.assetId && props.mediaDims && (
        <InspectorSection title="Crop" icon={Maximize2}>
          <label className="flex items-center gap-1.5 text-neutral-600">
            <input
              type="checkbox"
              disabled={editDisabled}
              checked={!!clip.crop}
              onChange={(e) =>
                props.onPatchClip({
                  crop: e.target.checked
                    ? { x: 0, y: 0, width: props.mediaDims!.w, height: props.mediaDims!.h }
                    : undefined,
                })
              }
            />
            Crop the source
          </label>
          {clip.crop && (
            <>
              {(["left", "top", "right", "bottom"] as const).map((edge) => {
                const dims = props.mediaDims!;
                const c = clip.crop!;
                const value =
                  edge === "left" ? c.x / dims.w
                  : edge === "top" ? c.y / dims.h
                  : edge === "right" ? 1 - (c.x + c.width) / dims.w
                  : 1 - (c.y + c.height) / dims.h;
                return (
                  <ColorSlider
                    key={edge}
                    label={edge[0].toUpperCase() + edge.slice(1)}
                    min={0}
                    max={0.45}
                    neutral={0}
                    value={Math.max(0, Math.min(0.45, value))}
                    disabled={editDisabled}
                    onChange={(v) => {
                      const d = props.mediaDims!;
                      const cur = clip.crop!;
                      const left = edge === "left" ? v : cur.x / d.w;
                      const top = edge === "top" ? v : cur.y / d.h;
                      const right = edge === "right" ? v : 1 - (cur.x + cur.width) / d.w;
                      const bottom = edge === "bottom" ? v : 1 - (cur.y + cur.height) / d.h;
                      props.onPatchClip({
                        crop: {
                          x: Math.round(left * d.w),
                          y: Math.round(top * d.h),
                          width: Math.max(8, Math.round((1 - left - right) * d.w)),
                          height: Math.max(8, Math.round((1 - top - bottom) * d.h)),
                        },
                      });
                    }}
                  />
                );
              })}
            </>
          )}
        </InspectorSection>
      )}

      {/* TRANSFORM (media clips on video/overlay tracks) */}
      {(track.kind === "video" || track.kind === "overlay") && (clip.assetId || clip.sequenceId) && (
        <InspectorSection title="Transform" icon={Layers}>
          <label className="flex items-center justify-between gap-2 text-neutral-600">
            <span>Fill</span>
            <select
              disabled={editDisabled}
              value={clip.fit ?? "cover"}
              onChange={(e) =>
                props.onPatchClip({ fit: e.target.value === "contain" ? "contain" : undefined })
              }
              className="rounded border border-neutral-300 bg-neutral-200 px-1.5 py-1 text-neutral-900 disabled:opacity-40"
            >
              <option value="cover">Fill the stage (crop)</option>
              <option value="contain">Fit inside (letterbox)</option>
            </select>
          </label>
          <ColorSlider
            label="Opacity"
            min={0}
            max={1}
            neutral={1}
            value={clip.opacity ?? 1}
            disabled={editDisabled}
            onChange={(v) => props.onPatchClip({ opacity: v >= 1 ? undefined : v })}
          />
          <label className="flex items-center justify-between gap-2 text-neutral-600">
            <span>Rotation</span>
            <span className="flex items-center gap-1">
              <input
                type="number"
                step={1}
                min={-180}
                max={180}
                disabled={editDisabled}
                value={clip.rotationDeg ?? 0}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  props.onPatchClip({ rotationDeg: Number.isFinite(v) && v !== 0 ? v : undefined });
                }}
                className="w-16 rounded border border-neutral-300 bg-neutral-200 px-1.5 py-1 text-right text-neutral-900 disabled:opacity-40"
              />
              <span className="text-neutral-500">&deg;</span>
            </span>
          </label>
        </InspectorSection>
      )}

      {(track.kind === "video" || track.kind === "overlay" || track.kind === "audio") && (
        <InspectorSection title="Animate" icon={Gauge}>
          <KeyframeRows
            clip={clip}
            playhead={playhead}
            editDisabled={editDisabled}
            onSetKeyframes={props.onSetKeyframes}
          />
        </InspectorSection>
      )}

      {track.kind === "video" && clip.assetId && (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={editDisabled}
            onClick={props.onDetachAudio}
            title="Move this clip's sound to an audio track (the video keeps playing silently)"
            className="flex flex-1 items-center justify-center gap-1 rounded bg-neutral-200 px-2 py-1.5 text-neutral-800 hover:bg-neutral-300 disabled:opacity-40"
          >
            <Music2 size={12} /> Detach audio
          </button>
          <button
            type="button"
            disabled={editDisabled || detectingScenes}
            onClick={props.onDetectScenes}
            title="Find cuts in the footage and split the clip at each one"
            className="flex flex-1 items-center justify-center gap-1 rounded bg-neutral-200 px-2 py-1.5 text-neutral-800 hover:bg-neutral-300 disabled:opacity-40"
          >
            <Scissors size={12} /> {detectingScenes ? "Detecting…" : "Detect scenes"}
          </button>
        </div>
      )}

      {(track.kind === "text" || clip.title) && (
        <InspectorSection title="Title" icon={TypeIcon}>
          <textarea
            rows={2}
            disabled={editDisabled}
            value={clip.title?.text ?? ""}
            onChange={(e) => props.onSetTitle({ text: e.target.value })}
            placeholder="Title text"
            className="w-full resize-y rounded border border-neutral-300 bg-neutral-200 px-1.5 py-1 text-neutral-900 disabled:opacity-40"
          />
          <label className="flex items-center justify-between gap-2 text-neutral-600">
            <span>Position</span>
            <select
              disabled={editDisabled}
              value={clip.title?.position ?? "center"}
              onChange={(e) => props.onSetTitle({ position: e.target.value as TitleCard["position"] })}
              className="rounded border border-neutral-300 bg-neutral-200 px-1.5 py-1 text-neutral-900 disabled:opacity-40"
            >
              <option value="top">Top</option>
              <option value="center">Center</option>
              <option value="lower-third">Lower third</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-2 text-neutral-600">
            <span>Size</span>
            <span className="flex items-center gap-1">
              <input
                type="number"
                min={2}
                max={30}
                disabled={editDisabled}
                value={Math.round((clip.title?.sizePct ?? 0.07) * 100)}
                onChange={(e) => props.onSetTitle({ sizePct: Math.max(0.02, Math.min(0.3, (parseInt(e.target.value, 10) || 7) / 100)) })}
                className="w-14 rounded border border-neutral-300 bg-neutral-200 px-1 py-0.5 text-neutral-900 disabled:opacity-40"
              />
              % of height
            </span>
          </label>
          <label className="flex items-center justify-between gap-2 text-neutral-600">
            <span>Color</span>
            <input
              type="color"
              disabled={editDisabled}
              value={clip.title?.color ?? "#ffffff"}
              onChange={(e) => props.onSetTitle({ color: e.target.value })}
              className="h-6 w-10 cursor-pointer rounded border border-neutral-300 bg-neutral-200"
            />
          </label>
          <label className="flex items-center justify-between gap-2 text-neutral-600">
            <span>Band</span>
            <span className="flex items-center gap-1.5">
              <input
                type="checkbox"
                disabled={editDisabled}
                checked={!!clip.title?.background}
                onChange={(e) => props.onSetTitle({ background: e.target.checked ? "rgba(0,0,0,0.6)" : undefined })}
              />
              <input
                type="color"
                disabled={editDisabled || !clip.title?.background}
                value={/^#/.test(clip.title?.background ?? "") ? (clip.title?.background as string) : "#000000"}
                onChange={(e) => props.onSetTitle({ background: e.target.value })}
                className="h-6 w-10 cursor-pointer rounded border border-neutral-300 bg-neutral-200 disabled:opacity-40"
              />
            </span>
          </label>
          <label className="flex items-center justify-between gap-2 text-neutral-600">
            <span>Enter</span>
            <select
              disabled={editDisabled}
              value={clip.title?.animIn ?? ""}
              onChange={(e) => props.onSetTitle({ animIn: (e.target.value || undefined) as TitleCard["animIn"] })}
              className="rounded border border-neutral-300 bg-neutral-200 px-1.5 py-1 text-neutral-900 disabled:opacity-40"
            >
              <option value="">None</option>
              <option value="fade">Fade</option>
              <option value="slide-up">Slide up</option>
              <option value="type-on">Type on</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-2 text-neutral-600">
            <span>Exit</span>
            <select
              disabled={editDisabled}
              value={clip.title?.animOut ?? ""}
              onChange={(e) => props.onSetTitle({ animOut: (e.target.value || undefined) as TitleCard["animOut"] })}
              className="rounded border border-neutral-300 bg-neutral-200 px-1.5 py-1 text-neutral-900 disabled:opacity-40"
            >
              <option value="">None</option>
              <option value="fade">Fade</option>
              <option value="slide-down">Slide down</option>
            </select>
          </label>
          {(clip.title?.animIn || clip.title?.animOut) && (
            <label className="flex items-center justify-between gap-2 text-neutral-600">
              <span>Anim length</span>
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  min={2}
                  max={120}
                  disabled={editDisabled}
                  value={clip.title?.animFrames ?? 12}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    props.onSetTitle({ animFrames: Number.isFinite(v) && v !== 12 ? Math.max(2, Math.min(120, v)) : undefined });
                  }}
                  className="w-14 rounded border border-neutral-300 bg-neutral-200 px-1 py-0.5 text-neutral-900 disabled:opacity-40"
                />
                f
              </span>
            </label>
          )}
        </InspectorSection>
      )}

      {isAudio && (
        <InspectorSection title="Audio" icon={Volume2}>
          <label className="flex items-center justify-between gap-2 text-neutral-600">
            <span>Clip gain</span>
            <span className="flex items-center gap-2">
              <input
                type="range"
                min={-60}
                max={6}
                step={1}
                disabled={editDisabled}
                value={clipGain}
                onChange={(e) => props.onSetClipGainDb(parseInt(e.target.value, 10))}
                className="h-1 w-24 accent-emerald-500 disabled:opacity-40"
              />
              <span className="w-10 text-right font-mono tabular-nums text-neutral-700">
                {clipGain > 0 ? "+" : ""}
                {clipGain} dB
              </span>
            </span>
          </label>
          <ReadoutRow label="Track gain" value={`${(track.gainDb ?? 0) > 0 ? "+" : ""}${track.gainDb ?? 0} dB`} />
          {/* fade envelope: seconds in the UI, integer frames in the model */}
          <label className="flex items-center justify-between gap-2 text-neutral-600">
            <span>Fade in</span>
            <span className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                step={0.1}
                disabled={editDisabled}
                value={Number(((clip.fadeInFrames ?? 0) / fps).toFixed(2))}
                onChange={(e) =>
                  props.onSetFades(Math.round(parseFloat(e.target.value || "0") * fps), clip.fadeOutFrames ?? 0)
                }
                className="w-16 rounded border border-neutral-300 bg-neutral-200 px-1 py-0.5 text-neutral-900 disabled:opacity-40"
              />
              s
            </span>
          </label>
          <label className="flex items-center justify-between gap-2 text-neutral-600">
            <span>Fade out</span>
            <span className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                step={0.1}
                disabled={editDisabled}
                value={Number(((clip.fadeOutFrames ?? 0) / fps).toFixed(2))}
                onChange={(e) =>
                  props.onSetFades(clip.fadeInFrames ?? 0, Math.round(parseFloat(e.target.value || "0") * fps))
                }
                className="w-16 rounded border border-neutral-300 bg-neutral-200 px-1 py-0.5 text-neutral-900 disabled:opacity-40"
              />
              s
            </span>
          </label>
          <div className="flex items-center gap-1.5 text-[11px]">
            {track.muted ? (
              <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
                <VolumeX size={12} /> track muted
              </span>
            ) : (
              <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <Volume2 size={12} /> track audible
              </span>
            )}
          </div>
        </InspectorSection>
      )}

      {/* CONVENIENCE ACTIONS (mirror the toolbar) */}
      <div className="flex gap-2">
        <button
          type="button"
          title="Split at playhead (S)"
          disabled={editDisabled}
          onClick={props.onSplit}
          className="flex flex-1 items-center justify-center gap-1 rounded bg-neutral-200 px-2 py-1.5 text-neutral-800 hover:bg-neutral-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Scissors size={12} /> Split
        </button>
        <button
          type="button"
          title="Ripple delete"
          disabled={editDisabled}
          onClick={props.onRippleDelete}
          className="flex flex-1 items-center justify-center gap-1 rounded bg-neutral-200 px-2 py-1.5 text-neutral-800 hover:bg-neutral-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Trash2 size={12} /> Ripple
        </button>
      </div>
    </div>
  );
}

// Compact dark-theme recorder for the media panel: one button per source
// (voice/webcam/screen). Click starts, click again stops; the capture uploads
// as a workspace asset through the panel's normal upload path.
function PanelRecorder(props: {
  mode: "audio" | "video" | "screen";
  disabled: boolean;
  onCapture: (blob: Blob, filename: string) => void;
}): React.ReactElement {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { mode, onCapture } = props;

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recRef.current = null;
  }, []);
  useEffect(() => cleanup, [cleanup]);

  const toggle = useCallback(async () => {
    if (recRef.current) {
      recRef.current.stop();
      return;
    }
    let stream: MediaStream;
    try {
      stream =
        mode === "screen"
          ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
          : await navigator.mediaDevices.getUserMedia(mode === "audio" ? { audio: true } : { audio: true, video: true });
    } catch {
      return; // permission denied or cancelled: the button simply stays idle
    }
    streamRef.current = stream;
    // Ending the share from the browser's own UI must stop the recorder too.
    stream.getVideoTracks()[0]?.addEventListener("ended", () => recRef.current?.stop());
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream);
    } catch {
      cleanup();
      return;
    }
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const type = rec.mimeType || (mode === "audio" ? "audio/webm" : "video/webm");
      const blob = new Blob(chunksRef.current, { type });
      const ext = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : "webm";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      if (blob.size > 0)
        onCapture(blob, `${mode === "audio" ? "voice" : mode === "screen" ? "screen" : "webcam"}-${stamp}.${ext}`);
      cleanup();
      setRecording(false);
      setSeconds(0);
    };
    recRef.current = rec;
    rec.start();
    setRecording(true);
    setSeconds(0);
    timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
  }, [mode, cleanup, onCapture]);

  const label = mode === "audio" ? "Voice" : mode === "screen" ? "Screen" : "Webcam";
  const Icon = mode === "audio" ? Mic : mode === "screen" ? MonitorUp : WebcamIcon;
  const supported =
    typeof navigator !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    (mode === "screen" ? !!navigator.mediaDevices?.getDisplayMedia : !!navigator.mediaDevices?.getUserMedia);
  return (
    <button
      type="button"
      disabled={props.disabled || !supported}
      onClick={() => void toggle()}
      title={recording ? `Stop the ${label.toLowerCase()} recording (uploads on stop)` : `Record ${label.toLowerCase()} into the media panel`}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded px-1 py-1.5 text-[10px] ${
        recording ? "bg-red-600 text-white" : "bg-neutral-200 text-neutral-700 hover:bg-neutral-300"
      } disabled:opacity-40`}
    >
      {recording ? (
        <>
          <span className="pointer-events-none h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
          <span className="pointer-events-none">{seconds}s</span>
        </>
      ) : (
        <>
          <Icon size={13} className="pointer-events-none" />
          <span className="pointer-events-none">{label}</span>
        </>
      )}
    </button>
  );
}

// Current time / total duration readout; click to type a time and seek.
function TimecodeEntry(props: {
  frame: number;
  fps: number;
  durationFrames: number;
  onSeek: (frame: number) => void;
}): React.ReactElement {
  const [text, setText] = useState<string | null>(null); // null = read-only display
  const cancelRef = useRef(false);
  if (text === null) {
    return (
      <button
        type="button"
        title="Click to type a time (mm:ss or mm:ss:ff) and seek"
        onClick={() => setText(formatTimecode(props.frame, props.fps))}
        className="ml-2 rounded px-1 font-mono text-xs tabular-nums text-neutral-600 hover:bg-neutral-200 hover:text-neutral-800"
      >
        {formatTimecode(props.frame, props.fps)}
        <span className="text-neutral-400"> / {formatTimecode(props.durationFrames, props.fps)}</span>
      </button>
    );
  }
  const commit = () => {
    const f = parseTimecode(text, props.fps);
    if (f !== null) props.onSeek(f);
    setText(null);
  };
  return (
    <input
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") {
          // Cancel: clear BEFORE the input unmount fires its blur.
          cancelRef.current = true;
          setText(null);
        }
        e.stopPropagation(); // keep S/M/I/O etc. from firing while typing
      }}
      onBlur={() => {
        if (cancelRef.current) {
          cancelRef.current = false;
          return;
        }
        commit();
      }}
      className="ml-2 w-24 rounded border border-neutral-400 bg-neutral-200 px-1 py-0.5 font-mono text-xs tabular-nums text-neutral-900 focus:outline-none"
    />
  );
}

// Slim per-track peak meter (vertical), rAF style-writes only.
function TrackMeter({ player, trackId }: { player: () => TimelinePlayer; trackId: string }): React.ReactElement {
  const barRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = barRef.current;
      if (el) {
        const level = Math.max(0, Math.min(1, player().trackLevel(trackId)));
        el.style.height = `${Math.round(level * 100)}%`;
        el.style.backgroundColor = level > 0.98 ? "#ef4444" : level > 0.85 ? "#f59e0b" : "#10b981";
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [player, trackId]);
  return (
    <span title="Track level" className="relative ml-0.5 inline-flex h-4 w-1 items-end overflow-hidden rounded-sm bg-neutral-300">
      <span ref={barRef} className="block w-full" />
    </span>
  );
}

// Tiny output peak meter driven straight off the player's analyser via rAF
// (style writes only; no React state at 60fps).
function LevelMeter({ getLevel }: { getLevel: () => number }): React.ReactElement {
  const barRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = barRef.current;
      if (el) {
        const level = Math.max(0, Math.min(1, getLevel()));
        el.style.width = `${Math.round(level * 100)}%`;
        el.style.backgroundColor = level > 0.98 ? "#ef4444" : level > 0.85 ? "#f59e0b" : "#10b981";
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getLevel]);
  return (
    <div title="Output level" className="h-1.5 w-14 overflow-hidden rounded bg-neutral-200">
      <div ref={barRef} className="h-full w-0" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// export dialog
// ---------------------------------------------------------------------------

interface ExportChoice {
  method: "exact" | "server";
  format: "mp4" | "webm" | "gif" | "mp3";
  scale: number;
  crf: number;
  useRange: boolean;
  /** exact path: prefer a WebM recording when the browser supports it. */
  preferWebm?: boolean;
  /** server path: output fps override (0/undefined = project fps). */
  fps?: number;
  skipCaptions?: boolean;
  stemTrackId?: string;
}

const EXPORT_KINDS: {
  kind: "exact-mp4" | "server-mp4" | "server-webm" | "gif" | "mp3";
  label: string;
  hint: string;
  server: boolean;
}[] = [
  {
    kind: "exact-mp4",
    label: "Video (exact)",
    hint: "Plays the timeline once in this tab and records it: keyframes, green screen, and every transition land in the file exactly as previewed.",
    server: false,
  },
  {
    kind: "server-mp4",
    label: "Video MP4 (fast)",
    hint: "Renders on the server, usually much faster than realtime, and the tab stays free. Cross-dissolves render truly; wipe/slide become fades; clip keyframes and green screen are not applied.",
    server: true,
  },
  {
    kind: "server-webm",
    label: "Video WebM (fast)",
    hint: "VP9/Opus WebM rendered on the server: smaller files, ideal for the web. Same fidelity notes as fast MP4.",
    server: true,
  },
  {
    kind: "gif",
    label: "GIF",
    hint: "Silent animated GIF at up to 15 fps, rendered on the server. Best for short clips or a marked range.",
    server: true,
  },
  {
    kind: "mp3",
    label: "MP3 (audio only)",
    hint: "Just the audio mix, rendered on the server.",
    server: true,
  },
];

function ExportDialog(props: {
  hasRange: boolean;
  rangeFrames: number;
  durationFrames: number;
  fps: number;
  stagePixels: number;
  captionsPresent: boolean;
  audioTracks: { id: string; label: string }[];
  serverAvailable: boolean;
  onStart: (choice: ExportChoice) => void;
  onClose: () => void;
}): React.ReactElement {
  const [kind, setKind] = useState<"exact-mp4" | "server-mp4" | "server-webm" | "gif" | "mp3">("exact-mp4");
  const [preferWebm, setPreferWebm] = useState(false);
  const [fpsOverride, setFpsOverride] = useState(0);
  const [burnCaptions, setBurnCaptions] = useState(true);
  const [stemTrackId, setStemTrackId] = useState("");
  const [quality, setQuality] = useState<"high" | "standard" | "compact">("standard");
  const [scale, setScale] = useState(1);
  const [useRange, setUseRange] = useState(props.hasRange);
  const isServer = kind !== "exact-mp4";
  const frames = useRange && props.hasRange ? props.rangeFrames : props.durationFrames;
  const seconds = Math.max(0, Math.round(frames / props.fps));

  const start = () => {
    props.onStart({
      method: isServer ? "server" : "exact",
      format: kind === "gif" ? "gif" : kind === "mp3" ? "mp3" : kind === "server-webm" ? "webm" : "mp4",
      scale,
      crf:
        kind === "server-webm"
          ? quality === "high" ? 28 : quality === "compact" ? 38 : 32
          : quality === "high" ? 18 : quality === "compact" ? 26 : 20,
      useRange: useRange && props.hasRange,
      preferWebm,
      fps: fpsOverride || undefined,
      skipCaptions: props.captionsPresent ? !burnCaptions : undefined,
      stemTrackId: kind === "mp3" && stemTrackId ? stemTrackId : undefined,
    });
  };

  // Very rough output size estimate (order-of-magnitude honesty only).
  const estimate = (() => {
    const secs = Math.max(1, seconds);
    const px = props.stagePixels * scale * scale;
    const outFps = fpsOverride || props.fps;
    if (kind === "mp3") return (192_000 / 8) * secs;
    if (kind === "gif") return px * Math.min(outFps, 15) * secs * 0.06;
    const bpp = kind === "server-webm" ? 0.045 : quality === "high" ? 0.12 : quality === "compact" ? 0.05 : 0.08;
    return ((px * outFps * bpp) / 8) * secs + (192_000 / 8) * secs;
  })();
  const estimateLabel = estimate > 1_500_000 ? `~${(estimate / 1_048_576).toFixed(1)} MB` : `~${Math.round(estimate / 1024)} KB`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={props.onClose}
      role="dialog"
      aria-label="Export"
    >
      <div
        className="w-[26rem] max-w-[calc(100vw-2rem)] rounded-lg border border-neutral-300 bg-neutral-100 p-4 text-xs shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-sm font-semibold text-neutral-900">Export</div>
        <div className="flex flex-col gap-1.5">
          {EXPORT_KINDS.map((k) => {
            const disabled = k.server && !props.serverAvailable;
            return (
              <label
                key={k.kind}
                className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 ${
                  kind === k.kind ? "border-brand-600 bg-neutral-200" : "border-neutral-200 hover:border-neutral-300"
                } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
              >
                <input
                  type="radio"
                  name="export-kind"
                  className="mt-0.5"
                  disabled={disabled}
                  checked={kind === k.kind}
                  onChange={() => {
                    setKind(k.kind);
                    if (k.kind === "gif") setScale(0.5);
                  }}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium text-neutral-900">{k.label}</span>
                  <span className="text-[11px] leading-snug text-neutral-600">{k.hint}</span>
                </span>
              </label>
            );
          })}
        </div>
        {!props.serverAvailable && (
          <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
            Server formats need the design saved to a workspace first.
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-4">
          {!isServer && (
            <label className="flex items-center gap-1.5 text-neutral-600" title="MP4 is used when the browser supports recording it">
              <input type="checkbox" checked={preferWebm} onChange={(e) => setPreferWebm(e.target.checked)} />
              Prefer WebM
            </label>
          )}
          {isServer && kind !== "mp3" && kind !== "gif" && (
            <label className="flex items-center gap-1.5 text-neutral-600">
              Frame rate
              <select
                value={fpsOverride}
                onChange={(e) => setFpsOverride(parseInt(e.target.value, 10))}
                className="rounded border border-neutral-300 bg-neutral-200 px-1.5 py-1 text-neutral-900"
              >
                <option value={0}>Project ({props.fps})</option>
                {[24, 25, 30, 50, 60].filter((f) => f !== props.fps).map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </label>
          )}
          {isServer && kind !== "mp3" && props.captionsPresent && (
            <label className="flex items-center gap-1.5 text-neutral-600">
              <input type="checkbox" checked={burnCaptions} onChange={(e) => setBurnCaptions(e.target.checked)} />
              Burn captions
            </label>
          )}
          {kind === "mp3" && props.audioTracks.length > 0 && (
            <label className="flex items-center gap-1.5 text-neutral-600">
              Audio
              <select
                value={stemTrackId}
                onChange={(e) => setStemTrackId(e.target.value)}
                title="A single track exports pre-master (no ducking, no master gain)"
                className="max-w-[10rem] rounded border border-neutral-300 bg-neutral-200 px-1.5 py-1 text-neutral-900"
              >
                <option value="">Master mix</option>
                {props.audioTracks.map((t) => (
                  <option key={t.id} value={t.id}>{t.label} (stem)</option>
                ))}
              </select>
            </label>
          )}
          {isServer && kind !== "mp3" && (
            <label className="flex items-center gap-1.5 text-neutral-600">
              Resolution
              <select
                value={scale}
                onChange={(e) => setScale(parseFloat(e.target.value))}
                className="rounded border border-neutral-300 bg-neutral-200 px-1.5 py-1 text-neutral-900"
              >
                <option value={1}>Full</option>
                <option value={0.5}>Half</option>
                <option value={0.25}>Quarter</option>
              </select>
            </label>
          )}
          {(kind === "server-mp4" || kind === "server-webm") && (
            <label className="flex items-center gap-1.5 text-neutral-600">
              Quality
              <select
                value={quality}
                onChange={(e) => setQuality(e.target.value as "high" | "standard" | "compact")}
                className="rounded border border-neutral-300 bg-neutral-200 px-1.5 py-1 text-neutral-900"
              >
                <option value="high">High</option>
                <option value="standard">Standard</option>
                <option value="compact">Small file</option>
              </select>
            </label>
          )}
        </div>

        <div className="mt-2 flex items-center gap-4">
          <label className={`flex items-center gap-1.5 ${props.hasRange ? "text-neutral-700" : "text-neutral-400"}`}>
            <input
              type="checkbox"
              disabled={!props.hasRange}
              checked={useRange && props.hasRange}
              onChange={(e) => setUseRange(e.target.checked)}
            />
            Marked range only
          </label>
          {!props.hasRange && (
            <span className="text-[10px] text-neutral-400">set a range with I and O on the timeline</span>
          )}
        </div>

        <div className="mt-3 flex items-center justify-between border-t border-neutral-200 pt-3">
          <span className="text-[11px] text-neutral-500">
            {seconds >= 1 ? `${seconds}s of timeline` : "under a second"}
            {kind === "exact-mp4" ? " · records in real time" : " · renders in the background"}
            {` · ${estimateLabel} (rough)`}
          </span>
          <span className="flex gap-2">
            <button
              type="button"
              onClick={props.onClose}
              className="rounded-md bg-neutral-200 px-3 py-1.5 font-medium text-neutral-800 hover:bg-neutral-300"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={start}
              className="rounded-md bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700"
            >
              Start export
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

// Labeled slider with a numeric readout; double-click snaps back to neutral.
function ColorSlider(props: {
  label: string;
  min: number;
  max: number;
  neutral: number;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}): React.ReactElement {
  return (
    <label className="flex items-center justify-between gap-2 text-neutral-600">
      <span>{props.label}</span>
      <span className="flex items-center gap-2">
        <input
          type="range"
          min={props.min}
          max={props.max}
          step={0.01}
          disabled={props.disabled}
          value={props.value}
          onChange={(e) => props.onChange(parseFloat(e.target.value))}
          onDoubleClick={() => props.onChange(props.neutral)}
          title="Double-click to reset"
          className="h-1 w-24 accent-emerald-500 disabled:opacity-40"
        />
        <span className="w-8 text-right font-mono tabular-nums text-neutral-700">
          {props.value.toFixed(2)}
        </span>
      </span>
    </label>
  );
}

// A dark-themed titled section for the inspector (matches the surface chrome,
// unlike the light-panel CollapsibleSection used elsewhere in the editor).
function InspectorSection(props: {
  title: string;
  icon: React.ComponentType<{ className?: string; size?: number }>;
  children: React.ReactNode;
}): React.ReactElement {
  const Icon = props.icon;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-neutral-200 bg-neutral-50/40 p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-600">
        <Icon size={12} className="text-neutral-500" />
        {props.title}
      </div>
      {props.children}
    </div>
  );
}

// A label/value readout row with an optional secondary (timecode) line.
function ReadoutRow(props: { label: string; value: string; sub?: string }): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-neutral-500">{props.label}</span>
      <span className="flex items-baseline gap-1.5 font-mono tabular-nums text-neutral-800">
        {props.value}
        {props.sub && <span className="text-[10px] text-neutral-500">{props.sub}</span>}
      </span>
    </div>
  );
}

// One clip-edge transition control: a type selector plus a duration input that
// is only meaningful (and enabled) when a transition type is set on the edge.
function TransitionEdge(props: {
  label: string;
  edge: "in" | "out";
  transition?: ClipTransition;
  disabled: boolean;
  onSetTransition: (edge: "in" | "out", type: "" | ClipTransition["type"]) => void;
  onSetDuration: (edge: "in" | "out", durationFrames: number) => void;
}): React.ReactElement {
  const t = props.transition;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-neutral-500">{props.label}</span>
      <div className="flex items-center gap-1.5">
        <select
          disabled={props.disabled}
          value={t?.type ?? ""}
          onChange={(e) =>
            props.onSetTransition(props.edge, e.target.value as "" | ClipTransition["type"])
          }
          className="min-w-0 flex-1 rounded border border-neutral-300 bg-neutral-200 px-1.5 py-1 text-neutral-900 disabled:opacity-40"
        >
          {TRANSITION_TYPES.map((opt) => (
            <option key={opt.value || "none"} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          step={1}
          title="Transition duration (frames)"
          disabled={props.disabled || !t}
          value={t?.durationFrames ?? ""}
          onChange={(e) => props.onSetDuration(props.edge, parseInt(e.target.value, 10))}
          className="w-14 rounded border border-neutral-300 bg-neutral-200 px-1.5 py-1 text-right text-neutral-900 disabled:opacity-40"
        />
        <span className="text-neutral-400">f</span>
      </div>
    </div>
  );
}

function TransportButton(props: {
  title: string;
  onClick: () => void;
  accent?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={props.title}
      onClick={props.onClick}
      className={`grid h-8 w-8 place-items-center rounded ${
        props.accent
          ? "bg-brand-600 text-white hover:bg-brand-700"
          : "bg-neutral-200 text-neutral-800 hover:bg-neutral-300"
      }`}
    >
      {props.children}
    </button>
  );
}

function ToolbarButton(props: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={props.title}
      onClick={props.onClick}
      disabled={props.disabled}
      className={`flex items-center gap-1 rounded px-2 py-1 disabled:cursor-not-allowed disabled:opacity-40 ${
        props.active
          ? "bg-brand-600 text-white hover:bg-brand-700"
          : "bg-neutral-200 text-neutral-800 hover:bg-neutral-300"
      }`}
    >
      {props.children}
    </button>
  );
}

// Keyframe editor rows: one animatable property at a time; "Add" captures the
// typed value at the playhead's local frame. Values: opacity 0..1, scale
// multiplier, dx/dy as fractions of the stage size.
function KeyframeRows({ clip, playhead, editDisabled, onSetKeyframes }: {
  clip: Clip;
  playhead: number;
  editDisabled: boolean;
  onSetKeyframes: (tracks: KeyframeTrack[]) => void;
}) {
  const [property, setProperty] = useState<"opacity" | "scale" | "dx" | "dy" | "gain">("opacity");
  const [value, setValue] = useState("1");
  const localFrame = Math.max(0, Math.round(playhead) - clip.startFrame);
  const tracks = clip.keyframes ?? [];
  const addKeyframe = () => {
    const v = parseFloat(value);
    if (!Number.isFinite(v)) return;
    const existing = tracks.find((t) => t.property === property);
    const keyframes = [
      ...(existing?.keyframes ?? []).filter((k) => k.frame !== localFrame),
      { frame: localFrame, value: v },
    ].sort((a, b) => a.frame - b.frame);
    const next = existing
      ? tracks.map((t) => (t.property === property ? { ...t, keyframes } : t))
      : [...tracks, { property, keyframes }];
    onSetKeyframes(next);
  };
  const removeKeyframe = (prop: string, frame: number) => {
    const next = tracks
      .map((t) => (t.property === prop ? { ...t, keyframes: t.keyframes.filter((k) => k.frame !== frame) } : t))
      .filter((t) => t.keyframes.length > 0);
    onSetKeyframes(next);
  };
  const dur = clipDurationFrames(clip);
  // The property track the easing select edits: the selected property when it
  // has keyframes, else the first animated property.
  const easingTrack = tracks.find((t) => t.property === property) ?? tracks[0];
  const easingValue = easingTrack?.keyframes.find((k) => k.easing)?.easing ?? "linear";
  return (
    <>
      {/* one-click motion presets (ordinary keyframes; edit them below) */}
      <div className="flex flex-wrap gap-1">
        {MOTION_PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            disabled={editDisabled}
            onClick={() => onSetKeyframes(applyMotionPreset(clip.keyframes, p.name, dur))}
            title="Writes pose keyframes over the clip edge; entrance and exit presets combine"
            className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-700 hover:bg-neutral-300 disabled:opacity-40"
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <select
          disabled={editDisabled}
          value={property}
          onChange={(e) => setProperty(e.target.value as typeof property)}
          className="rounded border border-neutral-300 bg-neutral-200 px-1 py-0.5 text-neutral-900 disabled:opacity-40"
        >
          <option value="opacity">Opacity</option>
          <option value="scale">Scale</option>
          <option value="dx">Offset X</option>
          <option value="dy">Offset Y</option>
          <option value="gain">Gain (dB)</option>
        </select>
        <input
          type="number"
          step={0.05}
          disabled={editDisabled}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-16 rounded border border-neutral-300 bg-neutral-200 px-1 py-0.5 text-neutral-900 disabled:opacity-40"
        />
        <button
          type="button"
          disabled={editDisabled || localFrame < 0}
          onClick={addKeyframe}
          title="Add a keyframe for this property at the playhead"
          className="rounded bg-neutral-200 px-2 py-0.5 text-neutral-800 hover:bg-neutral-300 disabled:opacity-40"
        >
          + at {localFrame}f
        </button>
      </div>
      {easingTrack && (
        <label className="flex items-center justify-between gap-2 text-neutral-600">
          <span>Easing ({easingTrack.property})</span>
          <select
            disabled={editDisabled}
            value={easingValue}
            onChange={(e) =>
              onSetKeyframes(
                setTrackEasing(
                  clip.keyframes,
                  easingTrack.property,
                  e.target.value === "linear" ? undefined : e.target.value,
                ),
              )
            }
            className="rounded border border-neutral-300 bg-neutral-200 px-1 py-0.5 text-neutral-900 disabled:opacity-40"
          >
            <option value="linear">Linear</option>
            <option value="easeIn">Ease in</option>
            <option value="easeOut">Ease out</option>
            <option value="easeInOut">Ease in-out</option>
          </select>
        </label>
      )}
      {tracks.length === 0 ? (
        <div className="text-[11px] text-neutral-400">No keyframes. Values interpolate between frames.</div>
      ) : (
        tracks.map((t) =>
          t.keyframes.map((k) => (
            <div key={`${t.property}-${k.frame}`} className="flex items-center gap-1.5 text-[11px] text-neutral-600">
              <span className="w-14">{t.property}</span>
              <span className="font-mono tabular-nums">{k.frame}f</span>
              <span className="font-mono tabular-nums text-neutral-700">{String(k.value)}</span>
              <button
                type="button"
                disabled={editDisabled}
                onClick={() => removeKeyframe(t.property, k.frame)}
                className="ml-auto rounded p-0.5 text-neutral-500 hover:bg-neutral-300 hover:text-red-600 dark:hover:text-red-400"
              >
                <Trash2 size={11} />
              </button>
            </div>
          )),
        )
      )}
    </>
  );
}

// The per-clip gain math (@hc/audio effectiveClipGain x fade envelope x
// ducking automation) lives in lib/video/compositor.clipGainAt, shared by the
// live preview mix and the export recording.
