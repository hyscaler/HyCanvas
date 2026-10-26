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
  Sun, Sparkles, Wand2, Paperclip, Loader2, X, Palette, Menu } from "lucide-react";
import { createBlankDesign, type DesignFile } from "@hc/schema";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { hycAccept, downloadHycFile, importedTitle, parseHycFile, readFileText } from "@/lib/hycFile";
import { odpToDesign, pptxToDesign } from "@hc/export";
import { catalogEntryForMood, deckThemes, dialTones, layoutDeck, parseMarkdownOutline } from "@hc/aistudio";

// Markdown outline import (F28 C26): DETERMINISTIC, no AI - headings become
// slides, list items become points, laid out through the same pure deck
// builder generation uses (theme seeded from the title, no model calls).
function mdOutlineToDesign(md: string, fallbackTitle: string): DesignFile {
  const outline = parseMarkdownOutline(md, { fallbackTitle });
  if (!outline) throw new Error("no outline structure in the markdown (add headings or list items)");
  const size = { width: 1920, height: 1080 };
  const seed = Array.from(outline.title).reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);
  const theme = deckThemes({ count: 1, kicker: outline.title, seed })[0];
  const deck = layoutDeck(outline, theme, size, { catalog: catalogEntryForMood(outline.theme, seed), seed });
  const file = createBlankDesign({ title: outline.title, width: size.width, height: size.height });
  let pageSeq = 0;
  file.pages = deck.pages.map((p, i) => ({
    id: `md-page-${++pageSeq}`,
    name: p.name || `Page ${i + 1}`,
    width: size.width,
    height: size.height,
    background: p.background,
    children: p.nodes,
    ...(p.note ? { notes: p.note } : {}),
  })) as DesignFile["pages"];
  return file;
}
import { ApiError, type AiProviderPreset, type DesignRecord, type HomeItem, type MyTask, type StorageUsageView, type TaskStatus, type TemplateCollectionSummary, type TemplateSummary, type WorkspaceRole } from "@hc/sdk";
import { formatBytes } from "@/lib/format";
import { useDateFormat } from "@/lib/datetime";
import { resolvedTheme, setThemePreference } from "@/lib/theme";
import { oc } from "@/lib/sdk";
import { BrandsView } from "./brands/BrandsView";
import { useAuth } from "@/store/auth";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { Logo, LogoMark } from "@/components/ui/Logo";
import { Modal } from "@/components/ui/Modal";
import { PromptHost } from "@/components/ui/PromptHost";
import { Spinner } from "@/components/ui/Spinner";
import { dashboardPath, type DashboardView } from "./views";
import { DesignThumb } from "./DesignThumb";
import { BulkCreateModal } from "./BulkCreateModal";
import { MembersPanel } from "./MembersPanel";
import { ApiKeysPanel } from "./ApiKeysPanel";
import { WorkspaceAiPanel } from "./WorkspaceAiPanel";
import { TemplateFromPptxDialog } from "./TemplateFromPptxDialog";
import { VerifyEmailBanner } from "@/components/auth/VerifyEmailBanner";
import { NotificationsBell } from "@/components/notifications/NotificationsBell";
import { HeroArt, EmptyArt, RailArt } from "@/components/ui/CanvasBackdrop";
import { attachableAccept, extractAiSources, maxAiSources, type AiSource } from "@/lib/aiAttachments";
import { stageAiSources } from "@/lib/aiRequests";
import { tr, trOr } from "@/lib/i18n";
import { apiCodeMessage, userMessage } from "@/lib/errors";
import { matchParts, rankByTitle } from "@/lib/searchMatch";

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

/** The server's provider catalog, fetched once per page load: it is static per
 *  deployment, so switching workspace should not ask for it again. */
let aiPresetCache: AiProviderPreset[] | null = null;

/** `plain` tiles (Blank, Import) are actions, so their tooltip omits a size. */
type Format = { label: string; icon: typeof Plus; w: number; h: number; kind?: string; plain?: boolean };

/** Canvases the brief composer can generate for. Short on purpose: these are
 *  the shapes AI generation actually composes well for, and the full format
 *  shelf sits directly below for everything else. */
const briefFormats = (): Format[] => [
  { label: tr("dashboard.presentation_16_9"), icon: Plus, w: 1920, h: 1080 },
  { label: tr("dashboard.instagram_post_2"), icon: Plus, w: 1080, h: 1080 },
  { label: tr("dashboard.instagram_story_2"), icon: Plus, w: 1080, h: 1920 },
  { label: tr("dashboard.linkedin_post_2"), icon: Plus, w: 1200, h: 627 },
  { label: tr("dashboard.poster"), icon: Plus, w: 1080, h: 1350 },
  { label: tr("dashboard.a4_document"), icon: Plus, w: 1240, h: 1754 },
];

