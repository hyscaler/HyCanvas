// Pose a design at an animation time: returns a deep-cloned
// DesignFile with every animated node's transform/opacity advanced to time tMs,
// composing entrance -> emphasis/custom (+ image motion) exactly like present
// mode. Pure (no canvas), so animated export can sample frames headlessly and
// the result matches on-screen playback.

import type { DesignFile, Node, NodeAnimation, ImageMotion } from "@hc/schema";
import { childrenOf } from "@hc/schema";
import {
  type AnimPatch, identityPatch, appliedOpacity, clipEnd,
  entrancePatch, emphasisPatch, customPatch, imageMotionPatch, entranceProgress,
} from "./animation";

type TextRun = { text: string; style?: unknown };
type TextPara = { runs: TextRun[]; style?: unknown };

/** Reveal only the first `keep` characters across a rich-text node's runs (the
 *  "typewriter" effect), truncating in place on a cloned node. Later runs become
 *  empty so layout (line breaks, alignment) stays stable as text appears. */
function revealTextContent(node: Node, keep: number): void {
  const content = (node as unknown as { content?: TextPara[] }).content;
  if (!Array.isArray(content)) return;
  let budget = Math.max(0, Math.floor(keep));
  for (const para of content) {
    if (!para || !Array.isArray(para.runs)) continue;
    for (const run of para.runs) {
      const len = run.text ? run.text.length : 0;
      if (budget >= len) { budget -= len; continue; }
      run.text = run.text ? run.text.slice(0, budget) : "";
      budget = 0;
    }
  }
}

/** Total character count across a text node's runs. */
function textLength(node: Node): number {
  const content = (node as unknown as { content?: TextPara[] }).content;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const para of content) for (const run of para.runs ?? []) n += run.text ? run.text.length : 0;
  return n;
}

