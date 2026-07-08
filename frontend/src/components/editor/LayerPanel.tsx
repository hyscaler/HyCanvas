// Layer panel: the active page's nodes in z-order (front at top), two-way synced
// with canvas selection, with per-row lock/hide/rename and drag-to-reorder
// (FR-19). Reorder maps the visual (front-first) order back to child indices.

import { useState } from "react";
import { Eye, EyeOff, Lock, Unlock, GripVertical, Copy, Trash2 } from "lucide-react";
import { useEditor } from "@/store/editor";

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
        Layers
      </div>
      <div className="flex-1 overflow-auto py-1">
        {ordered.length === 0 && (
          <div className="px-3 py-3 text-sm text-neutral-400">
            <div className="font-medium text-neutral-500">No layers</div>
            <div className="mt-0.5 text-xs">Add elements from the tool rail.</div>
          </div>
        )}
        {ordered.map((node) => {
          const selected = selection.includes(node.id);
          const showDropIndicator = dragId !== null && dragOverId === node.id && dragId !== node.id;
          return (
            <div
              key={node.id}
              draggable
              onDragStart={() => setDragId(node.id)}
              onDragOver={(e) => { e.preventDefault(); if (dragOverId !== node.id) setDragOverId(node.id); }}
              onDrop={() => drop(node.id)}
              onDragEnd={() => { setDragId(null); setDragOverId(null); }}
              onPointerDown={(e) => {
                if (e.shiftKey) useEditor.getState().addToSelection([node.id]);
                else useEditor.getState().select([node.id]);
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
                title={node.hidden ? "Show" : "Hide"}
                aria-label={node.hidden ? "Show layer" : "Hide layer"}
                aria-pressed={node.hidden}
                onPointerDown={(e) => { e.stopPropagation(); useEditor.getState().setNodeHidden(node.id, !node.hidden); }}
                className={`shrink-0 hover:text-neutral-700 ${node.hidden ? "text-neutral-700" : "text-neutral-300"}`}
              >
                {node.hidden ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
              <button
                type="button"
                title={node.locked ? "Unlock" : "Lock"}
                aria-label={node.locked ? "Unlock layer" : "Lock layer"}
                aria-pressed={node.locked}
                onPointerDown={(e) => { e.stopPropagation(); useEditor.getState().setNodeLocked(node.id, !node.locked); }}
                className={`shrink-0 hover:text-neutral-700 ${node.locked ? "text-neutral-700" : "text-neutral-300"}`}
              >
                {node.locked ? <Lock size={15} /> : <Unlock size={15} />}
              </button>
              <button
                type="button"
                title="Duplicate"
                aria-label="Duplicate layer"
                onPointerDown={(e) => { e.stopPropagation(); const st = useEditor.getState(); st.select([node.id]); st.duplicateSelection(); }}
                className="shrink-0 text-neutral-400 opacity-0 hover:text-neutral-700 group-hover:opacity-100"
              >
                <Copy size={14} />
              </button>
              <button
                type="button"
                title="Delete"
                aria-label="Delete layer"
                onPointerDown={(e) => { e.stopPropagation(); const st = useEditor.getState(); st.select([node.id]); st.deleteSelection(); }}
                className="shrink-0 text-neutral-400 opacity-0 hover:text-red-600 group-hover:opacity-100"
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
