// @hc/docs block diff (F31).
//
// Match blocks by id and classify added/removed/modified/unchanged. For modified
// text blocks, compute a word-level inline diff via a simple LCS so a reviewer
// sees exactly what changed. Pure, no I/O.

import { type DocBlock, richTextToPlain } from "./model";

export type BlockDiffType = "added" | "removed" | "unchanged" | "modified";

export interface InlineDiffSpan {
  text: string;
  op: "same" | "add" | "del";
}

export interface BlockDiffEntry {
  type: BlockDiffType;
  block: DocBlock;
  before?: DocBlock;
  inline?: InlineDiffSpan[];
}

/** Read a block's comparable plain text, or null for non-text blocks. */
function blockText(block: DocBlock): string | null {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "quote":
    case "callout":
      return richTextToPlain(block.text);
    case "code":
      return block.code;
    case "list":
      return block.items.map((i) => richTextToPlain(i.text)).join("\n");
    default:
      return null;
  }
}

/** Stable structural key for equality: serialize with sorted keys. */
function structuralEqual(a: DocBlock, b: DocBlock): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

/** Word-level LCS inline diff between two strings. */
export function inlineWordDiff(before: string, after: string): InlineDiffSpan[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const spans: InlineDiffSpan[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pushSpan(spans, a[i], "same");
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushSpan(spans, a[i], "del");
      i++;
    } else {
      pushSpan(spans, b[j], "add");
      j++;
    }
  }
  while (i < n) {
    pushSpan(spans, a[i], "del");
    i++;
  }
  while (j < m) {
    pushSpan(spans, b[j], "add");
    j++;
  }
  return spans;
}

// Tokenize keeping whitespace as its own tokens so reconstruction is faithful.
function tokenize(s: string): string[] {
  return s.match(/\s+|\S+/g) ?? [];
}

// Merge adjacent spans of the same op for a compact result.
function pushSpan(spans: InlineDiffSpan[], text: string, op: InlineDiffSpan["op"]): void {
  const last = spans[spans.length - 1];
  if (last && last.op === op) {
    last.text += text;
  } else {
    spans.push({ text, op });
  }
}

/**
 * Diff two block lists, matching by id. Blocks only in `b` are "added", only in
 * `a` are "removed", same id with differing content are "modified" (with an
 * inline word diff when both are text blocks), and identical blocks are
 * "unchanged". Result order follows `b` first (added/modified/unchanged in their
 * b positions), then removed blocks in their original `a` order.
 */
export function diffBlocks(a: DocBlock[], b: DocBlock[]): BlockDiffEntry[] {
  const aById = new Map<string, DocBlock>();
  for (const block of a) aById.set(block.id, block);
  const bIds = new Set(b.map((block) => block.id));

  const entries: BlockDiffEntry[] = [];

  for (const block of b) {
    const before = aById.get(block.id);
    if (!before) {
      entries.push({ type: "added", block });
      continue;
    }
    if (structuralEqual(before, block)) {
      entries.push({ type: "unchanged", block });
      continue;
    }
    const entry: BlockDiffEntry = { type: "modified", block, before };
    const beforeText = blockText(before);
    const afterText = blockText(block);
    if (beforeText !== null && afterText !== null) {
      entry.inline = inlineWordDiff(beforeText, afterText);
    }
    entries.push(entry);
  }

  for (const block of a) {
    if (!bIds.has(block.id)) {
      entries.push({ type: "removed", block });
    }
  }

  return entries;
}