/** Word count across a text node's runs (whitespace-delimited). */
function wordCount(node: Node): number {
  const content = (node as unknown as { content?: TextPara[] }).content;
  if (!Array.isArray(content)) return 0;
  const text = content.map((p) => (p.runs ?? []).map((r) => r.text ?? "").join("")).join(" ");
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

/** Reveal only the first `keepWords` whole words across the runs (word-wipe). */
function revealTextWords(node: Node, keepWords: number): void {
  const content = (node as unknown as { content?: TextPara[] }).content;
  if (!Array.isArray(content)) return;
  let budget = Math.max(0, Math.floor(keepWords));
  // Walk runs char-by-char, counting word starts; cut once the budget is spent
  // and we hit the next whitespace boundary (so a revealed word stays whole).
  let inWord = false;
  let done = false;
  for (const para of content) {
    if (!para || !Array.isArray(para.runs)) continue;
    for (const run of para.runs) {
      if (done) { run.text = ""; continue; }
      const t = run.text ?? "";
      let out = "";
      for (let i = 0; i < t.length; i++) {
        const ws = /\s/.test(t[i]);
        if (!ws && !inWord) { // word start
          if (budget <= 0) { done = true; break; }
          inWord = true;
          budget -= 1;
        } else if (ws) {
          inWord = false;
        }
        out += t[i];
      }
      run.text = out;
    }
  }
}

function compose(a: AnimPatch | null, b: AnimPatch): AnimPatch {
  const base = a ?? identityPatch;
  return {
    dx: base.dx + b.dx,
    dy: base.dy + b.dy,
    scale: base.scale * b.scale,
    rotate: base.rotate + b.rotate,
    opacityMul: base.opacityMul * b.opacityMul,
    // v23 absolute channels: the later patch wins where defined (the custom
    // track composes over the entrance, so its overrides take precedence).
    ...(b.color !== undefined ? { color: b.color } : a?.color !== undefined ? { color: a.color } : {}),
    ...(b.width !== undefined ? { width: b.width } : a?.width !== undefined ? { width: a.width } : {}),
    ...(b.height !== undefined ? { height: b.height } : a?.height !== undefined ? { height: a.height } : {}),
  };
}

function applyPatch(node: Node, patch: AnimPatch): void {
  const n = node as unknown as {
    transform: { x: number; y: number; scaleX: number; scaleY: number; rotation: number };
    opacity: number;
    size: { width: number; height: number };
    fills?: { type?: string; color?: unknown }[];
    content?: { runs: { style: { fill?: { type?: string; color?: unknown } } }[] }[];
  };
  const t = n.transform;
  n.opacity = appliedOpacity(n.opacity, patch.opacityMul);
  // v23 size channels: absolute px, keeping the node's CENTER fixed (the
  // half-delta shifts x/y in scaled page units), matching how scale reads.
  let cx = 0;
  let cy = 0;
  if (patch.width !== undefined && n.size) {
    cx = ((n.size.width - patch.width) / 2) * t.scaleX;
    n.size = { ...n.size, width: patch.width };
  }
  if (patch.height !== undefined && n.size) {
    cy = ((n.size.height - patch.height) / 2) * t.scaleY;
    n.size = { ...n.size, height: patch.height };
  }
  n.transform = {
    ...t,
    x: t.x + patch.dx + cx,
    y: t.y + patch.dy + cy,
    scaleX: t.scaleX * patch.scale,
    scaleY: t.scaleY * patch.scale,
    rotation: t.rotation + patch.rotate,
  };
  // v23 color channel: an absolute override on the node's solid fills and, for
  // text, on every run's solid fill. Poses mutate CLONES, so this never
  // touches the document.
  if (patch.color !== undefined) {
    if (Array.isArray(n.fills)) {
      n.fills = n.fills.map((f) => (f && f.type === "solid" ? { ...f, color: patch.color } : f));
    }
    for (const para of n.content ?? []) {
      for (const run of para.runs) {
        if (run.style.fill && run.style.fill.type === "solid") run.style.fill = { ...run.style.fill, color: patch.color };
      }
    }
  }
}

/** Reveal a text node's content for a typewriter/word-wipe entrance at local time
 *  `tMs` (no-op for other presets / non-text / after the clip ends). Mutates the
 *  node in place, so callers pass a clone or restore afterward. Shared by the
 *  poser, the editor "Play" preview, and present mode so all three match. */
export function revealEntranceText(node: Node, clip: { preset: string; durationMs: number; delayMs: number; easing: import("@hc/schema").Easing; bezier?: [number, number, number, number] }, tMs: number): void {
  if (node.type !== "text") return;
  if (clip.preset !== "typewriter" && clip.preset !== "word-wipe") return;
  if (tMs > clip.delayMs + clip.durationMs) return; // fully revealed once done
  const prog = entranceProgress(clip as never, tMs);
  if (clip.preset === "word-wipe") revealTextWords(node, prog * wordCount(node));
  else revealTextContent(node, prog * textLength(node));
}

/** Effective entrance start (ms) per node id, resolving cross-element sequencing
 *  ("with previous" / "after previous") against sibling order. Only entrances
 *  participate; nodes without one are skipped. Exported so the live preview and
 *  present mode resolve sequencing identically to the poser/export. */
export function sequenceStarts(nodes: Node[]): Map<string, number> {
  const starts = new Map<string, number>();
  let prevStart = 0;
  let prevEnd = 0;
  for (const n of nodes) {
    const ent = (n as unknown as { animation?: NodeAnimation }).animation?.entrance;
    if (!ent) continue;
    const mode = ent.startMode ?? "delay";
    const start = mode === "with-previous" ? prevStart : mode === "after-previous" ? prevEnd : ent.delayMs;
    starts.set(n.id, start);
    prevStart = start;
    prevEnd = start + ent.durationMs;
  }
  return starts;
}

/** The total animated duration of a page in ms (max over its nodes' entrance +
 *  emphasis/custom windows), for choosing an export length. Image motion loops,
 *  so it does not extend the total. */
export function pageAnimationDuration(file: DesignFile, pageIndex = 0): number {
  const page = file.pages[pageIndex];
  if (!page) return 0;
  const starts = sequenceStarts(page.children);
  let total = 0;
  const visit = (nodes: Node[]): void => {
    for (const n of nodes) {
      const anim = (n as unknown as { animation?: NodeAnimation }).animation;
      if (anim) {
        // Honor cross-element sequencing: a clip can start after the previous one.
        const entStart = starts.get(n.id);
        const entEnd = anim.entrance ? (entStart ?? anim.entrance.delayMs) + anim.entrance.durationMs : 0;
        let end = entEnd;
        if (anim.emphasis) end = Math.max(end, entEnd + clipEnd(anim.emphasis));
        if (anim.custom) end = Math.max(end, entEnd + anim.custom.durationMs);
        total = Math.max(total, end);
      }
      const kids = childrenOf(n);
      if (kids.length) visit(kids);
    }
  };
  visit(page.children);
  return total;
}

/** Return a clone of `file` with page `pageIndex` posed at time `tMs`. */
export function poseDesignAt(file: DesignFile, pageIndex: number, tMs: number): DesignFile {
  const clone = structuredClone(file);
  const page = clone.pages[pageIndex];
  if (!page) return clone;
  const starts = sequenceStarts(page.children);
  const visit = (nodes: Node[]): void => {
    for (const n of nodes) {
      const anim = (n as unknown as { animation?: NodeAnimation }).animation;
      const motion = n.type === "image" ? (n as unknown as { motion?: ImageMotion }).motion : undefined;
      if (anim || motion) {
        // Apply cross-element sequencing by overriding the entrance's effective
        // delay (so "after previous" starts when the previous element finishes).
        const entrance = anim?.entrance && starts.has(n.id)
          ? { ...anim.entrance, delayMs: starts.get(n.id)! }
          : anim?.entrance;
        let patch: AnimPatch | null = null;
        const entEnd = clipEnd(entrance);
        if (entrance && tMs <= entEnd) patch = entrancePatch(entrance, tMs);
        else if (anim?.emphasis) patch = emphasisPatch(anim.emphasis, tMs - entEnd);
        else if (entrance) patch = entrancePatch(entrance, entEnd);
        if (anim?.custom) patch = compose(patch, customPatch(anim.custom, tMs - entEnd));
        if (motion) patch = compose(patch, imageMotionPatch(motion, tMs));
        if (patch) applyPatch(n, patch);
        // Typewriter / word-wipe entrances reveal content over the clip (shared
        // helper, so live preview and present mode match exactly).
        if (entrance) revealEntranceText(n, entrance, tMs);
      }
      const kids = childrenOf(n);
      if (kids.length) visit(kids);
    }
  };
  visit(page.children);
  return clone;
}
