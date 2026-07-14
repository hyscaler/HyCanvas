// Selection overlay drawn above the canvas in screen space: a bounding outline,
// eight resize handles, and a rotate handle for a single selection (positioned
// at the node's true transformed corners), or a union box for multi-selection.
// Handles drive @hc/editor transform ops; one drag = one undo step.

import { useRef, useState } from "react";
import type { Size, TextNode, Transform } from "@hc/schema";
import { measuredTextHeight, minContentWidth } from "@/lib/textFit";
import { relayGridCells } from "@/store/editor";
import { overlay } from "@/lib/theme.generated";
import {
  locate,
  parentSpaceDelta,
  resizeNode,
  resizeSpacingSnap,
  rotateAboutCenter,
  unionAABB,
  worldAABB,
  worldMatrix,
  type EditCommand,
  type HandleId,
} from "@hc/editor";
import type { Mat2D, Rect } from "@hc/engine";
import { useEditor } from "@/store/editor";
import { usePresence } from "@/store/presence";
import { useBrand } from "@/store/brand";
import type { CanvasApi } from "@/lib/useEditorCanvas";

// True when any of `ids` is uneditable: collab-locked by another user (FR-8)
// OR a brand-template locked region for this caller.
// Used to block transform gestures on contended/locked nodes; the holder and a
// manage-brand user are unaffected. No-op (false) when realtime is offline and
// no kit is active.
function anyLockedByOther(ids: string[]): boolean {
  const p = usePresence.getState();
  const b = useBrand.getState();
  // collab-lock by another user, brand locked region, OR a facilitator/protected
  // lock this client doesn't own (FR-16) - all block resize/rotate.
  return ids.some((id) => p.collabLockedByOther(id) !== null || b.isLockedRegion(id) || p.protectedByOther(id));
}

const HANDLES: { id: HandleId; fx: number; fy: number }[] = [
  { id: "nw", fx: 0, fy: 0 },
  { id: "n", fx: 0.5, fy: 0 },
  { id: "ne", fx: 1, fy: 0 },
  { id: "e", fx: 1, fy: 0.5 },
  { id: "se", fx: 1, fy: 1 },
  { id: "s", fx: 0.5, fy: 1 },
  { id: "sw", fx: 0, fy: 1 },
  { id: "w", fx: 0, fy: 0.5 },
];

function apply(m: Mat2D, x: number, y: number) {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

const CORNERS = new Set(["nw", "ne", "se", "sw"]);

// A custom rotate cursor (curved arrow) for rotate handles. CSS has no native
// rotate cursor, so we embed an SVG data-URI with a white halo for contrast on
// any background; hotspot at the icon centre. Falls back to grab if unsupported.
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
    '<path d="M19 12a7 7 0 1 1-2.05-4.95" fill="none" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round"/>' +
    '<path d="M19 4v4h-4" fill="none" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M19 12a7 7 0 1 1-2.05-4.95" fill="none" stroke="#111827" stroke-width="1.6" stroke-linecap="round"/>' +
    '<path d="M19 4v4h-4" fill="none" stroke="#111827" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>",
)}") 12 12, grab`;

// The directional resize cursor for a handle. Derived from the handle's resize
// direction in the BOX's own axes (fx,fy in 0..1), plus the box's on-screen
// rotation, so corners always read as a diagonal (nwse/nesw) regardless of the
// box's aspect ratio, and every handle stays correct when the node is rotated.
// (Using the angle to the box center instead mislabels corners of a wide, short
// box, e.g. a text box, as a horizontal ew-resize.) Snapped to the four resize
// cursors at 45deg increments. `ex` is the box's screen-space
// x-axis vector (top-right corner minus top-left).
function resizeCursor(fx: number, fy: number, ex: { x: number; y: number }): string {
  const baseDeg = (Math.atan2(fy - 0.5, fx - 0.5) * 180) / Math.PI; // outward dir in box space
  const rotDeg = (Math.atan2(ex.y, ex.x) * 180) / Math.PI; // node's on-screen rotation
  const a = (((baseDeg + rotDeg) % 180) + 180) % 180; // fold opposite handles together
  if (a < 22.5 || a >= 157.5) return "ew-resize";
  if (a < 67.5) return "nwse-resize";
  if (a < 112.5) return "ns-resize";
  return "nesw-resize";
}

// Scale every run's font size by `factor`, reading sizes from the drag-start
// snapshot so the scaling doesn't compound across move events.
function scaleTextFonts(node: { content?: unknown }, startContent: unknown, factor: number) {
  const cur = (node.content ?? []) as { runs: { style: { fontSize: number } }[] }[];
  const start = (startContent ?? []) as { runs: { style: { fontSize: number } }[] }[];
  cur.forEach((p, pi) =>
    p.runs.forEach((run, ri) => {
      const base = start[pi]?.runs[ri]?.style.fontSize;
      if (base != null) run.style.fontSize = Math.max(1, base * factor);
    }),
  );
}

function surfacePoint(e: { clientX: number; clientY: number }) {
  const r = document.getElementById("oc-canvas-surface")?.getBoundingClientRect();
  return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: e.clientX, y: e.clientY };
}

/**
 * Transform gizmo for a multi-selection or a group: resize scales every selected
 * top-level node about the opposite corner (corners uniform, edges single-axis),
 * and rotate spins them about the selection center. One drag = one undo step.
 */
