// Caption (subtitle) helpers: cue lookup for the stage and SRT/VTT
// serialization for download. Pure and unit-tested; frames in, text out.

import type { CaptionTrack, VideoProject } from "@hc/timeline";

export type CaptionCue = CaptionTrack["cues"][number];

/** Typed view of a caption track's free-form `style` slot. */
export interface CaptionStyle {
  /** Font size as a fraction of stage height (default 0.045). */
  sizePct?: number;
  color?: string;
  background?: string;
  /** false = SRT/VTT only; cues are not drawn on the stage or in the export. */
  burnIn?: boolean;
}

export function captionStyleOf(track: CaptionTrack | undefined): CaptionStyle {
  return (track?.style as CaptionStyle | undefined) ?? {};
}

const newCapId = (): string => `cap_${Math.random().toString(36).slice(2, 9)}`;

/** Merge a style patch into a caption track (the target track by id, else the
 *  first, created when missing). */
export function withCaptionStyle(project: VideoProject, patch: Partial<CaptionStyle>, trackId?: string): VideoProject {
  const { project: base, track } = withCaptionTrack(project, trackId);
  const style = { ...captionStyleOf(track), ...patch };
  return {
    ...base,
    captions: (base.captions ?? []).map((t) => (t.id === track.id ? { ...t, style } : t)),
  };
}

/** The caption track to edit: the one matching `trackId`, else the first,
 *  creating one (immutably) when the project has none. */
export function withCaptionTrack(project: VideoProject, trackId?: string): { project: VideoProject; track: CaptionTrack } {
  const list = project.captions ?? [];
  const existing = trackId ? list.find((t) => t.id === trackId) : list[0];
  if (existing) return { project, track: existing };
  const track: CaptionTrack = { id: newCapId(), lang: "en", source: "manual", style: {}, cues: [] };
  return { project: { ...project, captions: [...list, track] }, track };
}

/** Replace a caption track's cues (immutably), keeping them sorted. */
export function withCues(project: VideoProject, cues: CaptionCue[], trackId?: string): VideoProject {
  const sorted = [...cues].sort((a, b) => a.startFrame - b.startFrame);
  const { project: base, track } = withCaptionTrack(project, trackId);
  return {
    ...base,
    captions: (base.captions ?? []).map((t) => (t.id === track.id ? { ...t, cues: sorted } : t)),
  };
}

/** Append a new caption track for a language (BCP-47). Returns the track too. */
export function addCaptionTrack(project: VideoProject, lang = "en"): { project: VideoProject; track: CaptionTrack } {
  const track: CaptionTrack = { id: newCapId(), lang, source: "manual", style: {}, cues: [] };
  return { project: { ...project, captions: [...(project.captions ?? []), track] }, track };
}

/** Remove a caption track by id. */
export function removeCaptionTrack(project: VideoProject, trackId: string): VideoProject {
  return { ...project, captions: (project.captions ?? []).filter((t) => t.id !== trackId) };
}

/** Set a caption track's language tag (BCP-47). */
export function setCaptionLang(project: VideoProject, trackId: string, lang: string): VideoProject {
  return { ...project, captions: (project.captions ?? []).map((t) => (t.id === trackId ? { ...t, lang } : t)) };
}

/** The cue under a frame, or null. Later-starting cues win on overlap. */
export function cueAt(cues: CaptionCue[] | undefined, frame: number): CaptionCue | null {
  if (!cues) return null;
  let hit: CaptionCue | null = null;
  for (const c of cues) {
    if (frame >= c.startFrame && frame < c.endFrame) hit = c;
  }
  return hit;
}

function pad(n: number, w = 2): string {
  return n.toString().padStart(w, "0");
}

/** A frame as an SRT/VTT timestamp; SRT uses a comma before milliseconds. */
export function formatCaptionTime(frame: number, fps: number, sep: "," | "."): string {
  const totalMs = Math.max(0, Math.round((frame / Math.max(1, fps)) * 1000));
  const ms = totalMs % 1000;
  const totalS = Math.floor(totalMs / 1000);
  const s = totalS % 60;
  const m = Math.floor(totalS / 60) % 60;
  const h = Math.floor(totalS / 3600);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`;
}

/** Serialize cues as SubRip (SRT). */
export function toSrt(cues: CaptionCue[], fps: number): string {
  return cues
    .map(
      (c, i) =>
        `${i + 1}\n${formatCaptionTime(c.startFrame, fps, ",")} --> ${formatCaptionTime(c.endFrame, fps, ",")}\n${c.text}\n`,
    )
    .join("\n");
}

/** Serialize cues as WebVTT. */
export function toVtt(cues: CaptionCue[], fps: number): string {
  const body = cues
    .map(
      (c) =>
        `${formatCaptionTime(c.startFrame, fps, ".")} --> ${formatCaptionTime(c.endFrame, fps, ".")}\n${c.text}\n`,
    )
    .join("\n");
  return `WEBVTT\n\n${body}`;
}
