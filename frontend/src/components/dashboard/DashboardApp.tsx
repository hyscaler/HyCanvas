// Home dashboard: a left nav rail + workspace switcher, a
// "create" format row, a templates gallery (F14), and recent designs with real
// previews and hover menus. Rename/delete/create use modals + toasts (no native
// dialogs). Favorites/shared sections and projects are deferred.

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/router";
import {
  Home as HomeIcon,
  LayoutTemplate,
  FileUp,
  FileDown,
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
  Moon,
  Sun,
} from "lucide-react";
import { createBlankDesign } from "@hc/schema";
import { hycAccept, downloadHycFile, importedTitle, parseHycFile, readFileText } from "@/lib/hycFile";
import { pptxToDesign } from "@hc/export";
import { ApiError, type DesignRecord, type HomeItem, type MyTask, type StorageUsageView, type TaskStatus, type TemplateCollectionSummary, type TemplateSummary, type WorkspaceRole } from "@hc/sdk";
import { formatBytes } from "@/lib/format";
import { useDateFormat } from "@/lib/datetime";
import { resolvedTheme, setThemePreference } from "@/lib/theme";
import { oc } from "@/lib/sdk";
import { useAuth } from "@/store/auth";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { Logo, LogoMark } from "@/components/ui/Logo";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { dashboardPath, type DashboardView } from "./views";
import { DesignThumb } from "./DesignThumb";
import { BulkCreateModal } from "./BulkCreateModal";
import { MembersPanel } from "./MembersPanel";
import { VerifyEmailBanner } from "@/components/auth/VerifyEmailBanner";
import { NotificationsBell } from "@/components/notifications/NotificationsBell";
import { HeroArt, EmptyArt, RailArt } from "@/components/ui/CanvasBackdrop";
import { tr } from "@/lib/i18n";
import { apiCodeMessage, userMessage } from "@/lib/errors";

