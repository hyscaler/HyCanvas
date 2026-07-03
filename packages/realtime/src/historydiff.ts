// Semantic history labels (doc 16 FR-9). The server journals raw Yjs update
// frames and cannot decode them (no pure-Go CRDT decoder), but the client folds
// any history point into a plain DesignFile. Diffing the folded state before and
// after an op-stop yields a human label ("Moved 3 elements") for the history
// scrubber, replacing the bare author + edit-count. Pure and framework-free so
// it is unit tested without a live doc.

import { walkNodes, type DesignFile, type Node, type Page } from "@hc/schema";

interface NodeSnap {
  type: string;
  x: number;
  y: number;
  sx: number;
  sy: number;
  w: number;
  h: number;
  rot: number;
  /** Signature of everything except id/transform/size/children, so a fill or
   *  text change reads as an "edit" distinct from a move/resize. */
  sig: string;
}

function contentSig(n: Node): string {
  const rest = { ...(n as unknown as Record<string, unknown>) };
  delete rest.id;
  delete rest.transform;
  delete rest.size;
  delete rest.children; // children are diffed as their own nodes
  try {
    return JSON.stringify(rest);
  } catch {
    return "";
  }
}

/** Flatten every node across all pages, keyed by id (groups + their children). */
function flatten(file: DesignFile): Map<string, NodeSnap> {
  const map = new Map<string, NodeSnap>();
  for (const page of file.pages ?? []) {
    walkNodes(page.children ?? [], (n) => {
      const t = (n.transform ?? {}) as { x?: number; y?: number; scaleX?: number; scaleY?: number; rotation?: number };
      const size = ((n as { size?: { width?: number; height?: number } }).size ?? {});
      map.set(n.id, {
        type: n.type,
        x: t.x ?? 0,
        y: t.y ?? 0,
        sx: t.scaleX ?? 1,
        sy: t.scaleY ?? 1,
        w: size.width ?? 0,
        h: size.height ?? 0,
        rot: t.rotation ?? 0,
        sig: contentSig(n),
      });
    });
  }
  return map;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * A concise label for what changed between two folded design states. Returns ""
 * when no node- or page-level change is detected (the caller then falls back to
 * the author + edit-count label). A single kind of change gets a specific verb
 * ("Moved 2 elements"); a mix gets a neutral "Edited N elements".
 */
export function diffLabel(before: DesignFile, after: DesignFile): string {
  const a = flatten(before);
  const b = flatten(after);
  let added = 0, removed = 0, moved = 0, resized = 0, rotated = 0, edited = 0;
  for (const [id, nb] of b) {
    const na = a.get(id);
    if (!na) { added++; continue; }
    // A size OR scale change reads as a resize (group/multi-select resizes scale
    // rather than changing size). Position is a move; rotation its own verb.
    if (na.w !== nb.w || na.h !== nb.h || na.sx !== nb.sx || na.sy !== nb.sy) resized++;
    else if (na.x !== nb.x || na.y !== nb.y) moved++;
    else if (na.rot !== nb.rot) rotated++;
    else if (na.sig !== nb.sig) edited++;
  }
  for (const id of a.keys()) if (!b.has(id)) removed++;

  // [count, Verb (single-kind), verb (enumerated)] in display priority order.
  const kinds: Array<[number, string, string]> = [
    [added, "Added", "added"],
    [removed, "Deleted", "deleted"],
    [moved, "Moved", "moved"],
    [resized, "Resized", "resized"],
    [rotated, "Rotated", "rotated"],
    [edited, "Edited", "edited"],
  ];
  const nonzero = kinds.filter(([c]) => c > 0);
  if (nonzero.length === 1) return `${nonzero[0][1]} ${plural(nonzero[0][0], "element")}`;
  if (nonzero.length > 1) {
    // Mixed op: enumerate each kind ("Added 1, moved 2") so no detail is lost.
    const parts = nonzero.map(([c, , v]) => `${v} ${c}`);
    const s = parts.join(", ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // No node-level change: describe page structure/props instead.
  const pa: Page[] = before.pages ?? [];
  const pb: Page[] = after.pages ?? [];
  if (pb.length > pa.length) return `Added ${plural(pb.length - pa.length, "page")}`;
  if (pa.length > pb.length) return `Removed ${plural(pa.length - pb.length, "page")}`;
  // Same page count: compare per-page props by id (rename, resize, background).
  const byId = new Map(pa.map((p) => [p.id, p]));
  let renamed = 0, pageResized = 0, bgChanged = 0;
  for (const p of pb) {
    const q = byId.get(p.id);
    if (!q) continue;
    if ((p.name ?? "") !== (q.name ?? "")) renamed++;
    else if (p.width !== q.width || p.height !== q.height) pageResized++;
    else if (JSON.stringify(p.background ?? null) !== JSON.stringify(q.background ?? null)) bgChanged++;
  }
  if (renamed) return `Renamed ${plural(renamed, "page")}`;
  if (pageResized) return `Resized ${plural(pageResized, "page")}`;
  if (bgChanged) return bgChanged === 1 ? "Changed page background" : "Changed page backgrounds";
  return "";
}
