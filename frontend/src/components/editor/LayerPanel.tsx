// Layer panel: the active page's nodes in z-order (front at top), two-way synced
// with canvas selection, with per-row lock/hide/rename, a step forward and a
// step back on every row, and drag-to-reorder (FR-19). A group opens to list
// its children indented under it; every action on a child works among the
// group's children, the way it works among the page's layers. A drop lands the
// dragged layer directly in front of the row it is dropped on (within the same
// container); the zone under the last row sends a top-level layer to the back.
// Alt+Up and Alt+Down move the focused row a step, the way the arrow keys
// alone move the selection.

import { useState } from "react";
import { Eye, EyeOff, Lock, Unlock, GripVertical, Copy, Trash2, ArrowUp, ArrowDown, ChevronRight, ChevronDown } from "lucide-react";
import type { Node } from "@hc/schema";
import { useEditor } from "@/store/editor";
import { layerDropIndex } from "@/lib/layerOrder";
import { tr } from "@/lib/i18n";

/** The end-of-list drop target's id in the drag state. */
const BACK = "\u0000back";

/** A row of the panel: a node, its depth, and the siblings it is stacked among. */
interface Row {
  node: Node;
  depth: number;
  siblings: Node[];
  /** Whether the node contains children the panel can list. */
  container: boolean;
}

function childrenOf(node: Node): Node[] | null {
  const kids = (node as unknown as { children?: unknown }).children;
  return Array.isArray(kids) ? (kids as Node[]) : null;
}

/** Front-first rows, groups expanded where asked. */
function buildRows(siblings: Node[], depth: number, expanded: Set<string>, out: Row[] = []): Row[] {
  for (const node of [...siblings].reverse()) {
    const kids = childrenOf(node);
    out.push({ node, depth, siblings, container: !!kids });
    if (kids && expanded.has(node.id)) buildRows(kids, depth + 1, expanded, out);
  }
  return out;
}

