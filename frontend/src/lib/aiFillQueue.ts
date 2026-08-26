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
  /** The content each slot landed with (the deterministic fill): a slot whose
   *  live text no longer matches was EDITED by the user while the refinement
   *  ran, and is left alone. */
  expected: { texts: Record<string, string>; lists: Record<string, string[]> };
  /** The design these refinements belong to, so a Stop can drop the ones that
   *  have not started and progress can be reported per design. */
  designId: string;
}

/** Queue progress for one design, so the panel can say "refining slide 3 of 9"
 *  instead of leaving the user watching text change by itself. */
export interface AiFillProgress {
  designId: string;
  done: number;
  total: number;
  /** Slides whose model copy failed. They keep the deterministic outline text,
   *  which reads as finished, so the count has to be surfaced or the user
   *  cannot tell written copy from their own brief echoed back. */
  failed: number;
}
type FillListener = (p: AiFillProgress) => void;
const fillListeners = new Set<FillListener>();

export function subscribeAiFillQueue(cb: FillListener): () => void {
  fillListeners.add(cb);
  return () => fillListeners.delete(cb);
}

// Per design: how many refinements were queued in this batch and how many have
// settled. Reset once a batch drains, so a later generation counts from zero.
const totalByDesign = new Map<string, number>();
const doneByDesign = new Map<string, number>();
const failedByDesign = new Map<string, AiFillTask[]>();

function reportProgress(designId: string): void {
  const total = totalByDesign.get(designId) ?? 0;
  const done = doneByDesign.get(designId) ?? 0;
  const failed = (failedByDesign.get(designId) ?? []).length;
  for (const cb of fillListeners) cb({ designId, done, total, failed });
  if (total > 0 && done >= total) {
    totalByDesign.delete(designId);
    doneByDesign.delete(designId);
  }
}

/** Re-queue the slides whose copy failed (the chat's Retry). Returns how many
 *  were re-queued. */
export function retryFailedAiFills(designId: string): number {
  const failed = failedByDesign.get(designId) ?? [];
  failedByDesign.delete(designId);
  enqueueAiFills(failed);
  return failed.length;
}

/** Drop every refinement for a design that has not started yet (the chat's
 *  Stop). In-flight calls are left to settle: their result is discarded by the
 *  page checks in refine(), and aborting them buys nothing already paid for. */
export function cancelAiFills(designId: string): number {
  let dropped = 0;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].designId === designId) {
      queue.splice(i, 1);
      dropped++;
    }
  }
  totalByDesign.delete(designId);
  doneByDesign.delete(designId);
  failedByDesign.delete(designId);
  return dropped;
}

/** Flatten a placeholder box's live text for the edited-slot comparison. */
function liveSlotText(page: { children: unknown[] }, placeholderId: string): string | null {
  type Textish = { type: string; data?: { placeholderId?: string }; content?: { runs: { text: string }[] }[] };
  const node = (page.children as Textish[]).find((n) => n.type === "text" && n.data?.placeholderId === placeholderId);
  if (!node?.content) return null;
  return node.content.map((par) => par.runs.map((r) => r.text).join("")).join("\n");
}

/** The text a slot was landed with (mirrors fillPlaceholderContent's shape:
 *  lists render one bulleted paragraph per item). */
function expectedSlotText(expected: AiFillTask["expected"], placeholderId: string): string | null {
  if (placeholderId in expected.texts) return expected.texts[placeholderId];
  if (placeholderId in expected.lists) return expected.lists[placeholderId].map((x) => `\u2022  ${x}`).join("\n");
  return null;
}

const queue: AiFillTask[] = [];
let running = 0;
const maxConcurrent = 3;

/** Queue per-slide refinements; each lands independently as it completes. */
export function enqueueAiFills(tasks: AiFillTask[]): void {
  if (!tasks.length) return;
  for (const t of tasks) totalByDesign.set(t.designId, (totalByDesign.get(t.designId) ?? 0) + 1);
  queue.push(...tasks);
  for (const id of new Set(tasks.map((t) => t.designId))) reportProgress(id);
  pump();
}

function pump(): void {
  while (running < maxConcurrent && queue.length) {
    const task = queue.shift()!;
    running++;
    void refine(task)
      .catch(() => {
        // The outline content stays on the slide, so nothing is broken - but
        // the user must be able to see which slides never got model copy, and
        // ask for them again.
        const list = failedByDesign.get(task.designId) ?? [];
        list.push(task);
        failedByDesign.set(task.designId, list);
      })
      .finally(() => {
        running--;
        doneByDesign.set(task.designId, (doneByDesign.get(task.designId) ?? 0) + 1);
        reportProgress(task.designId);
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
  // Never overwrite a user edit: a slot whose live text diverged from what the
  // deck landed with was touched by the user while this call ran; drop the
  // refinement for that slot and keep theirs.
  const page = st.doc.pages[idx] as unknown as { children: unknown[] };
  const keepTexts: Record<string, string> = {};
  const keepLists: Record<string, string[]> = {};
  for (const [slot, v] of Object.entries(fill.texts)) {
    const expectedText = expectedSlotText(task.expected, slot);
    if (expectedText === null || liveSlotText(page, slot) === expectedText) keepTexts[slot] = v;
  }
  for (const [slot, v] of Object.entries(fill.lists)) {
    const expectedText = expectedSlotText(task.expected, slot);
    if (expectedText === null || liveSlotText(page, slot) === expectedText) keepLists[slot] = v;
  }
  if (!Object.keys(keepTexts).length && !Object.keys(keepLists).length) return;
  // Continues the generation turn, so it records no undo entry of its own
  // (see runWithoutHistory): one undo should revert the deck, not peel off
  // one late slide refinement.
  st.runWithoutHistory(() => {
    st.fillPlaceholderContent(idx, { texts: keepTexts, lists: keepLists }, { styles: task.styles as never });
  });
  if (task.onImagePrompts && Object.keys(fill.imagePrompts).length) {
    task.onImagePrompts(task.pageId, fill.imagePrompts);
  }
}
