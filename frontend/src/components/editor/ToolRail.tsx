// Vertical tool rail (Canva-style) + the active slide-out panel. Switches
// between Elements, Text, Uploads, Stock, and Layers.

import { useState } from "react";
import { Shapes, Type, Upload, ImagePlus, Layers, Sparkles, LayoutGrid, Palette } from "lucide-react";
import { LayerPanel } from "./LayerPanel";
import { ReadingOrderPane } from "./ReadingOrderPane";
import { ElementsPanel, TextPanel, UploadsPanel, StockPanel, AppsPanel, AiPanel, PanelShell } from "./EditorPanels";
import { BrandPanel } from "./BrandPanel";

type Tool = "elements" | "text" | "ai" | "uploads" | "stock" | "apps" | "brand" | "layers";

const TOOLS: { id: Tool; icon: typeof Shapes; label: string }[] = [
  { id: "elements", icon: Shapes, label: "Elements" },
  { id: "text", icon: Type, label: "Text" },
  { id: "ai", icon: Sparkles, label: "AI" },
  { id: "uploads", icon: Upload, label: "Uploads" },
  { id: "stock", icon: ImagePlus, label: "Stock" },
  { id: "apps", icon: LayoutGrid, label: "Apps" },
  { id: "brand", icon: Palette, label: "Brand" },
  { id: "layers", icon: Layers, label: "Layers" },
];

export function ToolRail({ workspaceId, overlay = false, defaultCollapsed = false }: { workspaceId: string | null; overlay?: boolean; defaultCollapsed?: boolean }) {
  // null = panel collapsed (just the icon rail shows). Clicking the active tab
  // toggles it closed. Boards open with the panel collapsed for a canvas-first
  // start; the icon rail stays so any tool is one click away.
  const [active, setActive] = useState<Tool | null>(defaultCollapsed ? null : "elements");

  // On narrow screens the slide-out panel floats over the canvas (absolute,
  // positioned just right of the rail) instead of consuming layout width, so the
  // canvas keeps usable space. At lg+ it sits inline and pushes the canvas. The
  // per-tool panels are unchanged; the overlay treatment (position + shadow) is
  // applied here by wrapping whatever the active panel renders, and PanelShell
  // already narrows its own width responsively below lg.
  const panel = (() => {
    switch (active) {
      case "elements": return <ElementsPanel />;
      case "text": return <TextPanel />;
      case "ai": return <AiPanel workspaceId={workspaceId} />;
      case "uploads": return <UploadsPanel workspaceId={workspaceId} />;
      case "stock": return <StockPanel workspaceId={workspaceId} />;
      case "apps": return <AppsPanel />;
      case "brand": return <BrandPanel workspaceId={workspaceId} />;
      case "layers": return <PanelShell title="Layers"><LayersTabs /></PanelShell>;
      default: return null;
    }
  })();

  return (
    <div className="relative flex h-full shrink-0">
      <div
        role="toolbar"
        aria-label="Editor tools"
        aria-orientation="vertical"
        className="flex w-[68px] shrink-0 flex-col items-center gap-1 border-r border-neutral-200 bg-surface py-3"
      >
        {TOOLS.map((t) => {
          const isActive = active === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActive((cur) => (cur === t.id ? null : t.id))}
              title={isActive ? `Hide ${t.label}` : t.label}
              aria-label={isActive ? `Hide ${t.label}` : `Open ${t.label}`}
              aria-pressed={isActive}
              className={`flex w-14 flex-col items-center gap-1 rounded-xl py-2 text-[11px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${
                isActive ? "bg-brand-50 text-brand-ink" : "text-neutral-500 hover:bg-neutral-100"
              }`}
            >
              <t.icon size={20} />
              {t.label}
            </button>
          );
        })}
      </div>
      {/* Overlay mode: float the panel over the canvas just right of the rail.
          Inline mode (lg+): the panel is a normal flex sibling that pushes the
          canvas. */}
      {overlay && panel ? (
        <div className="absolute left-full top-0 z-30 h-full shadow-xl">{panel}</div>
      ) : (
        panel
      )}
    </div>
  );
}

export type { Tool };

/** Layers panel with two views of the same nodes: paint order (z-order) and the
 *  reading order assistive technology follows (doc 28 FR-29). They are
 *  deliberately separate, because changing what is drawn on top must not change
 *  what a screen reader announces first. */
function LayersTabs() {
  const [tab, setTab] = useState<"layers" | "reading">("layers");
  const tabCls = (on: boolean) =>
    `flex-1 border-b-2 px-2 py-1.5 text-xs font-medium transition ${
      on ? "border-brand-500 text-brand-ink" : "border-transparent text-neutral-500 hover:text-neutral-700"
    }`;
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 border-b border-neutral-200">
        <button type="button" onClick={() => setTab("layers")} className={tabCls(tab === "layers")} data-testid="tab-layers">
          Layers
        </button>
        <button type="button" onClick={() => setTab("reading")} className={tabCls(tab === "reading")} data-testid="tab-reading-order">
          Reading order
        </button>
      </div>
      <div className="min-h-0 flex-1">{tab === "layers" ? <LayerPanel /> : <ReadingOrderPane />}</div>
    </div>
  );
}
