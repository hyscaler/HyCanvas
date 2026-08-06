// F30 Whiteboard editing surface. The board IS the active design page:
// its nodes are stickies/frames/connectors/text/shapes, so we render the proven
// design canvas (<Canvas/>, which already does pan/zoom/marquee/move and whose
// engine renders the "sticky" node type) and float whiteboard chrome over it.
//
// Scene mutations go through the editor store (@hc/editor commands, undoable).
// Diagramming intelligence (auto-layout) and facilitation accounting (timer +
// dot voting) come from the pure @hc/whiteboard package; facilitation state is
// persisted under doc.meta.whiteboard as a WhiteboardMeta. Tailwind is used for
// chrome only; the design surface itself is rendered by @hc/engine.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  Brush,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Copy,
  CornerDownRight,
  Crown,
  Eraser,
  EyeOff,
  GripVertical,
  Highlighter,
  LayoutGrid,
  LayoutTemplate,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  Minus,
  Network,
  Pause,
  Pen,
  Play,
  Pointer,
  Presentation,
  RotateCcw,
  Search,
  Share2,
  Spline,
  Square,
  StickyNote,
  Timer as TimerIcon,
  Type,
  UserX,
  Users,
  Vote,
  Workflow,
  FileCode2,
} from "lucide-react";
import {
  buildTemplate,
  castVote,
  layoutFlowchart,
  layoutMindMap,
  addSavedView,
  pauseTimer,
  remainingBudget,
  removeSavedView,
  resetTimer,
  searchNodes,
  startTimer,
  stepSavedView,
  tallyVotes,
  timerRemainingMs,
  WHITEBOARD_TEMPLATES,
  type Graph,
  type SavedView,
  type SearchMatch,
  type TimerState,
  type VoteSession,
  type WhiteboardMeta,
  normalizeDiagramSpec,
  diagramToMermaid,
} from "@hc/whiteboard";
import {
  applyCommand,
  type EditCommand,
} from "@hc/editor";
import { createNode, newId, type ConnectorNode, type Node, type Transform } from "@hc/schema";
import { useRouter } from "next/router";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { oc } from "@/lib/sdk";
import type { WhiteboardToDeckResult, WhiteboardVoteTally } from "@hc/sdk";
import { useToast } from "@/components/ui/Toast";
import { useEditor } from "@/store/editor";
import { usePresence } from "@/store/presence";
import { useBoardFocus, toggleBoardFocus } from "@/store/boardFocus";
import { onModerated, onVoteChanged, serverNow } from "@/lib/realtime";
import { getRealtimeClient } from "@/lib/useRealtime";
import { Canvas } from "./Canvas";
import { ZoomControl } from "./ZoomControl";

// Ephemeral reaction palette: a fixed set of one-shot pings.
const REACTION_EMOJIS = ["👍", "❤️", "😂", "🎉", "👀", "✅"] as const;

// The stamp wheel (FR-21): dot-vote markers + sentiment emoji placed as StampNodes.
const STAMP_GLYPHS = ["🔴", "🟢", "🟡", "⭐", "👍", "👎", "❤️", "🔥", "✅", "❓", "💡", "🎯"] as const;

// Countdown timer presets in minutes (FR-17): quick stage timers plus a Pomodoro.
const TIMER_PRESETS = [1, 3, 5, 10, 15, 25] as const;

// Audible end-of-timer alert (FR-17): a short two-tone chime synthesized via
// WebAudio so it needs no bundled asset. Best-effort: silent where audio is
// unavailable or blocked (no user gesture yet).
function playTimerEndAlert(): void {
  try {
    const Ctor =
      typeof window !== "undefined"
        ? window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!Ctor) return;
    const ac = new Ctor();
    const beep = (freq: number, start: number, dur: number) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.connect(g);
      g.connect(ac.destination);
      o.type = "sine";
      o.frequency.value = freq;
      const t0 = ac.currentTime + start;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    };
    beep(880, 0, 0.25);
    beep(1175, 0.28, 0.35);
    window.setTimeout(() => { void ac.close(); }, 1000);
  } catch {
    /* audio unavailable / blocked */
  }
}

// The draggable toolbar position is a per-user UI preference, persisted in
// localStorage (NOT the doc) so each collaborator keeps their own placement.
const TOOLBAR_POS_KEY = "oc-wb-toolbar-pos";
// First-run onboarding is shown once per user (FR-33), tracked in localStorage
// (a per-user UI preference, not the shared doc).
const ONBOARD_KEY = "oc-wb-onboarded";
function readOnboarded(): boolean {
  if (typeof window === "undefined") return true; // SSR: never flash the card
  try {
    return window.localStorage.getItem(ONBOARD_KEY) === "1";
  } catch {
    return false;
  }
}
function readToolbarPos(): { x: number; y: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(TOOLBAR_POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { x?: unknown; y?: unknown };
    return typeof p.x === "number" && typeof p.y === "number" ? { x: p.x, y: p.y } : null;
  } catch {
    return null;
  }
}

const DEFAULT_META: WhiteboardMeta = {
  kind: "whiteboard",
  grid: { size: 8, snap: true },
};

// --- geometry helpers -------------------------------------------------------

/** Page-space point at the center of the visible viewport (mirrors the store's
 *  positionInView math: page = screen/zoom + pan). Falls back to the page center
 *  when the canvas has not reported its pixel size yet. */
function viewportCenter(): { x: number; y: number } {
  const s = useEditor.getState();
  const { zoom, panX, panY } = s.viewport;
  const vs = s.viewportSize;
  const page = s.doc.pages[Math.min(s.activePage, s.doc.pages.length - 1)];
  const cx = vs.width > 0 && zoom > 0 ? panX + vs.width / 2 / zoom : (page?.width ?? 1080) / 2;
  const cy = vs.height > 0 && zoom > 0 ? panY + vs.height / 2 / zoom : (page?.height ?? 1080) / 2;
  return { x: cx, y: cy };
}

function setNodeXY(node: Node, x: number, y: number): void {
  const t = (node as unknown as { transform: Transform }).transform;
  (node as unknown as { transform: Transform }).transform = { ...t, x, y };
}

function nodeSize(node: Node): { width: number; height: number } {
  const sz = (node as unknown as { size?: { width: number; height: number } }).size;
  return { width: sz?.width ?? 100, height: sz?.height ?? 100 };
}

function nodeXY(node: Node): { x: number; y: number } {
  const t = (node as unknown as { transform?: Transform }).transform;
  return { x: t?.x ?? 0, y: t?.y ?? 0 };
}

// --- scene insertion --------------------------------------------------------

/**
 * Insert a set of already-built nodes onto the active page as ONE undo step,
 * mirroring the store's paste()/duplicateSelection() mechanism: apply an
 * `insert` @hc/editor command per node directly against the live doc, then
 * record the whole batch through pushApplied() so it inverts as one step.
 * Returns the inserted node ids (and selects them).
 */
function insertNodes(nodes: Node[], select = true): string[] {
  if (!nodes.length) return [];
  const store = useEditor.getState();
  const doc = store.doc;
  // applyCommand's "page" parent resolves to pages[0], so compute the insert
  // base from pages[0] too (a whiteboard is single-page; this keeps the index
  // consistent with where the node actually lands).
  const page = doc.pages[0];
  const base = page.children.length;
  const cmds: EditCommand[] = nodes.map((node, i) => ({
    kind: "insert",
    parent: "page",
    index: base + i,
    node,
  }));
  for (const cmd of cmds) applyCommand(doc, cmd);
  store.pushApplied(cmds);
  const ids = nodes.map((n) => n.id);
  if (select) store.select(ids);
  return ids;
}

/** Translate every node in a freshly built template so its collective center
 *  lands at the current viewport center, then insert them as one undo step. */
function placeTemplate(nodes: Node[]): void {
  if (!nodes.length) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const { x, y } = nodeXY(n);
    const { width, height } = nodeSize(n);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }
  const center = viewportCenter();
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const dx = center.x - cx;
  const dy = center.y - cy;
  for (const n of nodes) {
    const { x, y } = nodeXY(n);
    setNodeXY(n, x + dx, y + dy);
  }
  insertNodes(nodes);
}

// --- toolbar node builders --------------------------------------------------

function addSticky(): void {
  const node = createNode("sticky", { id: newId(), size: { width: 180, height: 180 } });
  const c = viewportCenter();
  setNodeXY(node, c.x - 90, c.y - 90);
  insertNodes([node]);
}

/** Lay a block of blank stickies (3x2) near the viewport center as one undo
 *  step, for kicking off a brainstorm wall (F30 sticky speed). */
function addStickyGrid(): void {
  const cols = 3;
  const rows = 2;
  const size = 160;
  const gap = 20;
  const c = viewportCenter();
  const totalW = cols * size + (cols - 1) * gap;
  const totalH = rows * size + (rows - 1) * gap;
  const x0 = c.x - totalW / 2;
  const y0 = c.y - totalH / 2;
  const nodes: Node[] = [];
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const node = createNode("sticky", { id: newId(), size: { width: size, height: size } });
      setNodeXY(node, x0 + col * (size + gap), y0 + r * (size + gap));
      nodes.push(node);
    }
  }
  insertNodes(nodes);
}

