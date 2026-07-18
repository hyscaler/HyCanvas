// The editor shell: a polished top bar (home, inline rename, undo/redo, export,
// save) over a layout (vertical tool rail + slide-out panel,
// canvas with a zoom control, and a contextual properties panel). Client-only.

import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { useRouter } from "next/router";
import { ChevronLeft, Undo2, Redo2, Download, Play, MonitorPlay, Ruler, Grid3x3, Magnet, LayoutTemplate, History, Eye, Share2, MessageSquare, ShieldCheck, Activity, BarChart3, MoreHorizontal, Send, Globe, Printer, PanelRightClose, PanelRightOpen, Keyboard, Info, X, Accessibility, Maximize2, Minimize2, LayoutGrid } from "lucide-react";
import type { AccessMode } from "@hc/sdk";
import { ApiError } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { useEditor } from "@/store/editor";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Spinner } from "@/components/ui/Spinner";
import { LogoMark } from "@/components/ui/Logo";
import { Canvas } from "./Canvas";
import { ZoomControl } from "./ZoomControl";
import { CommandMenu } from "./CommandMenu";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { ExportDialog } from "./ExportDialog";
import { SlideOverview } from "./SlideOverview";
import { ShareDialog } from "./ShareDialog";
import { RequestAccessScreen } from "./RequestAccessScreen";
import { NotFoundScreen } from "@/components/ui/NotFound";
import { SaveAsTemplateDialog } from "./SaveAsTemplateDialog";
import { PublishDialog } from "./PublishDialog";
import { WebsiteDialog } from "./WebsiteDialog";
import { PrintDialog } from "./PrintDialog";
import { AccessibilityDialog } from "./AccessibilityDialog";
import { PropertiesPanel } from "./PropertiesPanel";
import { ToolRail } from "./ToolRail";
import { PagesBar } from "./PagesBar";
import { DocumentSurface } from "./DocumentSurface";
import { PresentMode } from "./PresentMode";
import { PresenceBar } from "./PresenceBar";
import { HistoryPanel } from "./HistoryPanel";
import { CommentsPanel } from "./CommentsPanel";
import { ActivityPanel } from "./ActivityPanel";
import { InsightsPanel } from "./InsightsPanel";
import { ApprovalBanner } from "./ApprovalBanner";
import { NotificationsBell } from "@/components/notifications/NotificationsBell";
import { PromptHost } from "@/components/ui/PromptHost";
import { useRealtime, getDesignDoc, resyncFromLiveDoc } from "@/lib/useRealtime";
import { useAutoSnapshot } from "@/lib/useAutoSnapshot";
import { onCommentChanged, onRoleChanged } from "@/lib/realtime";
import { useViewBeat } from "@/lib/useViewBeat";
import { useComments } from "@/store/comments";
import { useBrand } from "@/store/brand";
import { usePresence } from "@/store/presence";
import { useBoardFocus, enterBoardFocus, exitBoardFocus } from "@/store/boardFocus";

type Status = "loading" | "ready" | "error" | "forbidden" | "notfound";

/**
 * Subscribe to a CSS media query and return whether it currently matches. Uses
 * matchMedia so the overlay-vs-push and very-narrow decisions track real layout
 * breakpoints without polling the viewport on every resize. SSR-safe (returns
 * false until mounted); the listener is added once and cleaned up on unmount,
 * and setState only fires from the change event (never synchronously in render),
 * so it is React-compiler-safe with no update loop.
 */
