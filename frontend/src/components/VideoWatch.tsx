// Public video watch player (P7.9). Plays a shared video document's timeline as
// a lightweight player - a canvas stage plus play/pause and a scrubber - reusing
// the editor's compositor + playback engine (no editor chrome). Design-videos
// (element clips: backgrounds, text, shapes, images) play fully client-side;
// footage/audio/image assets resolve by asset id through the public
// /assets/{id}/content route, which the share link already serves anonymously.
// Reached via the /shared/<token> link for a video doc.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Play, Pause } from "lucide-react";
import type { DesignFile } from "@hc/sdk";
import type { VideoProject } from "@hc/timeline";
import { drawTimelineFrame, drawCaption } from "@/lib/video/compositor";
import { TimelinePlayer } from "@/lib/video/playback";
import { captionStyleOf, cueAt } from "@/lib/video/captions";
import { fonts } from "@/lib/fontProvider";
import { imageAssets } from "@/lib/assetProvider";
import { useViewBeat } from "@/lib/useViewBeat";
import { resolveAssetUrl } from "@/lib/sdk";
import { DESIGN_SURFACE_DIR } from "@/lib/locale";
import { tr } from "@/lib/i18n";

function fmt(frame: number, fps: number): string {
  const s = Math.max(0, Math.floor(frame / fps));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Web fonts used by the video's text element clips, so the canvas renderer
 *  draws the real face rather than a fallback. */
function collectFonts(project: VideoProject): Set<string> {
  const out = new Set<string>();
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    const node = n as { type?: string; content?: { runs?: { style?: { fontFamily?: string } }[] }[]; children?: unknown[] };
    if (node.type === "text" && Array.isArray(node.content)) {
      for (const p of node.content) for (const r of p.runs ?? []) {
        const f = r.style?.fontFamily;
        if (f && f !== "system") out.add(f);
      }
    }
    for (const c of node.children ?? []) walk(c);
  };
  for (const t of project.tracks) for (const c of t.clips) if (c.element) walk(c.element);
  return out;
}