function addFrame(): void {
  const node = createNode("frame", {
    id: newId(),
    name: "Section",
    clip: false,
    children: [],
    size: { width: 480, height: 360 },
  } as Partial<Node>);
  const c = viewportCenter();
  setNodeXY(node, c.x - 240, c.y - 180);
  insertNodes([node]);
}

function addTextBox(): void {
  const node = createNode("text", { id: newId(), size: { width: 240, height: 48 } });
  (node as unknown as { content: unknown }).content = [
    {
      runs: [
        {
          text: "Text",
          style: {
            fontFamily: "Inter",
            fontStyle: "normal",
            fontSize: 28,
            fill: { type: "solid", color: { srgb: { r: 0.1, g: 0.1, b: 0.12, a: 1 } } },
          },
        },
      ],
      style: { align: "left", direction: "auto" },
    },
  ];
  const c = viewportCenter();
  setNodeXY(node, c.x - 120, c.y - 24);
  insertNodes([node]);
}

function addShape(shape: "rect" | "ellipse"): void {
  const node = createNode("shape", {
    id: newId(),
    shape,
    fills: [{ type: "solid", color: { srgb: { r: 0.86, g: 0.92, b: 1, a: 1 } } }],
    size: { width: 160, height: 120 },
  } as Partial<Node>);
  const c = viewportCenter();
  setNodeXY(node, c.x - 80, c.y - 60);
  insertNodes([node]);
}

/** Connect exactly two selected nodes with an elbow connector attached to both
 *  (auto anchors). Inserted via the same undoable insert path as templates so
 *  it re-routes live as the endpoints move. No-op unless two nodes are selected. */
function addConnector(): void {
  const sel = useEditor.getState().selection;
  if (sel.length !== 2) return;
  // Delegates to the store action (shared with drag-to-connect) so the connector
  // styling and undo handling live in one place.
  useEditor.getState().connectNodes(sel[0], sel[1]);
}

// --- auto-layout (diagramming intelligence) ---------------------------------

/** Build a directed connector graph from the active page's connector nodes.
 *  Only attached endpoints contribute edges (floating endpoints are ignored).
 *  `nodes` is restricted to ids actually referenced by a connector. */
function buildConnectorGraph(): { graph: Graph; positionable: Set<string> } {
  const store = useEditor.getState();
  const page = store.doc.pages[Math.min(store.activePage, store.doc.pages.length - 1)];
  const edges: [string, string][] = [];
  const involved = new Set<string>();
  for (const n of page.children) {
    if (n.type !== "connector") continue;
    // UnknownNode can also report type "connector" (its `type` is the full
    // NodeType union), so narrow through the concrete shape rather than relying
    // on the discriminant alone.
    const conn = n as unknown as ConnectorNode;
    const from = conn.start?.attach?.nodeId;
    const to = conn.end?.attach?.nodeId;
    if (from && to) {
      edges.push([from, to]);
      involved.add(from);
      involved.add(to);
    }
  }
  return { graph: { nodes: [...involved], edges }, positionable: involved };
}

/** Move connector-graph nodes to computed positions as ONE undo step via the
 *  store's transform command (applies + records). Positions from the pure layout
 *  helpers are graph-local; we re-center the whole arrangement on the viewport so
 *  the diagram lands where the user is looking. */
function applyLayout(positions: Record<string, { x: number; y: number }>): number {
  const ids = Object.keys(positions);
  if (!ids.length) return 0;
  const store = useEditor.getState();
  const page = store.doc.pages[Math.min(store.activePage, store.doc.pages.length - 1)];
  const byId = new Map(page.children.map((n) => [n.id, n] as const));

  // Recenter computed positions (which are centered on origin) on the viewport.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const p = positions[id];
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const center = viewportCenter();
  const offX = center.x - (minX + maxX) / 2;
  const offY = center.y - (minY + maxY) / 2;

  const nodes: string[] = [];
  const before: Transform[] = [];
  const after: Transform[] = [];
  for (const id of ids) {
    const node = byId.get(id);
    if (!node) continue;
    const t = (node as unknown as { transform: Transform }).transform;
    const { width, height } = nodeSize(node);
    // layout point is a node CENTER; convert to top-left for the transform.
    const nx = positions[id].x + offX - width / 2;
    const ny = positions[id].y + offY - height / 2;
    nodes.push(id);
    before.push({ ...t });
    after.push({ ...t, x: nx, y: ny });
  }
  if (!nodes.length) return 0;
  store.runCommand({ kind: "transform", nodes, before, after });
  store.select(nodes);
  return nodes.length;
}

function autoLayoutFlowchart(): number {
  const { graph } = buildConnectorGraph();
  if (graph.nodes.length === 0) return 0;
  return applyLayout(layoutFlowchart(graph, { direction: "down" }));
}

function autoLayoutMindMap(): number {
  const { graph } = buildConnectorGraph();
  if (graph.nodes.length === 0) return 0;
  // Root = the node with the most outgoing edges (most "central"); fall back to
  // the first node. Mind-map layout treats edges as undirected links.
  const outDeg = new Map<string, number>();
  for (const [u] of graph.edges) outDeg.set(u, (outDeg.get(u) ?? 0) + 1);
  let root = graph.nodes[0];
  let best = -1;
  for (const n of graph.nodes) {
    const d = outDeg.get(n) ?? 0;
    if (d > best) {
      best = d;
      root = n;
    }
  }
  return applyLayout(layoutMindMap(root, graph));
}

// --- popover shell ----------------------------------------------------------

function Popover(props: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [props.open, props]);
  if (!props.open) return null;
  return (
    <div
      ref={ref}
      className={
        "absolute z-20 mt-2 rounded-xl border border-neutral-200 bg-surface p-3 shadow-xl " +
        (props.className ?? "")
      }
    >
      {props.children}
    </div>
  );
}

// --- main surface -----------------------------------------------------------

