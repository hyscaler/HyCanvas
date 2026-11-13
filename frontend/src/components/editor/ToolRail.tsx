// Tool rail + the active slide-out panel (a bottom tab bar and bottom sheet
// on a phone in portrait). Switches
// between Elements, Text, Uploads, Stock, and Layers.

import { useCallback, useEffect, useState } from "react";
import { Shapes, Type, Upload, ImagePlus, Layers, Sparkles, LayoutGrid, LayoutTemplate, Palette, X } from "lucide-react";
import { LayerPanel } from "./LayerPanel";
import { ReadingOrderPane } from "./ReadingOrderPane";
import { ElementsPanel, TextPanel, UploadsPanel, StockPanel, AppsPanel, AiPanel, TemplatesPanel, PanelShell } from "./EditorPanels";
import { BrandPanel } from "./BrandPanel";
import { useEditorFileDropTarget } from "./EditorFileDrop";
import { subscribeAiBusy } from "@/lib/aiRequests";
import { useEditor } from "@/store/editor";
import { tr } from "@/lib/i18n";

type Tool = "templates" | "elements" | "text" | "ai" | "uploads" | "stock" | "apps" | "brand" | "layers";

const tools = (): { id: Tool; icon: typeof Shapes; label: string }[] => [
  { id: "templates", icon: LayoutTemplate, label: tr("editor.templates") },
  { id: "elements", icon: Shapes, label: tr("editor.elements") },
  { id: "text", icon: Type, label: tr("editor.text") },
  { id: "ai", icon: Sparkles, label: "AI" },
  { id: "uploads", icon: Upload, label: tr("editor.uploads") },
  { id: "stock", icon: ImagePlus, label: tr("editor.stock") },
  { id: "apps", icon: LayoutGrid, label: tr("editor.apps") },
  { id: "brand", icon: Palette, label: tr("editor.brand") },
  { id: "layers", icon: Layers, label: tr("editor.layers") },
];

// Tools whose panels exist to insert something: on a phone the sheet closes
// once the insert lands, so the new element is visible instead of hidden
// under the sheet that created it.
const INSERT_TOOLS: ReadonlySet<Tool> = new Set(["templates", "elements", "text", "uploads", "stock", "apps"]);