export function VideoWatch({ doc, token, password }: { doc: DesignFile; token?: string; password?: string }) {
  const project = (doc.meta as { video?: VideoProject } | undefined)?.video;
  const sequences = useMemo(
    () => (doc.meta as { videoSequences?: Record<string, VideoProject> } | undefined)?.videoSequences ?? {},
    [doc.meta],
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<TimelinePlayer | null>(null);
  const frameRef = useRef(0);
  const lastTsRef = useRef(0);
  const playingRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(0);

  const fps = (project?.fps as number) ?? 30;
  const duration = project?.durationFrames ?? 0;

  // A video doc references workspace media by assetId (it does not carry an
  // assets[] manifest like a design). Resolve each id to its PUBLIC content URL
  // (the /assets/{id}/content route is open, so an anonymous viewer can load it),
  // and derive the kind from the project: clips on an audio track are audio, other
  // clips are video; element image nodes are registered as images. This lets
  // footage/audio/image videos play on the watch page, not just vector elements.
  const contentUrl = useCallback((assetId: string) => resolveAssetUrl(`/api/v1/assets/${assetId}/content`), []);
  const { mediaKinds, imageIds } = useMemo(() => {
    const kinds = new Map<string, "video" | "audio">();
    const imgs = new Set<string>();
    const walkNode = (n: unknown): void => {
      if (!n || typeof n !== "object") return;
      const node = n as { type?: string; source?: { assetId?: string }; fills?: { type?: string; source?: { assetId?: string } }[]; children?: unknown[] };
      if (node.type === "image" && node.source?.assetId) imgs.add(node.source.assetId);
      for (const f of node.fills ?? []) if (f.type === "image" && f.source?.assetId) imgs.add(f.source.assetId);
      for (const c of node.children ?? []) walkNode(c);
    };
    const scan = (proj?: VideoProject): void => {
      for (const t of proj?.tracks ?? []) for (const c of t.clips) {
        if (c.assetId) {
          // Video wins over audio for the same asset id. A detach-audio clip
          // reuses its source video's asset id on an audio track, but that asset
          // is still a video and its picture must render. Only an asset that is
          // never on a non-audio track is treated as audio-only.
          const k: "video" | "audio" = t.kind === "audio" ? "audio" : "video";
          if (k === "video" || !kinds.has(c.assetId)) kinds.set(c.assetId, k);
        }
        if (c.element) walkNode(c.element);
      }
    };
    scan(project);
    for (const s of Object.values(sequences)) scan(s);
    return { mediaKinds: kinds, imageIds: imgs };
  }, [project, sequences]);
  useEffect(() => {
    for (const id of imageIds) imageAssets.register(id, contentUrl(id));
  }, [imageIds, contentUrl]);
  useEffect(() => {
    for (const f of collectFonts(project ?? ({ tracks: [] } as unknown as VideoProject))) fonts.ensure(f);
    const off = fonts.onChange(() => playerRef.current?.invalidateElements());
    return off;
  }, [project]);

  const getPlayer = useCallback((): TimelinePlayer => {
    if (!playerRef.current) {
      playerRef.current = new TimelinePlayer(
        (assetId) => {
          const kind = mediaKinds.get(assetId);
          if (!kind) return null;
          return { url: contentUrl(assetId), kind };
        },
        (id) => sequences[id] ?? null,
      );
    }
    return playerRef.current;
  }, [mediaKinds, contentUrl, sequences]);

  // Anonymous engagement instrumentation for a shared video view (best-effort;
  // no page attribution - a video is a single timeline).
  useViewBeat({ token, password, enabled: !!token, getPageId: () => null });

  // Draw the current frame (media, title cards, and burn-in captions). Used by
  // the play loop and by one-off repaints when paused.
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !project) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (canvas.width !== project.stage.width || canvas.height !== project.stage.height) {
      canvas.width = project.stage.width;
      canvas.height = project.stage.height;
    }
    const player = getPlayer();
    const f = Math.floor(frameRef.current);
    player.setStage(project.stage.width, project.stage.height);
    player.syncAt(project, f, playingRef.current);
    drawTimelineFrame(ctx, project, f, (a) => player.drawSource(a), player.activeOptions());
    // Captions are composited separately from the timeline frame (as in the
    // editor). Show the default (first) caption track's active cue.
    const capTrack = project.captions?.[0];
    const style = captionStyleOf(capTrack);
    const cue = cueAt(capTrack?.cues, f);
    if (cue && style.burnIn !== false) drawCaption(ctx, project, cue.text, style);
  }, [project, getPlayer]);

  // Play loop: runs ONLY while playing, so a paused or ended player idles the
  // CPU instead of repainting at the display refresh rate forever.
  useEffect(() => {
    playingRef.current = playing;
    if (!playing) { paint(); return; }
    let raf = 0;
    const loop = (ts: number) => {
      const dt = lastTsRef.current ? (ts - lastTsRef.current) / 1000 : 0;
      lastTsRef.current = ts;
      frameRef.current = frameRef.current + dt * fps;
      if (frameRef.current >= duration) {
        frameRef.current = duration;
        setFrame(duration);
        setPlaying(false); // re-runs this effect, which paints the final frame
        return;
      }
      setFrame(frameRef.current);
      paint();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration, fps, paint]);

  // While paused, the loop isn't running, so repaint when late-loading media or
  // fonts become ready (dropping the element raster cache so text redraws in its
  // real face).
  useEffect(() => {
    if (playing) return;
    const offImg = imageAssets.onChange(() => paint());
    const offFont = fonts.onChange(() => { playerRef.current?.invalidateElements(); paint(); });
    return () => { offImg(); offFont(); };
  }, [playing, paint]);

  // Release hidden media elements + the audio graph when leaving the page.
  useEffect(() => () => { playerRef.current?.dispose(); playerRef.current = null; }, []);

  const toggle = useCallback(() => {
    if (!project) return;
    lastTsRef.current = 0;
    if (!playing) {
      // Resume the audio graph on the user gesture (it starts suspended), or a
      // shared video with music/voiceover would play silently.
      void getPlayer().resumeAudio();
      // Replay from the start once the playhead is at the end.
      if (frameRef.current >= duration) { frameRef.current = 0; setFrame(0); }
    }
    setPlaying((p) => !p);
  }, [project, playing, duration, getPlayer]);

  const seek = useCallback((f: number) => {
    frameRef.current = Math.max(0, Math.min(duration, f));
    setFrame(frameRef.current);
    if (!playingRef.current) paint();
  }, [duration, paint]);

  if (!project) {
    return <div className="flex flex-1 items-center justify-center p-8 text-sm text-neutral-500">{tr("app.this_shared_video_has_no_content_yet")}</div>;
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4" dir={DESIGN_SURFACE_DIR}>
      <div className="relative w-full max-w-3xl">
        <canvas
          ref={canvasRef}
          onClick={toggle}
          className="w-full cursor-pointer rounded-lg bg-black shadow-lg"
          style={{ aspectRatio: `${project.stage.width} / ${project.stage.height}` }}
        />
        {!playing && (
          <button
            type="button"
            onClick={toggle}
            aria-label={tr("app.play")}
            className="absolute inset-0 grid place-items-center"
          >
            <span className="grid h-16 w-16 place-items-center rounded-full bg-black/55 text-white backdrop-blur transition hover:bg-black/70">
              <Play size={28} className="translate-x-0.5" fill="currentColor" />
            </span>
          </button>
        )}
      </div>
      <div className="flex w-full max-w-3xl items-center gap-3 text-xs text-neutral-600">
        <button type="button" onClick={toggle} aria-label={playing ? tr("app.pause") : tr("app.play")} className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-neutral-200 text-neutral-700 hover:bg-neutral-300">
          {playing ? <Pause size={15} /> : <Play size={15} className="translate-x-0.5" />}
        </button>
        <span className="tabular-nums">{fmt(frame, fps)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(1, duration)}
          value={Math.min(frame, duration)}
          onChange={(e) => seek(Number(e.target.value))}
          className="h-1 flex-1 cursor-pointer accent-brand-600"
          aria-label={tr("app.seek")}
        />
        <span className="tabular-nums">{fmt(duration, fps)}</span>
      </div>
    </div>
  );
}