export function LayerPanel() {
  useEditor((s) => s.rev);
  const selection = useEditor((s) => s.selection);
  const activePage = useEditor((s) => s.activePage);
  const doc = useEditor.getState().doc;
  const [editing, setEditing] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const page = doc.pages[Math.min(activePage, doc.pages.length - 1)];
  const children = page?.children ?? [];
  const ordered = buildRows(children, 0, expanded);
  const rowOf = (id: string) => ordered.find((r) => r.node.id === id);

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Drop the dragged layer in front of `targetId` when both are stacked among
   *  the same siblings, or at the back of the page for null. */
  const drop = (targetId: string | null) => {
    const id = dragId;
    setDragId(null);
    setDragOverId(null);
    if (!id) return;
    const from = rowOf(id);
    if (!from) return;
    if (targetId === null) {
      if (from.siblings !== children) return; // the back zone is the page's
      const to = layerDropIndex(children.map((n) => n.id), id, null);
      if (to !== null) useEditor.getState().reorderLayer(id, to);
      return;
    }
    const target = rowOf(targetId);
    if (!target || target.siblings !== from.siblings) return; // across containers: not a restack
    const to = layerDropIndex(from.siblings.map((n) => n.id), id, targetId);
    if (to !== null) useEditor.getState().reorderLayer(id, to);
  };

  /** One step toward the front (+1) or the back (-1), among the node's siblings. */
  const step = (id: string, dir: 1 | -1) => {
    const r = rowOf(id);
    if (!r) return;
    const from = r.siblings.findIndex((n) => n.id === id);
    if (from < 0) return;
    useEditor.getState().reorderLayer(id, from + dir);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {tr("editor.layers")}
      </div>
      <div role="tree" aria-label={tr("editor.layers")} aria-multiselectable className="flex-1 overflow-auto py-1">
        {ordered.length === 0 && (
          <div className="px-3 py-3 text-sm text-neutral-400">
            <div className="font-medium text-neutral-500">{tr("editor.no_layers")}</div>
            <div className="mt-0.5 text-xs">{tr("editor.add_elements_from_the_tool_rail")}</div>
          </div>
        )}
        {ordered.map(({ node, depth, siblings, container }, rowIndex) => {
          const selected = selection.includes(node.id);
          const sibIndex = siblings.findIndex((n) => n.id === node.id);
          const atFront = sibIndex === siblings.length - 1;
          const atBack = sibIndex === 0;
          const sameContainer = dragId !== null && rowOf(dragId)?.siblings === siblings;
          const isOpen = expanded.has(node.id);
          // Roving tabindex (APG tree): exactly ONE row is a tab stop, so a
          // 50-layer design does not put 50 stops between the panel and the
          // next control. Arrow keys move within the list.
          const isTabStop = selection.length ? selected : rowIndex === 0;
          const showDropIndicator = sameContainer && dragOverId === node.id && dragId !== node.id;
          return (
            <div
              key={node.id}
              role="treeitem"
              tabIndex={isTabStop ? 0 : -1}
              aria-selected={selected}
              aria-level={depth + 1}
              aria-expanded={container ? isOpen : undefined}
              style={{ paddingInlineStart: 8 + depth * 14 }}
              draggable
              onDragStart={() => setDragId(node.id)}
              onDragOver={(e) => { e.preventDefault(); if (dragOverId !== node.id) setDragOverId(node.id); }}
              onDrop={(e) => { e.preventDefault(); drop(node.id); }}
              onDragEnd={() => { setDragId(null); setDragOverId(null); }}
              onPointerDown={(e) => {
                if (e.shiftKey) useEditor.getState().addToSelection([node.id]);
                else useEditor.getState().select([node.id]);
              }}
              onKeyDown={(e) => {
                // Keys from the action buttons or the rename input bubble here;
                // only act when the row itself is focused.
                if (e.target !== e.currentTarget) return;
                if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                  // Move the layer itself; the focused row keeps the layer.
                  e.preventDefault();
                  step(node.id, e.key === "ArrowUp" ? 1 : -1);
                } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const to = ordered[rowIndex + (e.key === "ArrowDown" ? 1 : -1)];
                  if (!to) return;
                  useEditor.getState().select([to.node.id]);
                  // Move focus with the selection so the roving stop follows.
                  const el = e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="treeitem"]')[rowIndex + (e.key === "ArrowDown" ? 1 : -1)];
                  el?.focus();
                } else if (container && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
                  // Open or close a group from the keyboard, the tree convention.
                  e.preventDefault();
                  if ((e.key === "ArrowRight") !== isOpen) toggleExpanded(node.id);
                } else if (e.key === "F2" || (e.key === "Enter" && selected)) {
                  e.preventDefault();
                  setEditing(node.id);
                } else if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (e.shiftKey) useEditor.getState().addToSelection([node.id]);
                  else useEditor.getState().select([node.id]);
                }
              }}
              className={`group flex items-center gap-1.5 border-t-2 py-1.5 pe-2 text-sm ${
                showDropIndicator ? "border-t-brand-500" : "border-t-transparent"
              } ${
                selected ? "bg-brand-50 text-brand-ink" : "text-neutral-700 hover:bg-neutral-50"
              } ${dragId === node.id ? "opacity-50" : ""}`}
            >
              <GripVertical size={14} className="shrink-0 cursor-grab text-neutral-300 group-hover:text-neutral-400" />
              {/* A group opens to its children; other rows keep the column. */}
              {container ? (
                <button
                  type="button"
                  aria-label={isOpen ? tr("editor.collapse") : tr("editor.expand")}
                  title={isOpen ? tr("editor.collapse") : tr("editor.expand")}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => toggleExpanded(node.id)}
                  className="shrink-0 text-neutral-400 hover:text-neutral-700"
                >
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              ) : (
                <span className="w-3.5 shrink-0" />
              )}
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
              {/* One step forward or back, on the row: the reason most people
                  open this panel, and dragging a row one slot is fiddly. */}
              <button
                type="button"
                title={tr("editor.bring_forward")}
                aria-label={tr("editor.bring_forward")}
                disabled={atFront}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => step(node.id, 1)}
                className="shrink-0 text-neutral-400 opacity-0 hover:text-neutral-700 focus-visible:opacity-100 disabled:opacity-0 group-hover:opacity-100 group-hover:disabled:opacity-20"
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                title={tr("editor.send_backward")}
                aria-label={tr("editor.send_backward")}
                disabled={atBack}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => step(node.id, -1)}
                className="shrink-0 text-neutral-400 opacity-0 hover:text-neutral-700 focus-visible:opacity-100 disabled:opacity-0 group-hover:opacity-100 group-hover:disabled:opacity-20"
              >
                <ArrowDown size={14} />
              </button>
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
        {/* Past the last row: the only way to drop a layer BEHIND everything,
            since a drop on a row lands in front of it. Shown while dragging a
            top-level layer; a group's children restack with their own rows. */}
        {dragId !== null && children.length > 1 && rowOf(dragId)?.siblings === children && (
          <div
            data-testid="layer-drop-back"
            onDragOver={(e) => { e.preventDefault(); if (dragOverId !== BACK) setDragOverId(BACK); }}
            onDrop={(e) => { e.preventDefault(); drop(null); }}
            className={`mx-2 mt-1 rounded-lg border-2 border-dashed px-2 py-2 text-center text-xs ${
              dragOverId === BACK ? "border-brand-500 bg-brand-50 text-brand-ink" : "border-neutral-200 text-neutral-400"
            }`}
          >
            {tr("editor.drop_here_to_send_to_back")}
          </div>
        )}
      </div>
    </div>
  );
}
