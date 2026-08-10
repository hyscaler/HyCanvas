// Layer panel: the active page's nodes in z-order (front at top), two-way synced
// with canvas selection, with per-row lock/hide/rename and drag-to-reorder
// (FR-19). Reorder maps the visual (front-first) order back to child indices.

import { useState } from "react";
import { Eye, EyeOff, Lock, Unlock, GripVertical, Copy, Trash2 } from "lucide-react";
import { useEditor } from "@/store/editor";
import { tr } from "@/lib/i18n";

export function LayerPanel() {
  useEditor((s) => s.rev);
  const selection = useEditor((s) => s.selection);
  const activePage = useEditor((s) => s.activePage);
  const doc = useEditor.getState().doc;
  const [editing, setEditing] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const page = doc.pages[Math.min(activePage, doc.pages.length - 1)];
  const children = page?.children ?? [];
  const ordered = [...children].reverse(); // front at top

  const drop = (targetId: string) => {
    const id = dragId;
    setDragId(null);
    setDragOverId(null);
    if (!id || id === targetId) return;
    const to = children.findIndex((n) => n.id === targetId);
    if (to >= 0) useEditor.getState().reorderLayer(id, to);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {tr("editor.layers")}
      </div>
      <div role="listbox" aria-label={tr("editor.layers")} className="flex-1 overflow-auto py-1">
        {ordered.length === 0 && (
          <div className="px-3 py-3 text-sm text-neutral-400">
            <div className="font-medium text-neutral-500">{tr("editor.no_layers")}</div>
            <div className="mt-0.5 text-xs">{tr("editor.add_elements_from_the_tool_rail")}</div>
          </div>
        )}
        {ordered.map((node, rowIndex) => {
          const selected = selection.includes(node.id);
          // Roving tabindex (APG listbox): exactly ONE row is a tab stop, so a
          // 50-layer design does not put 50 stops between the panel and the
          // next control. Arrow keys move within the list.
          const isTabStop = selection.length ? selected : rowIndex === 0;
          const showDropIndicator = dragId !== null && dragOverId === node.id && dragId !== node.id;
          return (
            <div
              key={node.id}
              role="option"
              tabIndex={isTabStop ? 0 : -1}
              aria-selected={selected}
              draggable
              onDragStart={() => setDragId(node.id)}
              onDragOver={(e) => { e.preventDefault(); if (dragOverId !== node.id) setDragOverId(node.id); }}
              onDrop={() => drop(node.id)}
              onDragEnd={() => { setDragId(null); setDragOverId(null); }}
              onPointerDown={(e) => {
                if (e.shiftKey) useEditor.getState().addToSelection([node.id]);
                else useEditor.getState().select([node.id]);
              }}
              onKeyDown={(e) => {
                // Keys from the action buttons or the rename input bubble here;
                // only act when the row itself is focused.
                if (e.target !== e.currentTarget) return;
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const to = ordered[rowIndex + (e.key === "ArrowDown" ? 1 : -1)];
                  if (!to) return;
                  useEditor.getState().select([to.id]);
                  // Move focus with the selection so the roving stop follows.
                  const el = e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="option"]')[rowIndex + (e.key === "ArrowDown" ? 1 : -1)];
                  el?.focus();
                } else if (e.key === "F2" || (e.key === "Enter" && selected)) {
                  e.preventDefault();
                  setEditing(node.id);
                } else if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (e.shiftKey) useEditor.getState().addToSelection([node.id]);
                  else useEditor.getState().select([node.id]);
                }
              }}
              className={`group flex items-center gap-1.5 border-t-2 px-2 py-1.5 text-sm ${
                showDropIndicator ? "border-t-brand-500" : "border-t-transparent"
              } ${
                selected ? "bg-brand-50 text-brand-ink" : "text-neutral-700 hover:bg-neutral-50"
              } ${dragId === node.id ? "opacity-50" : ""}`}
            >
              <GripVertical size={14} className="shrink-0 cursor-grab text-neutral-300 group-hover:text-neutral-400" />
              <span className="w-9 shrink-0 text-[10px] uppercase text-neutral-400">{node.type}</span>
              {editing === node.id ? (
                <input
                  autoFocus
                  aria-label={tr("editor.rename_layer")}
                  defaultValue={node.name ?? ""}
                  onBlur={(e) => { useEditor.getState().renameNode(node.id, e.target.value); setEditing(null); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setEditing(null);
                  }}
                  className="min-w-0 flex-1 rounded border border-neutral-300 px-1 py-0.5 text-sm"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate" onDoubleClick={() => setEditing(node.id)}>
                  {node.name ?? node.type}
                </span>
              )}
              <button
                type="button"
                title={node.hidden ? tr("editor.show") : tr("editor.hide")}
                aria-label={node.hidden ? tr("editor.show_layer") : tr("editor.hide_layer")}
                aria-pressed={node.hidden}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => useEditor.getState().setNodeHidden(node.id, !node.hidden)}
                className={`shrink-0 hover:text-neutral-700 ${node.hidden ? "text-neutral-700" : "text-neutral-300"}`}
              >
                {node.hidden ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
              <button
                type="button"
                title={node.locked ? tr("editor.unlock") : tr("editor.lock")}
                aria-label={node.locked ? tr("editor.unlock_layer") : tr("editor.lock_layer")}
                aria-pressed={node.locked}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => useEditor.getState().setNodeLocked(node.id, !node.locked)}
                className={`shrink-0 hover:text-neutral-700 ${node.locked ? "text-neutral-700" : "text-neutral-300"}`}
              >
                {node.locked ? <Lock size={15} /> : <Unlock size={15} />}
              </button>
              <button
                type="button"
                title={tr("editor.duplicate")}
                aria-label={tr("editor.duplicate_layer")}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => { const st = useEditor.getState(); st.select([node.id]); st.duplicateSelection(); }}
                className="shrink-0 text-neutral-400 opacity-0 hover:text-neutral-700 focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Copy size={14} />
              </button>
              <button
                type="button"
                title={tr("editor.delete")}
                aria-label={tr("editor.delete_layer")}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => { const st = useEditor.getState(); st.select([node.id]); st.deleteSelection(); }}
                className="shrink-0 text-neutral-400 opacity-0 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
