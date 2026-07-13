// Floating selection toolbar a small action bar that hovers just
// above the selected element(s) on the canvas, giving one-click duplicate,
// delete, lock, and z-order without going to the side panel. Rendered in screen
// space alongside the Gizmo; it owns no transform logic, only quick actions.

import { CopyPlus, Trash2, Lock, LockOpen, BringToFront, SendToBack, Group as GroupIcon, Ungroup } from "lucide-react";
import { unionAABB, locate } from "@hc/editor";
import { useEditor } from "@/store/editor";
import { usePresence } from "@/store/presence";
import type { CanvasApi } from "@/lib/useEditorCanvas";

const PAD = 76; // keep the bar from spilling off the canvas edges

function ToolBtn({ icon: Icon, label, onClick, danger }: { icon: typeof CopyPlus; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`grid h-8 w-8 place-items-center rounded-lg transition ${danger ? "text-neutral-500 hover:bg-red-50 hover:text-red-600" : "text-neutral-600 hover:bg-neutral-100 hover:text-brand-ink"}`}
    >
      <Icon size={16} />
    </button>
  );
}

export function SelectionToolbar({ api }: { api: CanvasApi }) {
  const selection = useEditor((s) => s.selection);
  // Track edits, pan/zoom so the bar follows the selection box.
  useEditor((s) => s.rev);
  useEditor((s) => s.viewport);
  const cropping = useEditor((s) => s.cropping);
  const presenting = useEditor((s) => s.presenting);
  // Re-render when access changes so viewers don't get edit actions.
  usePresence((s) => s.accessMode);

  if (!selection.length || cropping || presenting) return null;
  if (!usePresence.getState().canEdit() || useEditor.getState().readonlyPreview()) return null;

  const doc = useEditor.getState().doc;
  // A single connector has no box at its own transform (it routes between two
  // nodes), so anchor the bar to the routed line's bounds; otherwise use the
  // selection's union box.
  const connBox =
    selection.length === 1 && locate(doc, selection[0])?.node.type === "connector"
      ? api.scene()?.connectorBounds(selection[0])
      : null;
  const box = connBox ?? unionAABB(doc, selection);
  if (!box) return null;

  const tl = api.toScreen({ x: box.x, y: box.y });
  const br = api.toScreen({ x: box.x + box.width, y: box.y + box.height });
  const surface = document.getElementById("oc-canvas-surface")?.getBoundingClientRect();
  const w = surface?.width ?? 1e4;
  const centerX = Math.min(Math.max((tl.x + br.x) / 2, PAD), w - PAD);
  // Prefer above the box (clearing the rotate handle ~26px up); flip below when
  // there isn't room near the top of the canvas.
  const above = tl.y > 88;
  const top = above ? tl.y - 44 : br.y + 44;
  const translate = above ? "translate(-50%, -100%)" : "translate(-50%, 0)";

  const st = useEditor.getState();
  const allLocked = selection.every((id) => locate(doc, id)?.node.locked);
  const canGroup = selection.length >= 2;
  const isSingleGroup = selection.length === 1 && locate(doc, selection[0])?.node.type === "group";

  return (
    <div
      className="pointer-events-auto absolute z-30 flex items-center gap-0.5 rounded-xl border border-neutral-200 bg-surface p-1 shadow-lg ring-1 ring-black/5"
      style={{ left: centerX, top, transform: translate }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {canGroup && <ToolBtn icon={GroupIcon} label="Group" onClick={() => st.group()} />}
      {isSingleGroup && <ToolBtn icon={Ungroup} label="Ungroup" onClick={() => st.ungroupSelection()} />}
      {(canGroup || isSingleGroup) && <span className="mx-0.5 h-5 w-px bg-neutral-200" />}
      <ToolBtn icon={CopyPlus} label="Duplicate" onClick={() => st.duplicateSelection()} />
      <ToolBtn
        icon={allLocked ? Lock : LockOpen}
        label={allLocked ? "Unlock" : "Lock"}
        onClick={() => st.setLockedSel(!allLocked)}
      />
      <span className="mx-0.5 h-5 w-px bg-neutral-200" />
      <ToolBtn icon={BringToFront} label="Bring to front" onClick={() => st.orderSelection("front")} />
      <ToolBtn icon={SendToBack} label="Send to back" onClick={() => st.orderSelection("back")} />
      <span className="mx-0.5 h-5 w-px bg-neutral-200" />
      <ToolBtn icon={Trash2} label="Delete" danger onClick={() => st.deleteSelection()} />
    </div>
  );
}