// The format shelf, grouped by what the design is for. A new format joins a
// group by adding one entry here; both the "Start a design" shelf and the
// Create menu render from this list.
const formatGroups = (): { title: string; items: Format[] }[] => [
  {
    title: tr("dashboard.social_media"),
    items: [
      { label: tr("dashboard.instagram_post_2"), icon: Instagram, w: 1080, h: 1080 },
      { label: tr("dashboard.instagram_story_2"), icon: Smartphone, w: 1080, h: 1920 },
      { label: tr("dashboard.facebook_post_2"), icon: Facebook, w: 1200, h: 630 },
      { label: tr("dashboard.linkedin_post_2"), icon: Linkedin, w: 1200, h: 627 },
      { label: tr("dashboard.youtube_thumbnail"), icon: Youtube, w: 1280, h: 720 },
    ],
  },
  {
    // Document types beyond static design (docs 28-32) carry a `kind`, written
    // to meta.kind at creation so the editor mounts the matching surface.
    title: tr("dashboard.documents_print"),
    items: [
      { label: tr("dashboard.poster"), icon: FileText, w: 1080, h: 1350 },
      { label: tr("dashboard.flyer"), icon: File, w: 816, h: 1056 },
      { label: tr("dashboard.business_card_2"), icon: CreditCard, w: 1050, h: 600 },
      { label: tr("dashboard.a4_document"), icon: BookOpen, w: 1240, h: 1754 },
      { label: tr("dashboard.doc"), icon: FileText, w: 816, h: 1056, kind: "doc" },
    ],
  },
  {
    title: tr("dashboard.presentations"),
    items: [{ label: tr("dashboard.presentation"), icon: Presentation, w: 1920, h: 1080 }],
  },
  {
    title: tr("dashboard.video"),
    items: [{ label: tr("dashboard.video"), icon: Film, w: 1920, h: 1080, kind: "video" }],
  },
  {
    title: tr("dashboard.web_digital"),
    items: [
      { label: tr("dashboard.banner"), icon: RectangleHorizontal, w: 1500, h: 500 },
      { label: tr("dashboard.desktop_wallpaper"), icon: Monitor, w: 1920, h: 1080 },
      { label: tr("dashboard.logo"), icon: ImageIcon, w: 500, h: 500 },
    ],
  },
  {
    title: tr("dashboard.workspace_productivity"),
    items: [
      { label: tr("dashboard.whiteboard"), icon: LayoutGrid, w: 1920, h: 1080, kind: "whiteboard" },
      { label: tr("dashboard.sheet"), icon: Table2, w: 1280, h: 800, kind: "sheet" },
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
  // The query the visible results answer: set on submit, so typing alone never
  // relabels the recents as results.
  const [searched, setSearched] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<HomeItem | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<HomeItem | null>(null);
  const [wsModal, setWsModal] = useState(false);
  const [sizeOpen, setSizeOpen] = useState(false);
  const [aiBrief, setAiBrief] = useState("");
  const [aiFormat, setAiFormat] = useState(() => briefFormats()[0].label);
  const [aiTone, setAiTone] = useState("auto");
  const [briefSources, setBriefSources] = useState<AiSource[]>([]);
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefDrop, setBriefDrop] = useState(false);
  // Stamped with the workspace it describes, so a switch invalidates it by
  // derivation rather than a reset written during render or in an effect body.
  // `personal` is set when the caller's own key serves this workspace (#47).
  const [aiState, setAiState] = useState<{ ws: string; connected: boolean; label: string; personal: boolean; personalAllowed: boolean } | null>(null);
  const aiReady = aiState && aiState.ws === activeWorkspaceId ? aiState : null;

  // Best-effort and non-blocking: nothing on this page waits for it, and a
  // failed lookup shows no hint rather than claiming AI is missing.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const ws = activeWorkspaceId;
    let cancelled = false;
    void Promise.all([
      oc.getAiEffective(ws).catch(() => null),
      aiPresetCache ? Promise.resolve(aiPresetCache) : oc.aiProviders().then((l) => { aiPresetCache = l ?? []; return aiPresetCache; }).catch(() => [] as AiProviderPreset[]),
    ]).then(([eff, presets]) => {
      if (cancelled || !eff) return;
      const cfg = eff.config ?? eff.imageConfig;
      setAiState({
        ws,
        connected: eff.source !== "none" && !!cfg?.hasKey,
        label: presets.find((pr) => pr.id === cfg?.provider)?.label ?? cfg?.provider ?? "",
        personal: eff.source === "personal",
        personalAllowed: eff.personalKeysAllowed,
      });
    });
    return () => { cancelled = true; };
  }, [activeWorkspaceId]);
  const briefFileRef = useRef<HTMLInputElement | null>(null);

  /** Read attached files into grounding text, using the same pipeline the
   *  editor's assistant uses, so both agree about what can be read and how a
   *  scanned PDF is refused. */
  async function attachBriefFiles(picked: File[]) {
    if (!picked.length) return;
    const room = maxAiSources - briefSources.length;
    if (room <= 0) {
      toast.error(tr("editor.attachment_limit_reached", { max: maxAiSources }));
      return;
    }
    setBriefBusy(true);
    try {
      const out = await extractAiSources(picked, room);
      if (out.rejected) toast.error(tr("dashboard.only_documents_can_be_attached"));
      for (const e of out.errors) toast.error(e);
      if (out.sources.length) setBriefSources((xs) => [...xs, ...out.sources].slice(0, maxAiSources));
    } finally {
      setBriefBusy(false);
    }
  }

  /** Create the design for the chosen canvas and hand the brief to the editor's
   *  assistant. The tone rides the same per-workspace store the editor's dials
   *  use, so a choice made here is the choice the generation runs with. */
  function submitBrief() {
    const brief = aiBrief.trim();
    if (!brief || busy || !activeWorkspaceId) return;
    const fmt = briefFormats().find((f) => f.label === aiFormat) ?? briefFormats()[0];
    try {
      const key = `oc-ai-dials:${activeWorkspaceId}`;
      const saved = JSON.parse(window.localStorage.getItem(key) ?? "{}") as Record<string, string>;
      if (aiTone === "auto") delete saved.tone;
      else saved.tone = aiTone;
      window.localStorage.setItem(key, JSON.stringify(saved));
    } catch {
      /* private mode: the generation simply runs without the tone */
    }
    // Extracted text travels through the request channel, not the URL: one
    // document dwarfs any sane query string.
    stageAiSources(briefSources);
    // Created untitled on purpose: the generation names it from the outline it
    // produces, which reads far better than the raw prompt.
    void createDesign(fmt.w, fmt.h, undefined, fmt.kind, brief);
  }
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
  // Below Tailwind `md` the rail would leave the page no room, so it becomes an
  // off-canvas drawer opened from the header. The drawer always shows the full
  // rail; the remembered icon-only collapse applies to wider screens only.
  const isNarrow = useMediaQuery("(max-width: 767px)");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const railIcons = railCollapsed && !isNarrow;
  const navTo = (v: DashboardView) => {
    setDrawerOpen(false);
    gotoView(v);
  };
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawerOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);
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
  const [pptxTemplateOpen, setPptxTemplateOpen] = useState(false); // F40 E13
  const [tplRefresh, setTplRefresh] = useState(0); // bump to re-fetch the template shelf
  const [collections, setCollections] = useState<TemplateCollectionSummary[]>([]);

  const load = useCallback(async (q: string) => {
    if (!activeWorkspaceId) return [] as HomeItem[];
    return q.trim() ? oc.search(activeWorkspaceId, q.trim()) : oc.home(activeWorkspaceId, "recent");
  }, [activeWorkspaceId]);

  // A default brand kit that restricts templates keeps everyone but a brand
  // manager (owner or admin) on the workspace's own gallery; the built-ins
  // and other workspaces' templates are off-brand by definition.
  const activeRole = workspaces.find((w) => w.id === activeWorkspaceId)?.role;
  useEffect(() => {
    if (!activeWorkspaceId) return;
    let cancelled = false;
    void (async () => {
      const manages = activeRole === "owner" || activeRole === "admin";
      const restricted = manages
        ? false
        : await oc
            .listBrandKits(activeWorkspaceId)
            .then((kits) => !!(kits.find((k) => k.isDefault) ?? kits[0])?.controls.restrictTemplates)
            .catch(() => false);
      const [recent, tpls] = await Promise.all([
        oc.home(activeWorkspaceId, "recent"),
        oc.listTemplates(restricted ? { workspaceId: activeWorkspaceId } : undefined).catch(() => []),
      ]);
      if (cancelled) return;
      setItems(recent);
      setTemplates(tpls);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, activeRole]);

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
  }, [view, activeWorkspaceId, tplCollection, tplRefresh]);

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
  // Results keep the server's best-match order; only recents are re-sorted.
  const sortedItems = searched ? items : [...items].sort(bySort);
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
  // Templates are searched by title on the client (the shelf is already loaded).
  const matchingTemplates = searched ? rankByTitle(templates, searched) : [];
  const resultCount = items.length + matchingTemplates.length;
  const firstName = user?.name?.trim().split(/\s+/)[0] || user?.email?.split("@")[0] || "there";

  const open = (id: string, brief?: string) =>
    router.push({ pathname: "/editor", query: brief ? { id, ai: brief } : { id } });

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
      const isOdp = /\.odp$/i.test(f.name) || f.type === "application/vnd.oasis.opendocument.presentation";
      const isMd = /\.(md|markdown)$/i.test(f.name);
      const file = isPptx
        ? await pptxToDesign(new Uint8Array(await f.arrayBuffer()), { title: f.name.replace(/\.pptx$/i, "") })
        : isOdp
          ? await odpToDesign(new Uint8Array(await f.arrayBuffer()), { title: f.name.replace(/\.odp$/i, "") })
          : isMd
            ? mdOutlineToDesign(await readFileText(f), f.name.replace(/\.(md|markdown)$/i, ""))
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

  async function createDesign(width = 1080, height = 1080, label = tr("dashboard.untitled_design"), kind?: string, brief?: string) {
    if (!activeWorkspaceId) return;
    setSizeOpen(false);
    setBusy(true);
    try {
      const from = createBlankDesign({ title: label, width, height });
      // Document types (docs 28-32) carry their surface marker in meta.kind; a
      // plain design leaves it unset (treated as "design").
      if (kind) from.meta.kind = kind;
      const rec = await oc.createDesign({ workspaceId: activeWorkspaceId, title: label, from });
      await open(rec.id, brief);
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
      setItems(await load(searched));
      toast.success(tr("dashboard.design_duplicated"));
    } catch {
      toast.error(tr("dashboard.could_not_duplicate_the_design"));
    } finally {
      setBusy(false);
    }
  }

  function startFormat(f: Format) {
    void createDesign(f.w, f.h, f.label, f.kind);
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

  async function runSearch(q: string) {
    setSearched(q.trim());
    setLoading(true);
    setItems(await load(q));
    setLoading(false);
  }

  function onSearch(e: FormEvent) {
    e.preventDefault();
    gotoView("home"); // search always lands on the results in the home view
    void runSearch(query);
  }

  function clearSearch() {
    setQuery("");
    if (searched) void runSearch("");
  }

  async function confirmRename() {
    if (!renameTarget || !renameValue.trim()) return;
    await oc.renameDesign(renameTarget.id, renameValue.trim());
    setRenameTarget(null);
    toast.success(tr("dashboard.renamed"));
    setItems(await load(searched));
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    await oc.deleteDesign(deleteTarget.id);
    setDeleteTarget(null);
    toast.success(tr("dashboard.moved_to_trash"));
    setItems(await load(searched));
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
  const viewControls = (sortable = true) => (
    <div className="flex items-center gap-2">
      {sortable && <select
        value={sortBy}
        aria-label={tr("dashboard.sort_designs_by")}
        onChange={(e) => setSortBy(e.target.value as "recent" | "name")}
        className="h-8 rounded-lg border border-neutral-200 bg-surface px-2 text-xs text-neutral-600 outline-none focus:border-brand-400"
      >
        <option value="recent">{tr("dashboard.last_edited")}</option>
        <option value="name">{tr("dashboard.name_a_z")}</option>
      </select>}
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
          <div className="truncate text-sm font-semibold text-neutral-800"><Highlight text={item.title} q={searched} /></div>
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
        <div className="truncate text-sm font-semibold text-neutral-800"><Highlight text={item.title} q={searched} /></div>
        <div className="text-xs text-neutral-400">{df.date(item.updatedAt)}</div>
      </button>
      <button onClick={() => void toggleFavorite(item)} aria-label={item.starred ? tr("dashboard.unfavorite") : tr("dashboard.favorite")} className={`grid h-8 w-8 place-items-center rounded-lg transition ${item.starred ? "text-amber-400" : "text-neutral-400 opacity-0 hover:bg-neutral-100 group-hover:opacity-100"}`}><Star size={15} fill={item.starred ? "currentColor" : "none"} /></button>
      {itemMenu(item)}
    </li>
  );

  // A template card: the teaser shelf and template search results share it.
  const renderTemplate = (t: TemplateSummary) => (
    <button
      key={t.id}
      onClick={() => void applyTemplate(t)}
      disabled={busy}
      title={tr("dashboard.use_this_template")}
      className="group overflow-hidden rounded-2xl border border-neutral-200 bg-surface text-start shadow-sm transition hover:shadow-md disabled:opacity-60"
    >
      <div className="relative aspect-[4/3] bg-neutral-100">
        <DesignThumb templateId={t.id} />
        {(t.pageCount ?? 0) > 1 && (
          <span className="absolute bottom-2 start-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white/90">{tr("dashboard.n_slides", { count: t.pageCount })}</span>
        )}
      </div>
      <div className="truncate px-3 py-2.5 text-sm font-semibold text-neutral-800"><Highlight text={t.title} q={searched} /></div>
    </button>
  );

  // Render a list of designs as the current grid/list view.
  const itemsList = (list: HomeItem[]) =>
    viewMode === "grid" ? (
      <ul className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{list.map(renderCard)}</ul>
    ) : (
      <ul className="rounded-2xl border border-neutral-200 bg-surface shadow-sm [&>li:first-child]:rounded-t-2xl [&>li:last-child]:rounded-b-2xl">{list.map(renderRow)}</ul>
    );

  return (
    <div className="flex h-dvh overflow-hidden bg-neutral-50 text-neutral-900" onClick={() => setMenuFor(null)}>
      {/* Left rail: fixed to the viewport; only the main column scrolls.
          Collapsible to an icon-only strip (remembered in localStorage). */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 bg-black/30 md:hidden" aria-hidden onClick={() => setDrawerOpen(false)} />
      )}
      <aside
        className={`oc-panel-dots relative flex shrink-0 flex-col overflow-y-auto border-e border-neutral-200 bg-surface transition-[width,translate] duration-200 max-md:fixed max-md:inset-y-0 max-md:start-0 max-md:z-50 max-md:w-[min(20rem,85vw)] max-md:shadow-xl ${
          railIcons ? "w-[4.5rem] p-3" : "w-80 p-4"
        } ${drawerOpen ? "" : "max-md:invisible max-md:-translate-x-full max-md:rtl:translate-x-full"}`}
      >
        {railIcons ? (
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
                onClick={() => (isNarrow ? setDrawerOpen(false) : toggleRail(true))}
                title={isNarrow ? tr("ui.close") : tr("dashboard.collapse_sidebar")}
                aria-label={isNarrow ? tr("ui.close") : tr("dashboard.collapse_sidebar")}
                className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
              >
                {isNarrow ? <X size={18} /> : <PanelLeftClose size={18} />}
              </button>
            </div>

            <WorkspaceSwitcher
              workspaces={workspaces}
              activeId={activeWorkspaceId}
              onSelect={(id) => {
                setDrawerOpen(false);
                setActiveWorkspace(id);
              }}
              onCreate={() => setWsModal(true)}
            />
          </>
        )}

        <nav className="mt-5 flex flex-col gap-1 text-sm">
          <RailItem icon={HomeIcon} label={tr("dashboard.home")} active={view === "home"} collapsed={railIcons} onClick={() => navTo("home")} />
          <RailItem icon={Star} label={tr("dashboard.favorites")} active={view === "favorites"} collapsed={railIcons} onClick={() => navTo("favorites")} />
          <RailItem icon={CheckSquare} label={tr("dashboard.my_tasks")} active={view === "tasks"} collapsed={railIcons} onClick={() => navTo("tasks")} />
          <RailItem icon={LayoutTemplate} label={tr("dashboard.templates")} active={view === "templates"} collapsed={railIcons} onClick={() => navTo("templates")} />
          <RailItem icon={Palette} label={tr("dashboard.brand_kits")} active={view === "brands"} collapsed={railIcons} onClick={() => navTo("brands")} />
          <RailItem icon={Users} label={tr("dashboard.members")} active={view === "members"} collapsed={railIcons} onClick={() => navTo("members")} />
          <RailItem icon={Trash2} label={tr("dashboard.trash")} active={view === "trash"} collapsed={railIcons} onClick={() => navTo("trash")} />
        </nav>

        {/* Storage meter pinned to the rail's bottom corner. */}
        {!railIcons && storageUsage && (
          <div className="relative z-10 mt-auto pt-4">
            <RailStorage usage={storageUsage} />
          </div>
        )}
        {!railIcons && <RailArt />}
      </aside>

      {/* Main */}
      <main className="oc-scroll flex-1 overflow-y-auto" style={DASH_BACKDROP}>
        {/* Header: global search, create, notifications, and the user menu. */}
        <div className="sticky top-0 z-30 flex items-center gap-2 border-b border-neutral-200 bg-surface/90 px-4 py-2.5 backdrop-blur sm:gap-3 md:px-6">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label={tr("dashboard.open_navigation")}
            title={tr("dashboard.open_navigation")}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-neutral-600 hover:bg-neutral-100 md:hidden"
          >
            <Menu size={18} />
          </button>
          <form onSubmit={onSearch} className="relative min-w-0 max-w-lg flex-1">
            <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              value={query}
              onChange={(e) => (e.target.value.trim() ? setQuery(e.target.value) : clearSearch())}
              onKeyDown={(e) => { if (e.key === "Escape" && query) clearSearch(); }}
              type="search"
              aria-label={tr("dashboard.search_designs_and_templates")}
              placeholder={tr("dashboard.search_designs_and_templates")}
              className="h-9 w-full rounded-xl border border-neutral-200 bg-neutral-50 ps-9 pe-9 text-sm [&::-webkit-search-cancel-button]:hidden outline-none transition focus:border-brand-400 focus:bg-surface focus:ring-2 focus:ring-brand-100"
            />
            {query && (
              <button
                type="button"
                onClick={clearSearch}
                aria-label={tr("dashboard.clear_search")}
                title={tr("dashboard.clear_search")}
                className="absolute end-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
              >
                <X size={14} />
              </button>
            )}
          </form>
          <div className="ms-auto flex shrink-0 items-center gap-2">
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
        <div className="mx-auto max-w-[1600px] px-4 py-6 md:px-6 md:py-8">
          {view === "home" && (
          <>
          <VerifyEmailBanner />

          {/* Flat hero: greeting + workspace + CTAs sit directly on the page's
              ambient texture (no card frame), with the shared art floating right. */}
          {!searched && (
            <section className="relative mb-9 min-h-[8rem]">
              <HeroArt />
              <div className="relative mx-auto max-w-3xl text-center">
                <h1 className="text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">
                  {greetByHour()}, {firstName} <span className="inline-block">👋</span>
                </h1>
                <p className="mx-auto mt-2 max-w-xl text-sm text-neutral-500">
                  {tr("dashboard.let_s_make_something_today_start_from_a_blan")}
                </p>
                {/* The headline capability used to require: make a blank
                    deck, open the editor, notice the fourth of nine rail
                    icons, then connect a provider. Describing it here creates
                    the design and starts the generation. The controls under
                    the brief are the two that actually change the output -
                    the canvas it composes for, and the voice it writes in -
                    rather than decoration. */}
                <form
                  className={`relative mt-6 rounded-2xl border bg-surface p-3 text-start shadow-sm transition focus-within:ring-4 focus-within:ring-brand-50 ${
                    briefDrop ? "border-brand-400 ring-4 ring-brand-50" : "border-neutral-200 focus-within:border-brand-400"
                  }`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitBrief();
                  }}
                  onDragOver={(e) => {
                    // Dragging a document onto the brief is the same gesture the
                    // editor's assistant accepts; the dashboard had no drop
                    // target at all, so nothing else competes for it here.
                    if (!e.dataTransfer.types.includes("Files") || briefBusy) return;
                    e.preventDefault();
                    setBriefDrop(true);
                  }}
                  onDragLeave={(e) => {
                    // Ignore the dragleave fired by crossing this form's own
                    // children, or the hint flickers over every nested control.
                    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                    setBriefDrop(false);
                  }}
                  onDrop={(e) => {
                    if (!e.dataTransfer.types.includes("Files")) return;
                    e.preventDefault();
                    setBriefDrop(false);
                    void attachBriefFiles(Array.from(e.dataTransfer.files ?? []));
                  }}
                >
                  {briefDrop && (
                    <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl border-2 border-dashed border-brand-400 bg-brand-50/90">
                      <span className="flex items-center gap-1.5 text-xs font-medium text-brand-ink">
                        <Paperclip size={13} /> {tr("dashboard.drop_documents_to_build_from")}
                      </span>
                    </div>
                  )}
                  <textarea
                    value={aiBrief}
                    onChange={(e) => setAiBrief(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter sends, Shift+Enter breaks the line - the same
                      // contract as the editor's composer. IME composition is
                      // excluded, or the first Enter of a conversion submits.
                      if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
                      e.preventDefault();
                      submitBrief();
                    }}
                    rows={1}
                    onInput={(e) => {
                      const el = e.currentTarget;
                      el.style.height = "auto";
                      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                    }}
                    placeholder={tr("dashboard.describe_a_deck_to_generate")}
                    aria-label={tr("dashboard.describe_a_deck_to_generate")}
                    disabled={busy || !activeWorkspaceId}
                    className="w-full resize-none bg-transparent px-1.5 py-1 text-[15px] leading-relaxed outline-none placeholder:text-neutral-400 disabled:opacity-50"
                  />
                  {/* Attached sources: the documents the design should be
                      built FROM. Extraction runs here so the editor receives
                      text, not files, and so an unreadable file is reported
                      before the user has navigated away from it. */}
                  {briefSources.length > 0 && (
                    <ul className="mb-1 flex flex-wrap gap-1.5 px-1.5">
                      {briefSources.map((sc, i) => (
                        <li key={`${sc.name}-${i}`} className="flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[11px] text-brand-ink">
                          <FileText size={11} className="shrink-0" />
                          <span className="max-w-[10rem] truncate" title={sc.name}>{sc.name}</span>
                          <button
                            type="button"
                            onClick={() => setBriefSources((xs) => xs.filter((_, j) => j !== i))}
                            aria-label={tr("editor.remove_attached_content")}
                            className="rounded-full p-0.5 hover:bg-brand-100"
                          >
                            <X size={11} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => briefFileRef.current?.click()}
                      disabled={busy || briefBusy || !activeWorkspaceId || briefSources.length >= maxAiSources}
                      title={tr("dashboard.attach_documents_to_build_from")}
                      aria-label={tr("dashboard.attach_documents_to_build_from")}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-neutral-200 text-neutral-500 transition hover:border-neutral-300 hover:text-neutral-700 disabled:opacity-40"
                    >
                      {briefBusy ? <Loader2 size={15} className="animate-spin" /> : <Paperclip size={15} />}
                    </button>
                    <input
                      ref={briefFileRef}
                      type="file"
                      multiple
                      accept={attachableAccept}
                      hidden
                      onChange={(e) => {
                        void attachBriefFiles(Array.from(e.target.files ?? []));
                        e.target.value = "";
                      }}
                    />
                    <label className="flex items-center gap-1.5 rounded-full border border-neutral-200 py-1.5 ps-3 pe-1.5 text-[13px] text-neutral-700 transition hover:border-neutral-300 focus-within:border-brand-400">
                      <LayoutTemplate size={13} className="shrink-0 text-neutral-400" />
                      <span className="sr-only">{tr("dashboard.output_format")}</span>
                      <select
                        value={aiFormat}
                        onChange={(e) => setAiFormat(e.target.value)}
                        disabled={busy || !activeWorkspaceId}
                        className="max-w-[9rem] cursor-pointer truncate bg-transparent pe-1 outline-none"
                      >
                        {briefFormats().map((f) => (
                          <option key={f.label} value={f.label}>{f.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="flex items-center gap-1.5 rounded-full border border-neutral-200 py-1.5 ps-3 pe-1.5 text-[13px] text-neutral-700 transition hover:border-neutral-300 focus-within:border-brand-400">
                      <Wand2 size={13} className="shrink-0 text-neutral-400" />
                      <span className="sr-only">{tr("dashboard.tone")}</span>
                      <select
                        value={aiTone}
                        onChange={(e) => setAiTone(e.target.value)}
                        disabled={busy || !activeWorkspaceId}
                        className="max-w-[8rem] cursor-pointer truncate bg-transparent pe-1 outline-none"
                      >
                        {dialTones.map((t) => (
                          <option key={t} value={t}>{trOr(`editor.dial_${t}`, t)}</option>
                        ))}
                      </select>
                    </label>
                    <span className="flex-1" />
                    {aiReady && (aiReady.connected ? (
                      <span
                        className="hidden items-center gap-1.5 text-[11px] text-neutral-500 sm:flex"
                        title={aiReady.personal ? tr("dashboard.generates_with_your_provider", { provider: aiReady.label }) : tr("dashboard.this_workspace_generates_with_provider", { provider: aiReady.label })}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        {aiReady.personal ? tr("dashboard.your_provider_label", { provider: aiReady.label }) : aiReady.label}
                      </span>
                    ) : (
                      // Not a blocker: the brief is held through provider setup
                      // and generation resumes once a key exists. Saying so here
                      // just saves the detour of finding that out in the editor.
                      <button
                        type="button"
                        onClick={() => gotoView("members")}
                        className="flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] text-amber-800 transition hover:border-amber-400"
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                        {tr("dashboard.connect_an_ai_provider_first")}
                      </button>
                    ))}
                    {aiReady && !aiReady.connected && aiReady.personalAllowed && (
                      <button type="button" onClick={() => void router.push("/settings/ai/")} className="hidden text-[11px] font-medium text-brand-ink hover:underline sm:inline">
                        {tr("dashboard.or_use_your_own_key")}
                      </button>
                    )}
                    <button
                      type="submit"
                      disabled={busy || !activeWorkspaceId || !aiBrief.trim()}
                      className="flex items-center gap-1.5 rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:hover:bg-neutral-200"
                    >
                      <Sparkles size={15} /> {tr("dashboard.generate")}
                    </button>
                  </div>
                </form>
              </div>
            </section>
          )}

          {/* Create row: every format, grouped by what the design is for.
              Hidden while searching so the results lead the page. */}
          {!searched && (
          <section className="mb-10">
            <div className="mb-3 flex items-center gap-3">
              <h2 className="text-sm font-bold uppercase tracking-wide text-neutral-400">{tr("dashboard.start_a_design")}</h2>
              <span className="flex-1" />
              <button
                onClick={() => setSizeOpen(true)}
                disabled={busy || !activeWorkspaceId}
                className="flex items-center gap-1.5 rounded-full border border-neutral-200 bg-surface px-3 py-1.5 text-xs font-medium text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-800 disabled:opacity-40"
              >
                <Plus size={14} /> {tr("dashboard.blank_custom_size")}
              </button>
            </div>
            {/* Groups wrap side by side, so a one-tile group (Video) shares a
                row instead of leaving an empty band. */}
            <div className="flex flex-wrap gap-x-10 gap-y-6">
              {formatGroups().map((g, gi) => (
                <div key={g.title} role="group" aria-labelledby={`fmt-group-${gi}`}>
                  <h3 id={`fmt-group-${gi}`} className="mb-2 text-xs font-semibold text-neutral-500">{g.title}</h3>
                  <div className="flex flex-wrap gap-3">
                    {g.items.map((f) => (
                      <FormatTile key={f.label} f={f} disabled={busy} onClick={() => startFormat(f)} />
                    ))}
                  </div>
                </div>
              ))}
              <div role="group" aria-labelledby="fmt-import-custom">
                <h3 id="fmt-import-custom" className="mb-2 text-xs font-semibold text-neutral-500">{tr("dashboard.import_custom")}</h3>
                <div className="flex flex-wrap gap-3">
                  {/* Blank opens the size picker rather than guessing a canvas. */}
                  <FormatTile f={{ label: tr("dashboard.blank"), icon: Plus, w: 1080, h: 1080, plain: true }} disabled={busy} onClick={() => setSizeOpen(true)} />
                  <FormatTile
                    f={{ label: tr("dashboard.import_hyc_pptx"), icon: FileUp, w: 1080, h: 1080, plain: true }}
                    disabled={busy}
                    onClick={() => importDesignRef.current?.click()}
                  />
                </div>
              </div>
              <input
                ref={importDesignRef}
                type="file"
                accept={`${hycAccept},.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation,.odp,application/vnd.oasis.opendocument.presentation,.md,.markdown,text/markdown`}
                hidden
                onChange={(e) => {
                  void importHycDesign(e.target.files);
                  e.target.value = ""; // allow re-picking the same file
                }}
              />
            </div>
          </section>
          )}

          {/* Recent / results */}
          <section>
            {searched ? (
              <div className="mb-4 flex flex-wrap items-center gap-3 border-b border-neutral-200 pb-3">
                <h2 className="text-lg font-semibold text-neutral-800">{tr("dashboard.results_for", { q: searched })}</h2>
                {!loading && <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">{tr("dashboard.n_matches", { count: resultCount })}</span>}
                <button type="button" onClick={clearSearch} className="text-xs font-medium text-brand-ink hover:underline">{tr("dashboard.clear_search")}</button>
                <span className="flex-1" />
                {items.length > 0 && viewControls(false)}
              </div>
            ) : (
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-bold uppercase tracking-wide text-neutral-400">{tr("dashboard.recent_designs")}</h2>
                {items.length > 0 && viewControls()}
              </div>
            )}
            {searched && items.length > 0 && matchingTemplates.length > 0 && (
              <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-neutral-400">{tr("dashboard.designs")}</h3>
            )}
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
            ) : searched && resultCount === 0 ? (
              <EmptyState message={tr("dashboard.no_results_for", { q: searched })}>
                <p className="-mt-2 max-w-sm text-xs text-neutral-400">{tr("dashboard.no_results_hint")}</p>
                <Button variant="secondary" onClick={clearSearch}>{tr("dashboard.clear_search")}</Button>
              </EmptyState>
            ) : items.length === 0 ? (
              !searched && (
                <EmptyState message={tr("dashboard.no_designs_yet")}>
                  <Button onClick={() => setSizeOpen(true)}>
                    <Plus size={18} /> {tr("dashboard.create_your_first_design")}
                  </Button>
                </EmptyState>
              )
            ) : (
              itemsList(visibleItems)
            )}
          </section>

          {/* Templates whose title matches the search. */}
          {searched && !loading && matchingTemplates.length > 0 && (
            <section className={items.length > 0 ? "mt-10" : ""}>
              <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-neutral-400">{tr("dashboard.templates")}</h3>
              <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{matchingTemplates.map(renderTemplate)}</div>
            </section>
          )}

          {/* Templates teaser (below recents) */}
          {templates.length > 0 && !searched && (
            <section className="mt-10">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-neutral-400">{tr("dashboard.start_from_a_template")}</h2>
              <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {templates.map(renderTemplate)}
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
                <Button variant="secondary" size="sm" onClick={() => setPptxTemplateOpen(true)} title={tr("dashboard.build_a_template_from_a_powerpoint_file")}>
                  <FileUp size={15} /> {tr("dashboard.template_from_powerpoint")}
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
                        <div className="relative aspect-[4/3] overflow-hidden rounded-t-2xl bg-neutral-100">
                          <DesignThumb templateId={t.id} />
                          {(t.pageCount ?? 0) > 1 && (
                            <span className="absolute bottom-2 start-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white/90">{tr("dashboard.n_slides", { count: t.pageCount })}</span>
                          )}
                        </div>
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

          {view === "brands" && activeWorkspaceId && (
            <BrandsView
              key={activeWorkspaceId}
              workspaceId={activeWorkspaceId}
              canManage={activeWs?.role === "owner" || activeWs?.role === "admin"}
            />
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
              {/* F40: API keys live on the workspace administration surface,
                  admin-gated like the mint endpoint itself. */}
              {/* AI first: nearly every workspace connects a provider, while
                  few mint developer keys. The two are opposite directions -
                  this one is the key HyCanvas uses to call a model, the one
                  below is how other systems call HyCanvas - and the headings
                  say so, because "API keys" and "AI" read alike at a glance.
                  Every member can SEE what is connected (they are the ones it
                  generates for); only an admin can change it, matching the
                  server's own viewer-to-read, admin-to-write split. */}
              <WorkspaceAiPanel
                workspaceId={activeWorkspaceId}
                canEdit={activeWs?.role === "owner" || activeWs?.role === "admin"}
              />
              {activeWorkspaceId && (activeWs?.role === "owner" || activeWs?.role === "admin") && (
                <ApiKeysPanel workspaceId={activeWorkspaceId} />
              )}
            </section>
          )}
        </div>
      </main>
      {/* F40 E13: the PPTX-to-template builder. onSaved re-fetches the shelf
          by nudging the collection filter effect. */}
      {pptxTemplateOpen && (
        <TemplateFromPptxDialog
          open={pptxTemplateOpen}
          onClose={() => setPptxTemplateOpen(false)}
          workspaceId={activeWorkspaceId}
          onSaved={() => setTplRefresh((n) => n + 1)}
        />
      )}

      {/* Modals */}

      {/* The imperative dialog host: mounted in the editor from the start but
          never here, so a confirm raised from a dashboard panel had nothing to
          render it and would have waited forever. */}
      <PromptHost />
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
/** A title with every occurrence of the search query marked. */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  return (
    <>
      {matchParts(text, q).map((p, i) =>
        p.match ? <mark key={i} className="rounded-sm bg-brand-100 px-0.5 text-brand-ink">{p.text}</mark> : <span key={i}>{p.text}</span>,
      )}
    </>
  );
}

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
      title={f.plain ? f.label : `${f.label} · ${f.w}×${f.h}`}
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
      <Button onClick={() => setOpen((o) => !o)} disabled={disabled}><Plus size={16} /> <span className="max-sm:sr-only">{tr("dashboard.create")}</span></Button>
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
