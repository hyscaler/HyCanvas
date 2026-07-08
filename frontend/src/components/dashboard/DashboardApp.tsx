// Home dashboard: a left nav rail + workspace switcher, a
// "create" format row, a templates gallery (F14), and recent designs with real
// previews and hover menus. Rename/delete/create use modals + toasts (no native
// dialogs). Favorites/shared sections and projects are deferred.

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/router";
import {
  Home as HomeIcon,
  LayoutTemplate,
  PanelLeftClose,
  PanelLeftOpen,
  Trash2,
  Search,
  Star,
  Plus,
  ChevronDown,
  MoreHorizontal,
  Copy,
  Pencil,
  ExternalLink,
  Settings,
  LogOut,
  Layers,
  Image as ImageIcon,
  Presentation,
  Instagram,
  FileText,
  LayoutGrid,
  Table2,
  Film,
  Smartphone,
  Facebook,
  Youtube,
  Linkedin,
  CreditCard,
  Monitor,
  RectangleHorizontal,
  File,
  BookOpen,
  CheckSquare,
  List,
  Users,
} from "lucide-react";
import { createBlankDesign } from "@hc/schema";
import type { DesignRecord, HomeItem, MyTask, TaskStatus, TemplateCollectionSummary, TemplateSummary, WorkspaceRole } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { useAuth } from "@/store/auth";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { Logo, LogoMark } from "@/components/ui/Logo";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { DesignThumb } from "./DesignThumb";
import { BulkCreateModal } from "./BulkCreateModal";
import { MembersPanel } from "./MembersPanel";
import { VerifyEmailBanner } from "@/components/auth/VerifyEmailBanner";
import { NotificationsBell } from "@/components/notifications/NotificationsBell";
import { HeroArt, EmptyArt, RailArt } from "@/components/ui/CanvasBackdrop";