export function ToolRail({
  workspaceId,
  designId = null,
  overlay = false,
  defaultCollapsed = false,
  kind = "design",
  openTool,
  phone = null,
  onPanelOpen,
  closeSignal = 0,
  leading,
}: {
  workspaceId: string | null;
  designId?: string | null;
  overlay?: boolean;
  defaultCollapsed?: boolean;
  kind?: "design" | "whiteboard";
  openTool?: Tool;
  /** Phone layout: a bottom tab bar with bottom sheets in portrait, a slim
   *  icon rail with side sheets in landscape. null keeps the desktop rail. */
  phone?: "portrait" | "landscape" | null;
  /** Called when a panel opens, so the shell can close other overlays. */
  onPanelOpen?: () => void;
  /** Bumped by the shell to close the open panel (another overlay opened). */
  closeSignal?: number;
  /** An extra tab rendered first on a phone (the shell's Edit tab, which opens
   *  the properties sheet). */
  leading?: { icon: typeof Shapes; label: string; active: boolean; onClick: () => void };
}) {
  // null = panel collapsed (just the icon rail shows). Clicking the active tab
  // toggles it closed. Boards open with the panel collapsed for a canvas-first
  // start; the icon rail stays so any tool is one click away. openTool lets the
  // route decide (arriving from the dashboard with a brief opens AI). A phone
  // always starts canvas-first: an open panel there covers the whole canvas.
  const [active, setActive] = useState<Tool | null>(openTool ?? (defaultCollapsed || phone ? null : "elements"));
  // Tell the shell a panel opened so it can close its own overlays.
  useEffect(() => {
    if (active) onPanelOpen?.();
  }, [active, onPanelOpen]);
  // The shell asks the rail to close when it opens another overlay (the
  // properties sheet), so only one sheet covers the canvas at a time.
  const [seenSignal, setSeenSignal] = useState(closeSignal);
  if (seenSignal !== closeSignal) {
    setSeenSignal(closeSignal);
    setActive(null);
  }
  // On a phone an insert panel closes as soon as its insert lands, which the
  // store reports as a new selection.
  useEffect(() => {
    if (!phone || !active || !INSERT_TOOLS.has(active)) return;
    let prev = useEditor.getState().selection;
    return useEditor.subscribe((s) => {
      if (s.selection !== prev) {
        const grew = s.selection.length > 0 && s.selection.some((id) => !prev.includes(id));
        prev = s.selection;
        if (grew) setActive(null);
      }
    });
  }, [phone, active]);
  // The AI panel stays mounted once opened (its conversation must survive a
  // tool switch), but mounting it before that would make every editor load pay
  // for its provider-config and session-history fetches even when the user
  // never opens it. So: nothing until first open, then permanent.
  const [aiUsed, setAiUsed] = useState(false);
  if (active === "ai" && !aiUsed) setAiUsed(true);
  // A generation runs for a minute or more and the panel is often hidden
  // behind another tool, where nothing indicated work was happening at all.
  const [aiBusy, setAiBusyState] = useState(false);
  useEffect(() => subscribeAiBusy(setAiBusyState), []);

  // Files dropped anywhere in the editor land here rather than only on the
  // Uploads panel's own drop zone. The rail claims them because it is mounted
  // for the whole session, while UploadsPanel exists only while its tool is
  // open, so registering there would make an editor-wide drop work only when
  // the panel already happened to be showing.
  //
  // Opening the panel is part of the behavior, not a side effect: it is the
  // only place the upload's progress, per-file errors, and quota messages are
  // reported, and a file that vanished silently into the library would leave
  // the user with nothing to look at.
  const [droppedFiles, setDroppedFiles] = useState<File[] | null>(null);
  useEditorFileDropTarget(
    useCallback((files: File[]) => {
      setActive("uploads");
      setDroppedFiles(files);
    }, []),
  );

  // On narrow screens the slide-out panel floats over the canvas (absolute,
  // positioned just right of the rail) instead of consuming layout width, so the
  // canvas keeps usable space. At lg+ it sits inline and pushes the canvas. The
  // per-tool panels are unchanged; the overlay treatment (position + shadow) is
  // applied here by wrapping whatever the active panel renders, and PanelShell
  // already narrows its own width responsively below lg.
  const panel = (() => {
    switch (active) {
      case "templates": return <TemplatesPanel />;
      case "elements": return <ElementsPanel />;
      case "text": return <TextPanel />;
      case "uploads": return <UploadsPanel workspaceId={workspaceId} droppedFiles={droppedFiles} onDroppedFilesConsumed={() => setDroppedFiles(null)} />;
      case "stock": return <StockPanel workspaceId={workspaceId} />;
      case "apps": return <AppsPanel />;
      case "brand": return <BrandPanel workspaceId={workspaceId} />;
      case "layers": return <PanelShell title={tr("editor.layers")}><LayersTabs /></PanelShell>;
      default: return null;
    }
  })();

  const visibleTools = tools().filter((t) => kind === "design" || t.id !== "templates");
  const toolLabel = (t: { id: Tool; label: string }) =>
    t.id === "ai" && aiBusy ? tr("editor.ai_working") : active === t.id ? `Hide ${t.label}` : `Open ${t.label}`;
  const busyDot = (
    <span className="absolute -end-1.5 -top-0.5 flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-600" />
    </span>
  );

  const sheetFrame =
    "absolute inset-x-0 bottom-full z-30 flex h-[min(58dvh,30rem)] flex-col rounded-t-2xl border-t border-neutral-200 bg-surface shadow-2xl";
  // The AI panel is a CONVERSATION with in-flight work (a planner call, a
  // pending confirm, a running generation): it stays MOUNTED at one stable
  // tree position (the aside's first child, in every layout) and is hidden,
  // never unmounted, while another tool is active, the viewport crosses the
  // overlay breakpoint, or a phone rotates. Unmounting would silently drop the
  // busy state, the confirm gate, and the response of a message already sent.
  const aiPanel = (shownClass: string, extra?: React.ReactNode) =>
    aiUsed ? (
      <div className={active === "ai" ? shownClass : "hidden"}>
        <AiPanel workspaceId={workspaceId} designId={designId} />
        {extra}
      </div>
    ) : null;

  if (phone === "portrait") {
    // Phone portrait: the tools are a bottom tab bar and the active panel is a
    // bottom sheet over the lower part of the canvas, so the page stays in
    // view above it and every tool is reachable with a thumb.
    const activeTool = visibleTools.find((t) => t.id === active);
    const sheet = (body: React.ReactNode) => (
      <div
        role="dialog"
        aria-label={activeTool?.label}
        className={sheetFrame}
      >
        <div className="flex shrink-0 items-center justify-between ps-4 pe-1 pt-1">
          <span aria-hidden className="h-1 w-10 rounded-full bg-neutral-300" />
          <button
            type="button"
            onClick={() => setActive(null)}
            aria-label={tr("editor.close")}
            className="grid h-11 w-11 place-items-center rounded-lg text-neutral-500 hover:bg-neutral-100"
          >
            <X size={18} />
          </button>
        </div>
        <div className="oc-sheet min-h-0 flex-1">{body}</div>
      </div>
    );
    return (
      <aside aria-label={tr("editor.editor_tools")} className="relative order-last w-full shrink-0">
        {aiPanel(
          `${sheetFrame} oc-sheet pt-11`,
          <button
            type="button"
            onClick={() => setActive(null)}
            aria-label={tr("editor.close")}
            className="absolute end-1 top-1 grid h-11 w-11 place-items-center rounded-lg text-neutral-500 hover:bg-neutral-100"
          >
            <X size={18} />
          </button>,
        )}
        {panel && sheet(panel)}
        <div
          role="toolbar"
          aria-label={tr("editor.editor_tools")}
          aria-orientation="horizontal"
          // A fixed height (--oc-tabbar-h) so the shell can stack its own
          // sheet exactly on top of the bar.
          className="oc-scroll-none flex h-[var(--oc-tabbar-h)] items-stretch gap-0.5 overflow-x-auto border-t border-neutral-200 bg-surface px-1 pb-[env(safe-area-inset-bottom)]"
        >
          {leading && (
            <button
              type="button"
              onClick={leading.onClick}
              aria-pressed={leading.active}
              className={`my-1 flex min-w-[3.75rem] shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-[10px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                leading.active ? "bg-brand-50 text-brand-ink" : "text-neutral-500"
              }`}
            >
              <leading.icon size={20} />
              {leading.label}
            </button>
          )}
          {visibleTools.map((t) => {
            const isActive = active === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActive((cur) => (cur === t.id ? null : t.id))}
                aria-label={toolLabel(t)}
                aria-pressed={isActive}
                className={`my-1 flex min-w-[3.75rem] shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-[10px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                  isActive ? "bg-brand-50 text-brand-ink" : "text-neutral-500"
                }`}
              >
                <span className="relative">
                  <t.icon size={20} />
                  {t.id === "ai" && aiBusy && busyDot}
                </span>
                {t.label}
              </button>
            );
          })}
        </div>
      </aside>
    );
  }

  const slim = phone === "landscape";
  return (
    // A landmark, so the rail and its slide-out panel are reachable as a
    // region rather than announced as loose content outside any landmark.
    <aside aria-label={tr("editor.editor_tools")} className="relative flex h-full shrink-0">
      {aiPanel(overlay ? "absolute start-full top-0 z-30 h-full shadow-xl" : "contents")}
      <div
        role="toolbar"
        aria-label={tr("editor.editor_tools")}
        aria-orientation="vertical"
        // order-first: the AI panel is the aside's first child (see aiPanel)
        // but the rail must still lead the row.
        className={`order-first flex shrink-0 flex-col items-center gap-1 border-e max-lg:overflow-y-auto border-neutral-200 bg-surface ${slim ? "oc-scroll-none w-[52px] py-1" : "w-[68px] py-3"}`}
      >
        {slim && leading && (
          <button
            type="button"
            onClick={leading.onClick}
            title={leading.label}
            aria-label={leading.label}
            aria-pressed={leading.active}
            className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${leading.active ? "bg-brand-50 text-brand-ink" : "text-neutral-500 hover:bg-neutral-100"}`}
          >
            <leading.icon size={20} />
          </button>
        )}
        {visibleTools.map((t) => {
          const isActive = active === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActive((cur) => (cur === t.id ? null : t.id))}
              title={isActive ? `Hide ${t.label}` : t.label}
              aria-label={toolLabel(t)}
              aria-pressed={isActive}
              // A phone in landscape has the height of a toolbar to spare, not
              // a column: icon-only 44px targets so every tool fits or scrolls.
              className={`flex shrink-0 flex-col items-center rounded-xl text-[11px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${
                slim ? "h-11 w-11 justify-center" : "w-14 gap-1 py-2"
              } ${isActive ? "bg-brand-50 text-brand-ink" : "text-neutral-500 hover:bg-neutral-100"}`}
            >
              <span className="relative">
                <t.icon size={20} />
                {t.id === "ai" && aiBusy && busyDot}
              </span>
              {!slim && t.label}
            </button>
          );
        })}
      </div>
      {/* Overlay mode: float the panel over the canvas just right of the rail.
          Inline mode (lg+): the panel is a normal flex sibling that pushes the
          canvas. */}
      {overlay && panel ? (
        <div className="absolute start-full top-0 z-30 h-full shadow-xl">{panel}</div>
      ) : (
        panel
      )}
    </aside>
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
          {tr("editor.layers")}
        </button>
        <button type="button" onClick={() => setTab("reading")} className={tabCls(tab === "reading")} data-testid="tab-reading-order">
          {tr("editor.reading_order")}
        </button>
      </div>
      <div className="min-h-0 flex-1">{tab === "layers" ? <LayerPanel /> : <ReadingOrderPane />}</div>
    </div>
  );
}
