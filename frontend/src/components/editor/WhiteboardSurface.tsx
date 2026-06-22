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
  ChevronDown,
  Circle,
  GripVertical,
  LayoutTemplate,
  Loader2,
  MessageCircle,
  Network,
  Pause,
  Play,
  Presentation,
  RotateCcw,
  Share2,
  Spline,
  Square,
  StickyNote,
  Timer as TimerIcon,
  Type,
  Vote,
  Workflow,
} from "lucide-react";
import {
  buildTemplate,
  castVote,
  layoutFlowchart,
  layoutMindMap,
  pauseTimer,
  remainingBudget,
  resetTimer,
  startTimer,
  tallyVotes,
  timerRemainingMs,
  WHITEBOARD_TEMPLATES,
  type Graph,
  type TimerState,
  type VoteSession,
  type WhiteboardMeta,
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
import type { WhiteboardToDeckResult } from "@hc/sdk";
import { useToast } from "@/components/ui/Toast";
import { useEditor } from "@/store/editor";
import { usePresence } from "@/store/presence";
import { serverNow } from "@/lib/realtime";
import { getRealtimeClient } from "@/lib/useRealtime";
import { Canvas } from "./Canvas";

// Ephemeral reaction palette: a fixed set of one-shot pings.
const REACTION_EMOJIS = ["👍", "❤️", "😂", "🎉", "👀", "✅"] as const;

// The draggable toolbar position is a per-user UI preference, persisted in
// localStorage (NOT the doc) so each collaborator keeps their own placement.
const TOOLBAR_POS_KEY = "oc-wb-toolbar-pos";
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
// Cap on the cursor-chat message length.
const CHAT_MAX_LEN = 200;

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
        "absolute z-20 mt-2 rounded-xl border border-neutral-200 bg-white p-3 shadow-xl " +
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
  // Connect is enabled only when exactly two nodes are selected.
  const canConnect = useEditor((s) => s.selection.length === 2);

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

  const [menu, setMenu] = useState<null | "templates" | "shapes" | "timer" | "vote">(null);
  const closeMenu = useCallback(() => setMenu(null), []);

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

  // Cursor-chat composer: open the input, broadcast on each
  // change, and clear (chat: null) + close on Enter/Escape/blur or when empty.
  const [chatOpen, setChatOpen] = useState(false);
  const [chatText, setChatText] = useState("");
  const closeChat = useCallback(() => {
    getRealtimeClient()?.sendPresence({ chat: null });
    setChatText("");
    setChatOpen(false);
  }, []);
  const onChatChange = useCallback((value: string) => {
    const text = value.slice(0, CHAT_MAX_LEN);
    setChatText(text);
    if (text) getRealtimeClient()?.sendPresence({ chat: text });
    else getRealtimeClient()?.sendPresence({ chat: null });
  }, []);
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

  // Live clock tick (250ms) so the countdown re-renders while running. The
  // displayed remaining time is computed from serverNow() (the shared server
  // clock) so every participant sees the same countdown.
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    const id = window.setInterval(() => setNow(serverNow()), 250);
    return () => window.clearInterval(id);
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

  const fmt2 = (n: number) => String(n).padStart(2, "0");

  return (
    <div ref={surfaceRef} className="relative flex min-w-0 flex-1">
      {/* The board: the existing design canvas (engine-rendered). It owns pan,
          zoom, marquee-select, and move for the whiteboard nodes. */}
      <Canvas />

      {/* Empty-state hint, centered, non-interactive so it never eats canvas
          pointer events. */}
      {isEmpty && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="rounded-2xl border border-dashed border-neutral-300 bg-white/70 px-6 py-5 text-center backdrop-blur-sm">
            <p className="text-sm font-medium text-neutral-700">Your board is empty</p>
            <p className="mt-1 text-xs text-neutral-500">
              Add a sticky, or pick a template to get started.
            </p>
          </div>
        </div>
      )}

      {/* Floating toolbar. Absolutely positioned so it only captures pointer
          events on its own controls; draggable by the grip handle (defaults to
          the top-left until moved). */}
      <div
        ref={toolbarRef}
        className="absolute z-10 flex items-center gap-1 rounded-2xl border border-neutral-200 bg-white/95 p-1.5 shadow-lg backdrop-blur"
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
        <IconButton onClick={addFrame} tooltip="Add frame / section (F)" aria-label="Add frame">
          <LayoutTemplate size={18} />
        </IconButton>
        <IconButton onClick={addTextBox} tooltip="Add text (T)" aria-label="Add text">
          <Type size={18} />
        </IconButton>

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
              (menu === "templates" ? "bg-brand-50 text-brand-700" : "")
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

        {/* Timer */}
        <div className="relative">
          <button
            type="button"
            className={
              "flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium tabular-nums text-neutral-700 transition hover:bg-neutral-100 " +
              (menu === "timer" ? "bg-brand-50 text-brand-700" : "")
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
              {[1, 3, 5, 10, 15].map((m) => (
                <button
                  key={m}
                  type="button"
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
              (menu === "vote" ? "bg-brand-50 text-brand-700" : "")
            }
            onClick={() => setMenu(menu === "vote" ? null : "vote")}
            title="Dot voting"
          >
            <Vote size={16} />
            Vote
            {vote?.open && (
              <span className="ml-0.5 rounded-full bg-brand-500 px-1.5 text-[10px] font-semibold text-white">
                {myRemaining}
              </span>
            )}
          </button>
          <Popover open={menu === "vote"} onClose={closeMenu} className="left-0 w-72">
            <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Dot voting
            </p>
            {!vote && <VoteSetup onOpen={openVoteRound} />}
            {vote && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs text-neutral-600">
                  <span>
                    {vote.open ? "Round open" : "Round closed"}
                    {vote.anonymous ? " · anonymous" : ""}
                  </span>
                  <span className="font-medium tabular-nums">
                    {myRemaining}/{vote.budgetPerUser} left
                  </span>
                </div>

                {vote.open && (
                  <Button size="sm" block variant="secondary" onClick={voteForSelection}>
                    <Share2 size={14} /> Vote for selected node
                  </Button>
                )}

                <div className="max-h-40 overflow-auto rounded-lg border border-neutral-100">
                  {Object.keys(tallies).length === 0 ? (
                    <p className="px-2 py-3 text-center text-xs text-neutral-400">
                      No votes yet. Select a node and vote.
                    </p>
                  ) : (
                    <ul className="divide-y divide-neutral-100">
                      {Object.entries(tallies)
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
                  {vote.open ? (
                    <Button size="sm" block onClick={closeVoteRound}>
                      Close &amp; reveal
                    </Button>
                  ) : (
                    <Button size="sm" block variant="secondary" onClick={clearVoteRound}>
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

        {/* Cursor chat: only meaningful with live peers. */}
        {hasLiveClient && (
          <>
            <span className="mx-1 h-6 w-px bg-neutral-200" aria-hidden />
            {chatOpen ? (
              <input
                type="text"
                autoFocus
                value={chatText}
                maxLength={CHAT_MAX_LEN}
                placeholder="Say something…"
                aria-label="Cursor chat message"
                className="h-9 w-44 rounded-lg border border-neutral-200 px-2.5 text-sm text-neutral-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                onChange={(e) => onChatChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "Escape") {
                    e.preventDefault();
                    closeChat();
                  }
                }}
                onBlur={closeChat}
              />
            ) : (
              <button
                type="button"
                className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-100"
                onClick={() => setChatOpen(true)}
                title="Cursor chat"
              >
                <MessageCircle size={16} />
                Say something
              </button>
            )}
          </>
        )}
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