// Time-aware greeting for the dashboard hero band.
function greetByHour(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// Faint canvas dot-grid + soft corner blobs behind the main scroll area. Layered
// CSS backgrounds (no DOM, no z-index) so content cards paint cleanly on top.
const DASH_BACKDROP: React.CSSProperties = {
  backgroundImage: [
    "radial-gradient(rgba(116,88,232,0.06) 1px, transparent 1px)",
    "radial-gradient(42rem 28rem at 6% -4%, rgba(124,88,232,0.10), transparent 60%)",
    "radial-gradient(40rem 30rem at 100% 0%, rgba(47,123,255,0.08), transparent 55%)",
  ].join(", "),
  backgroundSize: "24px 24px, auto, auto",
  backgroundRepeat: "repeat, no-repeat, no-repeat",
};

type Format = { label: string; icon: typeof Plus; w: number; h: number; kind?: string };

const FORMAT_GROUPS: { title: string; items: Format[] }[] = [
  {
    title: "Social",
    items: [
      { label: "Instagram post", icon: Instagram, w: 1080, h: 1080 },
      { label: "Instagram story", icon: Smartphone, w: 1080, h: 1920 },
      { label: "Facebook post", icon: Facebook, w: 1200, h: 630 },
      { label: "LinkedIn post", icon: Linkedin, w: 1200, h: 627 },
      { label: "YouTube thumbnail", icon: Youtube, w: 1280, h: 720 },
    ],
  },
  {
    title: "Print",
    items: [
      { label: "Poster", icon: FileText, w: 1080, h: 1350 },
      { label: "Flyer", icon: File, w: 816, h: 1056 },
      { label: "Business card", icon: CreditCard, w: 1050, h: 600 },
      { label: "A4 document", icon: BookOpen, w: 1240, h: 1754 },
    ],
  },
  {
    title: "Digital",
    items: [
      { label: "Presentation", icon: Presentation, w: 1920, h: 1080 },
      { label: "Banner", icon: RectangleHorizontal, w: 1500, h: 500 },
      { label: "Desktop wallpaper", icon: Monitor, w: 1920, h: 1080 },
      { label: "Logo", icon: ImageIcon, w: 500, h: 500 },
    ],
  },
  {
    // Document types beyond static design (docs 28-32). `kind` is written to
    // meta.kind at creation so the editor mounts the matching surface.
    title: "Docs & data",
    items: [
      { label: "Whiteboard", icon: LayoutGrid, w: 1920, h: 1080, kind: "whiteboard" },
      { label: "Doc", icon: FileText, w: 816, h: 1056, kind: "doc" },
      { label: "Sheet", icon: Table2, w: 1280, h: 800, kind: "sheet" },
      { label: "Video", icon: Film, w: 1920, h: 1080, kind: "video" },
    ],
  },
];

// Preset canvas sizes offered in the "Create a design" size picker (Canva-style).
const SIZE_PRESETS: { label: string; w: number; h: number }[] = [
  { label: "Instagram Post", w: 1080, h: 1080 },
  { label: "Instagram Story", w: 1080, h: 1920 },
  { label: "Presentation 16:9", w: 1920, h: 1080 },
  { label: "Facebook Post", w: 1200, h: 630 },
  { label: "LinkedIn Post", w: 1200, h: 627 },
  { label: "Poster", w: 1080, h: 1350 },
  { label: "A4 Document", w: 1240, h: 1754 },
  { label: "Logo", w: 500, h: 500 },
  { label: "Business Card", w: 1050, h: 600 },
];

export function DashboardApp() {
  const router = useRouter();
  const toast = useToast();
  const { user, workspaces, activeWorkspaceId, setActiveWorkspace, logout, refreshWorkspaces } = useAuth();
  const [items, setItems] = useState<HomeItem[]>([]);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<HomeItem | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<HomeItem | null>(null);
  const [wsModal, setWsModal] = useState(false);
  const [sizeOpen, setSizeOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [customW, setCustomW] = useState(1080);
  const [customH, setCustomH] = useState(1080);
  const [wsName, setWsName] = useState("");
  const [view, setView] = useState<"home" | "favorites" | "templates" | "trash" | "tasks" | "members">("home");
  // Left rail collapse, remembered across visits. Lazy init: localStorage is
  // client-only and the static prerender falls back to expanded.
  const [railCollapsed, setRailCollapsed] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem("hc-dash-rail") === "collapsed",
  );
  function toggleRail(collapsed: boolean) {
    setRailCollapsed(collapsed);
    window.localStorage.setItem("hc-dash-rail", collapsed ? "collapsed" : "expanded");
  }
  const [trash, setTrash] = useState<DesignRecord[]>([]);
  const [favorites, setFavorites] = useState<HomeItem[]>([]);
  const [tasks, setTasks] = useState<MyTask[]>([]);
  // Hybrid-dashboard chrome: recents view/sort controls.
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [sortBy, setSortBy] = useState<"recent" | "name">("recent");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  // Template gallery filters.
  const [tplCategory, setTplCategory] = useState<string | null>(null);
  const [tplCollection, setTplCollection] = useState<string | null>(null);
  const [collections, setCollections] = useState<TemplateCollectionSummary[]>([]);

  const load = useCallback(async (q: string) => {
    if (!activeWorkspaceId) return [] as HomeItem[];
    return q.trim() ? oc.search(activeWorkspaceId, q.trim()) : oc.home(activeWorkspaceId, "recent");
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    let cancelled = false;
    void (async () => {
      const [recent, tpls] = await Promise.all([oc.home(activeWorkspaceId, "recent"), oc.listTemplates().catch(() => [])]);
      if (cancelled) return;
      setItems(recent);
      setTemplates(tpls);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  // Load trashed designs when the Trash view is opened.
  useEffect(() => {
    if (view !== "trash" || !activeWorkspaceId) return;
    let cancelled = false;
    void (async () => {
      const t = await oc.listTrash(activeWorkspaceId).catch(() => []);
      if (!cancelled) setTrash(t);
    })();
    return () => {
      cancelled = true;
    };
  }, [view, activeWorkspaceId]);

  // Load tasks assigned to the current user when the My tasks view is opened
  //. Spans every workspace the user can access, not just the active
  // one, so feedback assigned anywhere is visible in one place.
  useEffect(() => {
    if (view !== "tasks") return;
    let cancelled = false;
    void (async () => {
      const t = await oc.myTasks().catch(() => []);
      if (!cancelled) setTasks(t);
    })();
    return () => {
      cancelled = true;
    };
  }, [view]);

  // Load favorited designs when the Favorites view is opened.
  useEffect(() => {
    if (view !== "favorites" || !activeWorkspaceId) return;
    let cancelled = false;
    void (async () => {
      const f = await oc.home(activeWorkspaceId, "favorites").catch(() => []);
      if (!cancelled) setFavorites(f);
    })();
    return () => {
      cancelled = true;
    };
  }, [view, activeWorkspaceId]);

  // Template gallery: load this workspace's collections, and reload templates
  // whenever the category/collection filter changes.
  useEffect(() => {
    if (view !== "templates" || !activeWorkspaceId) return;
    let cancelled = false;
    void (async () => {
      const cols = await oc.listTemplateCollections(activeWorkspaceId).catch(() => []);
      if (!cancelled) setCollections(cols);
    })();
    return () => {
      cancelled = true;
    };
  }, [view, activeWorkspaceId]);

  // Collection filtering is server-side (scoped query); category filtering is
  // client-side so the chip set stays stable as one is selected.
  useEffect(() => {
    if (view !== "templates" || !activeWorkspaceId) return;
    let cancelled = false;
    void (async () => {
      const tpls = await oc
        .listTemplates({
          workspaceId: activeWorkspaceId,
          collection: tplCollection ?? undefined,
        })
        .catch(() => []);
      if (!cancelled) setTemplates(tpls);
    })();
    return () => {
      cancelled = true;
    };
  }, [view, activeWorkspaceId, tplCollection]);

  // Categories present across the loaded templates, for the filter chips.
  const templateCategories = Array.from(
    new Set(templates.flatMap((t) => t.categories ?? [])),
  ).sort();
  const filteredTemplates = tplCategory
    ? templates.filter((t) => (t.categories ?? []).includes(tplCategory))
    : templates;
  // Recents sort (client-side): last edited or name. Shared by Home + Favorites.
  const bySort = (a: HomeItem, b: HomeItem) =>
    sortBy === "name" ? a.title.localeCompare(b.title) : new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  const sortedItems = [...items].sort(bySort);
  const sortedFavorites = [...favorites].sort(bySort);
  // A design's effective type: its document surface kind, else "design".
  const itemKind = (i: HomeItem) => (i.docKind && i.docKind !== "design" ? i.docKind : "design");
  // Only offer type chips when there's actually a mix of types to filter.
  const presentKinds = new Set(items.map(itemKind));
  const TYPE_CHIPS: { id: string; label: string }[] = [
    { id: "all", label: "All" },
    { id: "design", label: "Designs" },
    { id: "doc", label: "Docs" },
    { id: "whiteboard", label: "Whiteboards" },
    { id: "sheet", label: "Sheets" },
    { id: "video", label: "Videos" },
  ];
  const typeChips = TYPE_CHIPS.filter((c) => c.id === "all" || presentKinds.has(c.id));
  // Fall back to "all" when the active filter is no longer available (e.g. the
  // last doc was deleted, or the workspace changed) so recents can't get stuck
  // blank with the chips hidden.
  const effectiveFilter = typeChips.some((c) => c.id === typeFilter) ? typeFilter : "all";
  const visibleItems = effectiveFilter === "all" ? sortedItems : sortedItems.filter((i) => itemKind(i) === effectiveFilter);

  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId);
  const firstName = user?.name?.trim().split(/\s+/)[0] || user?.email?.split("@")[0] || "there";

  const open = (id: string) => router.push({ pathname: "/editor", query: { id } });

  // Star/unstar a design; optimistically flip the flag in the open lists, then
  // reconcile from the server response (and drop it from Favorites when unstarred).
  async function toggleFavorite(item: HomeItem) {
    const next = !item.starred;
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, starred: next } : i)));
    setFavorites((prev) =>
      next ? prev : prev.filter((i) => i.id !== item.id),
    );
    try {
      const { starred } = await oc.toggleFavorite(item.id, next);
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, starred } : i)));
      if (!starred) setFavorites((prev) => prev.filter((i) => i.id !== item.id));
    } catch {
      // Revert on failure.
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, starred: item.starred } : i)));
      if (item.starred) setFavorites((prev) => (prev.some((i) => i.id === item.id) ? prev : [item, ...prev]));
      toast.error("Could not update favorite.");
    }
  }

  async function restoreFromTrash(id: string) {
    if (!activeWorkspaceId) return;
    await oc.restoreDesign(id);
    setTrash(await oc.listTrash(activeWorkspaceId).catch(() => []));
    toast.success("Restored.");
  }

  async function deleteForever(id: string) {
    if (!activeWorkspaceId) return;
    await oc.deleteDesign(id, true);
    setTrash(await oc.listTrash(activeWorkspaceId).catch(() => []));
    toast.success("Deleted permanently.");
  }

  async function createDesign(width = 1080, height = 1080, label = "Untitled design", kind?: string) {
    if (!activeWorkspaceId) return;
    setSizeOpen(false);
    setBusy(true);
    try {
      const from = createBlankDesign({ title: label, width, height });
      // Document types (docs 28-32) carry their surface marker in meta.kind; a
      // plain design leaves it unset (treated as "design").
      if (kind) from.meta.kind = kind;
      const rec = await oc.createDesign({ workspaceId: activeWorkspaceId, title: label, from });
      await open(rec.id);
    } catch {
      toast.error("Could not create design.");
      setBusy(false);
    }
  }

  async function duplicate(item: HomeItem) {
    if (!activeWorkspaceId) return;
    setBusy(true);
    try {
      const file = await oc.getDesignFile(item.id);
      const title = `${item.title} (copy)`;
      file.title = title;
      await oc.createDesign({ workspaceId: activeWorkspaceId, title, from: file });
      setItems(await load(query));
      toast.success("Design duplicated.");
    } catch {
      toast.error("Could not duplicate the design.");
    } finally {
      setBusy(false);
    }
  }

  function startFormat(f: Format) {
    if (f.label === "Blank") setSizeOpen(true);
    else void createDesign(f.w, f.h, f.label, f.kind);
  }

  async function applyTemplate(t: TemplateSummary) {
    if (!activeWorkspaceId) return;
    setBusy(true);
    try {
      const { designId } = await oc.applyTemplate(t.id, activeWorkspaceId);
      await open(designId);
    } catch {
      toast.error("Could not open template.");
      setBusy(false);
    }
  }

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    setView("home"); // search always lands on the results in the home view
    setLoading(true);
    setItems(await load(query));
    setLoading(false);
  }

  async function confirmRename() {
    if (!renameTarget || !renameValue.trim()) return;
    await oc.renameDesign(renameTarget.id, renameValue.trim());
    setRenameTarget(null);
    toast.success("Renamed.");
    setItems(await load(query));
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    await oc.deleteDesign(deleteTarget.id);
    setDeleteTarget(null);
    toast.success("Moved to trash.");
    setItems(await load(query));
  }

  async function createWorkspace() {
    if (!wsName.trim()) return;
    const ws = await oc.createWorkspace({ name: wsName.trim(), kind: "team" });
    await refreshWorkspaces();
    setActiveWorkspace(ws.id);
    setWsModal(false);
    setWsName("");
    toast.success(`Workspace “${ws.name}” created.`);
  }

  // Shared recents controls (sort + grid/list) used by Home and Favorites.
  const viewControls = () => (
    <div className="flex items-center gap-2">
      <select
        value={sortBy}
        onChange={(e) => setSortBy(e.target.value as "recent" | "name")}
        className="h-8 rounded-lg border border-neutral-200 bg-white px-2 text-xs text-neutral-600 outline-none focus:border-brand-400"
      >
        <option value="recent">Last edited</option>
        <option value="name">Name (A-Z)</option>
      </select>
      <div className="flex overflow-hidden rounded-lg border border-neutral-200">
        <button onClick={() => setViewMode("grid")} title="Grid view" className={`grid h-8 w-8 place-items-center ${viewMode === "grid" ? "bg-brand-50 text-brand-700" : "text-neutral-500 hover:bg-neutral-100"}`}><LayoutGrid size={15} /></button>
        <button onClick={() => setViewMode("list")} title="List view" className={`grid h-8 w-8 place-items-center border-l border-neutral-200 ${viewMode === "list" ? "bg-brand-50 text-brand-700" : "text-neutral-500 hover:bg-neutral-100"}`}><List size={15} /></button>
      </div>
    </div>
  );

  // One design's "more" menu (open/rename/delete), shared by card + row.
  const itemMenu = (item: HomeItem) => (
    <div className="relative">
      <IconButton size="sm" onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === item.id ? null : item.id); }} aria-label="More"><MoreHorizontal size={16} /></IconButton>
      {menuFor === item.id && (
        <div className="absolute right-0 z-30 mt-1 w-36 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 text-sm shadow-lg" onClick={(e) => e.stopPropagation()}>
          <MenuRow icon={ExternalLink} onClick={() => { setMenuFor(null); void open(item.id); }}>Open</MenuRow>
          <MenuRow icon={Copy} onClick={() => { setMenuFor(null); void duplicate(item); }}>Duplicate</MenuRow>
          <MenuRow icon={Pencil} onClick={() => { setMenuFor(null); setRenameTarget(item); setRenameValue(item.title); }}>Rename</MenuRow>
          <MenuRow icon={Trash2} danger onClick={() => { setMenuFor(null); setDeleteTarget(item); }}>Delete</MenuRow>
        </div>
      )}
    </div>
  );

  // A design as a grid card / a list row. Used across Home + Favorites.
  const renderCard = (item: HomeItem) => (
    <li key={item.id} className="group relative rounded-2xl border border-neutral-200 bg-white shadow-sm transition hover:shadow-md">
      <button onClick={() => void open(item.id)} className="block aspect-[4/3] w-full overflow-hidden rounded-t-2xl" title="Open"><DesignThumb designId={item.id} /></button>
      <FavoriteButton starred={item.starred} onToggle={() => void toggleFavorite(item)} />
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-neutral-800">{item.title}</div>
          <div className="text-xs text-neutral-400">{new Date(item.updatedAt).toLocaleDateString()}</div>
        </div>
        {itemMenu(item)}
      </div>
    </li>
  );

  const renderRow = (item: HomeItem) => (
    <li key={item.id} className="group flex items-center gap-3 border-b border-neutral-100 px-3 py-2 last:border-b-0 hover:bg-neutral-50">
      <button onClick={() => void open(item.id)} className="h-10 w-14 shrink-0 overflow-hidden rounded-md border border-neutral-200 bg-neutral-100" title="Open"><DesignThumb designId={item.id} /></button>
      <button onClick={() => void open(item.id)} className="min-w-0 flex-1 text-left">
        <div className="truncate text-sm font-semibold text-neutral-800">{item.title}</div>
        <div className="text-xs text-neutral-400">{new Date(item.updatedAt).toLocaleDateString()}</div>
      </button>
      <button onClick={() => void toggleFavorite(item)} aria-label={item.starred ? "Unfavorite" : "Favorite"} className={`grid h-8 w-8 place-items-center rounded-lg transition ${item.starred ? "text-amber-400" : "text-neutral-400 opacity-0 hover:bg-neutral-100 group-hover:opacity-100"}`}><Star size={15} fill={item.starred ? "currentColor" : "none"} /></button>
      {itemMenu(item)}
    </li>
  );

  // Render a list of designs as the current grid/list view.
  const itemsList = (list: HomeItem[]) =>
    viewMode === "grid" ? (
      <ul className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{list.map(renderCard)}</ul>
    ) : (
      <ul className="rounded-2xl border border-neutral-200 bg-white shadow-sm [&>li:first-child]:rounded-t-2xl [&>li:last-child]:rounded-b-2xl">{list.map(renderRow)}</ul>
    );

  return (
    <div className="flex h-screen overflow-hidden bg-neutral-50 text-neutral-900" onClick={() => setMenuFor(null)}>
      {/* Left rail: fixed to the viewport; only the main column scrolls.
          Collapsible to an icon-only strip (remembered in localStorage). */}
      <aside
        className={`oc-panel-dots relative flex shrink-0 flex-col overflow-y-auto border-r border-neutral-200 bg-white transition-[width] duration-200 ${
          railCollapsed ? "w-[4.5rem] p-3" : "w-80 p-4"
        }`}
      >
        {railCollapsed ? (
          <>
            <div className="mb-4 flex justify-center">
              <LogoMark size={30} />
            </div>
            <button
              type="button"
              onClick={() => toggleRail(false)}
              title="Expand sidebar"
              aria-label="Expand sidebar"
              className="mb-4 flex justify-center rounded-xl py-2 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
            >
              <PanelLeftOpen size={18} />
            </button>
            {/* Collapsed workspace chip: expanding is the way to switch. */}
            <button
              type="button"
              onClick={() => toggleRail(false)}
              title={workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? "Workspace"}
              aria-label="Expand sidebar to switch workspace"
              className="oc-gradient mx-auto grid h-8 w-8 place-items-center rounded-md text-xs font-bold text-white"
            >
              {(workspaces.find((w) => w.id === activeWorkspaceId)?.name || "?").charAt(0).toUpperCase()}
            </button>
          </>
        ) : (
          <>
            <div className="mb-6 flex items-center justify-between px-1">
              <Logo size={32} />
              <button
                type="button"
                onClick={() => toggleRail(true)}
                title="Collapse sidebar"
                aria-label="Collapse sidebar"
                className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
              >
                <PanelLeftClose size={18} />
              </button>
            </div>

            <WorkspaceSwitcher
              workspaces={workspaces}
              activeId={activeWorkspaceId}
              onSelect={setActiveWorkspace}
              onCreate={() => setWsModal(true)}
            />
          </>
        )}

        <nav className="mt-5 flex flex-col gap-1 text-sm">
          <RailItem icon={HomeIcon} label="Home" active={view === "home"} collapsed={railCollapsed} onClick={() => setView("home")} />
          <RailItem icon={Star} label="Favorites" active={view === "favorites"} collapsed={railCollapsed} onClick={() => setView("favorites")} />
          <RailItem icon={CheckSquare} label="My tasks" active={view === "tasks"} collapsed={railCollapsed} onClick={() => setView("tasks")} />
          <RailItem icon={LayoutTemplate} label="Templates" active={view === "templates"} collapsed={railCollapsed} onClick={() => setView("templates")} />
          <RailItem icon={Users} label="Members" active={view === "members"} collapsed={railCollapsed} onClick={() => setView("members")} />
          <RailItem icon={Trash2} label="Trash" active={view === "trash"} collapsed={railCollapsed} onClick={() => setView("trash")} />
        </nav>

        {!railCollapsed && <RailArt />}
      </aside>

      {/* Main */}
      <main className="oc-scroll flex-1 overflow-y-auto" style={DASH_BACKDROP}>
        {/* Header: global search, create, notifications, and the user menu. */}
        <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-neutral-200 bg-white/90 px-6 py-2.5 backdrop-blur">
          <form onSubmit={onSearch} className="relative max-w-lg flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search designs and templates…"
              className="h-9 w-full rounded-xl border border-neutral-200 bg-neutral-50 pl-9 pr-3 text-sm outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100"
            />
          </form>
          <div className="ml-auto flex items-center gap-2">
            <CreateMenu
              disabled={busy || !activeWorkspaceId}
              onPick={(f) => void createDesign(f.w, f.h, f.label, f.kind)}
              onCustom={() => setSizeOpen(true)}
              onBulk={() => setBulkOpen(true)}
            />
            <NotificationsBell />
            <UserMenu user={user} onSettings={() => void router.push("/settings")} onSignOut={() => void logout()} />
          </div>
        </div>
        <div className="mx-auto max-w-[1600px] px-6 py-8">
          {view === "home" && (
          <>
          <VerifyEmailBanner />

          {/* Flat hero: greeting + workspace + CTAs sit directly on the page's
              ambient texture (no card frame), with the shared art floating right. */}
          {!query.trim() && (
            <section className="relative mb-9 min-h-[8rem]">
              <HeroArt />
              <div className="relative max-w-xl">
                <h1 className="text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">
                  {greetByHour()}, {firstName} <span className="inline-block">👋</span>
                </h1>
                <p className="mt-2 text-sm text-neutral-500">
                  Let’s make something today. Start from a blank canvas or pick up where you left off.
                </p>
                <div className="mt-5 flex flex-wrap gap-2.5">
                  <Button onClick={() => setSizeOpen(true)} disabled={busy || !activeWorkspaceId}>
                    <Plus size={16} /> Start a design
                  </Button>
                  <Button variant="secondary" onClick={() => setView("templates")}>
                    <LayoutTemplate size={16} /> Browse templates
                  </Button>
                </div>
              </div>
            </section>
          )}

          {/* Create row: every format together in one wrap. */}
          <section className="mb-10">
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-neutral-400">Start a design</h2>
            <div className="flex flex-wrap gap-3">
              {[{ label: "Blank", icon: Plus, w: 1080, h: 1080 } as Format, ...FORMAT_GROUPS.flatMap((g) => g.items)].map((f) => (
                <FormatTile key={f.label} f={f} disabled={busy} onClick={() => startFormat(f)} />
              ))}
            </div>
          </section>

          {/* Recent / results */}
          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-bold uppercase tracking-wide text-neutral-400">
                {query.trim() ? "Search results" : "Recent designs"}
              </h2>
              {items.length > 0 && viewControls()}
            </div>
            {typeChips.length > 1 && (
              <div className="mb-4 flex flex-wrap gap-2">
                {typeChips.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setTypeFilter(c.id)}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition ${effectiveFilter === c.id ? "bg-brand-600 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}
            {loading ? (
              <div className="grid place-items-center py-16 text-neutral-400">
                <Spinner className="text-2xl" />
              </div>
            ) : items.length === 0 ? (
              <EmptyState message={query.trim() ? "No matching designs." : "No designs yet."}>
                {!query.trim() && (
                  <Button onClick={() => setSizeOpen(true)}>
                    <Plus size={18} /> Create your first design
                  </Button>
                )}
              </EmptyState>
            ) : (
              itemsList(visibleItems)
            )}
          </section>

          {/* Templates teaser (below recents) */}
          {templates.length > 0 && !query.trim() && (
            <section className="mt-10">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-neutral-400">Start from a template</h2>
              <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => void applyTemplate(t)}
                    disabled={busy}
                    title="Use this template"
                    className="group overflow-hidden rounded-2xl border border-neutral-200 bg-white text-left shadow-sm transition hover:shadow-md disabled:opacity-60"
                  >
                    <div className="aspect-[4/3] bg-neutral-100">
                      <DesignThumb templateId={t.id} />
                    </div>
                    <div className="truncate px-3 py-2.5 text-sm font-semibold text-neutral-800">{t.title}</div>
                  </button>
                ))}
              </div>
            </section>
          )}
          </>
          )}

          {view === "favorites" && (
            <section>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-bold uppercase tracking-wide text-neutral-400">Favorites</h2>
                {favorites.length > 0 && viewControls()}
              </div>
              {favorites.length === 0 ? (
                <EmptyState message="No favorites yet. Tap the star on a design to add it here." />
              ) : (
                itemsList(sortedFavorites)
              )}
            </section>
          )}

          {view === "templates" && (
            <section>
              {/* Header row matches Favorites: title left, controls right. */}
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-bold uppercase tracking-wide text-neutral-400">Templates</h2>
                {collections.length > 0 && (
                  <select
                    value={tplCollection ?? ""}
                    onChange={(e) => setTplCollection(e.target.value || null)}
                    className="h-8 rounded-lg border border-neutral-200 bg-white px-2 text-xs text-neutral-600 outline-none focus:border-brand-400"
                  >
                    <option value="">All collections</option>
                    {collections.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                )}
              </div>
              {/* Category filter chips (FR-2): flat, bordered, with a tinted active
                  state consistent with the rail and the grid/list controls. */}
              {templateCategories.length > 0 && (
                <div className="mb-4 flex flex-wrap gap-2">
                  <button
                    onClick={() => setTplCategory(null)}
                    className={`rounded-lg border px-3 py-1 text-sm transition ${tplCategory === null ? "border-brand-200 bg-brand-50 text-brand-700" : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50"}`}
                  >
                    All
                  </button>
                  {templateCategories.map((c) => (
                    <button
                      key={c}
                      onClick={() => setTplCategory(c)}
                      className={`rounded-lg border px-3 py-1 text-sm capitalize transition ${tplCategory === c ? "border-brand-200 bg-brand-50 text-brand-700" : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50"}`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              )}
              {filteredTemplates.length === 0 ? (
                <EmptyState message="No templates yet. Open a design and use Save as template to add one here." />
              ) : (
                <ul className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {filteredTemplates.map((t) => (
                    <li key={t.id} className="group relative rounded-2xl border border-neutral-200 bg-white shadow-sm transition hover:shadow-md">
                      <button
                        onClick={() => void applyTemplate(t)}
                        disabled={busy}
                        title="Use this template"
                        className="block w-full text-left disabled:opacity-60"
                      >
                        <div className="aspect-[4/3] overflow-hidden rounded-t-2xl bg-neutral-100"><DesignThumb templateId={t.id} /></div>
                        <div className="truncate px-3 py-2.5 text-sm font-semibold text-neutral-800">{t.title}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {view === "trash" && (
            <section>
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-neutral-400">Trash</h2>
              {trash.length === 0 ? (
                <EmptyState message="Trash is empty." />
              ) : (
                <ul className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {trash.map((d) => (
                    <li key={d.id} className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
                      <div className="aspect-[4/3] bg-neutral-100"><DesignThumb designId={d.id} trashed /></div>
                      <div className="px-3 py-2.5">
                        <div className="truncate text-sm font-semibold text-neutral-800">{d.title}</div>
                        <div className="mt-2 flex gap-2 text-xs">
                          <button onClick={() => void restoreFromTrash(d.id)} className="font-medium text-brand-700 hover:underline">Restore</button>
                          <button onClick={() => void deleteForever(d.id)} className="font-medium text-red-600 hover:underline">Delete forever</button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {view === "tasks" && (
            <section>
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-neutral-400">My tasks</h2>
              {tasks.length === 0 ? (
                <EmptyState message="No tasks assigned to you. Comments converted to tasks and assigned to you show up here." />
              ) : (
                <ul className="space-y-2">
                  {tasks.map((t) => {
                    const status = (t.task?.status ?? "open") as TaskStatus;
                    const label: Record<TaskStatus, string> = { open: "Open", in_progress: "In progress", done: "Done" };
                    const tone: Record<TaskStatus, string> = {
                      open: "bg-amber-50 text-amber-700",
                      in_progress: "bg-sky-50 text-sky-700",
                      done: "bg-emerald-50 text-emerald-700",
                    };
                    return (
                      <li key={t.id}>
                        <button
                          onClick={() => void open(t.designId)}
                          className="flex w-full items-center gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-left shadow-sm hover:border-brand-300 hover:bg-brand-50/40"
                        >
                          <CheckSquare size={18} className="shrink-0 text-brand-600" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-neutral-800">{t.body}</span>
                            <span className="block truncate text-xs text-neutral-400">
                              {t.designTitle}
                              {t.task?.dueAt ? ` · due ${new Date(t.task.dueAt).toLocaleDateString()}` : ""}
                            </span>
                          </span>
                          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${tone[status]}`}>{label[status]}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          {view === "members" && (
            <section>
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-neutral-400">Members</h2>
              <MembersPanel
                workspaceId={activeWorkspaceId}
                workspaceName={activeWs?.name ?? "this workspace"}
                workspaceKind={activeWs?.kind ?? "personal"}
                myRole={(activeWs?.role ?? "viewer") as WorkspaceRole}
                myUserId={user?.id ?? ""}
                onExit={() => { setView("home"); void refreshWorkspaces(); }}
              />
            </section>
          )}
        </div>
      </main>

      {/* Modals */}

      <Modal open={sizeOpen} onClose={() => setSizeOpen(false)} title="Create a design" width="w-[34rem]">
        <div className="grid grid-cols-2 gap-2">
          {SIZE_PRESETS.map((p) => {
            const box = 34;
            const ratio = p.w / p.h;
            const pw = ratio >= 1 ? box : Math.round(box * ratio);
            const ph = ratio >= 1 ? Math.round(box / ratio) : box;
            return (
              <button
                key={p.label}
                onClick={() => void createDesign(p.w, p.h, p.label)}
                className="flex items-center gap-3 rounded-lg border border-neutral-200 px-3 py-2.5 text-left transition-colors hover:border-brand-300 hover:bg-brand-50"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center" aria-hidden>
                  <span
                    className="rounded-[2px] border border-neutral-300 bg-neutral-100"
                    style={{ width: pw, height: ph }}
                  />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-neutral-800">{p.label}</span>
                  <span className="text-xs text-neutral-400">{p.w}×{p.h}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-4 border-t border-neutral-100 pt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">Custom size (px)</p>
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Input label="Width" type="number" className="w-full" value={customW} onChange={(e) => setCustomW(Math.max(1, Number(e.target.value) || 0))} />
            </div>
            <span className="pb-3 text-neutral-400">×</span>
            <div className="min-w-0 flex-1">
              <Input label="Height" type="number" className="w-full" value={customH} onChange={(e) => setCustomH(Math.max(1, Number(e.target.value) || 0))} />
            </div>
            <Button className="shrink-0" onClick={() => void createDesign(customW, customH, `Custom ${customW}×${customH}`)}>Create</Button>
          </div>
        </div>
      </Modal>

      <Modal open={!!renameTarget} onClose={() => setRenameTarget(null)} title="Rename design">
        <Input label="Title" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRenameTarget(null)}>Cancel</Button>
          <Button onClick={() => void confirmRename()}>Save</Button>
        </div>
      </Modal>

      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Move to trash?">
        <p className="text-sm text-neutral-600">“{deleteTarget?.title}” will be moved to trash. You can restore it later.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => void confirmDelete()}>Move to trash</Button>
        </div>
      </Modal>

      <BulkCreateModal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        workspaceId={activeWorkspaceId}
        templates={templates}
        designs={items.map((i) => ({ id: i.id, title: i.title }))}
        onOpenDesign={(id) => { setBulkOpen(false); void open(id); }}
      />

      <Modal open={wsModal} onClose={() => setWsModal(false)} title="Create a workspace">
        <Input label="Workspace name" value={wsName} onChange={(e) => setWsName(e.target.value)} placeholder="e.g. Marketing team" autoFocus />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setWsModal(false)}>Cancel</Button>
          <Button onClick={() => void createWorkspace()}>Create</Button>
        </div>
      </Modal>
    </div>
  );
}

function RailItem({
  icon: Icon,
  label,
  active,
  collapsed,
  onClick,
}: {
  icon: typeof HomeIcon;
  label: string;
  active?: boolean;
  collapsed?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? label : undefined}
      aria-label={label}
      className={`flex items-center rounded-xl font-medium ${
        collapsed ? "justify-center px-0 py-2.5" : "gap-3 px-3 py-2 text-left"
      } ${active ? "bg-brand-50 text-brand-700" : "text-neutral-600 hover:bg-neutral-100"}`}
    >
      <Icon size={18} className="shrink-0" />
      {!collapsed && label}
    </button>
  );
}

function FavoriteButton({ starred, onToggle }: { starred: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-label={starred ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={starred}
      title={starred ? "Remove from favorites" : "Add to favorites"}
      className={`absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-white/90 shadow-sm backdrop-blur transition hover:bg-white ${
        starred ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"
      }`}
    >
      <Star
        size={16}
        className={starred ? "text-amber-400" : "text-neutral-500"}
        fill={starred ? "currentColor" : "none"}
      />
    </button>
  );
}

// Uniform, flat empty state shared across Home / Favorites / Tasks / Trash: the
// shared canvas art over a centered message on the ambient background (no card
// frame), with an optional call to action.
function EmptyState({ message, children }: { message: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 py-20 text-center">
      <EmptyArt />
      <p className="max-w-sm text-sm text-neutral-500">{message}</p>
      {children}
    </div>
  );
}

function MenuRow({ children, onClick, danger, icon: Icon }: { children: React.ReactNode; onClick: () => void; danger?: boolean; icon?: typeof Trash2 }) {
  return (
    <button onClick={onClick} className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-neutral-50 ${danger ? "text-red-600" : "text-neutral-700"}`}>
      {Icon && <Icon size={15} className={danger ? "text-red-500" : "text-neutral-400"} />}
      {children}
    </button>
  );
}

/** A format card: a proportional preview rectangle + icon + label. */
function FormatTile({ f, disabled, onClick }: { f: Format; disabled?: boolean; onClick: () => void }) {
  const land = f.w >= f.h;
  const long = 50;
  const boxW = Math.max(14, Math.round(land ? long : (long * f.w) / f.h));
  const boxH = Math.max(14, Math.round(land ? (long * f.h) / f.w : long));
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="group flex w-24 flex-col items-center gap-2"
      title={f.label === "Blank" ? f.label : `${f.label} · ${f.w}×${f.h}`}
    >
      <span className="relative grid h-[78px] w-full place-items-center rounded-xl border border-neutral-200 bg-white shadow-sm transition group-hover:-translate-y-0.5 group-hover:border-brand-300 group-hover:shadow-md">
        <span className="rounded bg-brand-50 ring-1 ring-brand-100" style={{ width: boxW, height: boxH }} />
        <span className="absolute inset-0 grid place-items-center text-brand-500"><f.icon size={20} strokeWidth={1.75} /></span>
      </span>
      <span className="w-full truncate text-center text-xs font-medium text-neutral-600">{f.label}</span>
    </button>
  );
}

/** Close `open` when clicking outside `ref`. */
function useOutsideClose(ref: React.RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open, ref, onClose]);
}

/** Header "Create" dropdown: blank/custom, the grouped formats, and bulk create. */
function CreateMenu({ disabled, onPick, onCustom, onBulk }: { disabled?: boolean; onPick: (f: Format) => void; onCustom: () => void; onBulk: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, open, () => setOpen(false));
  return (
    <div className="relative" ref={ref}>
      <Button onClick={() => setOpen((o) => !o)} disabled={disabled}><Plus size={16} /> Create</Button>
      {open && (
        <div className="absolute right-0 z-40 mt-1.5 max-h-[72vh] w-64 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl ring-1 ring-black/5">
          <button onClick={() => { setOpen(false); onCustom(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-neutral-700 hover:bg-neutral-100">
            <Plus size={16} className="text-brand-600" /> Blank / custom size
          </button>
          {FORMAT_GROUPS.map((g) => (
            <div key={g.title}>
              <div className="px-2.5 pb-0.5 pt-2 text-[10px] font-bold uppercase tracking-wide text-neutral-400">{g.title}</div>
              {g.items.map((f) => (
                <button key={f.label} onClick={() => { setOpen(false); onPick(f); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100">
                  <f.icon size={16} className="shrink-0 text-neutral-500" />
                  <span className="min-w-0 flex-1 truncate">{f.label}</span>
                  <span className="shrink-0 text-[11px] text-neutral-400">{f.w}×{f.h}</span>
                </button>
              ))}
            </div>
          ))}
          <div className="mt-1 border-t border-neutral-100 pt-1">
            <button onClick={() => { setOpen(false); onBulk(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100">
              <Layers size={16} className="text-neutral-500" /> Bulk create
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Header account menu: email, security, sign out. */
function UserMenu({ user, onSettings, onSignOut }: { user: { name?: string | null; email?: string | null } | null; onSettings: () => void; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, open, () => setOpen(false));
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} aria-label="Account" className="oc-gradient grid h-8 w-8 place-items-center rounded-full text-sm font-bold text-white">
        {(user?.name || user?.email || "?").charAt(0).toUpperCase()}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1.5 w-56 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl ring-1 ring-black/5">
          <div className="px-2.5 py-1.5">
            {user?.name && <div className="truncate text-sm font-semibold text-neutral-800">{user.name}</div>}
            <div className="truncate text-xs text-neutral-500">{user?.email}</div>
          </div>
          <div className="my-1 border-t border-neutral-100" />
          <button onClick={() => { setOpen(false); onSettings(); }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"><Settings size={15} className="text-neutral-400" /> Settings</button>
          <button onClick={() => { setOpen(false); onSignOut(); }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"><LogOut size={15} className="text-neutral-400" /> Sign out</button>
        </div>
      )}
    </div>
  );
}

function WorkspaceSwitcher({
  workspaces,
  activeId,
  onSelect,
  onCreate,
}: {
  workspaces: { id: string; name: string; kind: string }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, open, () => setOpen(false));
  const active = workspaces.find((w) => w.id === activeId);
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className="flex w-full items-center gap-2 rounded-xl border border-neutral-200 px-3 py-2 text-left text-sm hover:bg-neutral-50"
      >
        <span className="oc-gradient grid h-6 w-6 shrink-0 place-items-center rounded-md text-xs font-bold text-white">
          {(active?.name || "?").charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate font-semibold">{active?.name ?? "Workspace"}</span>
        <ChevronDown size={16} className="text-neutral-400" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 z-20 mt-1 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-lg" onClick={(e) => e.stopPropagation()}>
          {workspaces.map((w) => (
            <button
              key={w.id}
              onClick={() => { onSelect(w.id); setOpen(false); }}
              className={`block w-full truncate px-3 py-2 text-left text-sm hover:bg-neutral-50 ${w.id === activeId ? "font-semibold text-brand-700" : "text-neutral-700"}`}
            >
              {w.name}
              {w.kind === "personal" ? " · personal" : ""}
            </button>
          ))}
          <button onClick={() => { onCreate(); setOpen(false); }} className="block w-full border-t border-neutral-100 px-3 py-2 text-left text-sm font-medium text-brand-700 hover:bg-neutral-50">
            + New workspace
          </button>
        </div>
      )}
    </div>
  );
}