function SelectionGizmo({ api, ids }: { api: CanvasApi; ids: string[] }) {
  useEditor((s) => s.rev);
  useEditor((s) => s.viewport);
  const transforming = useEditor((s) => s.transforming);
  const drag = useRef<{
    mode: "resize" | "rotate";
    fx: number;
    fy: number;
    anchor: { x: number; y: number };
    center: { x: number; y: number };
    startHandle: { x: number; y: number };
    startAngle: number;
    before: Map<string, Transform>;
  } | null>(null);

  const doc = useEditor.getState().doc;
  const box = unionAABB(doc, ids);
  if (!box) return null;
  const tl = api.toScreen({ x: box.x, y: box.y });
  const br = api.toScreen({ x: box.x + box.width, y: box.y + box.height });
  const sx = (fx: number) => tl.x + (br.x - tl.x) * fx;
  const sy = (fy: number) => tl.y + (br.y - tl.y) * fy;

  function begin(e: React.PointerEvent, mode: "resize" | "rotate", fx: number, fy: number) {
    e.stopPropagation();
    // Block the whole gesture if any node in the selection is collab-locked by
    // another participant: a group resize/rotate would otherwise
    // move a node out from under its holder.
    if (anyLockedByOther(ids)) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const before = new Map<string, Transform>();
    for (const id of ids) {
      const loc = locate(useEditor.getState().doc, id);
      if (loc && !loc.node.locked) before.set(id, { ...loc.node.transform });
    }
    // Rotation pivot: the box center by default, or the node's chosen rotation
    // origin (transform.origin, normalized 0..1) when set on a single selection.
    // Computed from the node's world matrix so it is exact for rotated nodes.
    let center = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    if (ids.length === 1) {
      const loc = locate(useEditor.getState().doc, ids[0]);
      const og = loc?.node.transform.origin;
      if (loc && og) {
        const m = worldMatrix(useEditor.getState().doc, ids[0]);
        if (m) {
          const px = loc.node.size.width * og.x;
          const py = loc.node.size.height * og.y;
          center = { x: m.a * px + m.c * py + m.e, y: m.b * px + m.d * py + m.f };
        }
      }
    }
    drag.current = {
      mode,
      fx,
      fy,
      anchor: { x: fx === 1 ? box!.x : box!.x + box!.width, y: fy === 1 ? box!.y : box!.y + box!.height },
      center,
      startHandle: { x: box!.x + box!.width * fx, y: box!.y + box!.height * fy },
      startAngle: 0,
      before,
    };
    if (mode === "rotate") {
      const c = drag.current.center;
      drag.current.startAngle = Math.atan2(box!.y - c.y, box!.x + box!.width / 2 - c.x); // handle starts at top-center
    }
    useEditor.getState().setTransforming(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
  }

  // Escape abandons the resize/rotate, restoring every node to its start
  // transform without pushing to history (pro-editor style).
  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    const d = drag.current;
    drag.current = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("keydown", onKey);
    useEditor.getState().setTransforming(false);
    if (!d) return;
    const store = useEditor.getState();
    for (const [id, t0] of d.before) {
      const loc = locate(store.doc, id);
      if (loc) loc.node.transform = { ...t0 };
    }
    store.tick();
  }

  function onMove(e: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const p = api.toPage(surfacePoint(e));
    const store = useEditor.getState();
    if (d.mode === "resize") {
      const corner = d.fx !== 0.5 && d.fy !== 0.5;
      let fX = 1;
      let fY = 1;
      if (corner) {
        const num = Math.hypot(p.x - d.anchor.x, p.y - d.anchor.y);
        const den = Math.hypot(d.startHandle.x - d.anchor.x, d.startHandle.y - d.anchor.y) || 1;
        fX = fY = Math.max(0.02, num / den); // corners scale uniformly
      } else if (d.fx !== 0.5) {
        fX = Math.max(0.02, (p.x - d.anchor.x) / ((d.startHandle.x - d.anchor.x) || 1));
      } else {
        fY = Math.max(0.02, (p.y - d.anchor.y) / ((d.startHandle.y - d.anchor.y) || 1));
      }
      for (const [id, t0] of d.before) {
        const loc = locate(store.doc, id);
        if (!loc) continue;
        loc.node.transform = {
          ...t0,
          x: d.anchor.x + (t0.x - d.anchor.x) * fX,
          y: d.anchor.y + (t0.y - d.anchor.y) * fY,
          scaleX: t0.scaleX * fX,
          scaleY: t0.scaleY * fY,
        };
      }
    } else {
      const ang = Math.atan2(p.y - d.center.y, p.x - d.center.x);
      let deltaDeg = ((ang - d.startAngle) * 180) / Math.PI;
      if (e.shiftKey) deltaDeg = Math.round(deltaDeg / 15) * 15;
      else if (useEditor.getState().snapEnabled) {
        // Soft-snap the group rotation to the nearest 45 deg (straight/diagonal)
        // when within a few degrees, so it clicks into clean angles.
        const n = Math.round(deltaDeg / 45) * 45;
        if (Math.abs(deltaDeg - n) < 3) deltaDeg = n;
      }
      const rad = (deltaDeg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      for (const [id, t0] of d.before) {
        const loc = locate(store.doc, id);
        if (!loc) continue;
        const dx = t0.x - d.center.x;
        const dy = t0.y - d.center.y;
        loc.node.transform = {
          ...t0,
          x: d.center.x + dx * cos - dy * sin,
          y: d.center.y + dx * sin + dy * cos,
          rotation: t0.rotation + deltaDeg,
        };
      }
    }
    store.tick();
  }

  function onUp() {
    const d = drag.current;
    drag.current = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("keydown", onKey);
    useEditor.getState().setTransforming(false);
    if (!d) return;
    const store = useEditor.getState();
    const nodes: string[] = [];
    const before: Transform[] = [];
    const after: Transform[] = [];
    for (const [id, t0] of d.before) {
      const loc = locate(store.doc, id);
      if (!loc) continue;
      nodes.push(id);
      before.push(t0);
      after.push({ ...loc.node.transform });
    }
    if (nodes.length) store.pushApplied([{ kind: "transform", nodes, before, after }]);
  }

  const handles: { fx: number; fy: number; cursor: string }[] = [
    { fx: 0, fy: 0, cursor: "nwse-resize" }, { fx: 0.5, fy: 0, cursor: "ns-resize" }, { fx: 1, fy: 0, cursor: "nesw-resize" },
    { fx: 1, fy: 0.5, cursor: "ew-resize" }, { fx: 1, fy: 1, cursor: "nwse-resize" }, { fx: 0.5, fy: 1, cursor: "ns-resize" },
    { fx: 0, fy: 1, cursor: "nesw-resize" }, { fx: 0, fy: 0.5, cursor: "ew-resize" },
  ];
  // Per-item outlines a thin dashed box around each selected
  // element so it's clear what's in the selection, not just the union bounds.
  // Computed via api.toScreen so it stays correct on any (offset) page.
  const outlines = ids
    .map((sid) => {
      const l = locate(doc, sid);
      const m = worldMatrix(doc, sid);
      if (!l || !m) return null;
      const { width: ow, height: oh } = l.node.size;
      const c = (fx: number, fy: number) => api.toScreen(apply(m, fx * ow, fy * oh));
      return [c(0, 0), c(1, 0), c(1, 1), c(0, 1)];
    })
    .filter(Boolean) as { x: number; y: number }[][];

  return (
    <>
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
        {outlines.map((pts, k) => (
          <polygon key={k} points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={overlay.selection} strokeWidth={1} strokeDasharray="4 3" opacity={0.6} />
        ))}
      </svg>
      <div className="pointer-events-none absolute border-2 border-[color:var(--color-selection)]" style={{ left: tl.x, top: tl.y, width: br.x - tl.x, height: br.y - tl.y }} />
      {/* A fully locked selection keeps its outline (so the lock is visible and
          the toolbar offers Unlock) but no transform handles. */}
      {!ids.every((id) => locate(doc, id)?.node.locked) && (
        <>
          <div
            onPointerDown={(e) => begin(e, "rotate", 0.5, 0)}
            className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[color:var(--color-selection)] bg-surface"
            style={{ left: sx(0.5), top: sy(0) - 26, cursor: ROTATE_CURSOR }}
          />
          {handles.map((h) => (
            <div
              key={`${h.fx},${h.fy}`}
              onPointerDown={(e) => begin(e, "resize", h.fx, h.fy)}
              className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-[color:var(--color-selection)] bg-surface"
              style={{ left: sx(h.fx), top: sy(h.fy), cursor: h.cursor }}
            />
          ))}
        </>
      )}
      {transforming && box && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded bg-neutral-800/90 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white shadow"
          style={{ left: sx(0.5), top: sy(1) + 14 }}
        >
          {Math.round(box.width)} × {Math.round(box.height)}
        </div>
      )}
    </>
  );
}

