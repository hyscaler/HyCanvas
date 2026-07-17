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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Play,
  Pause,
  Square,
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
  Headphones,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  PanelRightClose,
  PanelRightOpen,
  Gauge,
  Download,
  Loader2,
} from "lucide-react";
import {
  newProject,
  newTrack,
  trim,
  splitClip,
  rippleDelete,
  moveClip,
  setSpeed,
  addTransition,
  snapFrameToBeats,
  clipEndFrame,
  clipDurationFrames,
  projectDurationFrames,
  clipAtFrame,
  clipsOverlap,
  sortClips,
  remapFps,
  type Fps,
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
import { drawTimelineFrame, drawCaption, evalKeyframes, upsertPoseKeyframe, activeClipsAt } from "@/lib/video/compositor";
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
const DEFAULT_CLIP_FRAMES = 60; // length of a freshly added placeholder clip
const TRIM_STEP = 6; // frames per trim-button press
const MIN_PX_PER_FRAME = 0.25;
const MAX_PX_PER_FRAME = 12;
// Per-user persisted open/closed state for the right clip-inspector aside.
const INSPECTOR_OPEN_KEY = "oc-video-inspector-open";
// Stage size presets (the common social/broadcast formats).
const STAGE_PRESETS: { value: string; label: string }[] = [
  { value: "1920x1080", label: "1920x1080 (16:9)" },
  { value: "1080x1920", label: "1080x1920 (9:16)" },
  { value: "1080x1080", label: "1080x1080 (1:1)" },
  { value: "1280x720", label: "1280x720 (720p)" },
  { value: "3840x2160", label: "3840x2160 (4K)" },
];

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
  return { ...project, durationFrames: projectDurationFrames(project) };
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
  excludeClipId: string,
  playhead: number,
): number[] {
  const set = new Set<number>();
  set.add(0);
  set.add(playhead);
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.id === excludeClipId) continue;
      set.add(clip.startFrame);
      set.add(clipEndFrame(clip));
    }
  }
  for (const m of project.markers ?? []) set.add(m);
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
    } catch {
      /* keep the previous list on a transient failure */
    }
  }, [workspaceId]);
  useEffect(() => {
    // Deferred to a microtask so the effect body itself never sets state.
    queueMicrotask(() => void loadAssets());
  }, [loadAssets]);

  // Upload media straight from the panel (direct upload with a progress
  // readout; falls back to the legacy endpoint against an older server).
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const onUploadFiles = useCallback(
    async (files: FileList | null) => {
      if (!workspaceId || !files?.length) return;
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
      } catch {
        /* the panel simply keeps its list; the user can retry */
      } finally {
        setUploadPct(null);
        if (uploadInputRef.current) uploadInputRef.current.value = "";
      }
    },
    [workspaceId, loadAssets],
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
          const url = a.kind === "video" && proxyOkRef.current.get(a.id) ? proxyUrlFor(a) : resolveAssetUrl(a.url);
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
  const toggleInSelection = useCallback((id: string) => {
    setMultiIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelectedClipId(id);
  }, []);
  // Mirror for the overlay-chrome paint loop (armed once).
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selectedClipId;
  }, [selectedClipId]);
  const [pxPerFrame, setPxPerFrame] = useState(2);
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

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);

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
  const editDisabled = !selected || !!selected.track.locked;

  const durationFrames = project ? Math.max(project.durationFrames, project.fps) : 0;

  // Clamp the playhead if the project shrank (e.g. after a ripple delete). This
  // is React's sanctioned "adjust state during render" pattern, which avoids a
  // cascading setState inside an effect.
  if (playhead > durationFrames) setPlayhead(durationFrames);

  // -------------------------------------------------------------------------
  // transport: advance the playhead at the project fps via rAF; stop/loop at
  // durationFrames. The playhead is local UI state, not persisted per frame.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!playing || !project) return;
    const fps = project.fps;
    const step = (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const dtSec = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      setPlayhead((prev) => {
        const next = prev + dtSec * fps;
        if (next >= durationFrames) {
          // Stop at the end (no loop) so the user sees a clear playback finish.
          setPlaying(false);
          return durationFrames;
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
  }, [playing, project, durationFrames]);

  const frame = Math.round(playhead);

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
          if (loading > 0) {
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
    getPlayer().syncAt(project, frame, playing, duckPoints);
  }, [project, frame, playing, duckPoints, getPlayer]);

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
  const assetMap = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

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
  const doServerExport = useCallback(async () => {
    if (!props.designId || serverExporting) return;
    setServerExporting(true);
    setExportMsg("Rendering on the server…");
    try {
      // Flush the current document first: the job renders the PERSISTED file,
      // and racing the autosave would render a stale (or empty) timeline.
      await oc.saveSnapshot(props.designId, { file: useEditor.getState().doc, kind: "checkpoint" });
      useEditor.getState().markClean();
      const { jobId } = await oc.startVideoExport(props.designId, {
        startFrame: project?.range?.startFrame,
        endFrame: project?.range?.endFrame,
      });
      for (let i = 0; i < 800; i++) {
        const job = await oc.getJob(jobId);
        if (job.status === "completed") {
          // Fetch as a blob and download through the same object-URL path the
          // in-browser export uses (a cross-origin <a download> click is
          // unreliable: the attribute is ignored cross-origin).
          const res = await fetch(oc.videoExportDownloadUrl(props.designId, jobId), { credentials: "include" });
          if (!res.ok) throw new Error(`download failed (${res.status})`);
          downloadBlob(await res.blob(), `${(docTitle || "video").replace(/[^\w.-]+/g, "_")}.mp4`);
          setExportMsg("Downloaded MP4 (server render)");
          return;
        }
        if (job.status === "failed") {
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
  }, [props.designId, serverExporting, docTitle, project]);

  const doExportVideo = useCallback(async () => {
    if (!project) return;
    if (exportRef.current) {
      void finishExport(true); // acting as Cancel
      return;
    }
    const target = pickRecorderTarget();
    const canvas = stageCanvasRef.current;
    const player = getPlayer();
    if (!target || !canvas || typeof canvas.captureStream !== "function") {
      setExportMsg("This browser cannot record video (MediaRecorder unavailable).");
      return;
    }
    setExporting(true);
    setExportMsg(null);
    await player.resumeAudio();
    const startFrame = project.range?.startFrame ?? 0;
    const endFrame = Math.min(project.range?.endFrame ?? durationFrames, durationFrames);
    setPlayhead(startFrame);
    const controller = startRecording(canvas, player.audioStream(), project.fps, target);
    exportRef.current = { controller, startFrame, endFrame, extension: target.extension };
    setPlaying(true);
  }, [project, durationFrames, finishExport, getPlayer]);

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
  const stageDragRef = useRef<{
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

  const onStagePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!stageTarget) return;
      e.preventDefault();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      const pose = evalKeyframes(stageTarget.clip.keyframes, stageTarget.localFrame);
      stageDragRef.current = {
        clipId: stageTarget.clip.id,
        trackId: stageTarget.track.id,
        startX: e.clientX,
        startY: e.clientY,
        base: { dx: pose.dx, dy: pose.dy, scale: pose.scale },
        localFrame: stageTarget.localFrame,
      };
    },
    [stageTarget],
  );
  const onStagePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = stageDragRef.current;
      if (!d) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      applyPose(d.clipId, d.trackId, d.localFrame, {
        dx: d.base.dx + (e.clientX - d.startX) / rect.width,
        dy: d.base.dy + (e.clientY - d.startY) / rect.height,
      }, false);
    },
    [applyPose],
  );
  const onStagePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const d = stageDragRef.current;
      stageDragRef.current = null;
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      if (!d) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      applyPose(d.clipId, d.trackId, d.localFrame, {
        dx: d.base.dx + (e.clientX - d.startX) / Math.max(1, rect.width),
        dy: d.base.dy + (e.clientY - d.startY) / Math.max(1, rect.height),
      }, true);
    },
    [applyPose],
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
          const sel = selectedRef.current;
          if (sel) {
            const active = activeClipsAt(p, f).find((a) => a.clip.id === sel);
            if (active && (active.track.kind === "video" || active.track.kind === "overlay") && !active.track.hidden) {
              const pose = evalKeyframes(active.clip.keyframes, active.localFrame);
              const W = p.stage.width;
              const H = p.stage.height;
              const cx = W / 2 + pose.dx * W;
              const cy = H / 2 + pose.dy * H;
              const w = W * pose.scale;
              const h = H * pose.scale;
              ctx.save();
              ctx.strokeStyle = "rgba(255,255,255,0.85)";
              ctx.setLineDash([10, 7]);
              ctx.lineWidth = Math.max(2, Math.round(W / 640));
              ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
              ctx.restore();
            }
          }
        }
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, []);
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

  // Detach audio: a linked audio clip with the same source window lands on the
  // first unlocked audio track (created when missing) and the video clip's own
  // sound is silenced. The video asset's element still carries the audio.
  const detachAudio = useCallback(() => {
    if (!project || !selected || selected.track.kind !== "video" || !selected.clip.assetId) return;
    let tracks = project.tracks;
    let audioTrack = tracks.find((t) => t.kind === "audio" && !t.locked);
    if (!audioTrack) {
      audioTrack = newTrack("audio", `Audio ${tracks.filter((t) => t.kind === "audio").length + 1}`);
      tracks = [...tracks, audioTrack];
    }
    const srcClip = selected.clip;
    const startFrame = freeStartFrame(audioTrack, clipDurationFrames(srcClip), srcClip.startFrame);
    const audioClip: Clip = {
      id: shortId("clip"),
      assetId: srcClip.assetId,
      startFrame,
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
          ? { ...t, clips: t.clips.map((c) => (c.id === srcClip.id ? { ...c, audioGainDb: -60 } : c)) }
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
  const toggleMarker = useCallback(() => {
    if (!project) return;
    const markers = project.markers ?? [];
    const near = markers.find((m) => Math.abs(m - frame) <= 2);
    const next = near !== undefined ? markers.filter((m) => m !== near) : [...markers, frame].sort((a, b) => a - b);
    persist({ ...project, markers: next });
  }, [project, frame, persist]);

  // Export/preview range: I marks in, O marks out (invalid pairs collapse).
  const markRange = useCallback(
    (edge: "in" | "out") => {
      if (!project) return;
      const cur = project.range;
      let startFrame = edge === "in" ? frame : cur?.startFrame ?? 0;
      let endFrame = edge === "out" ? frame : cur?.endFrame ?? durationFrames;
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

  // Clip clipboard (Cmd/Ctrl+C / V): pastes at the playhead on the source
  // track (or the first surviving track of the same kind), new id, no overlap.
  const clipboardRef = useRef<{ trackId: string; kind: Track["kind"]; clip: Clip } | null>(null);
  const [hasClipboard, setHasClipboard] = useState(false);
  const copySelectedClip = useCallback(() => {
    if (!selected) return;
    clipboardRef.current = { trackId: selected.track.id, kind: selected.track.kind, clip: structuredClone(selected.clip) };
    setHasClipboard(true);
  }, [selected]);
  const pasteClip = useCallback(() => {
    if (!project || !clipboardRef.current) return;
    const { trackId, kind, clip } = clipboardRef.current;
    const track = project.tracks.find((t) => t.id === trackId && !t.locked) ?? project.tracks.find((t) => t.kind === kind && !t.locked);
    if (!track) return;
    const dur = clipDurationFrames(clip);
    const startFrame = freeStartFrame(track, dur, frame);
    const pasted: Clip = { ...structuredClone(clip), id: shortId("clip"), startFrame };
    const nextTrack: Track = { ...track, clips: sortClips([...track.clips, pasted]) };
    persist(replaceTrack(project, nextTrack));
    selectOnly(pasted.id);
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
  const setProjectFps = useCallback(
    (nextFps: Fps) => {
      if (!project || nextFps === project.fps) return;
      const from = project.fps;
      const map = (f: number) => remapFps(f, from, nextFps);
      const tracks = project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => ({
          ...c,
          startFrame: map(c.startFrame),
          inFrame: map(c.inFrame),
          outFrame: Math.max(map(c.inFrame) + 1, map(c.outFrame)),
          fadeInFrames: c.fadeInFrames !== undefined ? map(c.fadeInFrames) : undefined,
          fadeOutFrames: c.fadeOutFrames !== undefined ? map(c.fadeOutFrames) : undefined,
          transitionIn: c.transitionIn ? { ...c.transitionIn, durationFrames: Math.max(1, map(c.transitionIn.durationFrames)) } : undefined,
          transitionOut: c.transitionOut ? { ...c.transitionOut, durationFrames: Math.max(1, map(c.transitionOut.durationFrames)) } : undefined,
        })),
      }));
      const captions = project.captions?.map((ct) => ({
        ...ct,
        cues: ct.cues.map((q) => ({ ...q, startFrame: map(q.startFrame), endFrame: Math.max(map(q.startFrame) + 1, map(q.endFrame)) })),
      }));
      persist(withDuration({ ...project, fps: nextFps, tracks, captions }));
    },
    [project, persist],
  );

  const doSplit = useCallback(() => {
    if (!project || !selected || selected.track.locked) return;
    const next = splitClip(selected.track, selected.clip.id, frame);
    persist(replaceTrack(project, next));
  }, [project, selected, frame, persist]);

  const doRippleDelete = useCallback(() => {
    if (!project || !selected || selected.track.locked) return;
    const next = rippleDelete(selected.track, selected.clip.id);
    persist(replaceTrack(project, next));
    selectOnly(null);
  }, [project, selected, persist]);

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
      // Clipboard chords first (the plain-key switch below skips modifiers).
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
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
          setPlaying((p) => !p);
          break;
        case "s":
        case "S":
          e.preventDefault();
          doSplit();
          break;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          if (multiIds.size > 1) deleteSelected();
          else doRippleDelete();
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
  }, [doSplit, doRippleDelete, durationFrames, toggleMarker, markRange, copySelectedClip, pasteClip, multiIds, deleteSelected]);

  const doTrim = useCallback(
    (edge: "in" | "out", delta: number) => {
      if (!project || !selected || selected.track.locked) return;
      const next = trim(selected.track, selected.clip.id, edge, delta);
      persist(replaceTrack(project, next));
    },
    [project, selected, persist],
  );

  const doSetSpeed = useCallback(
    (speed: number) => {
      if (!project || !selected || selected.track.locked) return;
      const nextClip = setSpeed(selected.clip, speed);
      const nextTrack: Track = {
        ...selected.track,
        clips: selected.track.clips.map((c) => (c.id === nextClip.id ? nextClip : c)),
      };
      persist(replaceTrack(project, nextTrack));
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

  const toggleDucking = useCallback(() => {
    if (!project) return;
    const audioTracks = project.tracks.filter((t) => t.kind === "audio");
    let nextMaster = { ...project.master };
    if (project.master.ducking) {
      // Turn off: drop the config.
      nextMaster = { gainDb: project.master.gainDb };
    } else if (audioTracks.length >= 2) {
      // Auto-duck the first audio track (music) under the second (voice). With a
      // single audio track there is nothing to duck against, so the toggle no-ops.
      nextMaster = {
        ...nextMaster,
        ducking: {
          musicTrackId: audioTracks[0].id,
          voiceTrackId: audioTracks[1].id,
          amountDb: -12,
          attackMs: 80,
          releaseMs: 400,
        },
      };
    } else {
      return; // need at least two audio tracks for a sidechain
    }
    const next: VideoProject = { ...project, master: nextMaster };
    persist(next);
  }, [project, persist]);

  // When ducking is configured, validate it produces a non-trivial automation
  // curve via the pure solver. Voice activity is derived from the voice track's
  // clip windows (caption cues are deferred). This is informational for the MVP.
  const duckingInfo = useMemo(() => {
    if (!project || !project.master.ducking) return null;
    const voiceId = project.master.ducking.voiceTrackId;
    const voiceTrack = project.tracks.find((t) => t.id === voiceId);
    const windows = (voiceTrack?.clips ?? []).map((c) => ({
      startFrame: c.startFrame,
      endFrame: clipEndFrame(c),
    }));
    const points = solveDucking(project.master, windows, project.durationFrames, project.fps);
    return { count: points.length, lowestDb: Math.min(...points.map((p) => p.musicGainDb)) };
  }, [project]);

  // -------------------------------------------------------------------------
  // clip drag: move (horizontal + across compatible lanes) and edge trims.
  // Every pointer step recomputes from the pointer-down snapshot, so a drag is
  // stateless and commits as ONE undo step on release.
  // -------------------------------------------------------------------------
  const dragRef = useRef<{
    mode: "move" | "trim-in" | "trim-out";
    clipId: string;
    trackId: string; // source track
    startClientX: number;
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
    return Math.floor(y / TRACK_HEIGHT);
  }, []);

  const onClipPointerDown = useCallback(
    (e: React.PointerEvent, track: Track, clip: Clip, mode: "move" | "trim-in" | "trim-out" = "move") => {
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
      if (multiIds.has(clip.id) && multiIds.size > 1) setSelectedClipId(clip.id);
      else selectOnly(clip.id);
      // A locked track is selectable but not draggable: select, then bail out
      // before arming the drag so no move gesture starts.
      if (track.locked || !project) return;
      try {
        (e.target as Element).setPointerCapture?.(e.pointerId);
      } catch {
        /* synthetic pointer without an active id: capture is best-effort */
      }
      dragRef.current = {
        mode,
        clipId: clip.id,
        trackId: track.id,
        startClientX: e.clientX,
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

      if (drag.mode !== "move") {
        // Edge trim: the drag distance converts to SOURCE frames (the source
        // window scales by |speed|), applied by the pure trim() op. A step
        // that would overlap a neighbour is skipped, so the edge sticks at
        // the boundary instead of overlapping.
        const edge = drag.mode === "trim-in" ? "in" : "out";
        const sourceDelta = Math.round(timelineDelta * Math.abs(clip.speed));
        const nextTrack = trim(srcTrack, clip.id, edge, sourceDelta);
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
        if (!e.altKey) {
          const targets = snapTargets(orig, drag.clipId, frame);
          const tol = Math.max(2, Math.round(6 / pxPerFrame));
          target = snapFrameToBeats(raw, targets, tol);
        }
        setSnapGuide(target !== raw ? target : null);
        const delta = target - clip.startFrame;
        const tracks = orig.tracks.map((t) => ({
          ...t,
          clips: sortClips(
            t.clips.map((c) => (multiIds.has(c.id) && !t.locked ? { ...c, startFrame: Math.max(0, c.startFrame + delta) } : c)),
          ),
        }));
        setDraftProject(withDuration({ ...orig, tracks }));
        return;
      }

      // Move: horizontal target frame (snapped), plus the lane under the
      // pointer when it is a different, compatible, unlocked track.
      const raw = Math.max(0, Math.round(clip.startFrame + timelineDelta));
      let target = raw;
      if (!e.altKey) {
        const targets = snapTargets(orig, drag.clipId, frame);
        const tol = Math.max(2, Math.round(6 / pxPerFrame)); // ~6px snap radius
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
    [pxPerFrame, frame, laneIndexAt, multiIds],
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

  // -------------------------------------------------------------------------
  // ruler ticks: a tick per second, labelled with mm:ss.
  // -------------------------------------------------------------------------
  const rulerTicks = useMemo(() => {
    if (!project) return [] as { frame: number; label: string }[];
    const fps = project.fps;
    const out: { frame: number; label: string }[] = [];
    const totalSeconds = Math.ceil(durationFrames / fps) + 2;
    for (let s = 0; s <= totalSeconds; s++) {
      const f = s * fps;
      const mm = Math.floor(s / 60);
      const ss = s % 60;
      out.push({ frame: f, label: `${mm}:${ss.toString().padStart(2, "0")}` });
    }
    return out;
  }, [project, durationFrames]);

  if (!project) {
    return (
      <div className="light grid flex-1 place-items-center bg-neutral-950 text-sm text-neutral-400">
        Preparing video project...
      </div>
    );
  }

  const fps = project.fps;
  const contentWidth = Math.max(640, (durationFrames + fps * 2) * pxPerFrame);
  const playheadX = frame * pxPerFrame;
  const anySolo = soloActive(project.tracks);

  return (
    <div className="light flex h-full min-h-0 min-w-0 flex-1 bg-neutral-950 text-neutral-100">
      {/* ---------------------------------------------------------------- */}
      {/* MEDIA PANEL (left): workspace video/audio; drag onto a lane, or   */}
      {/* click to add at the playhead. Upload lands here too.              */}
      {/* ---------------------------------------------------------------- */}
      <aside className="flex w-52 shrink-0 flex-col border-r border-neutral-800 bg-neutral-900">
        <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-300">Media</span>
          <button
            type="button"
            title="Upload video or audio"
            disabled={!workspaceId || uploadPct !== null}
            onClick={() => uploadInputRef.current?.click()}
            className="flex items-center gap-1 rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
          >
            {uploadPct !== null ? `${uploadPct}%` : "Upload"}
          </button>
          <input
            ref={uploadInputRef}
            type="file"
            accept="video/*,audio/*"
            multiple
            hidden
            onChange={(e) => void onUploadFiles(e.target.files)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {assets.length === 0 ? (
            <div className="px-2 py-4 text-center text-[11px] text-neutral-600">
              No video or audio uploads yet. Upload here, or record voice, webcam, or screen from the design editor&apos;s Uploads panel.
            </div>
          ) : (
            assets.map((a) => (
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
                className="flex cursor-grab items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800 active:cursor-grabbing"
              >
                {a.kind === "video" ? <Film size={13} className="shrink-0 text-indigo-400" /> : <Music2 size={13} className="shrink-0 text-emerald-400" />}
                <span className="min-w-0 flex-1 truncate">{a.filename ?? a.id}</span>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* stage + timeline column (everything except the right inspector) */}
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {/* sequence breadcrumb (visible while editing a nested sequence) */}
      {seqPath.length > 0 && (
        <div className="flex items-center gap-1 border-b border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs">
          <button
            type="button"
            onClick={() => { setSeqPath([]); selectOnly(null); setPlaying(false); setPlayhead(0); }}
            className="rounded px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800 hover:text-white"
          >
            Main timeline
          </button>
          {seqPath.map((id, i) => (
            <span key={id} className="flex items-center gap-1">
              <span className="text-neutral-600">/</span>
              {i === seqPath.length - 1 ? (
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-medium text-white">
                  {sequenceNames?.[id] ?? "Sequence"}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => { setSeqPath(seqPath.slice(0, i + 1)); selectOnly(null); setPlaying(false); setPlayhead(0); }}
                  className="rounded px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800 hover:text-white"
                >
                  {sequenceNames?.[id] ?? "Sequence"}
                </button>
              )}
            </span>
          ))}
          <span className="ml-2 text-neutral-600">edits here render inside the parent&apos;s sequence clip</span>
        </div>
      )}
      {/* ---------------------------------------------------------------- */}
      {/* STAGE PREVIEW (top): the live compositor canvas.                  */}
      {/* ---------------------------------------------------------------- */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        <div className="flex h-full max-h-full w-full max-w-4xl flex-col items-center justify-center">
          <div
            className="relative flex w-full items-center justify-center overflow-hidden rounded-lg border border-neutral-800 bg-black shadow-inner"
            style={{ aspectRatio: `${project.stage.width} / ${project.stage.height}`, maxHeight: "100%" }}
          >
            <canvas
              ref={stageCanvasRef}
              width={project.stage.width}
              height={project.stage.height}
              className="h-full w-full"
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
              title={stageTarget ? "Drag to reframe the selected clip; wheel to scale" : undefined}
              className={`absolute inset-0 h-full w-full ${stageTarget ? "cursor-move" : "pointer-events-none"}`}
            />
            {activeClips.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
                <div className="font-mono text-2xl tabular-nums tracking-wider text-neutral-400">
                  {formatTimecode(frame, fps)}
                </div>
                <div className="text-xs text-neutral-600">
                  {project.stage.width}x{project.stage.height} &middot; {fps} fps &middot; use + on a track to add media
                </div>
              </div>
            )}
          </div>

          {/* transport controls */}
          <div className="mt-3 flex items-center gap-1.5">
            <TransportButton
              title="Stop to start"
              onClick={() => {
                setPlaying(false);
                setPlayhead(0);
              }}
            >
              <Square size={15} />
            </TransportButton>
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
              onClick={() => setPlaying((p) => !p)}
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
            <span className="ml-2 font-mono text-xs tabular-nums text-neutral-400">
              {formatTimecode(frame, fps)}
            </span>
            <button
              type="button"
              onClick={doExportVideo}
              title={
                exporting
                  ? "Cancel the render"
                  : "Render the timeline in this tab (realtime pass) and download the file"
              }
              className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              {exporting ? `Rendering ${Math.min(100, Math.round((frame / Math.max(1, durationFrames)) * 100))}% (cancel)` : "Export video"}
            </button>
            <button
              type="button"
              onClick={() => void doServerExport()}
              disabled={!props.designId || serverExporting || exporting}
              title="Faster-than-realtime MP4 render on the server (ffmpeg). Wipe/slide become fades; keyframes and green screen need the in-browser export."
              className="inline-flex items-center gap-1.5 rounded-md bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {serverExporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              {serverExporting ? "Server render…" : "Fast export"}
            </button>
          </div>
          {exportMsg && (
            <div className="mt-1.5 text-center text-[11px] text-neutral-400">{exportMsg}</div>
          )}
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* TOOLBAR: clip + track actions, audio master, zoom.                */}
      {/* ---------------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2 border-t border-neutral-800 bg-neutral-900 px-3 py-2 text-xs">
        {/* clip actions (require a selection on an unlocked track) */}
        <div className="flex items-center gap-1">
          <ToolbarButton title="Split at playhead (S)" disabled={editDisabled} onClick={doSplit}>
            <Scissors size={13} /> Split
          </ToolbarButton>
          <ToolbarButton title="Ripple delete" disabled={editDisabled} onClick={doRippleDelete}>
            <Trash2 size={13} /> Ripple
          </ToolbarButton>
          <ToolbarButton title="Trim in earlier" disabled={editDisabled} onClick={() => doTrim("in", -TRIM_STEP)}>
            In-
          </ToolbarButton>
          <ToolbarButton title="Trim in later" disabled={editDisabled} onClick={() => doTrim("in", TRIM_STEP)}>
            In+
          </ToolbarButton>
          <ToolbarButton title="Trim out earlier" disabled={editDisabled} onClick={() => doTrim("out", -TRIM_STEP)}>
            Out-
          </ToolbarButton>
          <ToolbarButton title="Trim out later" disabled={editDisabled} onClick={() => doTrim("out", TRIM_STEP)}>
            Out+
          </ToolbarButton>
          <ToolbarButton
            title="Collapse the selected clips into a nested sequence (double-click it to edit inside)"
            disabled={multiIds.size === 0}
            onClick={nestSelection}
          >
            <Layers size={13} /> Nest
          </ToolbarButton>
        </div>

        {/* speed */}
        <label className="flex items-center gap-1 text-neutral-400">
          Speed
          <input
            type="number"
            step={0.1}
            min={0.1}
            max={100}
            disabled={editDisabled}
            value={selected ? Number(selected.clip.speed.toFixed(2)) : 1}
            onChange={(e) => doSetSpeed(parseFloat(e.target.value))}
            className="w-16 rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-neutral-100 disabled:opacity-40"
          />
          x
        </label>

        {/* transition: an edge selector (in/out) plus a type select, so a
            transition can be attached to EITHER edge of the selected clip (V4). */}
        <label className="flex items-center gap-1 text-neutral-400">
          Transition
          <select
            disabled={editDisabled}
            value={transitionEdge}
            onChange={(e) => setTransitionEdge(e.target.value as "in" | "out")}
            title="Which edge the transition attaches to"
            className="rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-neutral-100 disabled:opacity-40"
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
            className="rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-neutral-100 disabled:opacity-40"
          >
            <option value="">none...</option>
            <option value="crossDissolve">Cross dissolve</option>
            <option value="fade">Fade</option>
            <option value="wipe">Wipe</option>
            <option value="slide">Slide</option>
            <option value="dipToColor">Dip to color</option>
          </select>
        </label>

        <div className="mx-1 h-5 w-px bg-neutral-700" />

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
        </div>

        <div className="mx-1 h-5 w-px bg-neutral-700" />

        {/* master ducking */}
        <button
          type="button"
          onClick={toggleDucking}
          title="Auto-duck music under voice (needs 2+ audio tracks)"
          className={`flex items-center gap-1 rounded px-2 py-1 ${
            project.master.ducking
              ? "bg-emerald-600 text-white"
              : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
          }`}
        >
          <Headphones size={13} /> Auto-duck
          {duckingInfo && (
            <span className="ml-1 text-[10px] opacity-80">
              {duckingInfo.count} pts &middot; {duckingInfo.lowestDb} dB
            </span>
          )}
        </button>

        {/* captions editor toggle */}
        <button
          type="button"
          onClick={() => setCaptionsOpen((v) => !v)}
          title="Captions: edit cues, export SRT/VTT"
          className={`flex items-center gap-1 rounded px-2 py-1 ${
            captionsOpen ? "bg-brand-600 text-white" : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
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

        <div className="mx-1 h-5 w-px bg-neutral-700" />

        {/* project settings: frame rate + stage preset (re-times clips on fps
            change so wall-clock timing holds) */}
        <label className="flex items-center gap-1 text-neutral-400">
          fps
          <select
            value={fps}
            onChange={(e) => setProjectFps(Number(e.target.value) as Fps)}
            className="rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-neutral-100"
          >
            {[24, 25, 30, 50, 60].map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-neutral-400">
          Size
          <select
            value={`${project.stage.width}x${project.stage.height}`}
            onChange={(e) => {
              const [w, h] = e.target.value.split("x").map(Number);
              if (w && h) setStageSize(w, h);
            }}
            className="rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-neutral-100"
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

        {/* zoom */}
        <div className="ml-auto flex items-center gap-1">
          <ToolbarButton
            title="Zoom out"
            onClick={() => setPxPerFrame((z) => Math.max(MIN_PX_PER_FRAME, z / 1.4))}
          >
            <ZoomOut size={13} />
          </ToolbarButton>
          <span className="w-14 text-center font-mono text-[11px] tabular-nums text-neutral-400">
            {pxPerFrame.toFixed(2)} px/f
          </span>
          <ToolbarButton
            title="Zoom in"
            onClick={() => setPxPerFrame((z) => Math.min(MAX_PX_PER_FRAME, z * 1.4))}
          >
            <ZoomIn size={13} />
          </ToolbarButton>
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* CAPTIONS editor (toggled): cue list + SRT/VTT export. Cues render  */}
      {/* burned-in on the stage (and therefore in the export).             */}
      {/* ---------------------------------------------------------------- */}
      {captionsOpen && (
        <div className="max-h-44 overflow-y-auto border-t border-neutral-800 bg-neutral-900 px-3 py-2 text-xs">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-semibold uppercase tracking-wide text-neutral-400">Captions</span>
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
                className="w-12 rounded border border-neutral-700 bg-neutral-800 px-1 py-0.5 text-neutral-100"
              />
              %
            </label>
            <input
              type="color"
              title="Caption color"
              value={captionStyle.color ?? "#ffffff"}
              onChange={(e) => patchCaptionStyle({ color: e.target.value })}
              className="h-5 w-8 cursor-pointer rounded border border-neutral-700 bg-neutral-800"
            />
            <span className="text-neutral-600">SRT/VTT for players</span>
          </div>
          {cues.length === 0 ? (
            <div className="py-1 text-neutral-600">No cues yet. Move the playhead and add one.</div>
          ) : (
            cues.map((cue) => (
              <div key={cue.id} className="flex items-center gap-1.5 border-t border-neutral-800/60 py-1">
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
                  className="w-16 rounded border border-neutral-700 bg-neutral-800 px-1 py-0.5 text-neutral-100"
                />
                <span className="text-neutral-600">-</span>
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
                  className="w-16 rounded border border-neutral-700 bg-neutral-800 px-1 py-0.5 text-neutral-100"
                />
                <input
                  value={cue.text}
                  onChange={(e) => persistCues(cues.map((c) => (c.id === cue.id ? { ...c, text: e.target.value } : c)))}
                  className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 text-neutral-100"
                />
                <button
                  type="button"
                  title="Jump to cue"
                  onClick={() => { setPlaying(false); setPlayhead(cue.startFrame); }}
                  className="rounded p-1 text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100"
                >
                  <SkipBack size={12} />
                </button>
                <button
                  type="button"
                  title="Delete cue"
                  onClick={() => persistCues(cues.filter((c) => c.id !== cue.id))}
                  className="rounded p-1 text-neutral-500 hover:bg-neutral-700 hover:text-red-400"
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
        className="flex shrink-0 border-t border-neutral-800 bg-neutral-900"
        style={{ height: RULER_HEIGHT + project.tracks.length * TRACK_HEIGHT + 12 }}
      >
        {/* left gutter: track headers */}
        <div className="shrink-0 border-r border-neutral-800 bg-neutral-900" style={{ width: GUTTER_WIDTH }}>
          <div
            className="flex items-center px-3 text-[10px] uppercase tracking-wide text-neutral-500"
            style={{ height: RULER_HEIGHT }}
          >
            Tracks
          </div>
          {project.tracks.map((track) => {
            const Icon = KIND_ICON[track.kind];
            const isAudio = track.kind === "audio";
            return (
              <div
                key={track.id}
                className="flex flex-col justify-center gap-1 border-t border-neutral-800/60 px-3"
                style={{ height: TRACK_HEIGHT }}
              >
                <div className="flex items-center gap-1.5">
                  <Icon className="text-neutral-400" size={13} />
                  <span className="truncate text-xs text-neutral-200">
                    {track.name ?? track.kind}
                  </span>
                  <button
                    type="button"
                    title="Move track up"
                    onClick={() => moveTrack(track.id, -1)}
                    className="ml-auto rounded p-0.5 text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100"
                  >
                    <ChevronUp size={11} />
                  </button>
                  <button
                    type="button"
                    title="Move track down (later tracks draw on top)"
                    onClick={() => moveTrack(track.id, 1)}
                    className="rounded p-0.5 text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100"
                  >
                    <ChevronDown size={11} />
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
                        : "text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100"
                    }`}
                  >
                    {track.locked ? <Lock size={12} /> : <Unlock size={12} />}
                  </button>
                  <button
                    type="button"
                    title={track.hidden ? "Show track" : "Hide track"}
                    onClick={() => patchTrack(track.id, { hidden: !track.hidden })}
                    className={`rounded p-0.5 ${
                      track.hidden
                        ? "bg-neutral-600 text-white"
                        : "text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100"
                    }`}
                  >
                    {track.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                  <button
                    type="button"
                    title="Add clip at playhead"
                    disabled={track.locked}
                    onClick={() => addClip(track.id)}
                    className="rounded p-0.5 text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Plus size={13} />
                  </button>
                </div>
                {isAudio && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      title={track.muted ? "Unmute" : "Mute"}
                      onClick={() => patchTrack(track.id, { muted: !track.muted })}
                      className={`rounded p-0.5 ${
                        track.muted ? "bg-red-600 text-white" : "text-neutral-500 hover:bg-neutral-700"
                      }`}
                    >
                      {track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                    </button>
                    <button
                      type="button"
                      title="Solo"
                      onClick={() => patchTrack(track.id, { solo: !track.solo })}
                      className={`rounded px-1 py-0.5 text-[10px] font-bold ${
                        track.solo ? "bg-amber-500 text-black" : "text-neutral-500 hover:bg-neutral-700"
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
        <div ref={scrollRef} className="relative flex-1 overflow-x-auto overflow-y-hidden">
          <div ref={laneAreaRef} className="relative" style={{ width: contentWidth }}>
            {/* ruler */}
            <div
              className="relative border-b border-neutral-800 bg-neutral-900"
              style={{ height: RULER_HEIGHT }}
              onClick={(e) => {
                // Click the ruler to scrub the playhead.
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const x = e.clientX - rect.left + (scrollRef.current?.scrollLeft ?? 0);
                setPlaying(false);
                setPlayhead(Math.max(0, Math.min(durationFrames, Math.round(x / pxPerFrame))));
              }}
            >
              {rulerTicks.map((t) => (
                <div
                  key={t.frame}
                  className="absolute top-0 flex h-full select-none items-end pb-0.5"
                  style={{ left: t.frame * pxPerFrame }}
                >
                  <div className="h-2 w-px bg-neutral-700" />
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
              {/* markers (M at the playhead toggles) */}
              {(project.markers ?? []).map((m) => (
                <div
                  key={m}
                  title={`Marker ${formatTimecode(m, fps)}`}
                  className="pointer-events-none absolute top-0 h-2 w-2 -translate-x-1/2 rotate-45 bg-amber-400"
                  style={{ left: m * pxPerFrame }}
                />
              ))}
            </div>

            {/* track lanes */}
            {project.tracks.map((track) => (
              <div
                key={track.id}
                className="relative border-t border-neutral-800/60"
                style={{ height: TRACK_HEIGHT, backgroundColor: "rgba(255,255,255,0.015)" }}
                onPointerDown={(e) => {
                  // A click on empty lane space clears the selection (clips
                  // stop propagation, so only true empty space lands here).
                  if (e.target === e.currentTarget) selectOnly(null);
                }}
                onPointerMove={onClipPointerMove}
                onPointerUp={onClipPointerUp}
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
                  const label = clip.sequenceId
                    ? `⧉ ${sequenceNames?.[clip.sequenceId] ?? "Sequence"}`
                    : asset?.filename ?? clip.title?.text ?? clip.nodeId ?? clip.id;
                  const art = clip.assetId ? clipArt[clip.assetId] : undefined;
                  const gainKfs = clip.keyframes?.find((t) => t.property === "gain")?.keyframes;
                  return (
                    <div
                      key={clip.id}
                      onPointerDown={(e) => onClipPointerDown(e, track, clip)}
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
                      } ${isPrimary ? "ring-2 ring-white" : isSel ? "ring-2 ring-white/50" : "ring-1 ring-black/30"}`}
                      style={{
                        left,
                        width,
                        height: TRACK_HEIGHT - 8,
                        backgroundColor: clip.sequenceId ? "#7c3aed" : KIND_COLOR[track.kind],
                        // Filmstrip (video) / waveform (audio) chrome behind the label.
                        backgroundImage: art ? `url(${art})` : undefined,
                        backgroundSize: "auto 100%",
                        backgroundRepeat: "repeat-x",
                        opacity: track.hidden ? 0.4 : 1,
                      }}
                    >
                      <div className="truncate bg-black/35 px-1.5 py-0.5 font-medium">
                        {label}
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
                      {/* edge trim handles: drag to trim in/out */}
                      {!track.locked && (
                        <>
                          <div
                            onPointerDown={(e) => onClipPointerDown(e, track, clip, "trim-in")}
                            title="Drag to trim the in point"
                            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize hover:bg-white/50"
                          />
                          <div
                            onPointerDown={(e) => onClipPointerDown(e, track, clip, "trim-out")}
                            title="Drag to trim the out point"
                            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize hover:bg-white/50"
                          />
                        </>
                      )}
                    </div>
                  );
                })}
                {track.clips.length === 0 && (
                  <div className="flex h-full items-center px-2 text-[10px] text-neutral-700">
                    empty &middot; use + to add a clip
                  </div>
                )}
              </div>
            ))}

            {/* snap guide while a clip drag is snapped to a target */}
            {snapGuide !== null && (
              <div
                className="pointer-events-none absolute top-0 z-10 w-px bg-amber-400"
                style={{ left: snapGuide * pxPerFrame, height: RULER_HEIGHT + project.tracks.length * TRACK_HEIGHT }}
              />
            )}
            {/* playhead line spanning ruler + lanes */}
            <div
              className="pointer-events-none absolute top-0 z-10 w-px bg-red-500"
              style={{
                left: playheadX,
                height: RULER_HEIGHT + project.tracks.length * TRACK_HEIGHT,
              }}
            >
              <div className="absolute -left-1 -top-0.5 h-2 w-2 rounded-sm bg-red-500" />
            </div>
          </div>
        </div>
      </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* RIGHT CLIP INSPECTOR: consolidates the selected clip's props.     */}
      {/* Collapses to a slim rail; state persisted per-user (localStorage).*/}
      {/* ---------------------------------------------------------------- */}
      {inspectorOpen ? (
        <aside className="flex w-60 shrink-0 flex-col border-l border-neutral-800 bg-neutral-900">
          <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-300">
              Clip inspector
            </span>
            <button
              type="button"
              title="Collapse inspector"
              onClick={toggleInspector}
              className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
            >
              <PanelRightClose size={15} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {selected ? (
              <ClipInspector
                key={selected.clip.id}
                track={selected.track}
                clip={selected.clip}
                fps={fps}
                editDisabled={editDisabled}
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
              <div className="p-4 text-xs text-neutral-500">
                Select a clip to edit its properties.
              </div>
            )}
          </div>
        </aside>
      ) : (
        <div className="flex w-9 shrink-0 flex-col items-center border-l border-neutral-800 bg-neutral-900 py-2">
          <button
            type="button"
            title="Open clip inspector"
            onClick={toggleInspector}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          >
            <PanelRightOpen size={15} />
          </button>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* CONTEXT MENU (right-click on a clip or an empty lane spot).       */}
      {/* ---------------------------------------------------------------- */}
      {ctxMenu && (
        <div className="fixed inset-0 z-50" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}>
          <div
            className="absolute w-52 overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 py-1 text-xs shadow-2xl"
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
                pasteAt: (f) => { setPlayhead(f); pasteClip(); },
                addClip,
                split: doSplit,
                copy: copySelectedClip,
                duplicate: duplicateClip,
                nest: nestSelection,
                openSequence,
                crossDissolve: crossDissolveAtCut,
                detachAudio,
                detectScenes: () => void detectScenes(),
                deleteSelection: () => { if (multiIds.size > 1) deleteSelected(); else doRippleDelete(); },
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
            className="max-h-[70vh] w-[28rem] overflow-y-auto rounded-xl border border-neutral-700 bg-neutral-900 p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-neutral-100">Add media to track</span>
              <button
                type="button"
                onClick={() => setPickerTrackId(null)}
                className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
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
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-neutral-200 hover:bg-neutral-800"
                >
                  {a.kind === "video" ? <Film size={14} className="shrink-0 text-indigo-400" /> : <Music2 size={14} className="shrink-0 text-emerald-400" />}
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
  menu: { trackId: string; clipId?: string; atFrame: number };
  frame: number;
  multiCount: number;
  hasClipboard: boolean;
  detectingScenes: boolean;
  close: () => void;
  actions: {
    pasteAt: (frame: number) => void;
    addClip: (trackId: string) => void;
    split: () => void;
    copy: () => void;
    duplicate: (trackId: string, clipId: string) => void;
    nest: () => void;
    openSequence: (id: string) => void;
    crossDissolve: (trackId: string, clipId: string) => void;
    detachAudio: () => void;
    detectScenes: () => void;
    deleteSelection: () => void;
  };
}): React.ReactElement | null {
  const { project, menu, frame, multiCount, actions } = props;
  const track = project.tracks.find((t) => t.id === menu.trackId);
  const clip = menu.clipId ? track?.clips.find((c) => c.id === menu.clipId) : undefined;
  if (!track) return null;
  const item = (label: string, onClick: () => void, disabled = false) => (
    <button
      key={label}
      type="button"
      disabled={disabled}
      onClick={() => { props.close(); onClick(); }}
      className="block w-full px-3 py-1.5 text-left text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );
  if (!clip) {
    return (
      <>
        {item("Paste here", () => actions.pasteAt(menu.atFrame), !props.hasClipboard)}
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
  if (abutting) items.push(item("Cross-dissolve at cut", () => actions.crossDissolve(track.id, clip.id), track.locked));
  if (track.kind === "video" && clip.assetId) {
    items.push(item("Detach audio", actions.detachAudio, track.locked));
    items.push(item("Detect scenes", actions.detectScenes, track.locked || props.detectingScenes));
  }
  items.push(item(multiCount > 1 ? `Delete ${multiCount} clips` : "Ripple delete", actions.deleteSelection, track.locked));
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
  editDisabled: boolean;
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
      {/* header: clip identity + its track */}
      <div className="flex flex-col gap-1">
        <div className="truncate font-mono text-sm text-neutral-100" title={clip.assetId ?? clip.nodeId ?? clip.id}>
          {clip.assetId ?? clip.nodeId ?? clip.id}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-neutral-400">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: KIND_COLOR[track.kind] }}
          />
          <KindIcon size={12} className="text-neutral-400" />
          <span className="truncate">{track.name ?? track.kind}</span>
          <span className="uppercase tracking-wide text-neutral-600">{track.kind}</span>
        </div>
        {editDisabled && (
          <div className="flex items-center gap-1 text-[10px] text-amber-400">
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
        <label className="mt-1 flex items-center justify-between gap-2 text-neutral-400">
          <span>Speed</span>
          <span className="flex items-center gap-1">
            <input
              type="number"
              step={0.1}
              min={0.1}
              max={100}
              disabled={editDisabled}
              value={Number(clip.speed.toFixed(2))}
              onChange={(e) => props.onSetSpeed(parseFloat(e.target.value))}
              className="w-16 rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-right text-neutral-100 disabled:opacity-40"
            />
            <span className="text-neutral-500">x</span>
          </span>
        </label>
        {reversed && (
          <div className="text-[10px] font-medium text-pink-400">plays in reverse</div>
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
          <label className="flex items-center gap-1.5 text-neutral-400">
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
              <label className="flex items-center justify-between gap-2 text-neutral-400">
                <span>Key color</span>
                <input
                  type="color"
                  disabled={editDisabled}
                  value={clip.chromaKey.keyColor}
                  onChange={(e) => props.onSetChroma({ ...clip.chromaKey!, keyColor: e.target.value })}
                  className="h-6 w-10 cursor-pointer rounded border border-neutral-700 bg-neutral-800"
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-neutral-400">
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
              <label className="flex items-center justify-between gap-2 text-neutral-400">
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
              <label className="flex items-center justify-between gap-2 text-neutral-400">
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
            className="flex flex-1 items-center justify-center gap-1 rounded bg-neutral-800 px-2 py-1.5 text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
          >
            <Music2 size={12} /> Detach audio
          </button>
          <button
            type="button"
            disabled={editDisabled || detectingScenes}
            onClick={props.onDetectScenes}
            title="Find cuts in the footage and split the clip at each one"
            className="flex flex-1 items-center justify-center gap-1 rounded bg-neutral-800 px-2 py-1.5 text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
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
            className="w-full resize-y rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-neutral-100 disabled:opacity-40"
          />
          <label className="flex items-center justify-between gap-2 text-neutral-400">
            <span>Position</span>
            <select
              disabled={editDisabled}
              value={clip.title?.position ?? "center"}
              onChange={(e) => props.onSetTitle({ position: e.target.value as TitleCard["position"] })}
              className="rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-neutral-100 disabled:opacity-40"
            >
              <option value="top">Top</option>
              <option value="center">Center</option>
              <option value="lower-third">Lower third</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-2 text-neutral-400">
            <span>Size</span>
            <span className="flex items-center gap-1">
              <input
                type="number"
                min={2}
                max={30}
                disabled={editDisabled}
                value={Math.round((clip.title?.sizePct ?? 0.07) * 100)}
                onChange={(e) => props.onSetTitle({ sizePct: Math.max(0.02, Math.min(0.3, (parseInt(e.target.value, 10) || 7) / 100)) })}
                className="w-14 rounded border border-neutral-700 bg-neutral-800 px-1 py-0.5 text-neutral-100 disabled:opacity-40"
              />
              % of height
            </span>
          </label>
          <label className="flex items-center justify-between gap-2 text-neutral-400">
            <span>Color</span>
            <input
              type="color"
              disabled={editDisabled}
              value={clip.title?.color ?? "#ffffff"}
              onChange={(e) => props.onSetTitle({ color: e.target.value })}
              className="h-6 w-10 cursor-pointer rounded border border-neutral-700 bg-neutral-800"
            />
          </label>
          <label className="flex items-center justify-between gap-2 text-neutral-400">
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
                className="h-6 w-10 cursor-pointer rounded border border-neutral-700 bg-neutral-800 disabled:opacity-40"
              />
            </span>
          </label>
        </InspectorSection>
      )}

      {isAudio && (
        <InspectorSection title="Audio" icon={Volume2}>
          <label className="flex items-center justify-between gap-2 text-neutral-400">
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
              <span className="w-10 text-right font-mono tabular-nums text-neutral-300">
                {clipGain > 0 ? "+" : ""}
                {clipGain} dB
              </span>
            </span>
          </label>
          <ReadoutRow label="Track gain" value={`${(track.gainDb ?? 0) > 0 ? "+" : ""}${track.gainDb ?? 0} dB`} />
          {/* fade envelope: seconds in the UI, integer frames in the model */}
          <label className="flex items-center justify-between gap-2 text-neutral-400">
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
                className="w-16 rounded border border-neutral-700 bg-neutral-800 px-1 py-0.5 text-neutral-100 disabled:opacity-40"
              />
              s
            </span>
          </label>
          <label className="flex items-center justify-between gap-2 text-neutral-400">
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
                className="w-16 rounded border border-neutral-700 bg-neutral-800 px-1 py-0.5 text-neutral-100 disabled:opacity-40"
              />
              s
            </span>
          </label>
          <div className="flex items-center gap-1.5 text-[11px]">
            {track.muted ? (
              <span className="flex items-center gap-1 text-red-400">
                <VolumeX size={12} /> track muted
              </span>
            ) : (
              <span className="flex items-center gap-1 text-emerald-400">
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
          className="flex flex-1 items-center justify-center gap-1 rounded bg-neutral-800 px-2 py-1.5 text-neutral-200 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Scissors size={12} /> Split
        </button>
        <button
          type="button"
          title="Ripple delete"
          disabled={editDisabled}
          onClick={props.onRippleDelete}
          className="flex flex-1 items-center justify-center gap-1 rounded bg-neutral-800 px-2 py-1.5 text-neutral-200 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Trash2 size={12} /> Ripple
        </button>
      </div>
    </div>
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
    <div className="flex flex-col gap-1.5 rounded-lg border border-neutral-800 bg-neutral-950/40 p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
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
      <span className="flex items-baseline gap-1.5 font-mono tabular-nums text-neutral-200">
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
          className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-neutral-100 disabled:opacity-40"
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
          className="w-14 rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-right text-neutral-100 disabled:opacity-40"
        />
        <span className="text-neutral-600">f</span>
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
          : "bg-neutral-800 text-neutral-200 hover:bg-neutral-700"
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
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={props.title}
      onClick={props.onClick}
      disabled={props.disabled}
      className="flex items-center gap-1 rounded bg-neutral-800 px-2 py-1 text-neutral-200 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
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
  return (
    <>
      <div className="flex items-center gap-1.5">
        <select
          disabled={editDisabled}
          value={property}
          onChange={(e) => setProperty(e.target.value as typeof property)}
          className="rounded border border-neutral-700 bg-neutral-800 px-1 py-0.5 text-neutral-100 disabled:opacity-40"
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
          className="w-16 rounded border border-neutral-700 bg-neutral-800 px-1 py-0.5 text-neutral-100 disabled:opacity-40"
        />
        <button
          type="button"
          disabled={editDisabled || localFrame < 0}
          onClick={addKeyframe}
          title="Add a keyframe for this property at the playhead"
          className="rounded bg-neutral-800 px-2 py-0.5 text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
        >
          + at {localFrame}f
        </button>
      </div>
      {tracks.length === 0 ? (
        <div className="text-[11px] text-neutral-600">No keyframes. Values interpolate linearly between frames.</div>
      ) : (
        tracks.map((t) =>
          t.keyframes.map((k) => (
            <div key={`${t.property}-${k.frame}`} className="flex items-center gap-1.5 text-[11px] text-neutral-400">
              <span className="w-14">{t.property}</span>
              <span className="font-mono tabular-nums">{k.frame}f</span>
              <span className="font-mono tabular-nums text-neutral-300">{String(k.value)}</span>
              <button
                type="button"
                disabled={editDisabled}
                onClick={() => removeKeyframe(t.property, k.frame)}
                className="ml-auto rounded p-0.5 text-neutral-500 hover:bg-neutral-700 hover:text-red-400"
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