export function WhiteboardSurface(props: {
  workspaceId?: string;
  designId?: string;
}): React.ReactElement {
  void props.workspaceId;
  const designId = props.designId;
  const router = useRouter();
  const toast = useToast();

  // Copy the board's diagram (stickies/shapes + connectors) as Mermaid source
  // (doc 30 Phase 3, diagram-as-code round-trip). Selection scopes it; with
  // nothing selected the whole board serializes.
  const copyAsMermaid = useCallback(() => {
    const st = useEditor.getState();
    const page = st.doc.pages[Math.min(st.activePage, st.doc.pages.length - 1)];
    if (!page) return;
    const scope = st.selection.length ? new Set(st.selection) : null;
    const labelOf = (n: Node): string => {
      if (n.type === "sticky") return ((n as unknown as { text?: string }).text ?? "").trim() || n.id.slice(0, 6);
      if (n.type === "text") {
        const paras = (n as unknown as { content?: { runs?: { text?: string }[] }[] }).content ?? [];
        const t = paras.map((pp) => (pp.runs ?? []).map((r) => r.text ?? "").join("")).join(" ").trim();
        return t || n.id.slice(0, 6);
      }
      return ((n as unknown as { name?: string }).name ?? "").trim() || n.id.slice(0, 6);
    };
    const nodes: { id: string; label: string }[] = [];
    const boxTypes = new Set(["sticky", "shape", "text", "frame"]);
    for (const n of page.children as Node[]) {
      if (!boxTypes.has(n.type)) continue;
      if (scope && !scope.has(n.id)) continue;
      nodes.push({ id: n.id, label: labelOf(n) });
    }
    const known = new Set(nodes.map((n) => n.id));
    const edges: { from: string; to: string; label?: string }[] = [];
    for (const n of page.children as Node[]) {
      if (n.type !== "connector") continue;
      const c = n as unknown as { start?: { attach?: { nodeId?: string } }; end?: { attach?: { nodeId?: string } }; label?: string };
      const from = c.start?.attach?.nodeId;
      const to = c.end?.attach?.nodeId;
      if (!from || !to || !known.has(from) || !known.has(to)) continue;
      edges.push({ from, to, ...(c.label?.trim() ? { label: c.label.trim() } : {}) });
    }
    const spec = normalizeDiagramSpec({ kind: "flowchart", nodes, edges });
    if (!spec) {
      toast.toast("Nothing diagram-shaped here yet: add stickies or shapes connected by arrows.", "info");
      return;
    }
    void navigator.clipboard.writeText(diagramToMermaid(spec)).then(
      () => toast.success(`Copied ${spec.nodes.length} nodes / ${spec.edges.length} edges as Mermaid.`),
      () => toast.error("Clipboard unavailable."),
    );
  }, [toast]);

  // Convert the board to a presentation deck (server job -> new design).
  const [converting, setConverting] = useState(false);
  const convertToDeck = useCallback(async () => {
    if (!designId || converting) return;
    setConverting(true);
    try {
      const { jobId } = await oc.convertWhiteboardToDeck(designId);
      for (let i = 0; i < 400; i++) {
        const job = await oc.getJob<WhiteboardToDeckResult>(jobId);
        if (job.status === "completed" && job.result?.designId) {
          toast.success(`Created a ${job.result.slides}-slide deck.`);
          router.push({ pathname: "/editor", query: { id: job.result.designId } });
          return;
        }
        if (job.status === "failed") {
          toast.error(job.error || "Conversion failed.");
          return;
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
      toast.error("Conversion timed out.");
    } catch {
      toast.error("Conversion failed.");
    } finally {
      setConverting(false);
    }
  }, [designId, converting, router, toast]);

  // Subscribe to scene revisions so the empty-state hint and vote tallies track
  // the live document.
  const rev = useEditor((s) => s.rev);
  const setDocMeta = useEditor((s) => s.setDocMeta);
  // Viewport drives the infinite-surface dot grid behind the canvas (F30 FR-1):
  // the grid scales with zoom and scrolls with pan, so panning beyond the page
  // reads as one continuous board rather than a bounded artboard on empty space.
  const viewport = useEditor((s) => s.viewport);
  // Active tool + ink mode drive the ink button highlight (F30 FR-4).
  const tool = useEditor((s) => s.tool);
  const inkMode = useEditor((s) => s.brush.mode);
  const boardFocus = useBoardFocus((s) => s.focus);
  const stampGlyph = useEditor((s) => s.stampGlyph);
  // Route of the first selected connector (drives the style picker, FR-7); null
  // when no connector is selected. Connectors live at the page top level.
  const selectedRoute = useEditor((s) => {
    for (const pg of s.doc.pages) {
      for (const ch of pg.children) {
        if (ch.type === "connector" && s.selection.includes(ch.id)) return (ch as ConnectorNode).route;
      }
    }
    return null;
  });
  // Connect is enabled only when exactly two nodes are selected.
  const canConnect = useEditor((s) => s.selection.length === 2);
  // On-board search overlay (F30 FR-2), opened with Cmd/Ctrl+F.
  const [searchOpen, setSearchOpen] = useState(false);

  // Auto-layout works on the graph formed by connectors; report the outcome so a
  // board with no connected nodes gives clear feedback instead of a silent no-op.
  const runFlowchart = useCallback(() => {
    const n = autoLayoutFlowchart();
    if (n === 0) toast.toast("Connect nodes with arrows first - auto-layout arranges the connected diagram.", "info");
    else toast.success(`Arranged ${n} connected node${n === 1 ? "" : "s"} into a flowchart.`);
  }, [toast]);
  const runMindMap = useCallback(() => {
    const n = autoLayoutMindMap();
    if (n === 0) toast.toast("Connect nodes with arrows first - mind-map layout arranges the connected diagram.", "info");
    else toast.success(`Arranged ${n} connected node${n === 1 ? "" : "s"} into a mind map.`);
  }, [toast]);

  // Real per-user identity for vote accounting: the server-assigned
  // user id when collaborating, falling back to a stable local key offline.
  const userId = usePresence((s) => s.self?.userId) ?? "me";

  const [menu, setMenu] = useState<null | "templates" | "shapes" | "timer" | "vote" | "stamp" | "views" | "participants">(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  // First-run onboarding (FR-33): a one-time guided welcome on an empty board.
  const [onboarded, setOnboarded] = useState<boolean>(readOnboarded);
  const dismissOnboarding = useCallback(() => {
    setOnboarded(true);
    try {
      window.localStorage.setItem(ONBOARD_KEY, "1");
    } catch {
      /* ignore quota/availability */
    }
  }, []);

  // Draggable floating toolbar (so the user can move it out of the way). Position
  // is null until first dragged (then it defaults to the top-left); the grip
  // handle drives a pointer-capture drag, clamped to the surface bounds.
  const surfaceRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarPos, setToolbarPos] = useState<{ x: number; y: number } | null>(() => readToolbarPos());
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  // Persist the placement so it survives reloads (per-user, via localStorage).
  useEffect(() => {
    if (!toolbarPos || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(TOOLBAR_POS_KEY, JSON.stringify(toolbarPos));
    } catch {
      /* ignore quota/availability errors */
    }
  }, [toolbarPos]);
  const onToolbarHandleDown = useCallback((e: React.PointerEvent) => {
    const tb = toolbarRef.current;
    if (!tb) return;
    const r = tb.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }, []);
  const onToolbarHandleMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    const surf = surfaceRef.current;
    const tb = toolbarRef.current;
    if (!d || !surf || !tb) return;
    const sr = surf.getBoundingClientRect();
    const tr = tb.getBoundingClientRect();
    const maxX = Math.max(0, sr.width - tr.width);
    const maxY = Math.max(0, sr.height - tr.height);
    const x = Math.min(maxX, Math.max(0, e.clientX - sr.left - d.dx));
    const y = Math.min(maxY, Math.max(0, e.clientY - sr.top - d.dy));
    setToolbarPos({ x, y });
  }, []);
  const onToolbarHandleUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  // Live-collab gate for ephemeral presence affordances (reactions + cursor
  // chat). These only make sense with an active realtime client; we mirror the
  // connection state into local state so the controls show/hide as it connects.
  const connection = usePresence((s) => s.connection);
  const hasLiveClient = connection === "connected" && getRealtimeClient() != null;

  // --- Facilitation: spotlight / summon / take-control (FR-14) --------------
  // Only an editor on a live connection can drive other participants' viewports;
  // the server drops a viewer's spotlight frame, so we hide the controls too.
  const accessMode = usePresence((s) => s.accessMode);
  const presenter = usePresence((s) => s.presenter); // set when WE are being presented to
  const summon = usePresence((s) => s.summon);
  const canFacilitate = hasLiveClient && accessMode === "edit";
  const [presentingSelf, setPresentingSelf] = useState(false);
  const presentingRef = useRef(false);
  useEffect(() => { presentingRef.current = presentingSelf; }, [presentingSelf]);

  // Take-control toggle: start/stop driving everyone's viewport. Our own client
  // never receives the frame (the server excludes the sender), so we track the
  // active state locally to toggle the button.
  const togglePresent = useCallback(() => {
    const c = getRealtimeClient();
    if (!c) return;
    const next = !presentingRef.current; // ref tracks state; keeps the updater pure
    c.sendSpotlight(next ? "start" : "stop");
    setPresentingSelf(next);
  }, []);

  // One-shot "bring everyone to my view": carries our current viewport so peers
  // snap to it once (without entering sustained follow).
  const summonEveryone = useCallback(() => {
    getRealtimeClient()?.sendSpotlight("summon", useEditor.getState().viewport);
  }, []);

  // Note: we intentionally do NOT auto re-broadcast "start" when a peer joins
  // mid-presentation. A broadcast re-assert would also re-capture participants who
  // pressed Esc to break free (FR-14 respects that exit). A late joiner is brought
  // in by the facilitator clicking Summon (one-shot) or toggling Present again; a
  // targeted, addressable re-assert is left for a future spotlight `to` frame.

  // Summon toast auto-dismiss: a summon shows "[name] brought everyone here"
  // (rendered directly off `summon`) and clears itself after a few seconds. The
  // clear runs in the timeout callback, not synchronously in the effect body.
  useEffect(() => {
    if (!summon) return;
    const id = window.setTimeout(() => usePresence.getState().setSummon(null), 3500);
    return () => window.clearTimeout(id);
  }, [summon]);

  // --- moderation (FR-32): roster + kick/ban, editor-gated (server-enforced) ---
  const peers = usePresence((s) => s.peers);
  const moderate = useCallback((action: "kick" | "ban" | "unban", userId: string) => {
    getRealtimeClient()?.sendModerate(action, userId);
  }, []);
  // Surface being removed by a facilitator (the transport already stopped reconnecting).
  useEffect(
    () =>
      onModerated((action) =>
        toast.error(
          action === "ban"
            ? "You were banned from this board by a facilitator."
            : "You were removed from this board by a facilitator.",
        ),
      ),
    [toast],
  );

  // Local reaction echoes so the SENDER sees their own reaction float up (peers
  // see it via PresenceOverlay; without a local echo the actor and any solo user
  // would see nothing happen). Each is auto-removed once its animation ends.
  const [localReactions, setLocalReactions] = useState<{ id: number; emoji: string }[]>([]);
  const reactionSeq = useRef(0);
  const sendReaction = useCallback((emoji: string) => {
    // Broadcast to peers when collaborating (no-op offline)...
    getRealtimeClient()?.sendPresence({ reaction: { emoji, at: serverNow() } });
    // ...and always echo locally so the reaction is visibly sent.
    const id = ++reactionSeq.current;
    setLocalReactions((prev) => [...prev, { id, emoji }]);
    window.setTimeout(() => {
      setLocalReactions((prev) => prev.filter((r) => r.id !== id));
    }, 2200);
  }, []);

  // Read facilitation meta (persisted under doc.meta.whiteboard).
  const meta = useMemo<WhiteboardMeta>(() => {
    void rev;
    const m = (useEditor.getState().doc.meta as { whiteboard?: WhiteboardMeta } | undefined)
      ?.whiteboard;
    return m ?? DEFAULT_META;
  }, [rev]);

  const writeMeta = useCallback(
    (next: WhiteboardMeta) => {
      setDocMeta({ whiteboard: next });
    },
    [setDocMeta],
  );

  // Merge a partial change into the CURRENT meta read fresh from the store (not a
  // render-time closure), so a write that follows an `await` cannot clobber a
  // concurrent meta change (e.g. a peer's timer/views edit landing meanwhile).
  const patchMeta = useCallback(
    (partial: Partial<WhiteboardMeta>) => {
      const cur = (useEditor.getState().doc.meta as { whiteboard?: WhiteboardMeta } | undefined)?.whiteboard ?? DEFAULT_META;
      setDocMeta({ whiteboard: { ...cur, ...partial } });
    },
    [setDocMeta],
  );

  // --- private mode (FR-15): facilitator-toggled "hidden until reveal" round ---
  const privateMode = meta.privateMode;
  const privateActive = !!privateMode?.active;
  const privateRevealed = !!privateMode?.revealed;
  // Keep the local round (baseline + own contribution ids) reconciled to the
  // synced meta, so each client captures its baseline when a round starts.
  useEffect(() => {
    useEditor.getState().syncPrivateRound(privateMode);
  }, [privateMode]);
  const startPrivate = useCallback(() => {
    patchMeta({ privateMode: { active: true, revealed: false, startedAt: serverNow() } });
  }, [patchMeta]);
  // Reveal is the terminal action: everyone's contributions become visible and the
  // round ends (active=false). `revealed` stays true so a late frame can't re-hide.
  const revealPrivate = useCallback(() => {
    patchMeta({ privateMode: { active: false, revealed: true, startedAt: privateMode?.startedAt ?? 0 } });
  }, [privateMode, patchMeta]);

  // --- facilitator role + handoff + protected lock (FR-16, server-tracked) ---
  const facilitator = usePresence((s) => s.facilitator);
  const selfClientIdF = usePresence((s) => s.self?.clientId ?? null);
  const protectedNodes = usePresence((s) => s.protectedNodes);
  const selection = useEditor((s) => s.selection);
  const amFacilitator = !!facilitator && facilitator.clientId === selfClientIdF;
  const otherFacilitator = !!facilitator && facilitator.clientId !== selfClientIdF;
  // Protect actions are accepted server-side only from the facilitator (or any
  // editor when none is set), so only offer them then.
  const canProtect = canFacilitate && (!facilitator || amFacilitator);
  const selProtected = selection.length > 0 && selection.every((id) => protectedNodes.has(id));
  const toggleFacilitate = useCallback(() => {
    const c = getRealtimeClient();
    if (!c) return;
    if (amFacilitator) c.sendFacilitator("release");
    else if (!facilitator) c.sendFacilitator("claim");
  }, [amFacilitator, facilitator]);
  const toggleProtect = useCallback(() => {
    const sel = useEditor.getState().selection;
    if (!sel.length) return;
    const allProt = sel.every((id) => usePresence.getState().protectedNodes.has(id));
    getRealtimeClient()?.sendProtect(allProt ? "unprotect" : "protect", sel);
  }, []);

  // Select an ink tool with a distinct default per mode so pen / marker /
  // highlighter read differently at a glance (a plain mouse has no pen pressure,
  // so without this they'd all be identical constant-width strokes). The preset is
  // applied only when switching mode, preserving a custom size set within a mode.
  const pickInk = useCallback((mode: "pen" | "marker" | "highlighter") => {
    const ed = useEditor.getState();
    if (ed.brush.mode !== mode) {
      const preset =
        mode === "highlighter" ? { width: 22, opacity: 0.35 } : mode === "marker" ? { width: 12, opacity: 1 } : { width: 3, opacity: 1 };
      ed.setBrush({ mode, ...preset });
    } else {
      ed.setBrush({ mode });
    }
    ed.setTool("ink");
  }, []);

  // Live clock tick (250ms) so the countdown re-renders while running. The
  // displayed remaining time is computed from serverNow() (the shared server
  // clock) so every participant sees the same countdown.
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    const id = window.setInterval(() => setNow(serverNow()), 250);
    return () => window.clearInterval(id);
  }, []);

  // Cmd/Ctrl+F opens on-board search (FR-2), replacing the browser's find so the
  // query runs over board content. Handled separately from the bare-key shortcuts
  // below (which ignore modifier combos).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Whiteboard keyboard shortcuts (active while the surface is mounted):
  // S add sticky, F add frame, T add text, V select tool, C connect two nodes.
  // Ignored while typing in an input/textarea/contentEditable so the sticky/text
  // edit overlays keep their own keys. Modifier combos are left to the canvas
  // (undo/redo/copy/...), so only bare keys are handled here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key.toLowerCase()) {
        case "s":
          e.preventDefault();
          addSticky();
          break;
        case "f":
          e.preventDefault();
          addFrame();
          break;
        case "t":
          e.preventDefault();
          addTextBox();
          break;
        case "v":
          e.preventDefault();
          useEditor.getState().setTool("select");
          break;
        case "p": {
          e.preventDefault();
          const ed = useEditor.getState();
          ed.setBrush({ mode: "pen" });
          ed.setTool("ink");
          break;
        }
        case "l": {
          e.preventDefault();
          const ed = useEditor.getState();
          ed.setTool(ed.tool === "laser" ? "select" : "laser");
          break;
        }
        case "c":
          if (useEditor.getState().selection.length === 2) {
            e.preventDefault();
            addConnector();
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Whether the active page has any nodes (drives the empty-state hint).
  const isEmpty = useMemo(() => {
    void rev;
    const s = useEditor.getState();
    const page = s.doc.pages[Math.min(s.activePage, s.doc.pages.length - 1)];
    return !page || page.children.length === 0;
  }, [rev]);

  // --- timer state + actions ---
  // Memoized so the fallback object is stable across renders (keeps the timer
  // action callbacks' dependencies from changing every render).
  const timer: TimerState = useMemo(
    () => meta.timer ?? { running: false, durationMs: 5 * 60_000, elapsedBeforeMs: 0 },
    [meta.timer],
  );
  const remainingMs = timerRemainingMs(timer, now);
  const remMin = Math.floor(remainingMs / 60_000);
  const remSec = Math.floor((remainingMs % 60_000) / 1000);

  const setTimerMinutes = useCallback(
    (minutes: number) => {
      const next: TimerState = resetTimer({ ...timer, durationMs: Math.max(1, minutes) * 60_000 });
      writeMeta({ ...meta, timer: next });
    },
    [meta, timer, writeMeta],
  );
  const onTimerStart = useCallback(() => {
    writeMeta({ ...meta, timer: startTimer(timer, serverNow()) });
  }, [meta, timer, writeMeta]);
  const onTimerPause = useCallback(() => {
    writeMeta({ ...meta, timer: pauseTimer(timer, serverNow()) });
  }, [meta, timer, writeMeta]);
  const onTimerReset = useCallback(() => {
    writeMeta({ ...meta, timer: resetTimer(timer) });
  }, [meta, timer, writeMeta]);

  // Audible end alert (FR-17): chime once when a running countdown reaches zero.
  // The "alerted" flag is keyed to the current run (start + duration) so a reset
  // or restart re-arms it, and the chime fires once across the synced tick.
  const timerAlertedRef = useRef(false);
  useEffect(() => {
    timerAlertedRef.current = false;
  }, [timer.startedAt, timer.durationMs, timer.running]);
  useEffect(() => {
    if (!timer.running || remainingMs > 0 || timerAlertedRef.current) return;
    timerAlertedRef.current = true;
    playTimerEndAlert();
  }, [timer.running, remainingMs]);

  // --- named views / agenda / deep-links (FR-3, FR-34) ----------------------
  const viewportSize = useEditor((s) => s.viewportSize);
  const views = useMemo(() => meta.views ?? [], [meta.views]);
  const [agendaId, setAgendaId] = useState<string | null>(null);

  const saveCurrentView = useCallback(() => {
    const vp = useEditor.getState().viewport;
    const existing = meta.views ?? [];
    const view: SavedView = {
      id: newId(),
      name: `View ${existing.length + 1}`,
      viewport: { zoom: vp.zoom, panX: vp.panX, panY: vp.panY },
    };
    writeMeta({ ...meta, views: addSavedView(existing, view) });
  }, [meta, writeMeta]);

  const recallView = useCallback((vw: SavedView) => {
    setAgendaId(vw.id);
    useEditor.getState().setViewport(vw.viewport);
  }, []);

  const deleteView = useCallback((id: string) => {
    writeMeta({ ...meta, views: removeSavedView(meta.views, id) });
  }, [meta, writeMeta]);

  const stepAgenda = useCallback((dir: 1 | -1) => {
    const next = stepSavedView(meta.views, agendaId, dir);
    if (next) recallView(next);
  }, [meta.views, agendaId, recallView]);

  const copyViewLink = useCallback((id: string) => {
    if (typeof window === "undefined") return;
    const designId = typeof router.query.id === "string" ? router.query.id : "";
    const url = `${window.location.origin}${window.location.pathname}?id=${encodeURIComponent(designId)}&view=${encodeURIComponent(id)}`;
    void navigator.clipboard?.writeText(url).then(
      () => toast.success("View link copied"),
      () => toast.error("Could not copy link"),
    );
  }, [router.query.id, toast]);

  // Deep-link target (FR-34): on open, restore the viewport to a saved view
  // (?view=) or jump to a node (?focus=), once and once the canvas has measured
  // (jumpToNode/setViewport need a real viewport size). No-ops if the target was
  // deleted. The share-link permission is already enforced by the load path.
  const deepLinkApplied = useRef(false);
  useEffect(() => {
    if (deepLinkApplied.current || !router.isReady) return;
    if (!viewportSize.width || !viewportSize.height) return; // wait for canvas measure
    const focus = typeof router.query.focus === "string" ? router.query.focus : null;
    const viewId = typeof router.query.view === "string" ? router.query.view : null;
    deepLinkApplied.current = true;
    if (focus) {
      useEditor.getState().jumpToNode(focus);
    } else if (viewId) {
      // Apply the saved viewport directly (the store setter, not React state) so
      // this one-shot effect doesn't trip the no-setState-in-effect rule.
      const vw = (meta.views ?? []).find((v) => v.id === viewId);
      if (vw) useEditor.getState().setViewport(vw.viewport);
    }
  }, [router.isReady, router.query.focus, router.query.view, viewportSize, meta.views]);

  // --- voting state + actions ---
  const vote: VoteSession | undefined = meta.vote;
  const tallies = useMemo(() => (vote ? tallyVotes(vote) : {}), [vote]);
  const myRemaining = vote ? remainingBudget(vote, userId) : 0;

  const openVoteRound = useCallback(
    (budget: number, anonymous: boolean) => {
      const session: VoteSession = {
        id: newId(),
        open: true,
        budgetPerUser: Math.max(1, budget),
        anonymous,
        revealed: !anonymous,
        votes: [],
      };
      writeMeta({ ...meta, vote: session });
    },
    [meta, writeMeta],
  );
  const closeVoteRound = useCallback(() => {
    if (!vote) return;
    writeMeta({ ...meta, vote: { ...vote, open: false, revealed: true } });
  }, [meta, vote, writeMeta]);
  const clearVoteRound = useCallback(() => {
    const next = { ...meta };
    delete next.vote;
    writeMeta(next);
  }, [meta, writeMeta]);
  // Cast/uncast a vote for the first selected node (the natural "vote for this
  // sticky" gesture). Server sync of votes is deferred.
  const voteForSelection = useCallback(() => {
    if (!vote || !vote.open) return;
    const sel = useEditor.getState().selection;
    const nodeId = sel[0];
    if (!nodeId) return;
    writeMeta({ ...meta, vote: castVote(vote, nodeId, userId) });
  }, [meta, userId, vote, writeMeta]);

  // --- server-authoritative voting (FR-19): on a saved, connected board the
  // round is server-owned. `meta.voteSessionId` (CRDT-synced) points every client
  // at the same session; the tally is fetched over REST and refetched on the
  // `{t:"vote"}` signal. Offline / unsaved docs keep the client-side `meta.vote`
  // above as the fallback. ---
  const designIdQ = typeof router.query.id === "string" ? router.query.id : "";
  const canServerVote = !!designIdQ && hasLiveClient;
  const serverSessionId = meta.voteSessionId;
  const [serverTally, setServerTally] = useState<WhiteboardVoteTally | null>(null);

  const refreshTally = useCallback((sessionId: string) => {
    if (!designIdQ) return;
    void oc.getVoteTally(designIdQ, sessionId).then(
      (t) => setServerTally(t),
      () => setServerTally(null), // session gone / no access: fall back to empty
    );
  }, [designIdQ]);

  // Fetch the tally when the active session pointer changes. The display getters
  // ignore a tally whose session id no longer matches, so no in-effect clear is
  // needed when the pointer goes away (which keeps this effect setState-free).
  useEffect(() => {
    if (!canServerVote || !serverSessionId) return;
    refreshTally(serverSessionId);
  }, [canServerVote, serverSessionId, refreshTally]);

  // Refetch on a peer's vote/session change (signal carries no payload).
  useEffect(() => {
    if (!canServerVote || !serverSessionId) return;
    return onVoteChanged((d) => {
      if (d === designIdQ) refreshTally(serverSessionId);
    });
  }, [canServerVote, serverSessionId, designIdQ, refreshTally]);

  const openServerVote = useCallback((budget: number, anonymous: boolean) => {
    if (!designIdQ) return;
    void oc.openVoteSession(designIdQ, { budgetPerUser: Math.max(1, budget), anonymous }).then(
      (s) => {
        setServerTally({ session: s, counts: {}, mine: [], remainingBudget: s.budgetPerUser });
        patchMeta({ voteSessionId: s.id }); // merge into fresh meta (post-await)
      },
      () => toast.error("Could not open the vote round"),
    );
  }, [designIdQ, patchMeta, toast]);

  const castServerVoteSelection = useCallback(() => {
    if (!designIdQ || !serverSessionId) return;
    const nodeId = useEditor.getState().selection[0];
    if (!nodeId) return;
    void oc.castVote(designIdQ, { sessionId: serverSessionId, nodeId }).then(
      (t) => setServerTally(t),
      () => {
        // 409 (over budget / closed) or transient: resync to the true standings
        // so the displayed counts/remaining never drift from the server.
        toast.error("Out of votes, or the round is closed");
        refreshTally(serverSessionId);
      },
    );
  }, [designIdQ, serverSessionId, refreshTally, toast]);

  const closeServerVote = useCallback(() => {
    if (!designIdQ || !serverSessionId) return;
    void oc.setVoteSessionState(designIdQ, serverSessionId, { open: false, revealed: true }).then(
      () => refreshTally(serverSessionId),
      () => toast.error("Could not close the round"),
    );
  }, [designIdQ, serverSessionId, refreshTally, toast]);

  const newServerRound = useCallback(() => {
    patchMeta({ voteSessionId: undefined }); // merge into fresh meta
    setServerTally(null);
  }, [patchMeta]);

  // Unified display + actions: prefer the server round when collaborating, else
  // the offline client-side round. The vote menu reads only these. `liveTally` is
  // the fetched tally only while it matches the active session pointer (a stale
  // one from a just-cleared/changed session is ignored).
  const liveTally = canServerVote && serverTally && serverTally.session.id === serverSessionId ? serverTally : null;
  const hasRound = canServerVote ? !!serverSessionId : !!vote;
  // A server round whose tally has not arrived yet (initial fetch in flight, or a
  // transient refetch miss): show a neutral loading state, never the closed-round
  // UI with its destructive "New round" action.
  const roundPending = canServerVote && !!serverSessionId && !liveTally;
  const roundOpen = canServerVote ? !!liveTally?.session.open : !!vote?.open;
  const roundAnon = canServerVote ? !!liveTally?.session.anonymous : !!vote?.anonymous;
  const roundBudget = canServerVote ? (liveTally?.session.budgetPerUser ?? 0) : (vote?.budgetPerUser ?? 0);
  const displayCounts = canServerVote ? (liveTally?.counts ?? {}) : tallies;
  const displayRemaining = canServerVote ? (liveTally?.remainingBudget ?? 0) : myRemaining;
  const doOpenVote = canServerVote ? openServerVote : openVoteRound;
  const doVoteSelection = canServerVote ? castServerVoteSelection : voteForSelection;
  const doCloseVote = canServerVote ? closeServerVote : closeVoteRound;
  const doNewRound = canServerVote ? newServerRound : clearVoteRound;

  const fmt2 = (n: number) => String(n).padStart(2, "0");

  return (
    <div ref={surfaceRef} className="relative flex min-w-0 flex-1">
      {/* Infinite-surface dot grid (F30 FR-1): sits behind the engine canvas, which
          is transparent outside the page, so panning anywhere shows a continuous
          board. Dots scale with zoom and scroll with pan. Non-interactive. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[#fafafa]"
        style={{
          zIndex: 0,
          backgroundImage: "radial-gradient(circle, rgba(15,23,42,0.12) 1px, transparent 1px)",
          backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px`,
          backgroundPosition: `${-viewport.panX * viewport.zoom}px ${-viewport.panY * viewport.zoom}px`,
        }}
      />
      {/* The board: the existing design canvas (engine-rendered). It owns pan,
          zoom, marquee-select, and move for the whiteboard nodes. */}
      <Canvas />

      {/* Zoom control (parity with the design editor): zoom in/out, %, fit, and
          zoom-to-selection. Pan/zoom also work via wheel/trackpad/shortcuts. */}
      <ZoomControl />

      {/* On-board search (FR-2): Cmd/Ctrl+F finds across sticky/text/connector/
          frame content and jumps the viewport to a chosen match. */}
      {searchOpen && <BoardSearch onClose={() => setSearchOpen(false)} />}

      {/* Empty-state hint, centered, non-interactive so it never eats canvas
          pointer events. */}
      {isEmpty && onboarded && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="rounded-2xl border border-dashed border-neutral-300 bg-surface/70 px-6 py-5 text-center backdrop-blur-sm">
            <p className="text-sm font-medium text-neutral-700">Your board is empty</p>
            <p className="mt-1 text-xs text-neutral-500">
              Add a sticky, or pick a template to get started.
            </p>
          </div>
        </div>
      )}

      {/* First-run guided start (FR-33): one-time, on an empty board. Three quick
          starts plus a pointer to the facilitation tools, dismissed per-user. */}
      {isEmpty && !onboarded && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center p-4">
          <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-neutral-200 bg-surface/95 p-5 shadow-xl backdrop-blur">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-base font-semibold text-neutral-800">Welcome to your whiteboard</p>
                <p className="mt-0.5 text-xs text-neutral-500">Brainstorm, diagram, and run workshops together. Pick a quick start:</p>
              </div>
              <button
                type="button"
                onClick={dismissOnboarding}
                aria-label="Dismiss"
                className="shrink-0 rounded-lg px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
              >
                ✕
              </button>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => { addSticky(); dismissOnboarding(); }}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-neutral-200 px-2 py-3 text-xs font-medium text-neutral-700 hover:border-brand-300 hover:bg-brand-50"
              >
                <StickyNote size={20} className="text-brand-ink" /> Add a sticky
              </button>
              <button
                type="button"
                onClick={() => { dismissOnboarding(); setMenu("templates"); }}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-neutral-200 px-2 py-3 text-xs font-medium text-neutral-700 hover:border-brand-300 hover:bg-brand-50"
              >
                <LayoutTemplate size={20} className="text-brand-ink" /> Use a template
              </button>
              <button
                type="button"
                onClick={() => { pickInk("pen"); dismissOnboarding(); }}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-neutral-200 px-2 py-3 text-xs font-medium text-neutral-700 hover:border-brand-300 hover:bg-brand-50"
              >
                <Pen size={20} className="text-brand-ink" /> Draw
              </button>
            </div>
            <p className="mt-4 text-[11px] leading-relaxed text-neutral-500">
              The top toolbar has sticky, frame, text, ink, shapes, connectors, and the stamp wheel. The bottom bar runs the workshop: countdown timer, dot voting, present-to-everyone, reactions, and Cmd/Ctrl+F to search.
            </p>
            <div className="mt-3 text-right">
              <Button size="sm" variant="secondary" onClick={dismissOnboarding}>Got it</Button>
            </div>
          </div>
        </div>
      )}

      {/* Forced-spotlight banner (FR-14): shown while a facilitator drives our
          viewport. Esc or the Exit button breaks free. */}
      {presenter && (
        <div className="pointer-events-auto absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-brand-200 bg-brand-50/95 px-3 py-1.5 text-xs font-medium text-brand-ink shadow-md backdrop-blur">
          <Presentation size={14} />
          <span>{presenter.name} is presenting</span>
          <button
            type="button"
            onClick={() => usePresence.getState().setFollowing(null)}
            className="rounded-full bg-surface/70 px-2 py-0.5 text-[11px] text-brand-ink hover:bg-surface"
          >
            Exit (Esc)
          </button>
        </div>
      )}

      {/* Private-mode banner (FR-15): shown while a round is hiding others' new
          contributions. The facilitator can reveal (which ends the round). */}
      {privateActive && !privateRevealed && (
        <div className="pointer-events-auto absolute left-1/2 top-12 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-200 bg-amber-50/95 px-3 py-1.5 text-xs font-medium text-amber-800 shadow-md backdrop-blur">
          <EyeOff size={14} />
          <span>Private mode: new notes are hidden from others until reveal</span>
          {canFacilitate && (
            <button
              type="button"
              onClick={revealPrivate}
              className="rounded-full bg-surface/80 px-2 py-0.5 text-[11px] text-amber-800 hover:bg-surface"
            >
              Reveal
            </button>
          )}
        </div>
      )}

      {/* One-shot summon toast (FR-14): a facilitator brought everyone here. */}
      {summon && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full border border-neutral-200 bg-surface/95 px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-md backdrop-blur">
          {summon.name} brought everyone here
        </div>
      )}

      {/* Floating toolbar. Absolutely positioned so it only captures pointer
          events on its own controls; draggable by the grip handle (defaults to
          the top-left until moved). */}
      <div
        ref={toolbarRef}
        className="absolute z-10 flex items-center gap-1 rounded-2xl border border-neutral-200 bg-surface/95 p-1.5 shadow-lg backdrop-blur"
        style={toolbarPos ? { left: toolbarPos.x, top: toolbarPos.y } : { left: 12, top: 12 }}
      >
        <button
          onPointerDown={onToolbarHandleDown}
          onPointerMove={onToolbarHandleMove}
          onPointerUp={onToolbarHandleUp}
          title="Drag toolbar"
          aria-label="Drag toolbar"
          className="grid h-8 w-5 shrink-0 cursor-grab touch-none place-items-center rounded text-neutral-300 hover:text-neutral-500 active:cursor-grabbing"
        >
          <GripVertical size={16} />
        </button>
        <IconButton onClick={addSticky} tooltip="Add sticky note (S)" aria-label="Add sticky note">
          <StickyNote size={18} />
        </IconButton>
        <IconButton onClick={addStickyGrid} tooltip="Add a grid of sticky notes" aria-label="Add sticky grid">
          <LayoutGrid size={18} />
        </IconButton>
        <IconButton onClick={addFrame} tooltip="Add frame / section (F)" aria-label="Add frame">
          <LayoutTemplate size={18} />
        </IconButton>
        <IconButton onClick={addTextBox} tooltip="Add text (T)" aria-label="Add text">
          <Type size={18} />
        </IconButton>

        {/* Ink tools (F30): pen / marker / highlighter. Each selects the board
            `ink` tool and sets the brush mode; drawing commits an ink node. */}
        <IconButton
          active={tool === "ink" && inkMode === "pen"}
          onClick={() => pickInk("pen")}
          tooltip="Pen (P) - thin, opaque"
          aria-label="Pen"
        >
          <Pen size={18} />
        </IconButton>
        <IconButton
          active={tool === "ink" && inkMode === "marker"}
          onClick={() => pickInk("marker")}
          tooltip="Marker - thick, opaque"
          aria-label="Marker"
        >
          <Brush size={18} />
        </IconButton>
        <IconButton
          active={tool === "ink" && inkMode === "highlighter"}
          onClick={() => pickInk("highlighter")}
          tooltip="Highlighter - wide, semi-transparent"
          aria-label="Highlighter"
        >
          <Highlighter size={18} />
        </IconButton>
        <IconButton
          active={tool === "laser"}
          onClick={() => useEditor.getState().setTool(tool === "laser" ? "select" : "laser")}
          tooltip="Laser pointer (L) - ephemeral, never saved"
          aria-label="Laser pointer"
        >
          <Pointer size={18} />
        </IconButton>
        <IconButton
          active={tool === "eraser"}
          onClick={() => useEditor.getState().setTool(tool === "eraser" ? "select" : "eraser")}
          tooltip="Eraser - click or drag over strokes/objects to remove them"
          aria-label="Eraser"
        >
          <Eraser size={18} />
        </IconButton>

        {/* Emoji / vote stamp (FR-21): pick a glyph, then click the board to drop
            stamps for dot-voting and sentiment. The button shows the active glyph;
            the popover is the stamp wheel. */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              if (tool !== "stamp") useEditor.getState().setTool("stamp");
              setMenu(menu === "stamp" ? null : "stamp");
            }}
            title="Stamp (emoji / dot-vote)"
            aria-label="Stamp"
            className={`grid h-8 w-8 place-items-center rounded-lg text-base leading-none ${
              tool === "stamp" ? "bg-brand-100 text-brand-ink" : "text-neutral-600 hover:bg-neutral-100"
            }`}
          >
            <span aria-hidden>{stampGlyph || "👍"}</span>
          </button>
          <Popover open={menu === "stamp"} onClose={closeMenu} className="left-0 w-44">
            <div className="grid grid-cols-6 gap-1 p-1">
              {STAMP_GLYPHS.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => { useEditor.getState().setStampGlyph(g); useEditor.getState().setTool("stamp"); closeMenu(); }}
                  className={`grid h-7 w-7 place-items-center rounded text-base hover:bg-neutral-100 ${g === stampGlyph ? "bg-brand-100" : ""}`}
                  aria-label={`Stamp ${g}`}
                >
                  <span aria-hidden>{g}</span>
                </button>
              ))}
            </div>
          </Popover>
        </div>

        {/* Facilitation (FR-14): present-to-everyone (take control of peers'
            viewports) + a one-shot summon. Editors only, and only with peers on a
            live connection. */}
        {canFacilitate && (
          <>
            <IconButton
              active={presentingSelf}
              onClick={togglePresent}
              tooltip={presentingSelf ? "Stop presenting" : "Present to everyone (drive their view)"}
              aria-label={presentingSelf ? "Stop presenting" : "Present to everyone"}
            >
              <Presentation size={18} />
            </IconButton>
            <IconButton
              onClick={summonEveryone}
              tooltip="Bring everyone to my view"
              aria-label="Bring everyone to my view"
            >
              <Users size={18} />
            </IconButton>
            <IconButton
              active={privateActive}
              onClick={privateActive ? revealPrivate : startPrivate}
              tooltip={privateActive ? "Reveal (end private mode)" : "Private mode (hide others' new notes until reveal)"}
              aria-label={privateActive ? "Reveal private mode" : "Start private mode"}
            >
              <EyeOff size={18} />
            </IconButton>
            <IconButton
              active={amFacilitator}
              disabled={otherFacilitator}
              onClick={toggleFacilitate}
              tooltip={otherFacilitator ? `${facilitator?.name} is facilitating` : amFacilitator ? "Stop facilitating" : "Become facilitator (run the session)"}
              aria-label="Facilitator"
            >
              <Crown size={18} />
            </IconButton>
            {canProtect && (
              <IconButton
                active={selProtected}
                disabled={selection.length === 0}
                onClick={toggleProtect}
                tooltip={selection.length === 0 ? "Select nodes to protect" : selProtected ? "Unprotect selection" : "Protect selection (facilitator lock)"}
                aria-label="Protect selection"
              >
                <Lock size={18} />
              </IconButton>
            )}
          </>
        )}

        {/* Shapes menu */}
        <div className="relative">
          <IconButton
            active={menu === "shapes"}
            onClick={() => setMenu(menu === "shapes" ? null : "shapes")}
            tooltip="Add shape"
            aria-label="Add shape"
          >
            <Square size={18} />
          </IconButton>
          <Popover open={menu === "shapes"} onClose={closeMenu} className="left-0 w-40">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100"
              onClick={() => {
                addShape("rect");
                closeMenu();
              }}
            >
              <Square size={16} /> Rectangle
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100"
              onClick={() => {
                addShape("ellipse");
                closeMenu();
              }}
            >
              <Circle size={16} /> Ellipse
            </button>
          </Popover>
        </div>

        <span className="mx-1 h-6 w-px bg-neutral-200" aria-hidden />

        {/* Templates menu */}
        <div className="relative">
          <button
            type="button"
            className={
              "flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-100 " +
              (menu === "templates" ? "bg-brand-50 text-brand-ink" : "")
            }
            onClick={() => setMenu(menu === "templates" ? null : "templates")}
            title="Insert a template"
          >
            <LayoutTemplate size={16} />
            Templates
            <ChevronDown size={14} />
          </button>
          <Popover open={menu === "templates"} onClose={closeMenu} className="left-0 w-56">
            <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Templates
            </p>
            <div className="grid">
              {WHITEBOARD_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100"
                  onClick={() => {
                    placeTemplate(buildTemplate(t.id).nodes);
                    closeMenu();
                  }}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </Popover>
        </div>

        <span className="mx-1 h-6 w-px bg-neutral-200" aria-hidden />

        {/* Connect: join the two selected nodes with an elbow connector. */}
        <IconButton
          onClick={addConnector}
          disabled={!canConnect}
          tooltip={canConnect ? "Connect the two selected nodes (C)" : "Select two nodes to connect (or drag a node's blue handle)"}
          aria-label="Connect selected nodes"
        >
          <Spline size={18} />
        </IconButton>

        {/* Connector style picker (FR-7): appears while a connector is selected. */}
        {selectedRoute && (
          <div className="flex items-center gap-0.5" role="group" aria-label="Connector style">
            {([
              { route: "straight" as const, icon: Minus, label: "Straight" },
              { route: "elbow" as const, icon: CornerDownRight, label: "Elbow" },
              { route: "curved" as const, icon: Spline, label: "Curved" },
            ]).map(({ route, icon: Icon, label }) => (
              <IconButton
                key={route}
                active={selectedRoute === route}
                onClick={() => useEditor.getState().setConnectorRoute(route)}
                tooltip={`${label} connector`}
                aria-label={`${label} connector`}
              >
                <Icon size={18} />
              </IconButton>
            ))}
          </div>
        )}

        <span className="mx-1 h-6 w-px bg-neutral-200" aria-hidden />

        {/* Auto-layout */}
        <IconButton
          onClick={runFlowchart}
          tooltip="Auto-layout flowchart (arranges connected nodes)"
          aria-label="Auto-layout flowchart"
        >
          <Workflow size={18} />
        </IconButton>
        <IconButton onClick={runMindMap} tooltip="Mind-map layout (arranges connected nodes)" aria-label="Mind-map layout">
          <Network size={18} />
        </IconButton>
        <IconButton onClick={copyAsMermaid} tooltip="Copy as Mermaid (selection, or the whole board)" aria-label="Copy as Mermaid code">
          <FileCode2 size={18} />
        </IconButton>

        {designId && (
          <>
            <span className="mx-1 h-6 w-px bg-neutral-200" aria-hidden />
            <IconButton
              onClick={convertToDeck}
              disabled={converting}
              tooltip="Convert this board into a presentation deck"
              aria-label="Convert to deck"
            >
              {converting ? <Loader2 size={18} className="animate-spin" /> : <Presentation size={18} />}
            </IconButton>
          </>
        )}

        <span className="mx-1 h-6 w-px bg-neutral-200" aria-hidden />

        {/* Focus / full-screen: hide the editor chrome so only the board canvas
            and this toolbar remain (also drives the browser Fullscreen API). */}
        <IconButton
          active={boardFocus}
          onClick={toggleBoardFocus}
          tooltip={boardFocus ? "Exit focus mode (Esc)" : "Focus mode - hide panels (full screen)"}
          aria-label={boardFocus ? "Exit focus mode" : "Enter focus mode"}
        >
          {boardFocus ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
        </IconButton>

        <span className="mx-1 h-6 w-px bg-neutral-200" aria-hidden />

        {/* Participants + moderation (FR-32): editors can remove/ban a participant
            (server-enforced kick + rejoin ban). Shown only to editors with peers. */}
        {canFacilitate && Object.keys(peers).length > 0 && (
          <div className="relative">
            <button
              type="button"
              className={
                "flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-100 " +
                (menu === "participants" ? "bg-brand-50 text-brand-ink" : "")
              }
              onClick={() => setMenu(menu === "participants" ? null : "participants")}
              title="Participants / moderation"
            >
              <UserX size={16} />
            </button>
            <Popover open={menu === "participants"} onClose={closeMenu} className="left-0 w-64">
              <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                Participants
              </p>
              <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                {Object.values(peers).map((p) => (
                  <li key={p.clientId} className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-neutral-100">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
                    <span className="flex-1 truncate text-neutral-700">
                      {p.name}
                      {facilitator?.clientId === p.clientId && <span className="ml-1 text-[10px] font-semibold uppercase text-amber-600">facilitator</span>}
                    </span>
                    {amFacilitator && facilitator?.clientId !== p.clientId && (
                      <button type="button" onClick={() => getRealtimeClient()?.sendFacilitator("handoff", p.clientId)} title="Make facilitator" className="rounded px-1.5 py-0.5 text-[11px] text-amber-700 hover:bg-amber-50">
                        Make facilitator
                      </button>
                    )}
                    <button type="button" onClick={() => moderate("kick", p.userId)} title="Remove from board" className="rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-200">
                      Remove
                    </button>
                    <button type="button" onClick={() => moderate("ban", p.userId)} title="Ban (block rejoin)" className="rounded px-1.5 py-0.5 text-[11px] text-red-600 hover:bg-red-50">
                      Ban
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 px-1 text-[11px] leading-relaxed text-neutral-400">
                Remove disconnects a participant; Ban also blocks them from rejoining this board.
              </p>
            </Popover>
          </div>
        )}

        {/* Saved views + agenda + deep-links (FR-3, FR-34) */}
        <div className="relative">
          <button
            type="button"
            className={
              "flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-100 " +
              (menu === "views" ? "bg-brand-50 text-brand-ink" : "")
            }
            onClick={() => setMenu(menu === "views" ? null : "views")}
            title="Saved views / agenda"
          >
            <Bookmark size={16} />
          </button>
          <Popover open={menu === "views"} onClose={closeMenu} className="left-0 w-64">
            <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Saved views
            </p>
            {views.length === 0 && (
              <p className="px-1 pb-2 text-xs text-neutral-500">Save the current viewport to recall or step through it as an agenda.</p>
            )}
            {views.length > 0 && (
              <ul className="mb-2 max-h-48 space-y-0.5 overflow-y-auto">
                {views.map((vw) => (
                  <li
                    key={vw.id}
                    className={"flex items-center gap-1 rounded-lg px-1.5 py-1 text-sm hover:bg-neutral-100 " + (vw.id === agendaId ? "bg-brand-50" : "")}
                  >
                    <button type="button" onClick={() => recallView(vw)} className="flex-1 truncate text-left text-neutral-700" title="Recall this view">
                      {vw.name}
                    </button>
                    <button type="button" onClick={() => copyViewLink(vw.id)} title="Copy deep link" aria-label="Copy deep link" className="rounded p-1 text-neutral-400 hover:text-neutral-700">
                      <Copy size={13} />
                    </button>
                    <button type="button" onClick={() => deleteView(vw.id)} title="Delete view" aria-label="Delete view" className="rounded p-1 text-neutral-400 hover:text-red-600">
                      <Minus size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Button size="sm" block onClick={saveCurrentView}>Save current view</Button>
            {views.length > 1 && (
              <div className="mt-2 flex items-center justify-between gap-2 border-t border-neutral-100 pt-2">
                <span className="px-1 text-xs text-neutral-500">Agenda</span>
                <div className="flex items-center gap-1">
                  <IconButton onClick={() => stepAgenda(-1)} title="Previous view" aria-label="Previous view"><ChevronLeft size={16} /></IconButton>
                  <IconButton onClick={() => stepAgenda(1)} title="Next view" aria-label="Next view"><ChevronRight size={16} /></IconButton>
                </div>
              </div>
            )}
          </Popover>
        </div>

        {/* Timer */}
        <div className="relative">
          <button
            type="button"
            className={
              "flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium tabular-nums text-neutral-700 transition hover:bg-neutral-100 " +
              (menu === "timer" ? "bg-brand-50 text-brand-ink" : "")
            }
            onClick={() => setMenu(menu === "timer" ? null : "timer")}
            title="Countdown timer"
          >
            <TimerIcon size={16} />
            {fmt2(remMin)}:{fmt2(remSec)}
          </button>
          <Popover open={menu === "timer"} onClose={closeMenu} className="left-0 w-64">
            <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Countdown timer
            </p>
            <div className="mb-3 text-center text-3xl font-semibold tabular-nums text-neutral-800">
              {fmt2(remMin)}:{fmt2(remSec)}
            </div>
            <div className="mb-3 flex items-center gap-1">
              {TIMER_PRESETS.map((m) => (
                <button
                  key={m}
                  type="button"
                  title={m === 25 ? "Pomodoro" : `${m} minutes`}
                  className="flex-1 rounded-lg border border-neutral-200 py-1 text-xs text-neutral-700 hover:bg-neutral-50"
                  onClick={() => setTimerMinutes(m)}
                >
                  {m}m
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              {timer.running ? (
                <Button size="sm" variant="secondary" block onClick={onTimerPause}>
                  <Pause size={14} /> Pause
                </Button>
              ) : (
                <Button size="sm" block onClick={onTimerStart}>
                  <Play size={14} /> Start
                </Button>
              )}
              <IconButton onClick={onTimerReset} title="Reset" aria-label="Reset timer">
                <RotateCcw size={16} />
              </IconButton>
            </div>
          </Popover>
        </div>

        {/* Dot voting */}
        <div className="relative">
          <button
            type="button"
            className={
              "flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-100 " +
              (menu === "vote" ? "bg-brand-50 text-brand-ink" : "")
            }
            onClick={() => setMenu(menu === "vote" ? null : "vote")}
            title="Dot voting"
          >
            <Vote size={16} />
            Vote
            {hasRound && roundOpen && (
              <span className="ml-0.5 rounded-full bg-brand-500 px-1.5 text-[10px] font-semibold text-white">
                {displayRemaining}
              </span>
            )}
          </button>
          <Popover open={menu === "vote"} onClose={closeMenu} className="left-0 w-72">
            <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Dot voting{canServerVote ? "" : " (offline)"}
            </p>
            {!hasRound && <VoteSetup onOpen={doOpenVote} />}
            {hasRound && roundPending && (
              <p className="flex items-center gap-2 px-1 py-3 text-xs text-neutral-500">
                <Loader2 size={14} className="animate-spin" /> Loading round…
              </p>
            )}
            {hasRound && !roundPending && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs text-neutral-600">
                  <span>
                    {roundOpen ? "Round open" : "Round closed"}
                    {roundAnon ? " · anonymous" : ""}
                  </span>
                  <span className="font-medium tabular-nums">
                    {displayRemaining}/{roundBudget} left
                  </span>
                </div>

                {roundOpen && (
                  <Button size="sm" block variant="secondary" onClick={doVoteSelection}>
                    <Share2 size={14} /> Vote for selected node
                  </Button>
                )}

                <div className="max-h-40 overflow-auto rounded-lg border border-neutral-100">
                  {Object.keys(displayCounts).length === 0 ? (
                    <p className="px-2 py-3 text-center text-xs text-neutral-400">
                      No votes yet. Select a node and vote.
                    </p>
                  ) : (
                    <ul className="divide-y divide-neutral-100">
                      {Object.entries(displayCounts)
                        .sort((a, b) => b[1] - a[1])
                        .map(([nodeId, count]) => (
                          <li
                            key={nodeId}
                            className="flex items-center justify-between px-2 py-1.5 text-xs"
                          >
                            <span className="truncate text-neutral-600">{nodeId.slice(0, 12)}…</span>
                            <span className="ml-2 inline-flex items-center gap-1 font-semibold text-neutral-800">
                              <span className="h-2 w-2 rounded-full bg-brand-500" aria-hidden />
                              {count}
                            </span>
                          </li>
                        ))}
                    </ul>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {roundOpen ? (
                    <Button size="sm" block onClick={doCloseVote}>
                      Close &amp; reveal
                    </Button>
                  ) : (
                    <Button size="sm" block variant="secondary" onClick={doNewRound}>
                      New round
                    </Button>
                  )}
                </div>
              </div>
            )}
          </Popover>
        </div>

        {/* Emoji reactions: one-shot pings broadcast to peers and
            echoed locally so the sender always sees feedback. Available even
            offline (the local echo plays; the broadcast is a no-op). */}
        <span className="mx-1 h-6 w-px bg-neutral-200" aria-hidden />
        <div className="flex items-center gap-0.5" role="group" aria-label="Send a reaction">
          {REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="grid h-9 w-8 place-items-center rounded-lg text-lg leading-none transition hover:bg-neutral-100"
              onClick={() => sendReaction(emoji)}
              title={`React ${emoji}`}
              aria-label={`React ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>

      </div>

      {/* Local reaction echo: the sender's own emoji floats up from the bottom
          center so reactions are visible to the actor (and when solo). Peers'
          reactions float near their cursors via PresenceOverlay. */}
      {localReactions.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-10 z-20 flex justify-center gap-2">
          {localReactions.map((r) => (
            <span key={r.id} className="oc-reaction-rise text-4xl leading-none">
              {r.emoji}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// On-board find overlay (FR-2): live-filters board content via @hc/whiteboard
// searchNodes and jumps the viewport to a chosen match. Self-contained: owns its
// query state and reads the live doc; re-runs as content changes (rev).
function BoardSearch({ onClose }: { onClose: () => void }): React.ReactElement {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEditor((s) => s.rev); // re-render (and re-run the scan) as board content changes
  const page = useEditor((s) => s.doc.pages[Math.min(s.activePage, s.doc.pages.length - 1)]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  // searchNodes is a cheap substring scan; recompute each render (the component
  // only re-renders on rev/page/query changes).
  const matches: SearchMatch[] = page ? searchNodes(page.children, q) : [];
  const jump = (id: string) => useEditor.getState().jumpToNode(id);
  return (
    <div className="absolute right-3 top-3 z-30 w-72 overflow-hidden rounded-xl border border-neutral-200 bg-surface shadow-lg">
      <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-2">
        <Search size={15} className="shrink-0 text-neutral-400" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); onClose(); }
            else if (e.key === "Enter" && matches.length) { e.preventDefault(); jump(matches[0].nodeId); }
          }}
          placeholder="Find on board"
          aria-label="Find on board"
          className="min-w-0 flex-1 bg-transparent text-sm text-neutral-800 outline-none placeholder:text-neutral-400"
        />
        <button onClick={onClose} aria-label="Close search" className="shrink-0 rounded px-1 text-neutral-400 hover:text-neutral-600">
          Esc
        </button>
      </div>
      {q.trim() && (
        <div className="max-h-72 overflow-auto py-1">
          {matches.length === 0 ? (
            <p className="px-3 py-2 text-xs text-neutral-400">No matches</p>
          ) : (
            matches.map((m) => (
              <button
                key={m.nodeId}
                onClick={() => jump(m.nodeId)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100"
              >
                <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-500">{m.kind}</span>
                <span className="min-w-0 flex-1 truncate">{m.text}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Inline setup form for a new voting round.
function VoteSetup(props: {
  onOpen: (budget: number, anonymous: boolean) => void;
}): React.ReactElement {
  const [budget, setBudget] = useState(3);
  const [anonymous, setAnonymous] = useState(true);
  return (
    <div className="space-y-3">
      <label className="flex items-center justify-between text-sm text-neutral-700">
        Votes per person
        <input
          type="number"
          min={1}
          max={20}
          value={budget}
          onChange={(e) => setBudget(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
          className="w-16 rounded-lg border border-neutral-200 px-2 py-1 text-right text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
        />
      </label>
      <label className="flex items-center justify-between text-sm text-neutral-700">
        Anonymous
        <input
          type="checkbox"
          checked={anonymous}
          onChange={(e) => setAnonymous(e.target.checked)}
          className="h-4 w-4 accent-brand-500"
        />
      </label>
      <Button size="sm" block onClick={() => props.onOpen(budget, anonymous)}>
        <Vote size={14} /> Open round
      </Button>
    </div>
  );
}
