// @hc/timeline scenes: the design-video "pages" model. Element clips (clips
// carrying a sceneId) group into scenes; each scene is a contiguous time block
// whose element clips share [startFrame, startFrame+durationFrames). These pure
// helpers derive the scene list and re-pack scenes contiguously after an
// add / reorder / duplicate / delete. Footage/audio clips (no sceneId) are left
// untouched, so scenes and free clips can coexist.

import { clipEndFrame, type VideoProject } from "./model";

export interface SceneInfo {
  id: string;
  startFrame: number;
  durationFrames: number;
  /** ids of the clips composing this scene, across tracks. */
  clipIds: string[];
}

/** Ordered scenes derived from element clips, earliest first. */
export function listScenes(project: VideoProject): SceneInfo[] {
  const acc = new Map<string, { start: number; end: number; ids: string[] }>();
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (!c.sceneId) continue;
      const end = clipEndFrame(c);
      const cur = acc.get(c.sceneId);
      if (cur) {
        cur.start = Math.min(cur.start, c.startFrame);
        cur.end = Math.max(cur.end, end);
        cur.ids.push(c.id);
      } else {
        acc.set(c.sceneId, { start: c.startFrame, end, ids: [c.id] });
      }
    }
  }
  return [...acc.entries()]
    .map(([id, v]) => ({ id, startFrame: v.start, durationFrames: Math.max(1, v.end - v.start), clipIds: v.ids }))
    .sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : 1));
}

/** The scene (page) containing a timeline frame, or null. */
export function sceneAtFrame(project: VideoProject, frame: number): SceneInfo | null {
  for (const s of listScenes(project)) {
    if (frame >= s.startFrame && frame < s.startFrame + s.durationFrames) return s;
  }
  return null;
}

/** Re-pack scenes as contiguous blocks in `orderedIds` order: each scene's clips
 *  shift so the scene begins at the running start (intra-scene layer offsets are
 *  preserved). Scenes present in the project but missing from `orderedIds` keep
 *  their relative order at the end. Clips with no sceneId are untouched. */
export function packScenes(project: VideoProject, orderedIds: string[]): VideoProject {
  const scenes = listScenes(project);
  const byId = new Map(scenes.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of orderedIds) {
    if (byId.has(id) && !seen.has(id)) {
      order.push(id);
      seen.add(id);
    }
  }
  for (const s of scenes) if (!seen.has(s.id)) order.push(s.id);

  const startOf = new Map<string, number>();
  let run = 0;
  for (const id of order) {
    startOf.set(id, run);
    run += byId.get(id)!.durationFrames;
  }
  return {
    ...project,
    tracks: project.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (!c.sceneId) return c;
        const sc = byId.get(c.sceneId);
        if (!sc) return c;
        const offset = c.startFrame - sc.startFrame;
        return { ...c, startFrame: startOf.get(c.sceneId)! + offset };
      }),
    })),
  };
}