// Time-aware greeting for the dashboard hero band.
function greetByHour(): string {
  const h = new Date().getHours();
  if (h < 12) return tr("dashboard.good_morning");
  if (h < 18) return tr("dashboard.good_afternoon");
  return tr("dashboard.good_evening");
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

const formatGroups = (): { title: string; items: Format[] }[] => [
  {
    title: tr("dashboard.social"),
    items: [
      { label: tr("dashboard.instagram_post_2"), icon: Instagram, w: 1080, h: 1080 },
      { label: tr("dashboard.instagram_story_2"), icon: Smartphone, w: 1080, h: 1920 },
      { label: tr("dashboard.facebook_post_2"), icon: Facebook, w: 1200, h: 630 },
      { label: tr("dashboard.linkedin_post_2"), icon: Linkedin, w: 1200, h: 627 },
      { label: tr("dashboard.youtube_thumbnail"), icon: Youtube, w: 1280, h: 720 },
    ],
  },
  {
    title: tr("dashboard.print"),
    items: [
      { label: tr("dashboard.poster"), icon: FileText, w: 1080, h: 1350 },
      { label: tr("dashboard.flyer"), icon: File, w: 816, h: 1056 },
      { label: tr("dashboard.business_card_2"), icon: CreditCard, w: 1050, h: 600 },
      { label: "A4 document", icon: BookOpen, w: 1240, h: 1754 },
    ],
  },
  {
    title: tr("dashboard.digital"),
    items: [
      { label: tr("dashboard.presentation"), icon: Presentation, w: 1920, h: 1080 },
      { label: tr("dashboard.banner"), icon: RectangleHorizontal, w: 1500, h: 500 },
      { label: tr("dashboard.desktop_wallpaper"), icon: Monitor, w: 1920, h: 1080 },
      { label: tr("dashboard.logo"), icon: ImageIcon, w: 500, h: 500 },
    ],
  },
  {
    // Document types beyond static design (docs 28-32). `kind` is written to
    // meta.kind at creation so the editor mounts the matching surface.
    title: tr("dashboard.docs_data"),
    items: [
      { label: tr("dashboard.whiteboard"), icon: LayoutGrid, w: 1920, h: 1080, kind: "whiteboard" },
      { label: tr("dashboard.doc"), icon: FileText, w: 816, h: 1056, kind: "doc" },
      { label: tr("dashboard.sheet"), icon: Table2, w: 1280, h: 800, kind: "sheet" },
      { label: tr("dashboard.video"), icon: Film, w: 1920, h: 1080, kind: "video" },
    ],
  },
];

// Preset canvas sizes offered in the "Create a design" size picker.
const sizePresets = (): { label: string; w: number; h: number }[] => [
  { label: tr("dashboard.instagram_post"), w: 1080, h: 1080 },
  { label: tr("dashboard.instagram_story"), w: 1080, h: 1920 },
  { label: tr("dashboard.presentation_16_9"), w: 1920, h: 1080 },
  { label: tr("dashboard.facebook_post"), w: 1200, h: 630 },
  { label: tr("dashboard.linkedin_post"), w: 1200, h: 627 },
  { label: tr("dashboard.poster"), w: 1080, h: 1350 },
  { label: "A4 Document", w: 1240, h: 1754 },
  { label: tr("dashboard.logo"), w: 500, h: 500 },
  { label: tr("dashboard.business_card"), w: 1050, h: 600 },
];

export function DashboardApp({ view }: { view: DashboardView }) {
  const router = useRouter();
  const toast = useToast();
  const { user, workspaces, activeWorkspaceId, setActiveWorkspace, logout, refreshWorkspaces } = useAuth();
  const df = useDateFormat();
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
  // The active section comes from the URL (one static page per view; see
  // pages/dashboard/[[...view]].tsx). Every section renders that same page
  // component, so navigating re-renders this mounted app with a new `view`
  // prop and switching stays instant (no remount, no refetch).
  // No-op when already there, so re-clicking the active rail item (or
  // re-submitting a search from Home) can't stack duplicate history entries.
  const gotoView = useCallback(
    (v: DashboardView) => { if (v !== view) void router.push(dashboardPath(v)); },
    [router, view],
  );
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
  // Storage usage for the rail meter (workspace + account scopes).
  const [storageUsage, setStorageUsage] = useState<StorageUsageView | null>(null);
  useEffect(() => {
    if (!activeWorkspaceId) return;
    let cancelled = false;
    void oc.assetUsage(activeWorkspaceId).then((u) => { if (!cancelled) setStorageUsage(u); }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeWorkspaceId]);
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
    { id: "all", label: tr("dashboard.all") },
    { id: "design", label: tr("dashboard.designs") },
    { id: "doc", label: tr("dashboard.docs") },
    { id: "whiteboard", label: tr("dashboard.whiteboards") },
    { id: "sheet", label: tr("dashboard.sheets") },
    { id: "video", label: tr("dashboard.videos") },
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
      toast.error(tr("dashboard.could_not_update_favorite"));
    }
  }

  async function restoreFromTrash(id: string) {
    if (!activeWorkspaceId) return;
    await oc.restoreDesign(id);
    setTrash(await oc.listTrash(activeWorkspaceId).catch(() => []));
    toast.success(tr("dashboard.restored"));
  }

  async function deleteForever(id: string) {
    if (!activeWorkspaceId) return;
    await oc.deleteDesign(id, true);
    setTrash(await oc.listTrash(activeWorkspaceId).catch(() => []));
    toast.success(tr("dashboard.deleted_permanently"));
  }

  // Import a .hyc file (the open format as JSON) as a NEW design in the active
  // workspace. Validation + forward migration happen client-side so the errors
  // are immediate and specific; the server re-validates on create.
  // Best user-facing message from a failed import: the server's problem+json
  // `detail` (a validate() slip that reached the server, quota, etc.) beats the
  // opaque "HyCanvas API 4xx" ApiError.message; a client-side Error keeps its
  // own specific message.
  const importErrorMessage = (e: unknown, fallback: string) => {
    if (e instanceof ApiError) {
      const coded = apiCodeMessage(e.body);
      if (coded) return coded;
      const detail = (e.body as { detail?: unknown } | null)?.detail;
      if (typeof detail === "string" && detail) return detail;
    }
    // Translates CodedError (the .hyc import failures); plain Error keeps its
    // message, as before.
    return userMessage(e, fallback);
  };
  const importDesignRef = useRef<HTMLInputElement>(null);
  async function importHycDesign(list: FileList | null) {
    const f = list?.[0];
    if (!f || !activeWorkspaceId || busy) return;
    setBusy(true);
    try {
      // .pptx imports through the client-side OOXML parser (doc 28 interop):
      // slides land as editable pages, embedded media as self-contained data
      // URLs the server ingests like any pasted image. Everything else is the
      // open .hyc format.
      const isPptx = /\.pptx$/i.test(f.name) || f.type === "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      const file = isPptx
        ? await pptxToDesign(new Uint8Array(await f.arrayBuffer()), { title: f.name.replace(/\.pptx$/i, "") })
        : parseHycFile(await readFileText(f));
      const title = importedTitle(file, f.name);
      const rec = await oc.createDesign({ workspaceId: activeWorkspaceId, title, from: { ...file, title } });
      toast.success(`Imported "${title}".`);
      await open(rec.id);
    } catch (e) {
      toast.error(importErrorMessage(e, tr("dashboard.could_not_import_the_file")));
      setBusy(false);
    }
  }

  // Import a .hyc as a WORKSPACE template (same file format; templates are
  // design files), so templates travel between instances as plain files.
  const importTemplateRef = useRef<HTMLInputElement>(null);
  async function importHycTemplate(list: FileList | null) {
    const f = list?.[0];
    if (!f || !activeWorkspaceId || busy) return;
    setBusy(true);
    try {
      const file = parseHycFile(await readFileText(f));
      const title = importedTitle(file, f.name);
      await oc.saveAsTemplate({ workspaceId: activeWorkspaceId, file, title, visibility: "workspace" });
      // Refresh with the SAME scope the Templates view loads under (workspace +
      // active collection), so the new card appears without collapsing the
      // view's scoping to an unfiltered global list.
      setTemplates(
        await oc
          .listTemplates({ workspaceId: activeWorkspaceId, collection: tplCollection ?? undefined })
          .catch(() => templates),
      );
      toast.success(`Template "${title}" imported.`);
    } catch (e) {
      toast.error(importErrorMessage(e, tr("dashboard.could_not_import_the_template")));
    } finally {
      setBusy(false);
    }
  }

  // Download a template as a portable .hyc file.
  async function downloadTemplateHyc(t: TemplateSummary) {
    try {
      downloadHycFile(await oc.getTemplateFile(t.id), t.title);
    } catch {
      toast.error(tr("dashboard.could_not_download_the_template"));
    }
  }

  async function createDesign(width = 1080, height = 1080, label = tr("dashboard.untitled_design"), kind?: string) {
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
      toast.error(tr("dashboard.could_not_create_design"));
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
      toast.success(tr("dashboard.design_duplicated"));
    } catch {
      toast.error(tr("dashboard.could_not_duplicate_the_design"));
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
      toast.error(tr("dashboard.could_not_open_template"));
      setBusy(false);
    }
  }

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    gotoView("home"); // search always lands on the results in the home view
    setLoading(true);
    setItems(await load(query));
    setLoading(false);
  }

  async function confirmRename() {
    if (!renameTarget || !renameValue.trim()) return;
    await oc.renameDesign(renameTarget.id, renameValue.trim());
    setRenameTarget(null);
    toast.success(tr("dashboard.renamed"));
    setItems(await load(query));
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    await oc.deleteDesign(deleteTarget.id);
    setDeleteTarget(null);
    toast.success(tr("dashboard.moved_to_trash"));
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
        aria-label={tr("dashboard.sort_designs_by")}
        onChange={(e) => setSortBy(e.target.value as "recent" | "name")}
        className="h-8 rounded-lg border border-neutral-200 bg-surface px-2 text-xs text-neutral-600 outline-none focus:border-brand-400"
      >
        <option value="recent">{tr("dashboard.last_edited")}</option>
        <option value="name">{tr("dashboard.name_a_z")}</option>
      </select>
      <div className="flex overflow-hidden rounded-lg border border-neutral-200">
        <button onClick={() => setViewMode("grid")} title={tr("dashboard.grid_view")} className={`grid h-8 w-8 place-items-center ${viewMode === "grid" ? "bg-brand-50 text-brand-ink" : "text-neutral-500 hover:bg-neutral-100"}`}><LayoutGrid size={15} /></button>
        <button onClick={() => setViewMode("list")} title={tr("dashboard.list_view")} className={`grid h-8 w-8 place-items-center border-s border-neutral-200 ${viewMode === "list" ? "bg-brand-50 text-brand-ink" : "text-neutral-500 hover:bg-neutral-100"}`}><List size={15} /></button>
      </div>
    </div>
  );

  // One design's "more" menu (open/rename/delete), shared by card + row.
  const itemMenu = (item: HomeItem) => (
    <div className="relative">
      <IconButton size="sm" onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === item.id ? null : item.id); }} aria-label={tr("dashboard.more")}><MoreHorizontal size={16} /></IconButton>
      {menuFor === item.id && (
        <div className="absolute end-0 z-30 mt-1 w-36 overflow-hidden rounded-xl border border-neutral-200 bg-surface py-1 text-sm shadow-lg" onClick={(e) => e.stopPropagation()}>
          <MenuRow icon={ExternalLink} onClick={() => { setMenuFor(null); void open(item.id); }}>{tr("dashboard.open")}</MenuRow>
          <MenuRow icon={Copy} onClick={() => { setMenuFor(null); void duplicate(item); }}>{tr("dashboard.duplicate")}</MenuRow>
          <MenuRow icon={Pencil} onClick={() => { setMenuFor(null); setRenameTarget(item); setRenameValue(item.title); }}>{tr("dashboard.rename")}</MenuRow>
          <MenuRow icon={Trash2} danger onClick={() => { setMenuFor(null); setDeleteTarget(item); }}>{tr("dashboard.delete")}</MenuRow>
        </div>
      )}
    </div>
  );

  // A design as a grid card / a list row. Used across Home + Favorites.
  const renderCard = (item: HomeItem) => (
    <li key={item.id} className="group relative rounded-2xl border border-neutral-200 bg-surface shadow-sm transition hover:shadow-md">
      <button onClick={() => void open(item.id)} className="block aspect-[4/3] w-full overflow-hidden rounded-t-2xl" title={tr("dashboard.open")}><DesignThumb designId={item.id} /></button>
      <FavoriteButton starred={item.starred} onToggle={() => void toggleFavorite(item)} />
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-neutral-800">{item.title}</div>
          <div className="text-xs text-neutral-400">{df.date(item.updatedAt)}</div>
        </div>
        {itemMenu(item)}
      </div>
    </li>
  );

  const renderRow = (item: HomeItem) => (
    <li key={item.id} className="group flex items-center gap-3 border-b border-neutral-100 px-3 py-2 last:border-b-0 hover:bg-neutral-50">
      <button onClick={() => void open(item.id)} className="h-10 w-14 shrink-0 overflow-hidden rounded-md border border-neutral-200 bg-neutral-100" title={tr("dashboard.open")}><DesignThumb designId={item.id} /></button>
      <button onClick={() => void open(item.id)} className="min-w-0 flex-1 text-start">
        <div className="truncate text-sm font-semibold text-neutral-800">{item.title}</div>
        <div className="text-xs text-neutral-400">{df.date(item.updatedAt)}</div>
      </button>
      <button onClick={() => void toggleFavorite(item)} aria-label={item.starred ? tr("dashboard.unfavorite") : tr("dashboard.favorite")} className={`grid h-8 w-8 place-items-center rounded-lg transition ${item.starred ? "text-amber-400" : "text-neutral-400 opacity-0 hover:bg-neutral-100 group-hover:opacity-100"}`}><Star size={15} fill={item.starred ? "currentColor" : "none"} /></button>
      {itemMenu(item)}
    </li>
  );

  // Render a list of designs as the current grid/list view.
  const itemsList = (list: HomeItem[]) =>
    viewMode === "grid" ? (
      <ul className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{list.map(renderCard)}</ul>
    ) : (
      <ul className="rounded-2xl border border-neutral-200 bg-surface shadow-sm [&>li:first-child]:rounded-t-2xl [&>li:last-child]:rounded-b-2xl">{list.map(renderRow)}</ul>
    );

  return (
    <div className="flex h-screen overflow-hidden bg-neutral-50 text-neutral-900" onClick={() => setMenuFor(null)}>
      {/* Left rail: fixed to the viewport; only the main column scrolls.
          Collapsible to an icon-only strip (remembered in localStorage). */}
      <aside
        className={`oc-panel-dots relative flex shrink-0 flex-col overflow-y-auto border-e border-neutral-200 bg-surface transition-[width] duration-200 ${
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
              title={tr("dashboard.expand_sidebar")}
              aria-label={tr("dashboard.expand_sidebar")}
              className="mb-4 flex justify-center rounded-xl py-2 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
            >
              <PanelLeftOpen size={18} />
            </button>
            {/* Collapsed workspace chip: expanding is the way to switch. */}
            <button
              type="button"
              onClick={() => toggleRail(false)}
              title={workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? tr("dashboard.workspace")}
              aria-label={tr("dashboard.expand_sidebar_to_switch_workspace")}
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
                title={tr("dashboard.collapse_sidebar")}
                aria-label={tr("dashboard.collapse_sidebar")}
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
          <RailItem icon={HomeIcon} label={tr("dashboard.home")} active={view === "home"} collapsed={railCollapsed} onClick={() => gotoView("home")} />
          <RailItem icon={Star} label={tr("dashboard.favorites")} active={view === "favorites"} collapsed={railCollapsed} onClick={() => gotoView("favorites")} />
          <RailItem icon={CheckSquare} label={tr("dashboard.my_tasks")} active={view === "tasks"} collapsed={railCollapsed} onClick={() => gotoView("tasks")} />
          <RailItem icon={LayoutTemplate} label={tr("dashboard.templates")} active={view === "templates"} collapsed={railCollapsed} onClick={() => gotoView("templates")} />
          <RailItem icon={Users} label={tr("dashboard.members")} active={view === "members"} collapsed={railCollapsed} onClick={() => gotoView("members")} />
          <RailItem icon={Trash2} label={tr("dashboard.trash")} active={view === "trash"} collapsed={railCollapsed} onClick={() => gotoView("trash")} />
        </nav>

        {/* Storage meter pinned to the rail's bottom corner. */}
        {!railCollapsed && storageUsage && (
          <div className="relative z-10 mt-auto pt-4">
            <RailStorage usage={storageUsage} />
          </div>
        )}
        {!railCollapsed && <RailArt />}
      </aside>

      {/* Main */}
      <main className="oc-scroll flex-1 overflow-y-auto" style={DASH_BACKDROP}>
        {/* Header: global search, create, notifications, and the user menu. */}
        <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-neutral-200 bg-surface/90 px-6 py-2.5 backdrop-blur">
          <form onSubmit={onSearch} className="relative max-w-lg flex-1">
            <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tr("dashboard.search_designs_and_templates")}
              className="h-9 w-full rounded-xl border border-neutral-200 bg-neutral-50 ps-9 pe-3 text-sm outline-none transition focus:border-brand-400 focus:bg-surface focus:ring-2 focus:ring-brand-100"
            />
          </form>
          <div className="ms-auto flex items-center gap-2">
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
                  {tr("dashboard.let_s_make_something_today_start_from_a_blan")}
                </p>
                <div className="mt-5 flex flex-wrap gap-2.5">
                  <Button onClick={() => setSizeOpen(true)} disabled={busy || !activeWorkspaceId}>
                    <Plus size={16} /> {tr("dashboard.start_a_design")}
                  </Button>
                  <Button variant="secondary" onClick={() => gotoView("templates")}>
                    <LayoutTemplate size={16} /> {tr("dashboard.browse_templates")}
                  </Button>
                </div>
              </div>
            </section>
          )}

          {/* Create row: every format together in one wrap. */}
          <section className="mb-10">
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-neutral-400">{tr("dashboard.start_a_design")}</h2>
            <div className="flex flex-wrap gap-3">
              {[{ label: tr("dashboard.blank"), icon: Plus, w: 1080, h: 1080 } as Format, ...formatGroups().flatMap((g) => g.items)].map((f) => (
                <FormatTile key={f.label} f={f} disabled={busy} onClick={() => startFormat(f)} />
              ))}
              <FormatTile
                f={{ label: tr("dashboard.import_hyc_pptx"), icon: FileUp, w: 1080, h: 1080 } as Format}
                disabled={busy}
                onClick={() => importDesignRef.current?.click()}
              />
              <input
                ref={importDesignRef}
                type="file"
                accept={`${hycAccept},.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation`}
                hidden
                onChange={(e) => {
                  void importHycDesign(e.target.files);
                  e.target.value = ""; // allow re-picking the same file
                }}
              />
            </div>
          </section>

          {/* Recent / results */}
          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-bold uppercase tracking-wide text-neutral-400">
                {query.trim() ? tr("dashboard.search_results") : tr("dashboard.recent_designs")}
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
              <EmptyState message={query.trim() ? tr("dashboard.no_matching_designs") : tr("dashboard.no_designs_yet")}>
                {!query.trim() && (
                  <Button onClick={() => setSizeOpen(true)}>
                    <Plus size={18} /> {tr("dashboard.create_your_first_design")}
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
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-neutral-400">{tr("dashboard.start_from_a_template")}</h2>
              <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => void applyTemplate(t)}
                    disabled={busy}
                    title={tr("dashboard.use_this_template")}
                    className="group overflow-hidden rounded-2xl border border-neutral-200 bg-surface text-start shadow-sm transition hover:shadow-md disabled:opacity-60"
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
                <h2 className="text-sm font-bold uppercase tracking-wide text-neutral-400">{tr("dashboard.favorites")}</h2>
                {favorites.length > 0 && viewControls()}
              </div>
              {favorites.length === 0 ? (
                <EmptyState message={tr("dashboard.no_favorites_yet_tap_the_star_on_a_design_to")} />
              ) : (
                itemsList(sortedFavorites)
              )}
            </section>
          )}

          {view === "templates" && (
            <section>
              {/* Header row matches Favorites: title left, controls right. */}
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-bold uppercase tracking-wide text-neutral-400">{tr("dashboard.templates")}</h2>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => importTemplateRef.current?.click()} title={tr("dashboard.import_a_template_from_a_hyc_file")}>
                  <FileUp size={15} /> {tr("dashboard.import_template")}
                </Button>
                <input
                  ref={importTemplateRef}
                  type="file"
                  accept={hycAccept}
                  hidden
                  onChange={(e) => {
                    void importHycTemplate(e.target.files);
                    e.target.value = "";
                  }}
                />
                <span className="flex-1" />
                {collections.length > 0 && (
                  <select
                    value={tplCollection ?? ""}
                    aria-label={tr("dashboard.filter_by_collection")}
                    onChange={(e) => setTplCollection(e.target.value || null)}
                    className="h-8 rounded-lg border border-neutral-200 bg-surface px-2 text-xs text-neutral-600 outline-none focus:border-brand-400"
                  >
                    <option value="">{tr("dashboard.all_collections")}</option>
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
                    className={`rounded-lg border px-3 py-1 text-sm transition ${tplCategory === null ? "border-brand-200 bg-brand-50 text-brand-ink" : "border-neutral-200 bg-surface text-neutral-600 hover:bg-neutral-50"}`}
                  >
                    {tr("dashboard.all")}
                  </button>
                  {templateCategories.map((c) => (
                    <button
                      key={c}
                      onClick={() => setTplCategory(c)}
                      className={`rounded-lg border px-3 py-1 text-sm capitalize transition ${tplCategory === c ? "border-brand-200 bg-brand-50 text-brand-ink" : "border-neutral-200 bg-surface text-neutral-600 hover:bg-neutral-50"}`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              )}
              {filteredTemplates.length === 0 ? (
                <EmptyState message={tr("dashboard.no_templates_yet_open_a_design_and_use_save")} />
              ) : (
                <ul className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {filteredTemplates.map((t) => (
                    <li key={t.id} className="group relative rounded-2xl border border-neutral-200 bg-surface shadow-sm transition hover:shadow-md">
                      <button
                        onClick={() => void applyTemplate(t)}
                        disabled={busy}
                        title={tr("dashboard.use_this_template")}
                        className="block w-full text-start disabled:opacity-60"
                      >
                        <div className="aspect-[4/3] overflow-hidden rounded-t-2xl bg-neutral-100"><DesignThumb templateId={t.id} /></div>
                        <div className="truncate px-3 py-2.5 text-sm font-semibold text-neutral-800">{t.title}</div>
                      </button>
                      <button
                        onClick={() => void downloadTemplateHyc(t)}
                        title={tr("dashboard.download_as_hyc_file")}
                        aria-label={`Download "${t.title}" as .hyc file`}
                        className="absolute end-2 top-2 rounded-lg border border-neutral-200 bg-surface p-1.5 text-neutral-600 opacity-0 shadow-sm transition hover:text-brand-ink focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <FileDown size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {view === "trash" && (
            <section>
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-neutral-400">{tr("dashboard.trash")}</h2>
              {trash.length === 0 ? (
                <EmptyState message={tr("dashboard.trash_is_empty")} />
              ) : (
                <ul className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {trash.map((d) => (
                    <li key={d.id} className="overflow-hidden rounded-2xl border border-neutral-200 bg-surface shadow-sm">
                      <div className="aspect-[4/3] bg-neutral-100"><DesignThumb designId={d.id} trashed /></div>
                      <div className="px-3 py-2.5">
                        <div className="truncate text-sm font-semibold text-neutral-800">{d.title}</div>
                        <div className="mt-2 flex gap-2 text-xs">
                          <button onClick={() => void restoreFromTrash(d.id)} className="font-medium text-brand-ink hover:underline">{tr("dashboard.restore")}</button>
                          <button onClick={() => void deleteForever(d.id)} className="font-medium text-red-600 hover:underline">{tr("dashboard.delete_forever")}</button>
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
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-neutral-400">{tr("dashboard.my_tasks")}</h2>
              {tasks.length === 0 ? (
                <EmptyState message={tr("dashboard.no_tasks_assigned_to_you_comments_converted")} />
              ) : (
                <ul className="space-y-2">
                  {tasks.map((t) => {
                    const status = (t.task?.status ?? "open") as TaskStatus;
                    const label: Record<TaskStatus, string> = { open: tr("dashboard.open"), in_progress: tr("dashboard.in_progress"), done: tr("dashboard.done") };
                    const tone: Record<TaskStatus, string> = {
                      open: "bg-amber-50 text-amber-700",
                      in_progress: "bg-sky-50 text-sky-700",
                      done: "bg-emerald-50 text-emerald-700",
                    };
                    return (
                      <li key={t.id}>
                        <button
                          onClick={() => void open(t.designId)}
                          className="flex w-full items-center gap-3 rounded-xl border border-neutral-200 bg-surface px-4 py-3 text-start shadow-sm hover:border-brand-300 hover:bg-brand-50/40"
                        >
                          <CheckSquare size={18} className="shrink-0 text-brand-ink" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-neutral-800">{t.body}</span>
                            <span className="block truncate text-xs text-neutral-400">
                              {t.designTitle}
                              {t.task?.dueAt ? ` · due ${df.date(t.task.dueAt)}` : ""}
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
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-neutral-400">{tr("dashboard.members")}</h2>
              <MembersPanel
                workspaceId={activeWorkspaceId}
                workspaceName={activeWs?.name ?? "this workspace"}
                workspaceKind={activeWs?.kind ?? "personal"}
                myRole={(activeWs?.role ?? "viewer") as WorkspaceRole}
                myUserId={user?.id ?? ""}
                onExit={() => { gotoView("home"); void refreshWorkspaces(); }}
              />
            </section>
          )}
        </div>
      </main>

      {/* Modals */}

      <Modal open={sizeOpen} onClose={() => setSizeOpen(false)} title={tr("dashboard.create_a_design")} width="w-[34rem]">
        <div className="grid grid-cols-2 gap-2">
          {sizePresets().map((p) => {
            const box = 34;
            const ratio = p.w / p.h;
            const pw = ratio >= 1 ? box : Math.round(box * ratio);
            const ph = ratio >= 1 ? Math.round(box / ratio) : box;
            return (
              <button
                key={p.label}
                onClick={() => void createDesign(p.w, p.h, p.label)}
                className="flex items-center gap-3 rounded-lg border border-neutral-200 px-3 py-2.5 text-start transition-colors hover:border-brand-300 hover:bg-brand-50"
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
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">{tr("dashboard.custom_size_px")}</p>
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Input label={tr("dashboard.width")} type="number" className="w-full" value={customW} onChange={(e) => setCustomW(Math.max(1, Number(e.target.value) || 0))} />
            </div>
            <span className="pb-3 text-neutral-400">×</span>
            <div className="min-w-0 flex-1">
              <Input label={tr("dashboard.height")} type="number" className="w-full" value={customH} onChange={(e) => setCustomH(Math.max(1, Number(e.target.value) || 0))} />
            </div>
            <Button className="shrink-0" onClick={() => void createDesign(customW, customH, `Custom ${customW}×${customH}`)}>{tr("dashboard.create")}</Button>
          </div>
        </div>
      </Modal>

      <Modal open={!!renameTarget} onClose={() => setRenameTarget(null)} title={tr("dashboard.rename_design")}>
        <Input label={tr("dashboard.title")} value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRenameTarget(null)}>{tr("dashboard.cancel")}</Button>
          <Button onClick={() => void confirmRename()}>{tr("dashboard.save")}</Button>
        </div>
      </Modal>

      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title={tr("dashboard.move_to_trash")}>
        <p className="text-sm text-neutral-600">“{deleteTarget?.title}” will be moved to trash. You can restore it later.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleteTarget(null)}>{tr("dashboard.cancel")}</Button>
          <Button variant="danger" onClick={() => void confirmDelete()}>{tr("dashboard.move_to_trash_2")}</Button>
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

      <Modal open={wsModal} onClose={() => setWsModal(false)} title={tr("dashboard.create_a_workspace")}>
        <Input label={tr("dashboard.workspace_name")} value={wsName} onChange={(e) => setWsName(e.target.value)} placeholder={tr("dashboard.e_g_marketing_team")} autoFocus />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setWsModal(false)}>{tr("dashboard.cancel")}</Button>
          <Button onClick={() => void createWorkspace()}>{tr("dashboard.create")}</Button>
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
        collapsed ? "justify-center px-0 py-2.5" : "gap-3 px-3 py-2 text-start"
      } ${active ? "bg-brand-50 text-brand-ink" : "text-neutral-600 hover:bg-neutral-100"}`}
    >
      <Icon size={18} className="shrink-0" />
      {!collapsed && label}
    </button>
  );
}

