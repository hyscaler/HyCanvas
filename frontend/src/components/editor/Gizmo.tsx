// Selection overlay drawn above the canvas in screen space: a bounding outline,
// eight resize handles, and a rotate handle for a single selection (positioned
// at the node's true transformed corners), or a union box for multi-selection.
// Handles drive @hc/editor transform ops; one drag = one undo step.

import { useRef } from "react";
import type { Size, Transform } from "@hc/schema";
import {
  locate,
  parentSpaceDelta,
  resizeNode,
  rotateAboutCenter,
  unionAABB,
  worldAABB,
  worldMatrix,
  type EditCommand,
  type HandleId,
} from "@hc/editor";
import type { Mat2D } from "@hc/engine";
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
  return ids.some((id) => p.collabLockedByOther(id) !== null || b.isLockedRegion(id));
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

// The directional resize cursor for a handle, from its on-screen angle relative
// to the box center. Screen space (y-down), so it stays correct when the node is
// rotated: the cursor reflects the edge's actual orientation, snapped to the four
// resize cursors at 45deg increments (matching Canva).
function resizeCursor(p: { x: number; y: number }, center: { x: number; y: number }): string {
  const deg = (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI;
  const a = ((deg % 180) + 180) % 180; // fold opposite handles together
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
    drag.current = {
      mode,
      fx,
      fy,
      anchor: { x: fx === 1 ? box!.x : box!.x + box!.width, y: fy === 1 ? box!.y : box!.y + box!.height },
      center: { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
      startHandle: { x: box!.x + box!.width * fx, y: box!.y + box!.height * fy },
      startAngle: 0,
      before,
    };
    if (mode === "rotate") {
      const c = drag.current.center;
      drag.current.startAngle = Math.atan2(box!.y - c.y, box!.x + box!.width / 2 - c.x); // handle starts at top-center
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
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
  // Per-item outlines (Canva-style): a thin dashed box around each selected
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
          <polygon key={k} points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#2563eb" strokeWidth={1} strokeDasharray="4 3" opacity={0.6} />
        ))}
      </svg>
      <div className="pointer-events-none absolute border-2 border-blue-500" style={{ left: tl.x, top: tl.y, width: br.x - tl.x, height: br.y - tl.y }} />
      <div
        onPointerDown={(e) => begin(e, "rotate", 0.5, 0)}
        className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-blue-600 bg-white"
        style={{ left: sx(0.5), top: sy(0) - 26, cursor: ROTATE_CURSOR }}
      />
      {handles.map((h) => (
        <div
          key={`${h.fx},${h.fy}`}
          onPointerDown={(e) => begin(e, "resize", h.fx, h.fy)}
          className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-blue-600 bg-white"
          style={{ left: sx(h.fx), top: sy(h.fy), cursor: h.cursor }}
        />
      ))}
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
      <rect x={x} y={y} width={w} height={h} fill="none" stroke="#2563eb" strokeWidth={1.5} strokeDasharray="5 4" rx={4} />
      <circle cx={tl.x} cy={tl.y} r={3.5} fill="#fff" stroke="#2563eb" strokeWidth={1.5} />
      <circle cx={br.x} cy={br.y} r={3.5} fill="#fff" stroke="#2563eb" strokeWidth={1.5} />
    </svg>
  );
}

export function Gizmo({ api }: { api: CanvasApi }) {
  const selection = useEditor((s) => s.selection);
  // Subscribe to rev + viewport so the overlay tracks edits and pan/zoom.
  useEditor((s) => s.rev);
  useEditor((s) => s.viewport);
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
  } | null>(null);

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
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
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
      const deltaDeg = ((ang - (d.startAngle ?? 0)) * 180) / Math.PI;
      node.transform = rotateAboutCenter(d.startTransform, d.startSize, deltaDeg, e.shiftKey);
    } else {
      // Convert the page-space drag into the node's parent space so resizing a
      // node inside a transformed group still tracks the cursor.
      const pd = parentSpaceDelta(store.doc, d.id, page.x - d.startPage.x, page.y - d.startPage.y);
      // Dragging a CORNER of a text box scales the font (Canva-style); edges just
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
      if (canSnap) {
        const T = 6 / api.viewport().zoom;
        const pg = loc2!.page;
        const xs = [0, pg.width, pg.width / 2];
        const ys = [0, pg.height, pg.height / 2];
        for (const sib of loc2!.siblings) {
          if (sib.id === d.id || (sib as { hidden?: boolean }).hidden) continue;
          const b = worldAABB(store.doc, sib.id);
          if (!b) continue;
          xs.push(b.x, b.x + b.width, b.x + b.width / 2);
          ys.push(b.y, b.y + b.height, b.y + b.height / 2);
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
        tf = { ...tf, x: left, y: top };
        size = { width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
      }
      node.transform = tf;
      node.size = size;
      store.setSnapGuides(gx.length || gy.length ? { x: gx, y: gy } : null);
      if (node.type === "text") {
        // Text wraps/clips to its box, so keep the box in sync with the size
        // (edge-resize reflows); corners also scale the font.
        const tn = node as unknown as { box: { width: number; height: number; mode?: string } };
        tn.box = { ...tn.box, width: size.width, height: size.height };
        // Dragging a pure vertical edge (top/bottom, not a corner) is an explicit
        // height choice: switch to a fixed box so it stops auto-growing and the
        // user's size sticks. Width-only and corner (font-scale) drags stay
        // auto-height and re-fit to the content.
        if (d.handle === "n" || d.handle === "s") tn.box.mode = "fixed";
        if (isTextCorner && d.startContent && d.startSize.width > 0) {
          scaleTextFonts(node as unknown as { content?: unknown }, d.startContent, size.width / d.startSize.width);
        }
      }
    }
    store.tick();
  }

  function onUp() {
    const d = drag.current;
    drag.current = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (!d) return;
    const store = useEditor.getState();
    store.setSnapGuides(null);
    const node = locate(store.doc, d.id)?.node;
    if (!node) return;
    // Any text resize changed the box (and corners the font too); capture box +
    // content in the undo so it round-trips.
    if (node.type === "text" && d.handle !== "rotate") {
      store.pushNodeSnapshot(d.id, { transform: d.startTransform, size: d.startSize, box: d.startBox, content: d.startContent });
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
  const center = corner(0.5, 0.5); // for rotation-aware resize cursors
  const top = corner(0.5, 0);
  const ne = corner(1, 0);
  const nw = corner(0, 0);
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
          stroke="#2563eb"
          strokeWidth={1.5}
        />
        <line x1={rot.x} y1={rot.y} x2={rotPos.x} y2={rotPos.y} stroke="#2563eb" strokeWidth={1.5} />
      </svg>
      {!locked && (
        <>
          {HANDLES.map((hd) => {
            const p = corner(hd.fx, hd.fy);
            return (
              <div
                key={hd.id}
                onPointerDown={(e) => beginResize(e, hd.id)}
                className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-blue-600 bg-white"
                style={{ left: p.x, top: p.y, cursor: resizeCursor(p, center) }}
              />
            );
          })}
          <div
            onPointerDown={(e) => beginResize(e, "rotate")}
            className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-blue-600 bg-white"
            style={{ left: rotPos.x, top: rotPos.y, cursor: ROTATE_CURSOR }}
          />
        </>
      )}
    </>
  );
}