/** Selection indicator for a connector: a light dashed outline of the routed
 *  line's bounds plus endpoint dots, anchored to the drawn line (not the
 *  connector's origin box). No resize/rotate handles - the line auto-routes. */
function ConnectorSelection({ api, id }: { api: CanvasApi; id: string }) {
  useEditor((s) => s.rev); // re-render when geometry changes
  useEditor((s) => s.viewport); // re-render on pan/zoom
  const b = api.scene()?.connectorBounds(id);
  if (!b) return null;
  const pad = 4;
  const tl = api.toScreen({ x: b.x, y: b.y });
  const br = api.toScreen({ x: b.x + b.width, y: b.y + b.height });
  const x = Math.min(tl.x, br.x) - pad;
  const y = Math.min(tl.y, br.y) - pad;
  const w = Math.abs(br.x - tl.x) + pad * 2;
  const h = Math.abs(br.y - tl.y) + pad * 2;
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      <rect x={x} y={y} width={w} height={h} fill="none" stroke={overlay.selection} strokeWidth={1.5} strokeDasharray="5 4" rx={4} />
      <circle cx={tl.x} cy={tl.y} r={3.5} fill="#fff" stroke={overlay.selection} strokeWidth={1.5} />
      <circle cx={br.x} cy={br.y} r={3.5} fill="#fff" stroke={overlay.selection} strokeWidth={1.5} />
    </svg>
  );
}