function useMediaQuery(query: string): boolean {
  // Lazy initializer reads the current match on the client (false during SSR),
  // so the effect never has to setState synchronously in its body. The effect
  // only subscribes; setState fires from the change-event callback. The query
  // strings used here are constant per call site, so there is no stale-initial
  // concern across renders.
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function ViewToggles() {
  const showRulers = useEditor((s) => s.showRulers);
  const showGrid = useEditor((s) => s.showGrid);
  const snapEnabled = useEditor((s) => s.snapEnabled);
  const st = useEditor.getState;
  const cls = (on: boolean) => `grid h-8 w-8 place-items-center rounded-lg ${on ? "bg-brand-50 text-brand-ink" : "text-neutral-500 hover:bg-neutral-100"}`;
  return (
    <div className="ml-1 flex items-center gap-0.5">
      <button onClick={() => st().toggleRulers()} title="Rulers & guides" className={cls(showRulers)}><Ruler size={16} /></button>
      <button onClick={() => st().toggleGrid()} title="Grid" className={cls(showGrid)}><Grid3x3 size={16} /></button>
      <button onClick={() => st().toggleSnap()} title="Snapping" className={cls(snapEnabled)}><Magnet size={16} /></button>
    </div>
  );
}

/** Thin vertical divider separating top-bar action groups. */
function Sep() {
  return <div className="mx-0.5 h-5 w-px shrink-0 bg-neutral-200" />;
}

type TopIcon = ComponentType<{ size?: number | string; className?: string }>;
type MenuItem = { icon: TopIcon; label: string; onClick: () => void; disabled?: boolean };

/** Overflow "more actions" menu collapsing the less-frequent top-bar items so the
 *  bar stays uncluttered and never wraps. Closes on outside-click or Escape, and
 *  is keyboard-navigable: opening moves focus to the first item, Up/Down move
 *  between items, Escape closes, and focus returns to the trigger on close. */
function OverflowMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Track whether the menu was closed via a keyboard action so we can return
  // focus to the trigger (an outside mouse click should not steal focus back).
  const restoreFocusRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { restoreFocusRef.current = true; setOpen(false); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  // On open, move focus into the first enabled menu item. On close (only when a
  // keyboard action requested it), return focus to the trigger button.
  useEffect(() => {
    if (open) {
      const first = menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not([disabled])');
      first?.focus();
    } else if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);
  // Arrow-key roving focus between enabled menu items; Escape closes (handled by
  // the document listener too, but here it also restores focus to the trigger).
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Escape") return;
    if (e.key === "Escape") { e.preventDefault(); restoreFocusRef.current = true; setOpen(false); return; }
    const nodes = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not([disabled])') ?? []);
    if (nodes.length === 0) return;
    e.preventDefault();
    const idx = nodes.indexOf(document.activeElement as HTMLButtonElement);
    const delta = e.key === "ArrowDown" ? 1 : -1;
    const next = idx === -1 ? 0 : (idx + delta + nodes.length) % nodes.length;
    nodes[next]?.focus();
  };
  if (!items.length) return null;
  return (
    <div ref={ref} className="relative">
      <IconButton ref={triggerRef} size="sm" aria-label="More actions" title="More actions" aria-haspopup="menu" aria-expanded={open} active={open} onClick={() => setOpen((v) => !v)}>
        <MoreHorizontal size={18} />
      </IconButton>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="More actions"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-xl border border-neutral-200 bg-surface py-1 shadow-lg"
        >
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              disabled={it.disabled}
              onClick={() => { restoreFocusRef.current = true; setOpen(false); it.onClick(); }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-neutral-700 transition hover:bg-neutral-100 focus-visible:bg-neutral-100 focus-visible:outline-none disabled:opacity-40"
            >
              <it.icon size={16} className="shrink-0 text-neutral-500" />
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Fixed zoom levels (page units centred on the viewport) offered by the % menu.
// Read-only preview banner: shown over the canvas while viewing a
// past version, naming who/when. Restore and Branch are driven from the History
// panel (which owns the selected version); the banner offers a quick Exit back
// to the live state. The panel is always open while previewing, since preview
// can only be entered from it.
function PreviewBanner() {
  const preview = useEditor((s) => s.preview);
  if (!preview) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center p-3">
      <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 shadow-md">
        <Eye size={16} className="text-amber-600" />
        <span className="text-sm font-medium text-amber-900">
          Viewing a past version - {preview.label}
        </span>
        <Button variant="ghost" size="sm" onClick={() => { useEditor.getState().exitPreview(); resyncFromLiveDoc(); }}>
          Exit preview
        </Button>
      </div>
    </div>
  );
}

// Resolved-access banner: shown over the canvas when the caller's
// effective mode is not edit. View/comment users keep presence but their edits
// are rejected server-side, so the editing affordances are disabled and this
// banner names the mode.
function AccessBanner({ mode, suppressed }: { mode: AccessMode; suppressed?: boolean }) {
  // An approval lock owns the banner when active: the more
  // specific "Approved - locked" banner shows instead of this generic one.
  if (mode === "edit" || suppressed) return null;
  const isComment = mode === "comment";
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center p-3">
      <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-4 py-2 shadow-md">
        {isComment ? <MessageSquare size={16} className="text-sky-600" /> : <Eye size={16} className="text-sky-600" />}
        <span className="text-sm font-medium text-sky-900">
          {isComment ? "You can comment on this design, but not edit it." : "You have view-only access to this design."}
        </span>
      </div>
    </div>
  );
}

export function EditorApp() {
  const router = useRouter();
  const toast = useToast();
  const loadDoc = useEditor((s) => s.loadDoc);
  const setDocTitle = useEditor((s) => s.setDocTitle);
  const title = useEditor((s) => s.doc.title);
  // The document kind selects which editing surface mounts. Plain
  // designs and presentations use the canvas; whiteboard/doc/sheet/video swap in
  // their own surface. `rev` is in the selector so a kind change re-renders.
  const docKind = useEditor((s) => ((s.doc.meta as { kind?: string } | undefined)?.kind ?? "design"));
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const playing = useEditor((s) => s.playing);
  // Dirty tracking: the doc has unsaved edits whenever its revision counter has
  // moved past the revision captured at the last save (markClean). Subscribing
  // to both keeps the indicator and the unload guard reactive.
  const rev = useEditor((s) => s.rev);
  const savedRev = useEditor((s) => s.savedRev);
  const dirty = rev !== savedRev;
  const [status, setStatus] = useState<Status>("loading");
  // The design id the caller was denied; drives the "Request access" screen.
  const [forbiddenId, setForbiddenId] = useState<string | null>(null);
  const [designId, setDesignId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // When the Share dialog is opened from an access-request notification deep
  // link, scroll its pending-requests inbox into view.
  const [shareFocusRequests, setShareFocusRequests] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  // Phase 7 distribution flows (publish to social, publish as website, order
  // prints). Each opens a self-contained dialog over the current design.
  const [publishOpen, setPublishOpen] = useState(false);
  const [websiteOpen, setWebsiteOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [a11yOpen, setA11yOpen] = useState(false);
  const [presenting, setPresenting] = useState(false);
  // Whiteboard focus (full-screen) mode: hides the chrome so only the board
  // canvas + its floating toolbar remain. Board-only; non-board kinds ignore it.
  const focus = useBoardFocus((s) => s.focus);
  const inFocus = focus && docKind === "whiteboard";
  const [historyOpen, setHistoryOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  // Page count for the overview affordance; `rev` bumps on add/delete.
  const pageCount = useEditor((s) => { void s.rev; return s.doc.pages.length; });
  // Responsive breakpoints (graceful degradation for narrow laptops/tablets;
  // not a mobile redesign). Below lg the left tool panel floats over the canvas
  // instead of taking layout width so the canvas keeps usable space; below the
  // very-narrow width we show a one-time advisory banner.
  const isCompact = useMediaQuery("(max-width: 1023px)"); // below Tailwind `lg`
  const isVeryNarrow = useMediaQuery("(max-width: 639px)"); // below Tailwind `sm`
  // One-time, dismissible "optimized for larger screens" notice (non-blocking).
  const [narrowNoticeDismissed, setNarrowNoticeDismissed] = useState(false);
  // The right Properties panel can be collapsed for more canvas/board space; the
  // preference is per-user (localStorage), defaulting to open.
  const [propsOpen, setPropsOpen] = useState(
    () => typeof window === "undefined" || window.localStorage.getItem("oc-properties-open") !== "0",
  );
  // The whiteboard is canvas-first (its tools live on the floating toolbar), so
  // the Properties panel opens collapsed there by default. It is a separate
  // persisted preference so toggling it on a board never disturbs the design
  // editor's panel preference (and vice versa); only "1" opens it.
  const [boardPropsOpen, setBoardPropsOpen] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem("oc-board-properties-open") === "1",
  );
  // In compact (below lg) the Properties aside defaults collapsed so the canvas
  // keeps usable width, without writing localStorage (which would fight the
  // user's persisted lg+ preference). A per-session flag lets the user open it
  // while compact; the persisted `propsOpen` still governs the lg+ layout.
  const [compactPropsOpen, setCompactPropsOpen] = useState(false);
  const isBoard = docKind === "whiteboard";
  const effectivePropsOpen = isCompact ? compactPropsOpen : (isBoard ? boardPropsOpen : propsOpen);
  // Below lg the secondary right-side panels (history/comments/activity/insights,
  // all fixed w-80) float over the canvas instead of pushing it to a sliver, the
  // same treatment as the Properties panel. `display: contents` keeps them as
  // normal flex siblings at lg+. showPanel() is exclusive among these four, so
  // at most one overlays at a time.
  const rightPanelOverlay = isCompact ? "absolute right-0 top-0 z-30 h-full shadow-xl" : "contents";
  const toggleProps = () => {
    if (isCompact) {
      setCompactPropsOpen((v) => !v);
      return;
    }
    if (isBoard) {
      setBoardPropsOpen((v) => {
        const next = !v;
        try { window.localStorage.setItem("oc-board-properties-open", next ? "1" : "0"); } catch { /* ignore */ }
        return next;
      });
      return;
    }
    setPropsOpen((v) => {
      const next = !v;
      try { window.localStorage.setItem("oc-properties-open", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };
  // Resizable Properties panel: drag its left edge to a custom width, clamped and
  // persisted per-user. Default 288px (the former fixed w-72).
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 288;
    const v = Number(window.localStorage.getItem("oc-properties-width"));
    return Number.isFinite(v) && v >= 240 && v <= 520 ? v : 288;
  });
  useEffect(() => {
    try { window.localStorage.setItem("oc-properties-width", String(panelWidth)); } catch { /* ignore */ }
  }, [panelWidth]);

  // Reconcile focus mode with native browser fullscreen: leaving fullscreen by
  // any route (Esc, F11, the browser's own UI) drops focus mode too, so the
  // chrome always comes back together with the OS chrome.
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) useBoardFocus.getState().setFocus(false);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // Esc leaves focus mode. With native fullscreen, the browser's own Esc exits
  // fullscreen and the listener above clears focus; this covers the case where
  // native fullscreen was denied (focus mode still hides the chrome).
  useEffect(() => {
    if (!inFocus) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") exitBoardFocus(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [inFocus]);

  // Focus is a module-level store, so clear it when leaving the editor: every
  // session starts un-focused, and it can never "stick" into the next design.
  useEffect(() => () => { exitBoardFocus(); }, []);
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null);
  const onPanelResizeDown = (e: React.PointerEvent) => {
    resizeRef.current = { startX: e.clientX, startW: panelWidth };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPanelResizeMove = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    // The panel is on the right; dragging its left edge leftward widens it.
    setPanelWidth(Math.min(520, Math.max(240, r.startW + (r.startX - e.clientX))));
  };
  const onPanelResizeUp = (e: React.PointerEvent) => {
    resizeRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  // Slice D side panels: the activity feed (FR-12) and engagement insights
  // (FR-14). Insights is only offered to members/owners (canMember).
  const [activityOpen, setActivityOpen] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [canMember, setCanMember] = useState(false);
  // The right-side auxiliary panels (history/comments/activity/insights) are
  // mutually exclusive so they never stack and crush the canvas: at most one
  // plus the Properties aside is shown. Opening one closes the rest; toggling
  // the already-open one closes it (returning to Properties). The Comments panel
  // lives in its own store, so it is included in both the open and the clear.
  const showPanel = (panel: "history" | "comments" | "activity" | "insights") => {
    // While previewing a past version the History panel owns the flow (its
    // footer holds Exit/Restore/Branch); closing or swapping panels under the
    // preview would strand it, so route the user through Exit first.
    if (useEditor.getState().preview) return;
    const wasOpen =
      panel === "history" ? historyOpen
      : panel === "comments" ? commentsOpen
      : panel === "activity" ? activityOpen
      : insightsOpen;
    setHistoryOpen(false);
    setActivityOpen(false);
    setInsightsOpen(false);
    useComments.getState().setPanelOpen(false);
    if (wasOpen) return; // toggled off: leave everything closed (Properties shows)
    if (panel === "history") setHistoryOpen(true);
    else if (panel === "comments") {
      // Mirror the store's togglePanel: open and refresh the threads for the
      // current design so the panel shows the latest on open.
      const c = useComments.getState();
      c.setPanelOpen(true);
      if (c.designId) void c.refresh();
    } else if (panel === "activity") setActivityOpen(true);
    else setInsightsOpen(true);
  };
  // The caller's resolved per-design access. Defaults to edit for the
  // local/unsaved doc; a loaded design fails closed to read-only until its
  // access resolves (so a viewer/comment user never sees an editable surface
  // whose edits would only fail on save), then takes the resolved mode.
  const [accessMode, setAccessMode] = useState<AccessMode>("edit");
  const [canShare, setCanShare] = useState(false);
  // Approval workflow. canApprove gates the "Request approval"
  // top-bar action (a requester needs share or edit). approvalRequestOpen drives
  // the request dialog. approvalRefresh bumps on a live role flip to refetch the
  // banner. The banner reports the derived lock state back so editing disables
  // the moment an approval grants (reusing the access-mode read-only gating).
  const [canApprove, setCanApprove] = useState(false);
  const [approvalRequestOpen, setApprovalRequestOpen] = useState(false);
  const [approvalRefresh, setApprovalRefresh] = useState(0);
  // True while an approval lock is the reason editing is disabled, so the generic
  // view/comment AccessBanner yields to the more specific approval banner.
  const [approvalLocked, setApprovalLocked] = useState(false);
  const commentsOpen = useComments((s) => s.panelOpen);
  // Count unresolved threads for the toolbar badge (derived reactively from the
  // comments store; no store change needed). A thread is "open" while !resolved.
  const openComments = useComments((s) => s.threads.reduce((n, t) => n + (t.resolved ? 0 : 1), 0));
  const titleRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  // Set true on setup (not just false on cleanup): React StrictMode runs
  // setup->cleanup->setup, so a cleanup-only effect would leave this stuck false
  // after mount, making post-await save state (markClean/setSaving) never apply.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // Realtime presence: connect only once a real backend design id is loaded
  // (never for the unsaved/local doc). Disconnects on unmount/route change.
  useRealtime(designId);

  // Automatic snapshots (FR-11): idle / interval-cap / tab-hidden, silent, with
  // the save time surfaced in the status text. Manual Save is unchanged.
  useAutoSnapshot(designId, () => setSavedAt(new Date().toLocaleTimeString()));

  // Engagement instrumentation: record a view + heartbeats while
  // the editor is focused, attributing time to the current page. Only for a
  // saved design; the local/unsaved doc has nothing to attribute.
  useViewBeat({
    designId,
    enabled: !!designId,
    getPageId: () => {
      const s = useEditor.getState();
      return s.doc.pages[s.activePage]?.id ?? null;
    },
  });

  useEffect(() => {
    if (!router.isReady) return;
    // The design id arrives either path-style (/editor/<id>/, served by the Go
    // rewrite on hard loads) or as the legacy ?id= query (client-side navs and
    // old links). The query form is canonicalized to the path form below.
    const pathMatch = typeof window !== "undefined" ? /^\/editor\/([^/?#]+)\/?$/.exec(window.location.pathname) : null;
    const id = typeof router.query.id === "string" ? router.query.id : pathMatch ? decodeURIComponent(pathMatch[1]) : null;
    if (id && typeof window !== "undefined" && !pathMatch) {
      // Cosmetic URL rewrite only (outside the Next router, which has no
      // /editor/[id] route in the static export): keep every other query param
      // (e.g. share=requests) so deep links still resolve.
      const rest = new URLSearchParams(window.location.search);
      rest.delete("id");
      const qs = rest.toString();
      window.history.replaceState(window.history.state, "", `/editor/${encodeURIComponent(id)}/${qs ? `?${qs}` : ""}`);
    }
    let cancelled = false;
    void (async () => {
      if (!id) {
        if (!cancelled) setStatus("ready");
        return;
      }
      try {
        const [rec, file] = await Promise.all([oc.getDesign(id), oc.getDesignFile(id)]);
        if (cancelled) return;
        loadDoc(file);
        setDesignId(id);
        setWorkspaceId(rec.workspaceId);
        setStatus("ready");
        // Fail closed: until access resolves, treat a loaded design as
        // read-only. designAccess success sets the real mode below; a failure
        // keeps it read-only rather than exposing edit affordances whose writes
        // the server would reject (the server stays the source of truth).
        setAccessMode("view");
        // Resolve the caller's per-design access to drive the
        // read-only/comment banner and gate the Share + Save affordances.
        try {
          const access = await oc.designAccess(id);
          if (cancelled) return;
          setAccessMode(access.mode);
          setCanShare(access.capabilities.includes("share"));
          // Insights are member/owner only; the `share` cap marks
          // member-or-higher (viewers/comment-only users lack it).
          setCanMember(access.capabilities.includes("share"));
          // A requester needs share or edit to start an approval.
          setCanApprove(access.capabilities.includes("share") || access.capabilities.includes("edit"));
          // Wire the comments store to this design (FR-2). A comment/view user
          // can comment per the capability even though they cannot edit.
          useComments.getState().setDesign(id, access.capabilities.includes("comment"));
        } catch {
          /* keep defaults; server remains the source of truth */
        }
        // Wire the brand store to this design: resolves the
        // active kit + the caller's manage-brand flag for the Brand panel and
        // the locked pickers (FR-4). Best-effort; falls back to no-brand.
        useBrand.getState().setDesign(id, rec.workspaceId);
      } catch (e) {
        if (cancelled) return;
        // A 403 means the design exists but the caller has no access: offer to
        // request it. Anything else is a generic open failure.
        if (e instanceof ApiError && e.status === 403) {
          setForbiddenId(id);
          setStatus("forbidden");
        } else if (e instanceof ApiError && e.status === 404) {
          // The design id does not exist (or was deleted): show the branded
          // not-found screen rather than a generic open error.
          setStatus("notfound");
        } else {
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router.isReady, router.query.id, loadDoc]);

  // Deep link: an access-request notification routes to
  // /editor?id=...&share=requests. Once the design is loaded, open the Share
  // dialog on its pending-requests inbox so the owner can act in one click
  // instead of having to open Share manually. setState is deferred to a timer
  // (the codebase's pattern for deep-link-driven state) to keep the effect body
  // free of synchronous setState.
  useEffect(() => {
    if (!router.isReady || !designId) return;
    if (router.query.share !== "requests") return;
    const t = setTimeout(() => {
      setShareOpen(true);
      setShareFocusRequests(true);
    }, 0);
    return () => clearTimeout(t);
  }, [router.isReady, router.query.share, designId]);

  // Live comment updates: refetch threads/pins when a peer
  // posts/resolves/reacts over the realtime room. Clients without a socket still
  // work via REST; this just keeps the panel and pins current. Reset the comments
  // store on unmount so a stale design's threads never leak into the next editor.
  useEffect(() => {
    const off = onCommentChanged((changedDesignId) => {
      if (changedDesignId === useComments.getState().designId) {
        void useComments.getState().refresh();
      }
    });
    return () => {
      off();
      useComments.getState().setDesign(null, false);
    };
  }, []);

  // Live role downgrade/upgrade (FR-11 / F16 AC-9). When the server pushes
  // a `{ t: "role" }` frame (e.g. an approval locked or was reopened, or a grant
  // changed) the editing affordances must flip with NO reconnect. A viewer role
  // caps us at comment (review continues; the server already rejects viewer
  // mutations); an editor role restores edit. We also bump the approval banner's
  // refresh token so it re-reads the workflow, and toast the change.
  useEffect(() => {
    const off = onRoleChanged((role, reason) => {
      setAccessMode((prev) => {
        if (role === "viewer") return prev === "edit" ? "comment" : prev;
        return "edit"; // editor: editing restored
      });
      setApprovalRefresh((n) => n + 1);
      if (reason === "approval-locked") toast.toast("This design was approved and locked. Editing is disabled.", "info");
      else if (reason === "approval-reopened") toast.success("This design was reopened. You can edit again.");
      else toast.toast("Your access to this design changed.", "info");
    });
    return off;
  }, [toast]);

  // Mirror the resolved access mode into the presence store so the canvas
  // keyboard path (a global listener with no props) can gate document mutations
  // exactly like the pointer path and the disabled Save button (F16 fix). Reset
  // to the "edit" default on unmount so the next editor's local/unsaved doc is
  // not stuck read-only from a previous design.
  useEffect(() => {
    usePresence.getState().setAccessMode(accessMode);
  }, [accessMode]);
  useEffect(() => () => usePresence.getState().setAccessMode("edit"), []);

  // Unsaved-changes guard: warn before the tab is closed/reloaded while a saved
  // design has unsaved edits. The listener is added once and reads the latest
  // dirty/designId through a ref, so the effect never re-subscribes per edit and
  // never calls setState (no React-compiler violation).
  const unloadRef = useRef({ dirty, designId });
  // Keep the ref current via an effect (never written during render). This is a
  // cheap commit-time sync; the listener below reads it lazily, so the listener
  // itself is registered once.
  useEffect(() => {
    unloadRef.current = { dirty, designId };
  }, [dirty, designId]);
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const { dirty: d, designId: id } = unloadRef.current;
      if (d && id) {
        e.preventDefault();
        e.returnValue = ""; // required for the native prompt in most browsers
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Global "?" (Shift+/) opens the keyboard-shortcuts sheet, ignoring keystrokes
  // typed into inputs/textareas/contentEditable (and while crop/present own the
  // keyboard). Mirrors the command-menu's typing guard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable) return;
      const ed = useEditor.getState();
      if (ed.cropping || ed.presenting) return;
      e.preventDefault();
      setShortcutsOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Cmd/Ctrl+P opens our native print (rendered pages) instead of letting the
  // browser print the editor DOM, which would be useless. Only for scene-backed
  // kinds; ignored while typing, cropping, or presenting.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "p" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable) return;
      const ed = useEditor.getState();
      if (ed.cropping || ed.presenting) return;
      const kind = (ed.doc.meta as { kind?: string } | undefined)?.kind ?? "design";
      if (kind !== "design" && kind !== "whiteboard") return;
      e.preventDefault();
      setPrintOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const save = useCallback(async () => {
    if (!designId) return;
    // Never checkpoint a history preview: without realtime the store doc IS
    // the previewed historical file, and saving it would silently move the
    // design's current version back in time. Restore is the explicit path.
    if (useEditor.getState().preview) {
      toast.error("You're viewing a past version. Exit the preview to save, or use Restore.");
      return;
    }
    setSaving(true);
    useEditor.getState().setManualSaving(true); // auto-snapshot yields while this runs
    try {
      // When realtime is live, snapshot the shared Y.Doc (the source of truth
      // for collaborative edits); otherwise fall back to the local store doc.
      const file = getDesignDoc()?.snapshot() ?? useEditor.getState().doc;
      if (!Array.isArray(file.pages) || file.pages.length === 0) {
        // A blank zero-page file means the document has not loaded yet (the
        // server would 422 it anyway); saving now could only lose work.
        toast.error("The design is still loading; try again in a moment.");
        return;
      }
      await oc.saveSnapshot(designId, { file, kind: "checkpoint" });
      if (!mounted.current) return;
      // Mark the doc clean at the just-saved revision so the dirty indicator and
      // the unload guard clear; record the wall-clock time for the status text.
      useEditor.getState().markClean();
      setSavedAt(new Date().toLocaleTimeString());
      toast.success("Saved.");
    } catch {
      if (mounted.current) toast.error("Save failed.");
    } finally {
      useEditor.getState().setManualSaving(false); // always clear, even if unmounted
      if (mounted.current) setSaving(false);
    }
  }, [designId, toast]);

  async function commitTitle() {
    const value = titleRef.current?.value.trim();
    if (!value || value === title) return;
    const prev = title;
    setDocTitle(value);
    if (designId) {
      try {
        await oc.renameDesign(designId, value);
      } catch {
        // Roll back the optimistic title so local state matches the server.
        setDocTitle(prev);
        toast.error("Rename failed.");
      }
    }
  }

  if (status === "loading") {
    return <div className="grid h-screen place-items-center text-neutral-400"><Spinner className="text-2xl" /></div>;
  }
  if (status === "error") {
    return (
      <div className="grid h-screen place-items-center gap-3 text-center">
        <p className="text-sm text-neutral-600">Could not open this design.</p>
        <Button variant="secondary" onClick={() => void router.push("/dashboard")}>Back to dashboard</Button>
      </div>
    );
  }
  if (status === "notfound") {
    return (
      <NotFoundScreen
        title="Design not found"
        message="This design doesn't exist or may have been deleted."
        homeLabel="Back to dashboard"
        homeHref="/dashboard"
      />
    );
  }
  if (status === "forbidden" && forbiddenId) {
    return <RequestAccessScreen designId={forbiddenId} onBack={() => void router.push("/dashboard")} />;
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-neutral-100 text-neutral-900">
      {/* Top bar. flex-nowrap keeps the bar single-line down to ~768px; the
          title input shrinks/truncates and secondary actions live in the
          OverflowMenu so groups overflow gracefully instead of wrapping. In
          focus (full-screen) mode the whole bar is hidden so only the board
          canvas + its floating toolbar remain. */}
      {!inFocus && (
      <header className="flex flex-nowrap items-center gap-3 border-b border-neutral-200 bg-surface px-3 py-2">
        <IconButton className="shrink-0" aria-label="Back to dashboard" onClick={() => void router.push("/dashboard")}>
          <ChevronLeft size={20} />
        </IconButton>
        <LogoMark size={28} />
        <input
          ref={titleRef}
          defaultValue={title}
          key={title}
          onBlur={() => void commitTitle()}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="min-w-0 max-w-[8rem] flex-shrink rounded-lg px-2 py-1 text-sm font-semibold text-neutral-800 outline-none hover:bg-neutral-100 focus:bg-neutral-100 sm:max-w-[12rem] lg:max-w-[14rem]"
        />
        <div className="ml-2 flex shrink-0 items-center">
          <IconButton aria-label="Undo" onClick={undo}><Undo2 size={18} /></IconButton>
          <IconButton aria-label="Redo" onClick={redo}><Redo2 size={18} /></IconButton>
        </div>
        {/* Rulers/grid/snap fit inline down to sm; below that they fold into the
            overflow menu (they have no other entry point, so they must stay
            reachable). */}
        {!isVeryNarrow && <ViewToggles />}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {!isCompact && designId && <PresenceBar />}
          {designId && (
            dirty ? (
              <span className="mr-1 hidden items-center gap-1.5 text-xs font-medium text-amber-600 lg:inline-flex" title="You have unsaved changes">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                Unsaved changes
              </span>
            ) : (
              <span className="mr-1 hidden text-xs text-neutral-400 lg:inline" title={savedAt ? `Last saved ${savedAt}` : undefined}>
                {savedAt ? `Saved ${savedAt}` : "All changes saved"}
              </span>
            )
          )}

          {/* Frequent view/collaborate actions as compact icon buttons. Below lg
              (isCompact) these fold into the overflow menu so the bar fits narrow
              screens without scrolling sideways. Animation preview and fullscreen
              present are canvas-surface only. */}
          {!isCompact && <Sep />}
          {!isCompact && docKind === "design" && (
            <>
              <IconButton size="sm" onClick={() => useEditor.getState().playAnimations()} disabled={playing} title={playing ? "Playing…" : "Preview animations"}>
                <Play size={18} />
              </IconButton>
              <IconButton size="sm" onClick={() => { useEditor.getState().setPresenting(true); setPresenting(true); }} title="Present (fullscreen)">
                <MonitorPlay size={18} />
              </IconButton>
            </>
          )}
          {!isCompact && docKind === "whiteboard" && (
            <IconButton size="sm" onClick={enterBoardFocus} title="Focus mode — hide panels (full screen)">
              <Maximize2 size={18} />
            </IconButton>
          )}
          {!isCompact && designId && (
            <div className="relative">
              <IconButton size="sm" active={commentsOpen} onClick={() => showPanel("comments")} title={openComments > 0 ? `Comments (${openComments} open)` : "Comments"}>
                <MessageSquare size={18} />
              </IconButton>
              {openComments > 0 && (
                <span className="pointer-events-none absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand-600 px-1 text-[10px] font-semibold leading-none text-white">
                  {openComments > 99 ? "99+" : openComments}
                </span>
              )}
            </div>
          )}
          {designId && <NotificationsBell />}

          <Sep />
          {/* Less-frequent actions collapse into an overflow menu so the bar
              never wraps; each is gated the same way it was as a button. */}
          <OverflowMenu
            items={[
              // Below lg, the inline secondary actions fold in here so the top bar
              // fits narrow screens without overflowing.
              ...(isCompact && docKind === "design"
                ? [
                    { icon: Play as TopIcon, label: "Preview animations", onClick: () => useEditor.getState().playAnimations() },
                    { icon: MonitorPlay as TopIcon, label: "Present (fullscreen)", onClick: () => { useEditor.getState().setPresenting(true); setPresenting(true); } },
                  ]
                : []),
              ...(isCompact && docKind === "whiteboard" ? [{ icon: Maximize2 as TopIcon, label: "Focus mode", onClick: enterBoardFocus }] : []),
              ...(isCompact && designId ? [{ icon: MessageSquare as TopIcon, label: openComments > 0 ? `Comments (${openComments} open)` : "Comments", onClick: () => showPanel("comments") }] : []),
              ...(isCompact && (docKind === "design" || docKind === "whiteboard") ? [{ icon: Download as TopIcon, label: "Download", onClick: () => setExportOpen(true) }] : []),
              ...(isCompact && designId && canShare ? [{ icon: Share2 as TopIcon, label: "Share", onClick: () => setShareOpen(true) }] : []),
              // Below sm the rulers/grid/snap toggles fold in here (their only
              // other home, the inline ViewToggles, is hidden at that width).
              ...(isVeryNarrow
                ? [
                    { icon: Ruler as TopIcon, label: "Rulers & guides", onClick: () => useEditor.getState().toggleRulers() },
                    { icon: Grid3x3 as TopIcon, label: "Grid", onClick: () => useEditor.getState().toggleGrid() },
                    { icon: Magnet as TopIcon, label: "Snapping", onClick: () => useEditor.getState().toggleSnap() },
                  ]
                : []),
              ...(docKind === "design" && pageCount > 1
                ? [{ icon: LayoutGrid as TopIcon, label: "Slide overview", onClick: () => setOverviewOpen(true) }]
                : []),
              ...(designId ? [{ icon: History as TopIcon, label: "Version history", onClick: () => showPanel("history") }] : []),
              ...(designId ? [{ icon: Activity as TopIcon, label: "Activity feed", onClick: () => showPanel("activity") }] : []),
              ...(designId && canMember ? [{ icon: BarChart3 as TopIcon, label: "Engagement insights", onClick: () => showPanel("insights") }] : []),
              ...(designId && canApprove && docKind === "design" ? [{ icon: ShieldCheck as TopIcon, label: "Request approval", onClick: () => setApprovalRequestOpen(true) }] : []),
              // Template/publish/print render the page scene, so they apply to
              // scene-backed designs only (doc/sheet/video content lives in meta).
              ...(docKind === "design"
                ? [
                    { icon: LayoutTemplate as TopIcon, label: "Save as template", onClick: () => setTemplateOpen(true), disabled: !workspaceId },
                    { icon: Send as TopIcon, label: "Publish to social", onClick: () => setPublishOpen(true) },
                    { icon: Globe as TopIcon, label: "Publish as website", onClick: () => setWebsiteOpen(true) },
                    { icon: Printer as TopIcon, label: "Print", onClick: () => setPrintOpen(true) },
                  ]
                : []),
              { icon: Accessibility as TopIcon, label: "Accessibility check", onClick: () => setA11yOpen(true) },
              { icon: Keyboard as TopIcon, label: "Keyboard shortcuts", onClick: () => setShortcutsOpen(true) },
            ]}
          />
          {/* Image/PDF/SVG export renders the scene; doc/sheet/video keep their
              content in meta (not scene nodes), so the chrome export is only shown
              for scene-backed kinds (Docs has its own Markdown export). */}
          {!isCompact && (docKind === "design" || docKind === "whiteboard") && (
            <IconButton size="sm" onClick={() => setExportOpen(true)} title="Download">
              <Download size={18} />
            </IconButton>
          )}

          {!isCompact && <Sep />}
          {!isCompact && designId && canShare && (
            <Button variant="secondary" size="sm" onClick={() => setShareOpen(true)} title="Share this design">
              <Share2 size={16} /> Share
            </Button>
          )}
          <Button size="sm" onClick={() => void save()} disabled={!designId || saving || accessMode !== "edit"} title={accessMode !== "edit" ? "You do not have edit access" : designId ? "Save a snapshot" : "Open from the dashboard to save"}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </header>
      )}

      {/* Very-narrow advisory (below sm): the editor is a complex desktop tool,
          so on small viewports we surface a subtle, dismissible notice. It is a
          slim bar in the layout flow (not an overlay), so it never blocks the
          canvas or any control. */}
      {isVeryNarrow && !narrowNoticeDismissed && !inFocus && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
          <Info size={14} className="shrink-0 text-amber-600" />
          <span className="min-w-0 flex-1">The editor is optimized for larger screens. Some panels float over the canvas to keep it usable.</span>
          <button
            onClick={() => setNarrowNoticeDismissed(true)}
            aria-label="Dismiss notice"
            title="Dismiss"
            className="grid h-5 w-5 shrink-0 place-items-center rounded text-amber-600 hover:bg-amber-100 hover:text-amber-800"
          >
            <X size={13} />
          </button>
        </div>
      )}

      <CommandMenu onExport={() => setExportOpen(true)} onShortcuts={() => setShortcutsOpen(true)} workspaceId={workspaceId} />
      <ShortcutsHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      {shareOpen && designId && (
        <ShareDialog key={designId} open onClose={() => { setShareOpen(false); setShareFocusRequests(false); }} designId={designId} focusRequests={shareFocusRequests} />
      )}
      <SaveAsTemplateDialog open={templateOpen} onClose={() => setTemplateOpen(false)} designId={designId} workspaceId={workspaceId} />
      {publishOpen && <PublishDialog open onClose={() => setPublishOpen(false)} designId={designId ?? undefined} workspaceId={workspaceId ?? undefined} />}
      {websiteOpen && <WebsiteDialog open onClose={() => setWebsiteOpen(false)} designId={designId ?? undefined} workspaceId={workspaceId ?? undefined} />}
      {printOpen && <PrintDialog open onClose={() => setPrintOpen(false)} />}
      {a11yOpen && <AccessibilityDialog open onClose={() => setA11yOpen(false)} />}
      <SlideOverview open={overviewOpen} onClose={() => setOverviewOpen(false)} />
      {presenting && <PresentMode onClose={() => { useEditor.getState().setPresenting(false); setPresenting(false); }} />}
      <PromptHost />

      <div className="relative flex min-h-0 flex-1">
        {/* The left tool rail is shared by the canvas-backed kinds. Whiteboard is
            scene-backed (its surface renders the same Canvas + store), so the
            Elements/Text/Uploads/Stock/Brand/Layers panels apply there too; only
            doc/sheet/video (meta-backed) omit it. */}
        {(docKind === "design" || docKind === "whiteboard") && !inFocus && (
          // key by kind so switching surface re-applies its default; boards open
          // with the slide-out panel collapsed (canvas-first).
          <ToolRail key={docKind} workspaceId={workspaceId} overlay={isCompact} defaultCollapsed={isBoard} />
        )}
        {docKind !== "design" ? (
          // Same relative wrapper as the design canvas so overlays (the
          // read-only history preview banner) cover every document surface.
          <main className="relative flex min-w-0 flex-1">
            <DocumentSurface kind={docKind} workspaceId={workspaceId ?? undefined} designId={designId ?? undefined} />
            <PreviewBanner />
          </main>
        ) : (
        <>
        <main className="relative min-w-0 flex-1">
          <Canvas />
          <PreviewBanner />
          <AccessBanner mode={accessMode} suppressed={approvalLocked} />
          {designId && (
            <ApprovalBanner
              designId={designId}
              requestOpen={approvalRequestOpen}
              onRequestClose={() => setApprovalRequestOpen(false)}
              refreshToken={approvalRefresh}
              onLockChange={(locked) => {
                // Reconcile the editor's read-only gating with the lock state
                // for the local user, not just live peers. On lock,
                // cap an editor to comment; on unlock, refetch the true access.
                setApprovalLocked(locked);
                if (locked) {
                  setAccessMode((prev) => (prev === "edit" ? "comment" : prev));
                } else if (designId) {
                  void oc
                    .designAccess(designId)
                    .then((a) => setAccessMode(a.mode))
                    .catch(() => undefined);
                }
              }}
            />
          )}
          <ZoomControl />
        </main>
        </>
        )}
        {/* Right-side panels are shared across every document kind (they operate
            on the server design by id). Version history replaces the design
            Properties aside; on other kinds it stands alone. The Properties aside
            itself is design-only (it edits scene-node properties). All of them are
            hidden in board focus mode. */}
        {!inFocus && (
        <>
        {historyOpen && designId ? (
          <div className={rightPanelOverlay}>
          <HistoryPanel
            designId={designId}
            workspaceId={workspaceId}
            onClose={() => {
              // Don't silently discard an active preview on a header close: while
              // previewing, the panel's own footer owns the explicit Exit/Restore
              // (which call exitPreview + resync). So a header close keeps the
              // preview and the panel open, routing the user to that footer
              // instead of dumping them back to live with no warning. Only when
              // NOT previewing do we close (no preview to lose).
              if (useEditor.getState().preview) return;
              setHistoryOpen(false);
            }}
          />
          </div>
        ) : docKind === "design" || docKind === "whiteboard" ? (
          // The Properties panel edits scene-node properties, so it applies to
          // the canvas-backed kinds (design and whiteboard). Doc/sheet/video keep
          // their state in meta and have no scene-node properties to show. The
          // panel collapses to a slim rail for more canvas/board space. Under
          // lg it defaults collapsed (effectivePropsOpen) to protect canvas width.
          effectivePropsOpen ? (
            <aside
              // Below lg the panel floats over the canvas (like the left rail's
              // overlay) and caps its width to the viewport, so opening it on a
              // phone never crushes the canvas; at lg+ it is a normal flex sibling
              // at the user's resizable width.
              className={`flex flex-col border-l border-neutral-200 bg-surface ${
                isCompact ? "absolute right-0 top-0 z-30 h-full shadow-xl" : "relative shrink-0"
              }`}
              style={{ width: isCompact ? "min(20rem, 86vw)" : panelWidth }}
            >
              {/* Drag the left edge to resize the panel. */}
              <div
                onPointerDown={onPanelResizeDown}
                onPointerMove={onPanelResizeMove}
                onPointerUp={onPanelResizeUp}
                title="Drag to resize"
                className="absolute left-0 top-0 z-20 h-full w-1.5 cursor-col-resize touch-none hover:bg-brand-200"
              />
              {/* A thin header bar with the collapse toggle on the panel's inner
                  (left) edge, so it stays put and never overlaps the content. */}
              <div className="flex shrink-0 items-center border-b border-neutral-100 py-1 pl-2.5 pr-2">
                <button
                  onClick={toggleProps}
                  title="Collapse panel"
                  aria-label="Collapse properties panel"
                  className="grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
                >
                  <PanelRightClose size={16} />
                </button>
              </div>
              <div className="oc-scroll min-h-0 flex-1 overflow-y-auto">
                <PropertiesPanel />
              </div>
            </aside>
          ) : (
            <button
              onClick={toggleProps}
              title="Show properties"
              aria-label="Show properties panel"
              className="grid w-9 shrink-0 cursor-pointer place-items-start justify-center border-l border-neutral-200 bg-surface pt-2.5 text-neutral-400 hover:bg-neutral-50 hover:text-neutral-700"
            >
              <PanelRightOpen size={18} />
            </button>
          )
        ) : null}
        {commentsOpen && designId && (
          <div className={rightPanelOverlay}>
            <CommentsPanel onClose={() => useComments.getState().setPanelOpen(false)} />
          </div>
        )}
        {activityOpen && designId && (
          <div className={rightPanelOverlay}>
            <ActivityPanel designId={designId} onClose={() => setActivityOpen(false)} />
          </div>
        )}
        {insightsOpen && designId && canMember && (
          <div className={rightPanelOverlay}>
            <InsightsPanel designId={designId} onClose={() => setInsightsOpen(false)} />
          </div>
        )}
        </>
        )}
      </div>
      {docKind === "design" && <PagesBar />}

      {/* Focus-mode exit affordance. In focus mode the chrome is gone, so this
          floating pill (top-right, above the board's own overlays) is the way
          back; Esc and leaving native fullscreen also exit. */}
      {inFocus && (
        <button
          type="button"
          onClick={exitBoardFocus}
          title="Exit focus mode (Esc)"
          aria-label="Exit focus mode"
          className="fixed right-3 top-3 z-[60] flex items-center gap-1.5 rounded-full border border-neutral-200 bg-surface/95 px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-lg backdrop-blur hover:bg-neutral-100"
        >
          <Minimize2 size={14} />
          Exit focus
          <kbd className="ml-0.5 rounded border border-neutral-300 bg-neutral-50 px-1 text-[10px] font-semibold text-neutral-500">Esc</kbd>
        </button>
      )}
    </div>
  );
}
