// Page-level animation build order (doc 28 FR-10).
//
// A pure projection of a page's entrance animations onto one timeline: for each
// animated node, when it starts, how long it runs, and how it is sequenced
// relative to the previous one. This is the model behind the build-order strip
// (PowerPoint's Animation Pane / Keynote's Build Order) and it reuses the
// shipped `sequenceStarts` contract, so the strip cannot disagree with playback.
//
// Framework-agnostic: no React, no DOM. Rendering the strip is the caller's job.

import type { AnimationStartMode, Node, NodeAnimation, Page } from "@hc/schema";
import { sequenceStarts } from "./pose";

/** One animated element's slot on the page timeline. */
export interface BuildStep {
  nodeId: string;
  nodeName?: string;
  /** Position among animated siblings, 1-based (what the UI numbers). */
  order: number;
  /** Index of this node in the page's `children`, so a caller can reorder it. */
  childIndex: number;
  preset: string;
  startMode: AnimationStartMode;
  /** Absolute start on the page timeline, in ms. */
  startMs: number;
  durationMs: number;
  /** `startMs + durationMs`. */
  endMs: number;
}

/** The whole page timeline: every animated element, in build order. */
export interface BuildPlan {
  steps: BuildStep[];
  /** When the last entrance finishes, in ms (0 when nothing animates). */
  totalMs: number;
}

function entranceOf(node: Node): NodeAnimation["entrance"] | undefined {
  return (node as unknown as { animation?: NodeAnimation }).animation?.entrance;
}

/**
 * Project a page's entrance animations onto one ordered timeline.
 *
 * Order is the page's child order restricted to animated nodes, which is what
 * `sequenceStarts` walks, so "step 2" here is the same element playback treats
 * as second. Nodes with no entrance are omitted; a node whose start cannot be
 * resolved (it has an entrance but `sequenceStarts` skipped it) is defensively
 * skipped too, rather than being drawn at a wrong time.
 */
export function planBuildOrder(page: Page): BuildPlan {
  const children = page.children ?? [];
  const starts = sequenceStarts(children);
  const steps: BuildStep[] = [];
  let totalMs = 0;

  children.forEach((node, childIndex) => {
    const ent = entranceOf(node);
    if (!ent) return;
    const startMs = starts.get(node.id);
    if (startMs === undefined) return;
    const endMs = startMs + ent.durationMs;
    steps.push({
      nodeId: node.id,
      nodeName: node.name,
      order: steps.length + 1,
      childIndex,
      preset: ent.preset,
      startMode: ent.startMode ?? "delay",
      startMs,
      durationMs: ent.durationMs,
      endMs,
    });
    if (endMs > totalMs) totalMs = endMs;
  });

  return { steps, totalMs };
}

/**
 * The child index a build step must move to so it lands at build position
 * `toOrder` (1-based) among the animated siblings.
 *
 * Reordering the build strip reorders the page's children, because the child
 * order IS the build order. Only animated siblings shift; a non-animated node
 * sitting between them keeps its place, which is why this maps through the
 * animated subset rather than assuming the two orders are the same.
 *
 * Returns null when the move is a no-op or out of range.
 */
export function childIndexForBuildOrder(page: Page, fromOrder: number, toOrder: number): number | null {
  const { steps } = planBuildOrder(page);
  if (fromOrder === toOrder) return null;
  if (fromOrder < 1 || fromOrder > steps.length) return null;
  if (toOrder < 1 || toOrder > steps.length) return null;
  return steps[toOrder - 1].childIndex;
}

/** Human label for a start mode, shared by the strip and any tooltip. */
export function startModeLabel(mode: AnimationStartMode): string {
  switch (mode) {
    case "with-previous":
      return "With previous";
    case "after-previous":
      return "After previous";
    default:
      return "On delay";
  }
}
