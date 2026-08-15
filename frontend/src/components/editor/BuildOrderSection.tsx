// Page-level animation build order (doc 28 FR-10): every animated element on
// one strip, showing its order, start mode, delay, and duration, draggable to
// reorder. PowerPoint calls this the Animation Pane; Keynote calls it Build
// Order.
//
// The order shown IS the playback order: it comes from the pure `planBuildOrder`
// projection, which walks the same sibling sequence `sequenceStarts` walks. So
// the strip cannot disagree with what present mode plays. Reordering a step
// reorders the page's children, mapped through `childIndexForBuildOrder` because
// a non-animated node may sit between two animated ones.

import { useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import { childIndexForBuildOrder, planBuildOrder, startModeLabel, type BuildStep } from "@hc/engine";
import { useEditor } from "@/store/editor";
import { tr } from "@/lib/i18n";

/** ms -> a compact "1.2s" / "400ms" label. */
function ms(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}s` : `${Math.round(v)}ms`;
}

export function BuildOrderSection() {
  useEditor((s) => s.rev);
  const activePage = useEditor((s) => s.activePage);
  const selection = useEditor((s) => s.selection);
  const doc = useEditor.getState().doc;
  // The dragged step lives in a ref as well as state: `drop` must read it
  // synchronously in the same event turn, and React may not have re-rendered
  // with the state update from `dragstart` yet. State only drives the indicator.
  const dragOrder = useRef<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [overOrder, setOverOrder] = useState<number | null>(null);

  const page = doc.pages[Math.min(activePage, doc.pages.length - 1)];
  if (!page) return null;
  const { steps, totalMs } = planBuildOrder(page);

  const drop = (toOrder: number) => {
    const fromOrder = dragOrder.current;
    dragOrder.current = null;
    setDragging(null);
    setOverOrder(null);
    if (fromOrder === null) return;
    const childIndex = childIndexForBuildOrder(page, fromOrder, toOrder);
    if (childIndex === null) return;
    const moving = steps[fromOrder - 1];
    useEditor.getState().reorderLayer(moving.nodeId, childIndex);
  };

  if (!steps.length) {
    return (
      <div className="px-3 py-2" data-testid="build-order-empty">
        <p className="text-[11px] leading-relaxed text-neutral-500">
          {tr("editor.no_animations_on_this_slide_add_an_entrance")}
        </p>
      </div>
    );
  }

  // The strip's bar scale: the longest timeline gets the full width.
  const scale = totalMs > 0 ? 100 / totalMs : 0;

  return (
    <div className="flex flex-col" data-testid="build-order">
      <div className="flex items-center justify-between px-3 pb-1.5 pt-1 text-[11px] text-neutral-500">
        <span>
          {steps.length} animation{steps.length === 1 ? "" : "s"}
        </span>
        <span className="tabular-nums">{ms(totalMs)} total</span>
      </div>
      <ol className="flex flex-col">
        {steps.map((step) => (
          <BuildRow
            key={step.nodeId}
            step={step}
            scale={scale}
            selected={selection.includes(step.nodeId)}
            showDrop={dragging !== null && overOrder === step.order && dragging !== step.order}
            onDragStart={() => {
              dragOrder.current = step.order;
              setDragging(step.order);
            }}
            onDragOver={() => setOverOrder(step.order)}
            onDrop={() => drop(step.order)}
            onDragEnd={() => {
              dragOrder.current = null;
              setDragging(null);
              setOverOrder(null);
            }}
          />
        ))}
      </ol>
    </div>
  );
}

function BuildRow({
  step,
  scale,
  selected,
  showDrop,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  step: BuildStep;
  scale: number;
  selected: boolean;
  showDrop: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  return (
    <li
      draggable
      data-testid={`build-step-${step.nodeId}`}
      onDragStart={onDragStart}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver();
      }}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      // Selecting swaps the properties panel to node mode, unmounting this strip.
      // So select on an explicit click, never on pointer-down (which begins a drag).
      onClick={() => useEditor.getState().select([step.nodeId])}
      className={`group border-t-2 px-2 py-1.5 ${showDrop ? "border-t-brand-500" : "border-t-transparent"} ${
        selected ? "bg-brand-50" : "hover:bg-neutral-50"
      }`}
    >
      <div className="flex items-center gap-1.5 text-sm">
        <GripVertical size={13} className="shrink-0 cursor-grab text-neutral-300 group-hover:text-neutral-400" />
        <span className="w-4 shrink-0 text-end text-[11px] tabular-nums text-neutral-400">{step.order}</span>
        <span className={`min-w-0 flex-1 truncate ${selected ? "text-brand-ink" : "text-neutral-700"}`}>
          {step.nodeName || step.nodeId}
        </span>
        <span className="shrink-0 text-[11px] capitalize text-neutral-400">{step.preset}</span>
      </div>
      {/* The bar: offset by start, width by duration, on the page timeline. */}
      <div className="ms-[3.1rem] mt-1 h-1.5 rounded-full bg-neutral-100" title={`${ms(step.startMs)} to ${ms(step.endMs)}`}>
        <div
          data-testid={`build-bar-${step.nodeId}`}
          className="h-full rounded-full bg-brand-400"
          style={{ marginLeft: `${step.startMs * scale}%`, width: `${Math.max(2, step.durationMs * scale)}%` }}
        />
      </div>
      <div className="ms-[3.1rem] mt-0.5 flex gap-2 text-[10px] text-neutral-400">
        <span>{startModeLabel(step.startMode)}</span>
        <span className="tabular-nums">starts {ms(step.startMs)}</span>
        <span className="tabular-nums">for {ms(step.durationMs)}</span>
      </div>
    </li>
  );
}
