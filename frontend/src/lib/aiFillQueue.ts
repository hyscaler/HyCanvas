// F28 T18 - progressive per-slide content refinement. Layout-grounded
// generation lands its pages INSTANTLY with the outline's own content
// (deterministic fills: real titles and points, not placeholders), and this
// queue then runs the per-slide model fills behind the scenes, replacing each
// page's content as its call completes - the text sibling of the T10 image
// queue. Every application goes through the page-id-addressed store mutation,
// so a late result after an undo (the page id is gone) or a design switch
// no-ops instead of corrupting anything. Failures keep the outline content:
// the deck is complete either way, so nothing is surfaced as an error.

import type { SlideLayout } from "@hc/schema";
import { deriveLayoutContentSchema, layoutFillSystemPrompt, normalizeLayoutFill, type LayoutFill } from "@hc/aistudio";
import { useEditor } from "@/store/editor";
import { oc } from "@/lib/sdk";
import { parseModelJson } from "@/lib/magicDesign";

export interface AiFillTask {
  workspaceId: string;
  pageId: string;
  layout: SlideLayout;
  /** The fill prompt for this slide (deck context + outline item). */
  prompt: string;
  /** Style clause (dials + brand voice) forwarded to the fill system prompt. */
  styleClause: string;
  /** Per-slot style overrides, resolved at enqueue time (brand fonts + ink). */
  styles: Record<string, { fontFamily?: string; fill?: unknown }>;
  /** Called with the fill's image prompts so picture slots route to the image
   *  queue only after the REAL fill decided them. */
  onImagePrompts?: (pageId: string, prompts: Record<string, string>) => void;
}

const queue: AiFillTask[] = [];
let running = 0;
const maxConcurrent = 3;

/** Queue per-slide refinements; each lands independently as it completes. */
export function enqueueAiFills(tasks: AiFillTask[]): void {
  if (!tasks.length) return;
  queue.push(...tasks);
  pump();
}

function pump(): void {
  while (running < maxConcurrent && queue.length) {
    const task = queue.shift()!;
    running++;
    void refine(task)
      .catch(() => {}) // the outline content stays; a failed refinement is silent
      .finally(() => {
        running--;
        if (queue.length) pump();
      });
  }
}

async function refine(task: AiFillTask): Promise<void> {
  // The page must still exist BEFORE spending a model call on it.
  if (!useEditor.getState().doc.pages.some((p) => p.id === task.pageId)) return;
  const schema = deriveLayoutContentSchema(task.layout);
  const { text } = await oc.aiTextStructured({
    workspaceId: task.workspaceId,
    system: layoutFillSystemPrompt(schema, task.styleClause),
    prompt: task.prompt,
    schema,
  });
  const fill: LayoutFill = normalizeLayoutFill(task.layout, parseModelJson(text));
  if (!Object.keys(fill.texts).length && !Object.keys(fill.lists).length) return;
  const st = useEditor.getState();
  const idx = st.doc.pages.findIndex((p) => p.id === task.pageId);
  if (idx < 0) return; // undone or switched away: the late result no-ops
  st.fillPlaceholderContent(idx, { texts: fill.texts, lists: fill.lists }, { styles: task.styles as never });
  if (task.onImagePrompts && Object.keys(fill.imagePrompts).length) {
    task.onImagePrompts(task.pageId, fill.imagePrompts);
  }
}
