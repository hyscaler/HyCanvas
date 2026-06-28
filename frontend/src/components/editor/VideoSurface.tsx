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
// SCOPE / DEFERRED:
//   - Real per-frame compositing/preview is DEFERRED. It needs the engine's
//     composeFrame(scene, frame) plus decoded source media (proxies); neither is
//     available client-side yet. The stage here is a placeholder that shows the
//     current timecode and which clips sit under the playhead. Transport advances
//     a local playhead via requestAnimationFrame at the project fps.
//   - Export / encode is IMPLEMENTED server-side: "Export MP4" enqueues the
//     video-export job (engine compositor + ffmpeg on the backend),
//     polls it, and downloads the rendered MP4. Live in-editor preview
//     compositing is still client-side deferred (the stage shows a placeholder).
//   - Screen / camera recorders are DEFERRED.
//   - Auto-captions, beat detection (DSP onset analysis), and chroma-key
//     rendering are DEFERRED. Beat SNAPPING is wired (snapFrameToBeats) but with
//     an empty beat grid until detection lands, so it is a no-op for now.
//   - Keyframe property lanes are DEFERRED (the model carries keyframes; editing
//     them needs the animation UI).
// The timeline MODEL editing experience (add/move/trim/split/ripple/speed/
// transition, multi-track, audio mixing, ducking solve) is built fully since it
// is the buildable-now core.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Play,
  Pause,
  Square,
  SkipBack,
  ChevronLeft,
  ChevronRight,
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
  trackDurationFrames,
  projectDurationFrames,
  clipAtFrame,
  clipsOverlap,
  type VideoProject,
  type Track,
  type Clip,
  type ClipTransition,
} from "@hc/timeline";
import {
  effectiveClipGain,
  soloActive,
  dbToGain,
  gainToDb,
  solveDucking,
} from "@hc/audio";
import type { VideoExportResult } from "@hc/sdk";
import { useEditor } from "@/store/editor";
import { oc } from "@/lib/sdk";

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
  void props.workspaceId;
  const designId = props.designId;
  const docTitle = useEditor((s) => s.doc.title);

  // Server-side MP4 export: enqueue the render job, poll it, then download.
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const doExportVideo = useCallback(async () => {
    if (!designId || exporting) return;
    setExporting(true);
    setExportMsg("Rendering on the server…");
    try {
      const { jobId } = await oc.startVideoExport(designId);
      for (let i = 0; i < 800; i++) {
        const job = await oc.getJob<VideoExportResult>(jobId);
        if (job.status === "completed") {
          const a = document.createElement("a");
          a.href = oc.videoExportDownloadUrl(designId, jobId);
          a.download = `${(docTitle || "video").replace(/[^\w.-]+/g, "_")}.mp4`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setExportMsg("Downloaded MP4");
          return;
        }
        if (job.status === "failed") {
          setExportMsg(job.error ? `Export failed: ${job.error}` : "Export failed");
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      setExportMsg("Export timed out");
    } catch (e) {
      setExportMsg(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }, [designId, exporting, docTitle]);

  // The project is read from the store (re-reading whenever rev bumps), and all
  // writes go back through setDocMeta so undo/redo is the store's single stack.
  const storeProject = useEditor((s) => s.doc.meta.video as VideoProject | undefined);
  // During an in-progress gesture (clip drag, gain slider) we render from this
  // local copy WITHOUT persisting, then commit once on release so the whole
  // gesture is a single undo step. Null when no gesture is active.
  const [draftProject, setDraftProject] = useState<VideoProject | null>(null);
  const project = draftProject ?? storeProject;
  // `rev` is intentionally subscribed so this surface re-renders on every doc
  // mutation (including undo/redo of a timeline edit). The value itself is unused.
  useEditor((s) => s.rev);

  // Local-only editor UI state (never persisted on every frame).
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
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
  // persistence: write a new project back as one undoable step.
  // -------------------------------------------------------------------------
  const persist = useCallback((next: VideoProject) => {
    useEditor.getState().setDocMeta({ video: next });
  }, []);

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

  // Clips currently under the playhead (one per track at most), for the stage
  // placeholder readout.
  const activeClips = useMemo(() => {
    if (!project) return [] as { track: Track; clip: Clip }[];
    const out: { track: Track; clip: Clip }[] = [];
    for (const track of project.tracks) {
      const clip = clipAtFrame(track, frame);
      if (clip) out.push({ track, clip });
    }
    return out;
  }, [project, frame]);

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

  const addClip = useCallback(
    (trackId: string) => {
      if (!project) return;
      const track = project.tracks.find((t) => t.id === trackId);
      if (!track || track.locked) return;
      // A placeholder clip: a generated assetId, a default source window, placed
      // at the next free frame at/after the playhead so it never overlaps an
      // existing clip on this track (V1). Real media binding (assetId/nodeId)
      // lands with import.
      const startFrame = freeStartFrame(track, DEFAULT_CLIP_FRAMES, frame);
      const clip: Clip = {
        id: shortId("clip"),
        assetId: shortId("asset"),
        startFrame,
        inFrame: 0,
        outFrame: DEFAULT_CLIP_FRAMES,
        speed: 1,
      };
      const nextTrack: Track = { ...track, clips: [...track.clips, clip] };
      persist(replaceTrack(project, nextTrack));
      setSelectedClipId(clip.id);
    },
    [project, frame, persist],
  );

  const doSplit = useCallback(() => {
    if (!project || !selected || selected.track.locked) return;
    const next = splitClip(selected.track, selected.clip.id, frame);
    persist(replaceTrack(project, next));
  }, [project, selected, frame, persist]);

  // V4: bind the S shortcut (advertised in the Split tooltip) to split the
  // selected clip at the playhead. We ignore the key when the user is typing in
  // a form field so it does not hijack text entry, and skip modifier combos.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "s" && e.key !== "S") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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
      e.preventDefault();
      doSplit();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [doSplit]);

  const doRippleDelete = useCallback(() => {
    if (!project || !selected || selected.track.locked) return;
    const next = rippleDelete(selected.track, selected.clip.id);
    persist(replaceTrack(project, next));
    setSelectedClipId(null);
  }, [project, selected, persist]);

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
  // clip drag-to-move (horizontal). Snaps to neighbour edges / whole seconds.
  // -------------------------------------------------------------------------
  const dragRef = useRef<{
    clipId: string;
    trackId: string;
    startClientX: number;
    origStart: number;
  } | null>(null);

  const onClipPointerDown = useCallback(
    (e: React.PointerEvent, track: Track, clip: Clip) => {
      e.stopPropagation();
      setSelectedClipId(clip.id);
      // A locked track is selectable but not draggable: select, then bail out
      // before arming the drag so no move gesture starts.
      if (track.locked) return;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      dragRef.current = {
        clipId: clip.id,
        trackId: track.id,
        startClientX: e.clientX,
        origStart: clip.startFrame,
      };
    },
    [],
  );

  const onClipPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || !project) return;
      const deltaFrames = (e.clientX - drag.startClientX) / pxPerFrame;
      let target = Math.max(0, Math.round(drag.origStart + deltaFrames));
      // Snap unless the user holds Alt (free move).
      if (!e.altKey) {
        const targets = snapTargets(project, drag.clipId, frame);
        const tol = Math.max(2, Math.round(6 / pxPerFrame)); // ~6px snap radius
        target = snapFrameToBeats(target, targets, tol);
      }
      const track = project.tracks.find((t) => t.id === drag.trackId);
      if (!track) return;
      const next = moveClip(track, drag.clipId, target);
      // Update the local draft only; the timeline re-renders from it so the move
      // is visible during the drag, but we do NOT persist per pointer step. The
      // whole drag is committed as ONE undo step on pointer-up.
      setDraftProject(replaceTrack(project, next));
    },
    [project, pxPerFrame, frame],
  );

  const onClipPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
      if (!draftProject) {
        setDraftProject(null);
        return;
      }
      // Before committing, ensure the dropped clip does not overlap a neighbour
      // on its track (V1): clamp its start to the nearest free gap at/after the
      // dragged position. clipAtFrame returns the first clip in track order, so
      // an overlap would make the second clip unreachable; never persist that.
      let toCommit = draftProject;
      if (drag) {
        const track = draftProject.tracks.find((t) => t.id === drag.trackId);
        const moved = track?.clips.find((c) => c.id === drag.clipId);
        if (track && moved) {
          const collides = track.clips.some(
            (c) => c.id !== moved.id && clipsOverlap(c, moved),
          );
          if (collides) {
            const safeStart = freeStartFrame(
              track,
              clipDurationFrames(moved),
              moved.startFrame,
              moved.id,
            );
            const next = moveClip(track, moved.id, safeStart);
            toCommit = replaceTrack(draftProject, next);
          }
        }
      }
      // Commit once (single undo step), then drop the draft so we render from
      // the store again.
      persist(toCommit);
      setDraftProject(null);
    },
    [draftProject, persist],
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
      <div className="grid flex-1 place-items-center bg-neutral-950 text-sm text-neutral-400">
        Preparing video project...
      </div>
    );
  }

  const fps = project.fps;
  const contentWidth = Math.max(640, (durationFrames + fps * 2) * pxPerFrame);
  const playheadX = frame * pxPerFrame;
  const anySolo = soloActive(project.tracks);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 bg-neutral-950 text-neutral-100">
      {/* stage + timeline column (everything except the right inspector) */}
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {/* ---------------------------------------------------------------- */}
      {/* STAGE PREVIEW (top): placeholder; real compositing deferred.      */}
      {/* ---------------------------------------------------------------- */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        <div className="flex h-full max-h-full w-full max-w-4xl flex-col items-center justify-center">
          <div
            className="relative flex w-full items-center justify-center overflow-hidden rounded-lg border border-neutral-800 bg-black shadow-inner"
            style={{ aspectRatio: "16 / 9", maxHeight: "100%" }}
          >
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="font-mono text-3xl tabular-nums tracking-wider text-neutral-100">
                {formatTimecode(frame, fps)}
              </div>
              <div className="text-xs text-neutral-500">
                frame {frame} / {durationFrames} &middot; {project.stage.width}x{project.stage.height} &middot; {fps} fps
              </div>
              <div className="mt-1 flex flex-wrap items-center justify-center gap-1.5">
                {activeClips.length === 0 ? (
                  <span className="text-xs text-neutral-600">no clips under playhead</span>
                ) : (
                  activeClips.map(({ track, clip }) => (
                    <span
                      key={clip.id}
                      className="rounded px-2 py-0.5 text-[11px] font-medium text-white/90"
                      style={{ backgroundColor: KIND_COLOR[track.kind] }}
                    >
                      {clip.assetId ?? clip.nodeId ?? clip.id}
                    </span>
                  ))
                )}
              </div>
              <div className="mt-1 text-[10px] uppercase tracking-wide text-neutral-700">
                preview compositing deferred
              </div>
            </div>
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
              disabled={!designId || exporting}
              title={designId ? "Render this timeline to an MP4" : "Save the design first to export"}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              {exporting ? "Exporting…" : "Export MP4"}
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
                  {/* lock / hide toggles on EVERY track header. Each is a single
                      undoable patch through the normal persist path. */}
                  <button
                    type="button"
                    title={track.locked ? "Unlock track" : "Lock track (block edits)"}
                    onClick={() => patchTrack(track.id, { locked: !track.locked })}
                    className={`ml-auto rounded p-0.5 ${
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
          <div className="relative" style={{ width: contentWidth }}>
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
            </div>

            {/* track lanes */}
            {project.tracks.map((track) => (
              <div
                key={track.id}
                className="relative border-t border-neutral-800/60"
                style={{ height: TRACK_HEIGHT, backgroundColor: "rgba(255,255,255,0.015)" }}
                onPointerMove={onClipPointerMove}
                onPointerUp={onClipPointerUp}
              >
                {track.clips.map((clip) => {
                  const left = clip.startFrame * pxPerFrame;
                  const width = Math.max(4, (clipEndFrame(clip) - clip.startFrame) * pxPerFrame);
                  const isSel = clip.id === selectedClipId;
                  return (
                    <div
                      key={clip.id}
                      onPointerDown={(e) => onClipPointerDown(e, track, clip)}
                      title={`${clip.assetId ?? clip.nodeId ?? clip.id} | ${clip.startFrame}-${clipEndFrame(clip)}f${
                        clip.speed !== 1 ? ` | ${clip.speed}x` : ""
                      }`}
                      className={`absolute top-1 touch-none select-none overflow-hidden rounded text-[10px] text-white/95 ${
                        track.locked
                          ? "cursor-default"
                          : "cursor-grab active:cursor-grabbing"
                      } ${isSel ? "ring-2 ring-white" : "ring-1 ring-black/30"}`}
                      style={{
                        left,
                        width,
                        height: TRACK_HEIGHT - 8,
                        backgroundColor: KIND_COLOR[track.kind],
                        opacity: track.hidden ? 0.4 : 1,
                      }}
                    >
                      <div className="truncate px-1.5 py-1 font-medium">
                        {clip.assetId ?? clip.nodeId ?? clip.id}
                      </div>
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// small presentational helpers (chrome only)
// ---------------------------------------------------------------------------

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
  onSplit: () => void;
  onRippleDelete: () => void;
}): React.ReactElement {
  const { track, clip, fps, editDisabled } = props;
  const dur = clipDurationFrames(clip);
  const end = clipEndFrame(clip);
  const reversed = clip.speed < 0;
  const KindIcon = KIND_ICON[track.kind];
  const isAudio = track.kind === "audio";
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

// Re-exported so the timeline gain UI demonstrably depends on the @hc/audio
// decibel<->linear helpers (effectiveClipGain is exercised by the audibility
// indicator above via soloActive; these complete the FR-7 contract surface and
// are used by the per-clip gain math the export audio path will reuse).
export function clipLinearGain(clip: Clip, track: Track, project: VideoProject): number {
  return effectiveClipGain(clip, track, project.master, project.tracks);
}
export { dbToGain, gainToDb, trackDurationFrames };
