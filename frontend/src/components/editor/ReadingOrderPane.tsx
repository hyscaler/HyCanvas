// Reading Order pane (doc 28 FR-29): the order assistive technology traverses
// the active page's elements, which is independent of z-order.
//
// The list is the resolved order (`resolveReadingOrder`), so a page with no
// explicit order shows its z-order and every node always appears, even one
// added after the order was authored. Dragging a row writes an explicit order;
// Reset clears it and falls back to z-order.
//
// Decorative nodes stay in the list but are marked, because hiding them would
// make it impossible to un-mark one. Their position is irrelevant to a screen
// reader, which is exactly what the badge communicates.

import { useState } from "react";
import { EyeOff, GripVertical, RotateCcw } from "lucide-react";
import { isDecorative, nodeAltText, resolveReadingOrder } from "@hc/schema";
import { useEditor } from "@/store/editor";
import { tr } from "@/lib/i18n";
import { nodeDisplayName } from "@/lib/nodeName";

export function ReadingOrderPane() {
  useEditor((s) => s.rev);
  const selection = useEditor((s) => s.selection);
  const activePage = useEditor((s) => s.activePage);
  const doc = useEditor.getState().doc;
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const page = doc.pages[Math.min(activePage, doc.pages.length - 1)];
  if (!page) return null;
  const ordered = resolveReadingOrder(page);
  const explicit = !!page.readingOrder?.length;

  const drop = (to: number) => {
    const from = dragIndex;
    setDragIndex(null);
    setOverIndex(null);
    if (from === null || from === to) return;
    useEditor.getState().moveReadingOrder(from, to);
  };

  return (
    <div className="flex h-full flex-col" data-testid="reading-order-pane">
      <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{tr("editor.reading_order")}</span>
        {explicit && (
          <button
            type="button"
            onClick={() => useEditor.getState().resetReadingOrder()}
            title={tr("editor.reset_to_layer_order")}
            data-testid="reset-reading-order"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
          >
            <RotateCcw size={12} /> {tr("editor.reset")}
          </button>
        )}
      </div>
      <p className="border-b border-neutral-100 px-3 py-2 text-[11px] leading-relaxed text-neutral-500">
        {tr("editor.reading_order_hint")}
      </p>
      <div className="flex-1 overflow-auto py-1">
        {ordered.length === 0 && (
          <div className="px-3 py-3 text-sm text-neutral-400">
            <div className="font-medium text-neutral-500">{tr("editor.nothing_to_read")}</div>
            <div className="mt-0.5 text-xs">{tr("editor.add_elements_from_the_tool_rail")}</div>
          </div>
        )}
        {ordered.map((node, i) => {
          const selected = selection.includes(node.id);
          const decorative = isDecorative(node);
          const alt = nodeAltText(node);
          const showDrop = dragIndex !== null && overIndex === i && dragIndex !== i;
          return (
            <div
              key={node.id}
              draggable
              data-testid={`reading-row-${node.id}`}
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => {
                e.preventDefault();
                if (overIndex !== i) setOverIndex(i);
              }}
              onDrop={() => drop(i)}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
              onPointerDown={() => useEditor.getState().select([node.id])}
              className={`group flex items-center gap-1.5 border-t-2 px-2 py-1.5 text-sm ${
                showDrop ? "border-t-brand-500" : "border-t-transparent"
              } ${selected ? "bg-brand-50 text-brand-ink" : "text-neutral-700 hover:bg-neutral-50"}`}
            >
              <GripVertical size={13} className="shrink-0 cursor-grab text-neutral-300 group-hover:text-neutral-400" />
              <span className="w-5 shrink-0 text-end text-[11px] tabular-nums text-neutral-400">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">
                <span className="truncate">{nodeDisplayName(node)}</span>
                {alt && !decorative && (
                  <span className="ms-1.5 truncate text-[11px] text-neutral-400" title={alt}>
                    {alt}
                  </span>
                )}
              </span>
              {decorative && (
                <span
                  title={tr("editor.decorative_skipped_by_screen_readers")}
                  className="flex shrink-0 items-center gap-1 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500"
                >
                  <EyeOff size={10} /> {tr("editor.decorative")}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