export function Gizmo({ api }: { api: CanvasApi }) {
  const selection = useEditor((s) => s.selection);
  // Subscribe to rev + viewport so the overlay tracks edits and pan/zoom.
  useEditor((s) => s.rev);
  useEditor((s) => s.viewport);
  // Show a live size/angle readout while the selection is being moved/resized/rotated.
  const transforming = useEditor((s) => s.transforming);
  // Subscribe to the lock map so handles appear/disappear as a peer locks/unlocks.
  usePresence((s) => s.locks);
  const drag = useRef<{
    id: string;
    handle: HandleId | "rotate";
    startPage: { x: number; y: number };
    startTransform: Transform;
    startSize: Size;
    center?: { x: number; y: number };
    startAngle?: number;
    startContent?: unknown; // text run snapshot, for font-scaling on corner-resize
    startBox?: unknown; // text box snapshot, kept in sync with size so text reflows
    startMinW?: number; // narrowest reflow width (longest word) at the start font
    startMinH?: number; // natural content height at the start font + width
    startPoints?: { x: number; y: number }[]; // line polyline snapshot, scaled with the box on resize
    startChildren?: unknown; // photo-grid cell snapshot, re-laid with the box on resize
  } | null>(null);
  // Equal-size match during a resize: the sibling width/height the dragged
  // dimension has snapped to (null = no match on that axis). The state drives
  // the "same size" outlines in render; the ref mirrors it so the pointermove
  // handler can dedupe and only re-render when the match actually changes.
  const [sizeMatch, setSizeMatch] = useState<{ w: number | null; h: number | null }>({ w: null, h: null });
  const sizeMatchRef = useRef<{ w: number | null; h: number | null }>({ w: null, h: null });
  const updateSizeMatch = (w: number | null, h: number | null) => {
    if (sizeMatchRef.current.w === w && sizeMatchRef.current.h === h) return;
    sizeMatchRef.current = { w, h };
    setSizeMatch({ w, h });
  };
  // Equal-spacing match during a resize: the two now-equal gaps (page coords)
  // between the resized box and its neighbors on the dragged axis, so the render
  // can draw the "matching gap" bars. Deduped on the resulting position.
  type SpacingHint = { axis: "x" | "y"; gap: number; s1: [number, number]; s2: [number, number]; cross: number } | null;
  const [spacingMatch, setSpacingMatch] = useState<SpacingHint>(null);
  const spacingMatchRef = useRef<SpacingHint>(null);
  const updateSpacingMatch = (h: SpacingHint) => {
    const p = spacingMatchRef.current;
    if (p === h || (p && h && p.axis === h.axis && p.gap === h.gap && p.s1[0] === h.s1[0] && p.s1[1] === h.s1[1] && p.s2[0] === h.s2[0] && p.s2[1] === h.s2[1])) return;
    spacingMatchRef.current = h;
    setSpacingMatch(h);
  };

  const doc = useEditor.getState().doc;
  if (selection.length === 0) return null;

  // Multi-selection uses the proportional transform gizmo (resize + rotate).
  if (selection.length > 1) return <SelectionGizmo api={api} ids={selection} />;

  const id = selection[0];
  const loc = locate(doc, id);
  const wm = worldMatrix(doc, id);
  if (!loc || !wm) return null;
  // A group scales as a unit (its children scale with its transform), so it uses
  // the proportional gizmo too rather than the size-based single-node one.
  if (loc.node.type === "group") return <SelectionGizmo api={api} ids={selection} />;
  // A connector is an auto-routed line between two nodes - it has no resizable
  // box (its own transform/size sit at the origin), so show a light outline of
  // the routed line's bounds rather than the size-based resize gizmo.
  if (loc.node.type === "connector") return <ConnectorSelection api={api} id={id} />;
  const { width: w, height: h } = loc.node.size;
  // Map a page-local corner to screen via api.toScreen, which folds in the
  // active page's stacked offset - so the handles are correct on any page, not
  // just page 0 (a raw viewport matrix would be off by the page's offset).
  const corner = (fx: number, fy: number) => api.toScreen(apply(wm, fx * w, fy * h));
  // Hide handles when statically locked (schema flag) OR collab-locked by another
  // participant. The holder of a collab lock keeps full handles.
  const locked = !!loc.node.locked || anyLockedByOther([id]);

  function beginResize(e: React.PointerEvent, handle: HandleId | "rotate") {
    e.stopPropagation();
    if (anyLockedByOther([id])) return; // contended: holder-only gesture

    // Capture the pointer so a release outside the window still ends the drag
    // (and removes the move/up listeners) reliably.
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const startPage = api.toPage(toLocalScreen({ x: e.clientX, y: e.clientY }));
    // Node center in page space (wm is the page-space world matrix).
    const centerPage = apply(wm!, w / 2, h / 2);
    drag.current = {
      id,
      handle,
      startPage,
      startTransform: { ...loc!.node.transform },
      startSize: { ...loc!.node.size },
      center: centerPage,
      startAngle: Math.atan2(startPage.y - centerPage.y, startPage.x - centerPage.x),
      startContent: loc!.node.type === "text" ? structuredClone((loc!.node as unknown as { content: unknown }).content) : undefined,
      startBox: loc!.node.type === "text" ? structuredClone((loc!.node as unknown as { box: unknown }).box) : undefined,
      // Reflow thresholds captured once at the start font, so the two-phase side
      // resize (reflow, then scale past the fit) has a stable pivot per gesture.
      startMinW: loc!.node.type === "text" ? minContentWidth(loc!.node as unknown as TextNode) : undefined,
      startMinH: loc!.node.type === "text" ? measuredTextHeight(loc!.node as unknown as TextNode) : undefined,
      startPoints: loc!.node.type === "line" ? structuredClone((loc!.node as unknown as { points: { x: number; y: number }[] }).points) : undefined,
      startChildren: loc!.node.type === "grid" ? structuredClone((loc!.node as unknown as { children: unknown }).children) : undefined,
    };
    useEditor.getState().setTransforming(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
  }

  // Escape abandons the resize/rotate, restoring the node to its start state
  // (transform + size, and for text the reflowed box + font-scaled content)
  // without pushing to history.
  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    const d = drag.current;
    drag.current = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("keydown", onKey);
    const store = useEditor.getState();
    store.setSnapGuides(null);
    updateSizeMatch(null, null);
    updateSpacingMatch(null);
    store.setTransforming(false);
    if (!d) return;
    const node = locate(store.doc, d.id)?.node;
    if (node) {
      node.transform = { ...d.startTransform };
      node.size = { ...d.startSize };
      if (node.type === "text") {
        const tn = node as unknown as { box: unknown; content: unknown };
        if (d.startBox !== undefined) tn.box = structuredClone(d.startBox);
        if (d.startContent !== undefined) tn.content = structuredClone(d.startContent);
      }
      if (node.type === "line" && d.startPoints) {
        (node as unknown as { points: unknown }).points = structuredClone(d.startPoints);
      }
      if (node.type === "grid" && d.startChildren !== undefined) {
        (node as unknown as { children: unknown }).children = structuredClone(d.startChildren);
      }
      store.tick();
    }
  }

  // Convert a clientX/clientY point to canvas-local screen coordinates.
  function toLocalScreen(p: { x: number; y: number }) {
    const rect = document.getElementById("oc-canvas-surface")?.getBoundingClientRect();
    return rect ? { x: p.x - rect.left, y: p.y - rect.top } : p;
  }

  function onMove(e: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const page = api.toPage(toLocalScreen({ x: e.clientX, y: e.clientY }));
    const store = useEditor.getState();
    const node = locate(store.doc, d.id)?.node;
    if (!node) return;
    if (d.handle === "rotate") {
      const ang = Math.atan2(page.y - d.center!.y, page.x - d.center!.x);
      let deltaDeg = ((ang - (d.startAngle ?? 0)) * 180) / Math.PI;
      if (!e.shiftKey && useEditor.getState().snapEnabled) {
        // Soft-snap the resulting angle to the nearest 45 deg when within a few
        // degrees, so the element clicks into straight/diagonal.
        const finalDeg = (d.startTransform.rotation ?? 0) + deltaDeg;
        const n = Math.round(finalDeg / 45) * 45;
        if (Math.abs(finalDeg - n) < 3) deltaDeg += n - finalDeg;
      }
      node.transform = rotateAboutCenter(d.startTransform, d.startSize, deltaDeg, e.shiftKey);
    } else {
      // Convert the page-space drag into the node's parent space so resizing a
      // node inside a transformed group still tracks the cursor.
      const pd = parentSpaceDelta(store.doc, d.id, page.x - d.startPage.x, page.y - d.startPage.y);
      // Dragging a CORNER of a text box scales the font; edges just
      // resize the box and reflow. Corners are aspect-locked for text/image/group.
      const isTextCorner = node.type === "text" && CORNERS.has(d.handle as string);
      const aspect = node.type === "image" || node.type === "group" || isTextCorner ? !e.shiftKey : e.shiftKey;
      const r = resizeNode(
        { ...node, transform: d.startTransform, size: d.startSize },
        d.handle,
        pd.dx,
        pd.dy,
        { aspect, fromCenter: e.altKey },
      );
      let tf = r.transform;
      let size = r.size;
      // Snap the dragged edge(s) to nearby object/page edges. Only for free
      // (non-aspect) resize of an unrotated, unit-scale, top-level node, where
      // the world box edges map straight to transform + size.
      const loc2 = locate(store.doc, d.id);
      const canSnap =
        !aspect &&
        !e.altKey &&
        store.snapEnabled &&
        loc2 != null &&
        loc2.parent === null &&
        d.startTransform.rotation === 0 &&
        Math.abs(d.startTransform.scaleX) === 1 &&
        Math.abs(d.startTransform.scaleY) === 1;
      const gx: number[] = [];
      const gy: number[] = [];
      let matchW: number | null = null;
      let matchH: number | null = null;
      let spacingHint: SpacingHint = null;
      if (canSnap) {
        const T = 6 / api.viewport().zoom;
        const pg = loc2!.page;
        const xs = [0, pg.width, pg.width / 2];
        const ys = [0, pg.height, pg.height / 2];
        const widths: number[] = [];
        const heights: number[] = [];
        const sibBoxes: Rect[] = [];
        for (const sib of loc2!.siblings) {
          if (sib.id === d.id || (sib as { hidden?: boolean }).hidden) continue;
          const b = worldAABB(store.doc, sib.id);
          if (!b) continue;
          xs.push(b.x, b.x + b.width, b.x + b.width / 2);
          ys.push(b.y, b.y + b.height, b.y + b.height / 2);
          widths.push(b.width);
          heights.push(b.height);
          sibBoxes.push(b);
        }
        const nearest = (cur: number, targets: number[]) => {
          let best: number | null = null;
          let bd = T;
          for (const t of targets) {
            const dd = Math.abs(cur - t);
            if (dd < bd) { bd = dd; best = t; }
          }
          return best;
        };
        const hid = d.handle as string;
        let left = tf.x, right = tf.x + size.width, top = tf.y, bottom = tf.y + size.height;
        if (hid.includes("w")) { const t = nearest(left, xs); if (t != null) { left = t; gx.push(t); } }
        if (hid.includes("e")) { const t = nearest(right, xs); if (t != null) { right = t; gx.push(t); } }
        if (hid.includes("n")) { const t = nearest(top, ys); if (t != null) { top = t; gy.push(t); } }
        if (hid.includes("s")) { const t = nearest(bottom, ys); if (t != null) { bottom = t; gy.push(t); } }
        // Equal-size: on an axis the edge-snap didn't already claim, snap the
        // dragged dimension to a sibling's matching width/height.
        // The anchor edge stays put; the moving edge shifts to hit the size.
        if (!gx.length && (hid.includes("w") || hid.includes("e"))) {
          const t = nearest(right - left, widths);
          if (t != null) { matchW = t; if (hid.includes("e")) right = left + t; else left = right - t; }
        }
        if (!gy.length && (hid.includes("n") || hid.includes("s"))) {
          const t = nearest(bottom - top, heights);
          if (t != null) { matchH = t; if (hid.includes("s")) bottom = top + t; else top = bottom - t; }
        }
        // Snap-to-square (1:1): on a single-axis edge drag, if the dragged
        // dimension comes within threshold of the box's other (fixed) dimension,
        // snap to equal so it becomes a perfect square. Only when neither an edge
        // nor an equal-size snap already claimed the axis; the W x H readout shows it.
        let squared = false;
        if (hid.length === 1) {
          if (!gx.length && matchW == null && (hid === "e" || hid === "w")) {
            const h = bottom - top;
            if (Math.abs((right - left) - h) < T) { if (hid === "e") right = left + h; else left = right - h; squared = true; }
          } else if (!gy.length && matchH == null && (hid === "n" || hid === "s")) {
            const w = right - left;
            if (Math.abs((bottom - top) - w) < T) { if (hid === "s") bottom = top + w; else top = bottom - w; squared = true; }
          }
        }
        // Equal-spacing on resize (lowest precedence, single-axis edge only): move
        // the dragged edge so the box's two neighbor-gaps become equal. Delegated
        // to the pure, unit-tested resizeSpacingSnap. Only when no edge/equal-size/
        // square snap already claimed the axis.
        const spacingAxisFree =
          hid === "e" || hid === "w" ? !gx.length && matchW == null :
          hid === "n" || hid === "s" ? !gy.length && matchH == null : false;
        if (hid.length === 1 && !squared && spacingAxisFree) {
          const rs = resizeSpacingSnap({ x: left, y: top, width: right - left, height: bottom - top }, hid as "e" | "w" | "n" | "s", sibBoxes, T);
          if (rs) {
            if (hid === "e") right += rs.delta;
            else if (hid === "w") left += rs.delta;
            else if (hid === "s") bottom += rs.delta;
            else top += rs.delta;
            spacingHint = { axis: rs.axis, gap: rs.gap, s1: rs.s1, s2: rs.s2, cross: rs.cross };
          }
        }
        tf = { ...tf, x: left, y: top };
        size = { width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
      }
      updateSizeMatch(matchW, matchH);
      updateSpacingMatch(spacingHint);
      node.transform = tf;
      node.size = size;
      store.setSnapGuides(gx.length || gy.length ? { x: gx, y: gy } : null);
      if (node.type === "text") {
        const tn = node as unknown as { box: { width: number; height: number; mode?: string } };
        tn.box = { ...tn.box, width: size.width, height: size.height };
        const scale = (factor: number) => {
          if (d.startContent && factor !== 1) scaleTextFonts(node as unknown as { content?: unknown }, d.startContent, factor);
        };
        if (isTextCorner) {
          // Corner: uniform aspect scale + font by the width ratio (unchanged).
          if (d.startSize.width > 0) scale(size.width / d.startSize.width);
        } else if (d.handle === "e" || d.handle === "w") {
          // Left/right: the box reflows the text at the current font first;
          // only once it's narrower than the tightest wrap (longest word at the
          // start font, startMinW) does the font scale down to keep fitting.
          // Growing never scales up - the text just gets more room.
          const minW = d.startMinW ?? 1;
          scale(size.width < minW ? size.width / minW : 1);
          // Height auto-fits the (reflowed or rescaled) text.
          if (tn.box.mode !== "fixed") {
            const hh = measuredTextHeight(node as unknown as TextNode);
            tn.box.height = hh;
            size = { ...size, height: hh };
            node.size = size;
          }
        } else if (d.handle === "n" || d.handle === "s") {
          // Top/bottom: the box holds the text plus empty space at the current
          // font first; only once it's shorter than the text needs (startMinH)
          // does the font scale down. Growing adds space, never scales up. The
          // box holds the dragged height, so switch off auto-height.
          const minH = d.startMinH ?? 1;
          scale(size.height < minH ? size.height / minH : 1);
          tn.box.mode = "fixed";
        }
      }
      if (node.type === "line" && d.startPoints?.length) {
        // A line is DRAWN from its points, not its size; resizeNode only moves
        // the box, so scale the polyline to match or the handles do nothing
        // visible. An axis the polyline doesn't span (a straight horizontal or
        // vertical line) stays locked to its start box, otherwise the box
        // would drift away from the stroke.
        const xs = d.startPoints.map((p) => p.x);
        const ys = d.startPoints.map((p) => p.y);
        const degX = Math.max(...xs) - Math.min(...xs) < 0.5;
        const degY = Math.max(...ys) - Math.min(...ys) < 0.5;
        if (degX) { size = { ...size, width: d.startSize.width }; tf = { ...tf, x: d.handle.includes("w") || d.handle.includes("e") ? d.startTransform.x : tf.x }; }
        if (degY) { size = { ...size, height: d.startSize.height }; tf = { ...tf, y: d.handle.includes("n") || d.handle.includes("s") ? d.startTransform.y : tf.y }; }
        const kx = degX || d.startSize.width <= 0 ? 1 : size.width / d.startSize.width;
        const ky = degY || d.startSize.height <= 0 ? 1 : size.height / d.startSize.height;
        (node as unknown as { points: { x: number; y: number }[] }).points =
          d.startPoints.map((p) => ({ x: p.x * kx, y: p.y * ky }));
        node.transform = tf;
        node.size = size;
      }
      if (node.type === "grid") {
        // A photo grid's cells are laid out from the grid box, so resizing the
        // grid re-lays every cell (spans preserved, filled images re-cover).
        relayGridCells(node as unknown as Parameters<typeof relayGridCells>[0], size);
      }
    }
    store.tick();
  }

  function onUp() {
    const d = drag.current;
    drag.current = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("keydown", onKey);
    useEditor.getState().setTransforming(false);
    if (!d) return;
    const store = useEditor.getState();
    store.setSnapGuides(null);
    updateSizeMatch(null, null);
    updateSpacingMatch(null);
    const node = locate(store.doc, d.id)?.node;
    if (!node) return;
    // A handle click that didn't actually drag (transform + size unchanged) must
    // not push an empty undo step. Text box/font only change alongside size on an
    // edge/corner drag, so transform+size covers those too.
    const t0 = d.startTransform;
    const t1 = node.transform;
    const changed =
      t1.x !== t0.x || t1.y !== t0.y ||
      t1.scaleX !== t0.scaleX || t1.scaleY !== t0.scaleY ||
      t1.rotation !== t0.rotation ||
      node.size.width !== d.startSize.width || node.size.height !== d.startSize.height;
    if (!changed) return;
    // Any text resize changed the box (and corners the font too); capture box +
    // content in the undo so it round-trips.
    if (node.type === "text" && d.handle !== "rotate") {
      store.pushNodeSnapshot(d.id, { transform: d.startTransform, size: d.startSize, box: d.startBox, content: d.startContent });
      return;
    }
    if (node.type === "line" && d.handle !== "rotate") {
      store.pushNodeSnapshot(d.id, { transform: d.startTransform, size: d.startSize, points: d.startPoints });
      return;
    }
    if (node.type === "grid" && d.handle !== "rotate") {
      store.pushNodeSnapshot(d.id, { transform: d.startTransform, size: d.startSize, children: d.startChildren });
      return;
    }
    const cmd: EditCommand = {
      kind: "transform",
      nodes: [d.id],
      before: [d.startTransform],
      after: [node.transform],
      beforeSizes: [d.startSize],
      afterSizes: [node.size],
    };
    store.pushApplied([cmd]);
  }

  const rot = corner(0.5, 0);
  const top = corner(0.5, 0);
  const ne = corner(1, 0);
  const nw = corner(0, 0);
  // Box's on-screen x-axis (top-left -> top-right), used to make resize cursors
  // rotation-aware while staying independent of the box's aspect ratio.
  const exAxis = { x: ne.x - nw.x, y: ne.y - nw.y };
  // Rotate handle sits ~26px outside the top edge along its outward normal.
  const edgeDx = ne.x - nw.x;
  const edgeDy = ne.y - nw.y;
  const len = Math.hypot(edgeDx, edgeDy) || 1;
  const normal = { x: edgeDy / len, y: -edgeDx / len };
  const rotPos = { x: top.x + normal.x * 26, y: top.y + normal.y * 26 };

  return (
    <>
      {/* Outline polygon through the four transformed corners. */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
        <polygon
          points={[corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)]
            .map((p) => `${p.x},${p.y}`)
            .join(" ")}
          fill="none"
          stroke={overlay.selection}
          strokeWidth={1.5}
        />
        <line x1={rot.x} y1={rot.y} x2={rotPos.x} y2={rotPos.y} stroke={overlay.selection} strokeWidth={1.5} />
      </svg>
      {transforming && (sizeMatch.w != null || sizeMatch.h != null) && (() => {
        // Equal-size hint a dimension bar on the matched edge of
        // the resized element and every sibling that now shares that width/height,
        // so it's clear they're equal. The resized element's bar carries the label.
        const d = useEditor.getState().doc;
        const sm = sizeMatch;
        const near = (x: number, y: number) => Math.abs(x - y) < 0.6;
        const self = worldAABB(d, id);
        const wBoxes: Rect[] = [];
        const hBoxes: Rect[] = [];
        if (self) { if (sm.w != null) wBoxes.push(self); if (sm.h != null) hBoxes.push(self); }
        for (const s of loc.siblings) {
          if (s.id === id || (s as { hidden?: boolean }).hidden) continue;
          const b = worldAABB(d, s.id);
          if (!b) continue;
          if (sm.w != null && near(b.width, sm.w)) wBoxes.push(b);
          if (sm.h != null && near(b.height, sm.h)) hBoxes.push(b);
        }
        const OFF = 10, CAP = 4;
        const els: React.ReactElement[] = [];
        const seg = (x1: number, y1: number, x2: number, y2: number, k: string) => (
          <line key={k} x1={x1} y1={y1} x2={x2} y2={y2} stroke={overlay.guideConflict} strokeWidth={1} />
        );
        const pill = (cx: number, cy: number, text: string, k: string) => {
          const w = text.length * 6.2 + 8;
          return (
            <g key={k}>
              <rect x={cx - w / 2} y={cy - 7} width={w} height={14} rx={3} fill={overlay.guideConflict} />
              <text x={cx} y={cy + 3} fontSize={9} fontWeight={600} textAnchor="middle" fill="#ffffff">{text}</text>
            </g>
          );
        };
        wBoxes.forEach((b, i) => {
          const y = api.toScreen({ x: 0, y: b.y + b.height }).y + OFF;
          const x1 = api.toScreen({ x: b.x, y: 0 }).x;
          const x2 = api.toScreen({ x: b.x + b.width, y: 0 }).x;
          els.push(<g key={`w${i}`}>{seg(x1, y, x2, y, "l")}{seg(x1, y - CAP, x1, y + CAP, "a")}{seg(x2, y - CAP, x2, y + CAP, "b")}</g>);
        });
        hBoxes.forEach((b, i) => {
          const x = api.toScreen({ x: b.x + b.width, y: 0 }).x + OFF;
          const y1 = api.toScreen({ x: 0, y: b.y }).y;
          const y2 = api.toScreen({ x: 0, y: b.y + b.height }).y;
          els.push(<g key={`h${i}`}>{seg(x, y1, x, y2, "l")}{seg(x - CAP, y1, x + CAP, y1, "a")}{seg(x - CAP, y2, x + CAP, y2, "b")}</g>);
        });
        if (self && sm.w != null) {
          const y = api.toScreen({ x: 0, y: self.y + self.height }).y + OFF;
          const cx = (api.toScreen({ x: self.x, y: 0 }).x + api.toScreen({ x: self.x + self.width, y: 0 }).x) / 2;
          els.push(pill(cx, y - 10, String(Math.round(sm.w)), "wl"));
        }
        if (self && sm.h != null) {
          const x = api.toScreen({ x: self.x + self.width, y: 0 }).x + OFF;
          const cy = (api.toScreen({ x: 0, y: self.y }).y + api.toScreen({ x: 0, y: self.y + self.height }).y) / 2;
          els.push(pill(x + 12, cy, String(Math.round(sm.h)), "hl"));
        }
        return els.length ? <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">{els}</svg> : null;
      })()}
      {transforming && spacingMatch && (() => {
        // Equal-spacing hint: the two now-equal gaps between the resized box and
        // its neighbors on the dragged axis, each shown as a capped bar + label.
        const sm = spacingMatch;
        const CAP = 4;
        const els: React.ReactElement[] = [];
        const label = String(Math.round(sm.gap));
        const lw = label.length * 6.2 + 8;
        const drawSeg = (from: number, to: number, key: string) => {
          if (sm.axis === "x") {
            const y = api.toScreen({ x: 0, y: sm.cross }).y;
            const x1 = api.toScreen({ x: from, y: 0 }).x, x2 = api.toScreen({ x: to, y: 0 }).x;
            els.push(
              <g key={key}>
                <line x1={x1} y1={y} x2={x2} y2={y} stroke={overlay.guideConflict} strokeWidth={1} />
                <line x1={x1} y1={y - CAP} x2={x1} y2={y + CAP} stroke={overlay.guideConflict} strokeWidth={1} />
                <line x1={x2} y1={y - CAP} x2={x2} y2={y + CAP} stroke={overlay.guideConflict} strokeWidth={1} />
                {to - from > 1 && (
                  <g>
                    <rect x={(x1 + x2) / 2 - lw / 2} y={y - 15} width={lw} height={14} rx={3} fill={overlay.guideConflict} />
                    <text x={(x1 + x2) / 2} y={y - 5} fontSize={9} fontWeight={600} textAnchor="middle" fill="#ffffff">{label}</text>
                  </g>
                )}
              </g>,
            );
          } else {
            const x = api.toScreen({ x: sm.cross, y: 0 }).x;
            const y1 = api.toScreen({ x: 0, y: from }).y, y2 = api.toScreen({ x: 0, y: to }).y;
            els.push(
              <g key={key}>
                <line x1={x} y1={y1} x2={x} y2={y2} stroke={overlay.guideConflict} strokeWidth={1} />
                <line x1={x - CAP} y1={y1} x2={x + CAP} y2={y1} stroke={overlay.guideConflict} strokeWidth={1} />
                <line x1={x - CAP} y1={y2} x2={x + CAP} y2={y2} stroke={overlay.guideConflict} strokeWidth={1} />
                {to - from > 1 && (
                  <g>
                    <rect x={x + 6} y={(y1 + y2) / 2 - 7} width={lw} height={14} rx={3} fill={overlay.guideConflict} />
                    <text x={x + 6 + lw / 2} y={(y1 + y2) / 2 + 3} fontSize={9} fontWeight={600} textAnchor="middle" fill="#ffffff">{label}</text>
                  </g>
                )}
              </g>,
            );
          }
        };
        drawSeg(sm.s1[0], sm.s1[1], "sp1");
        drawSeg(sm.s2[0], sm.s2[1], "sp2");
        return <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">{els}</svg>;
      })()}
      {!locked && (
        <>
          {HANDLES.map((hd) => {
            const p = corner(hd.fx, hd.fy);
            return (
              <div
                key={hd.id}
                onPointerDown={(e) => beginResize(e, hd.id)}
                className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-[color:var(--color-selection)] bg-surface"
                style={{ left: p.x, top: p.y, cursor: resizeCursor(hd.fx, hd.fy, exAxis) }}
              />
            );
          })}
          <div
            onPointerDown={(e) => beginResize(e, "rotate")}
            className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[color:var(--color-selection)] bg-surface"
            style={{ left: rotPos.x, top: rotPos.y, cursor: ROTATE_CURSOR }}
          />
        </>
      )}
      {transforming && (() => {
        // Live readout below the box: W x H (page units), plus the angle when the
        // element is rotated. Updates each frame as size/rotation change.
        const bc = corner(0.5, 1);
        const deg = Math.round((((loc.node.transform.rotation ?? 0) % 360) + 360) % 360);
        const label = deg ? `${Math.round(w)} × ${Math.round(h)}  ·  ${deg}°` : `${Math.round(w)} × ${Math.round(h)}`;
        return (
          <div
            className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded bg-neutral-800/90 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white shadow"
            style={{ left: bc.x, top: bc.y + 14 }}
          >
            {label}
          </div>
        );
      })()}
    </>
  );
}