// RailStorage is the bottom-of-sidebar storage meter: the workspace quota
// bar, plus the global account bar on instances that set a per-user limit.
function RailStorage({ usage }: { usage: StorageUsageView }) {
  const bar = (used: number, quota: number) => (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-500/15">
      <div
        className={`h-full rounded-full ${quota > 0 && used / quota >= 0.9 ? "bg-red-500" : "oc-gradient"}`}
        style={{ width: `${quota > 0 ? Math.min(100, (used / quota) * 100) : 0}%` }}
      />
    </div>
  );
  return (
    <div className="rounded-xl border border-white/60 bg-surface/40 p-3 shadow-[0_8px_24px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.7)] backdrop-blur-[6px] backdrop-saturate-150 dark:border-white/10 dark:shadow-[0_8px_24px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.08)]">
      <div className="mb-1 flex items-center justify-between text-[11px] text-neutral-600">
        <span className="font-medium">{tr("dashboard.workspace_storage")}</span>
        <span>{formatBytes(usage.usedBytes)}{usage.quotaBytes > 0 ? ` of ${formatBytes(usage.quotaBytes)}` : ""}</span>
      </div>
      {usage.quotaBytes > 0 && bar(usage.usedBytes, usage.quotaBytes)}
      {usage.userQuotaBytes > 0 && (
        <>
          <div className="mb-1 mt-2.5 flex items-center justify-between text-[11px] text-neutral-600">
            <span className="font-medium">{tr("dashboard.your_storage")}</span>
            <span>{formatBytes(usage.userUsedBytes)} of {formatBytes(usage.userQuotaBytes)}</span>
          </div>
          {bar(usage.userUsedBytes, usage.userQuotaBytes)}
        </>
      )}
    </div>
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
      aria-label={starred ? tr("dashboard.remove_from_favorites") : tr("dashboard.add_to_favorites")}
      aria-pressed={starred}
      title={starred ? tr("dashboard.remove_from_favorites") : tr("dashboard.add_to_favorites")}
      className={`absolute end-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-surface/90 shadow-sm backdrop-blur transition hover:bg-surface ${
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
    <button onClick={onClick} className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-start hover:bg-neutral-50 ${danger ? "text-red-600" : "text-neutral-700"}`}>
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
      title={f.label === "Blank" || f.label.startsWith("Import") ? f.label : `${f.label} · ${f.w}×${f.h}`}
    >
      <span className="relative grid h-[78px] w-full place-items-center rounded-xl border border-neutral-200 bg-surface shadow-sm transition group-hover:-translate-y-0.5 group-hover:border-brand-300 group-hover:shadow-md">
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
      <Button onClick={() => setOpen((o) => !o)} disabled={disabled}><Plus size={16} /> {tr("dashboard.create")}</Button>
      {open && (
        <div className="absolute end-0 z-40 mt-1.5 max-h-[72vh] w-64 overflow-y-auto rounded-xl border border-neutral-200 bg-surface p-1.5 shadow-xl ring-1 ring-black/5">
          <button onClick={() => { setOpen(false); onCustom(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-start text-sm font-medium text-neutral-700 hover:bg-neutral-100">
            <Plus size={16} className="text-brand-ink" /> {tr("dashboard.blank_custom_size")}
          </button>
          {formatGroups().map((g) => (
            <div key={g.title}>
              <div className="px-2.5 pb-0.5 pt-2 text-[10px] font-bold uppercase tracking-wide text-neutral-400">{g.title}</div>
              {g.items.map((f) => (
                <button key={f.label} onClick={() => { setOpen(false); onPick(f); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-start text-sm text-neutral-700 hover:bg-neutral-100">
                  <f.icon size={16} className="shrink-0 text-neutral-500" />
                  <span className="min-w-0 flex-1 truncate">{f.label}</span>
                  <span className="shrink-0 text-[11px] text-neutral-400">{f.w}×{f.h}</span>
                </button>
              ))}
            </div>
          ))}
          <div className="mt-1 border-t border-neutral-100 pt-1">
            <button onClick={() => { setOpen(false); onBulk(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-start text-sm text-neutral-700 hover:bg-neutral-100">
              <Layers size={16} className="text-neutral-500" /> {tr("dashboard.bulk_create")}
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
      <button onClick={() => setOpen((o) => !o)} aria-label={tr("dashboard.account")} className="oc-gradient grid h-8 w-8 place-items-center rounded-full text-sm font-bold text-white">
        {(user?.name || user?.email || "?").charAt(0).toUpperCase()}
      </button>
      {open && (
        <div className="absolute end-0 z-40 mt-1.5 w-56 rounded-xl border border-neutral-200 bg-surface p-1.5 shadow-xl ring-1 ring-black/5">
          <div className="px-2.5 py-1.5">
            {user?.name && <div className="truncate text-sm font-semibold text-neutral-800">{user.name}</div>}
            <div className="truncate text-xs text-neutral-500">{user?.email}</div>
          </div>
          <div className="my-1 border-t border-neutral-100" />
          <ThemeMenuItem />
          <button onClick={() => { setOpen(false); onSettings(); }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-sm text-neutral-700 hover:bg-neutral-100"><Settings size={15} className="text-neutral-400" /> {tr("dashboard.settings")}</button>
          <button onClick={() => { setOpen(false); onSignOut(); }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-sm text-neutral-700 hover:bg-neutral-100"><LogOut size={15} className="text-neutral-400" /> {tr("dashboard.sign_out")}</button>
        </div>
      )}
    </div>
  );
}

// Quick dark-mode toggle in the avatar menu; cycles the resolved look and
// stores it as an explicit preference (the full 3-way choice lives in
// Settings > Appearance).
function ThemeMenuItem() {
  const [dark, setDark] = useState(() => resolvedTheme() === "dark");
  return (
    <button
      onClick={() => {
        const next = dark ? "light" : "dark";
        setThemePreference(next);
        setDark(next === "dark");
      }}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-sm text-neutral-700 hover:bg-neutral-100"
    >
      {dark ? <Sun size={15} className="text-neutral-400" /> : <Moon size={15} className="text-neutral-400" />}
      {dark ? tr("dashboard.light_mode") : tr("dashboard.dark_mode")}
    </button>
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
        className="flex w-full items-center gap-2 rounded-xl border border-neutral-200 px-3 py-2 text-start text-sm hover:bg-neutral-50"
      >
        <span className="oc-gradient grid h-6 w-6 shrink-0 place-items-center rounded-md text-xs font-bold text-white">
          {(active?.name || "?").charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate font-semibold">{active?.name ?? tr("dashboard.workspace")}</span>
        <ChevronDown size={16} className="text-neutral-400" />
      </button>
      {open && (
        <div className="absolute start-0 end-0 z-20 mt-1 overflow-hidden rounded-xl border border-neutral-200 bg-surface py-1 shadow-lg" onClick={(e) => e.stopPropagation()}>
          {workspaces.map((w) => (
            <button
              key={w.id}
              onClick={() => { onSelect(w.id); setOpen(false); }}
              className={`block w-full truncate px-3 py-2 text-start text-sm hover:bg-neutral-50 ${w.id === activeId ? "font-semibold text-brand-ink" : "text-neutral-700"}`}
            >
              {w.name}
              {w.kind === "personal" ? " · personal" : ""}
            </button>
          ))}
          <button onClick={() => { onCreate(); setOpen(false); }} className="block w-full border-t border-neutral-100 px-3 py-2 text-start text-sm font-medium text-brand-ink hover:bg-neutral-50">
            + New workspace
          </button>
        </div>
      )}
    </div>
  );
}
