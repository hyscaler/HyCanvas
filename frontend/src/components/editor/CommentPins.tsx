// Comment pins rendered over the canvas: one numbered pin per
// thread, anchored to its element (top-right of the node world-AABB) or to a
// freeform region/point in page coords, converted to screen via the shared
// CanvasApi so pins track pan and zoom exactly like presence cursors. An element
// anchor whose node was deleted is `orphaned` and its pin is hidden (the thread
// still lists in the panel). A draft anchor (pin being composed) renders a dashed
// placeholder. Clicking a pin opens its thread in the panel.

import { worldAABB } from "@hc/editor";
import { useEditor } from "@/store/editor";
import { useComments } from "@/store/comments";
import { useAuth } from "@/store/auth";
import { initials, avatarColor } from "@/lib/avatar";
import type { CommentAnchor, CommentThread } from "@hc/sdk";
import type { CanvasApi } from "@/lib/useEditorCanvas";
import { tr } from "@/lib/i18n";

/** Page-space (canvas) coordinates for a comment anchor, or null when it cannot
 *  be placed (orphaned element, or an anchor with no resolvable point). This is
 *  the single source of truth for where a pin sits in page coordinates: the
 *  on-canvas pin (via `anchorScreen`) and the panel's "jump to pin" both use it.
 *  An element anchor resolves to the top-right of the node's world-AABB; a
 *  region anchor uses its stored page point. */
export function anchorPagePoint(
  anchor: CommentAnchor,
  doc: ReturnType<typeof useEditor.getState>["doc"],
): { x: number; y: number } | null {
  if (anchor.kind === "element") {
    if (anchor.orphaned || !anchor.nodeId) return null;
    const b = worldAABB(doc, anchor.nodeId);
    if (!b) return null;
    return { x: b.x + b.width, y: b.y };
  }
  if (anchor.kind === "region" && typeof anchor.x === "number" && typeof anchor.y === "number") {
    return { x: anchor.x, y: anchor.y };
  }
  return null;
}

/** Screen position for a comment anchor, or null when it cannot be placed. */
function anchorScreen(
  api: CanvasApi,
  anchor: CommentAnchor,
  doc: ReturnType<typeof useEditor.getState>["doc"],
): { x: number; y: number } | null {
  const p = anchorPagePoint(anchor, doc);
  return p ? api.toScreen(p) : null;
}

export function CommentPins({ api }: { api: CanvasApi }) {
  const threads = useComments((s) => s.threads);
  const openThreadId = useComments((s) => s.openThreadId);
  const draftAnchor = useComments((s) => s.draftAnchor);
  const panelOpen = useComments((s) => s.panelOpen);
  const meName = useAuth((s) => s.user?.name ?? tr("editor.you"));
  const meId = useAuth((s) => s.user?.id ?? null);
  // Re-render on viewport/document changes so pins track pan/zoom and edits.
  useEditor((s) => s.viewport);
  useEditor((s) => s.rev);
  const doc = useEditor.getState().doc;

  if (!panelOpen && !draftAnchor) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {threads.map((t: CommentThread) => {
        const p = anchorScreen(api, t.anchor, doc);
        if (!p) return null;
        const active = t.id === openThreadId;
        // The pin wears the author's avatar (initials + stable color), matching
        // the panel, so you can tell who left it without opening the thread.
        // Resolved threads mute to gray; the open thread lifts (scale + shadow).
        return (
          <button
            key={t.id}
            onClick={() => useComments.getState().setOpenThread(active ? null : t.id)}
            className={`pointer-events-auto absolute grid h-6 w-6 -translate-y-1/2 translate-x-1 place-items-center rounded-full rounded-bl-none text-[10px] font-semibold uppercase leading-none text-white ring-2 ring-white transition ${active ? "z-10 scale-110 shadow-lg" : "shadow-md hover:scale-105"}`}
            style={{ left: p.x, top: p.y, background: t.resolved ? "#a3a3a3" : avatarColor(t.authorId || t.authorName) }}
            title={`${t.authorName}: ${t.body.slice(0, 60)}`}
          >
            {initials(t.authorName)}
          </button>
        );
      })}
      {draftAnchor &&
        (() => {
          const p = anchorScreen(api, draftAnchor, doc);
          if (!p) return null;
          // The draft pin previews where the new comment lands, in the current
          // user's avatar color with a pulse to read as "in progress".
          return (
            <div
              className="absolute grid h-6 w-6 -translate-y-1/2 translate-x-1 animate-pulse place-items-center rounded-full rounded-bl-none text-[12px] font-semibold leading-none text-white shadow-md ring-2 ring-white"
              style={{ left: p.x, top: p.y, background: avatarColor(meId || meName) }}
            >
              +
            </div>
          );
        })()}
    </div>
  );
}
