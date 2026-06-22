// @hc/timeline - nested sequences.
//
// A clip may reference another VideoProject by `sequenceId`. Nesting must never
// form a cycle (a sequence referencing itself transitively) and depth is
// bounded. The caller supplies a `resolve` function mapping a sequenceId to its
// VideoProject (or null if unresolved).

import type { VideoProject } from "./model";

/** Maximum allowed nesting depth before nesting is rejected. */
export const MAX_NEST_DEPTH = 16;

export type ResolveSequence = (sequenceId: string) => VideoProject | null;

/** Collect every sequenceId referenced directly by a project's clips. */
function directSequenceRefs(project: VideoProject): string[] {
  const ids: string[] = [];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.sequenceId) ids.push(clip.sequenceId);
    }
  }
  return ids;
}

/**
 * Validate that every nested sequence reference in a project resolves and that
 * the nesting forms no cycle and does not exceed MAX_NEST_DEPTH. Returns false
 * if any reference is unresolved, a cycle is found, or the depth limit is
 * exceeded.
 */
export function nestClipRefsValid(project: VideoProject, resolve: ResolveSequence): boolean {
  const visiting = new Set<string>();

  const walk = (proj: VideoProject, depth: number): boolean => {
    if (depth > MAX_NEST_DEPTH) return false;
    for (const seqId of directSequenceRefs(proj)) {
      if (visiting.has(seqId)) return false; // cycle
      const child = resolve(seqId);
      if (!child) return false; // unresolved reference
      visiting.add(seqId);
      if (!walk(child, depth + 1)) return false;
      visiting.delete(seqId);
    }
    return true;
  };

  return walk(project, 0);
}

/**
 * Would adding a clip that references `sequenceId` into `project` create a cycle?
 * True if the target sequence (transitively) references `project` itself, or if
 * resolving the target would exceed the depth limit. `project` is the project
 * being edited; if it is itself registered under some id, pass `selfId` so a
 * direct self-reference is detected.
 */
export function wouldCreateCycle(
  project: VideoProject,
  sequenceId: string,
  resolve: ResolveSequence,
  selfId?: string,
): boolean {
  // Direct self-reference.
  if (selfId && sequenceId === selfId) return true;

  // Walk the target's transitive references. If we ever reach `selfId`, or any
  // id already on the current path, it is a cycle. We also fail on excessive
  // depth or unresolved targets being absent is treated as "no cycle via that
  // branch" (an unresolved ref cannot close a loop back to us).
  const onPath = new Set<string>();

  const reaches = (seqId: string, depth: number): boolean => {
    if (depth > MAX_NEST_DEPTH) return true; // treat over-deep as a reject
    if (selfId && seqId === selfId) return true;
    if (onPath.has(seqId)) return true;
    const proj = resolve(seqId);
    if (!proj) return false;
    onPath.add(seqId);
    for (const child of directSequenceRefs(proj)) {
      if (reaches(child, depth + 1)) return true;
    }
    onPath.delete(seqId);
    return false;
  };

  return reaches(sequenceId, 0);
}
