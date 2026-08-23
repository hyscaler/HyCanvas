// Node editor for vector paths: when a single path node is selected
// with the select tool, its anchors and bezier handles are draggable, and the
// path can be edited structurally:
//  - Drag an anchor (one undo step) or a bezier handle. Smooth anchors mirror
//    the opposite handle as you drag; corner anchors move handles independently
//    (handled in the store's editHandle).
//  - Click a SEGMENT (the curve/line between two anchors) to insert a new anchor
//    there, splitting it while preserving the curve.
//  - Double-click an anchor to convert it between corner (square marker) and
//    smooth (round marker, mirrored handles).
//  - Click to select an anchor, Shift-click to multi-select; Delete/Backspace
//    removes the selected anchors (rejoining neighbours). Alt-click an anchor
//    deletes it directly.
// Anchors/handles are placed through the node's full world matrix, so editing
// works on rotated/scaled paths too (the Canvas only mounts this overlay for an
// untransformed path, but the math is general).

import { useEffect, useRef, useState } from "react";
import { locate, worldMatrix } from "@hc/editor";
import { applyToPoint } from "@hc/engine";
import { useEditor } from "@/store/editor";
import type { CanvasApi } from "@/lib/useEditorCanvas";
import { overlay } from "@/lib/theme.generated";

type Seg = { x: number; y: number; cIn?: { x: number; y: number }; cOut?: { x: number; y: number }; corner?: boolean };

// Closest parameter t (0..1) on the cubic from a->b to a screen point, plus the
// screen distance there. Missing handles collapse to the endpoints (a line).
function nearestOnSegment(
  a: { x: number; y: number },
  c1: { x: number; y: number },
  c2: { x: number; y: number },
  b: { x: number; y: number },
  p: { x: number; y: number },
): { t: number; dist: number } {
  let best = { t: 0, dist: Infinity };
  const steps = 24;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const u = 1 - t;
    const x = u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x;
    const y = u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y;
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < best.dist) best = { t, dist: d };
  }
  return best;
}

export function PathEditor({ api }: { api: CanvasApi }) {
  useEditor((s) => s.rev);
  useEditor((s) => s.viewport);
  const selection = useEditor((s) => s.selection);
  const drag = useRef<{ id: string; index: number; which: "anchor" | "in" | "out"; before: unknown; moved: boolean } | null>(null);
  // Selected anchor indices (for multi-delete), tagged with the node they belong
  // to so a change of edited node implicitly clears them (no setState-in-effect).
  const [sel, setSel] = useState<{ id: string; indices: number[] }>({ id: "", indices: [] });
  // Hovered segment + the screen point of the insert affordance.
  const [hoverSeg, setHoverSeg] = useState<{ index: number; t: number; x: number; y: number } | null>(null);

  const id = selection.length === 1 ? selection[0] : null;
  const loc = id ? locate(useEditor.getState().doc, id) : null;
  // Anchor selection only applies to the currently edited node.
  const selAnchors = sel.id === id && id ? sel.indices : [];
  const setSelAnchors = (next: number[] | ((prev: number[]) => number[])) =>
    setSel((prev) => ({ id: id ?? "", indices: typeof next === "function" ? next(prev.id === id ? prev.indices : []) : next }));

  // Delete the selected anchors on Delete/Backspace while editing this path.
  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable) return;
      const indices = sel.id === id ? sel.indices : [];
      if ((e.key === "Delete" || e.key === "Backspace") && indices.length) {
        e.preventDefault();
        e.stopPropagation();
        useEditor.getState().deleteAnchors(id, indices);
        setSel({ id, indices: [] });
      }
    };
    // Capture so this fires before the Canvas's window keydown handler (which
    // would otherwise delete the whole node).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [id, sel]);

  if (!id || !loc || loc.node.type !== "path") return null;
  const node = loc.node as unknown as { transform: { x: number; y: number }; segments: Seg[] };
  const wm = worldMatrix(useEditor.getState().doc, id);
  // Local segment space -> page (honours rotation/scale of the node and any
  // ancestor groups) -> screen.
  const toS = (lx: number, ly: number) =>
    api.toScreen(wm ? applyToPoint(wm, { x: lx, y: ly }) : { x: node.transform.x + lx, y: node.transform.y + ly });

  function localScreen(e: PointerEvent) {
    const rect = document.getElementById("oc-canvas-surface")?.getBoundingClientRect();
    return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : { x: e.clientX, y: e.clientY };
  }
  function onMove(e: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    d.moved = true;
    const page = api.toPage(localScreen(e));
    const store = useEditor.getState();
    if (d.which === "anchor") store.editAnchor(d.id, d.index, page.x, page.y);
    else store.editHandle(d.id, d.index, d.which, page.x, page.y);
  }
  function onUp() {
    const d = drag.current;
    drag.current = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (d && d.moved) useEditor.getState().commitPathEdit(d.id, d.before);
  }
  function begin(e: React.PointerEvent, index: number, which: "anchor" | "in" | "out") {
    e.stopPropagation();
    // Alt-click an anchor deletes it (rejoins neighbours); no drag begins.
    if (which === "anchor" && e.altKey) {
      useEditor.getState().deleteAnchor(id!, index);
      setSelAnchors([]);
      return;
    }
    if (which === "anchor") {
      setSelAnchors((prev) => (e.shiftKey ? (prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]) : [index]));
    }
    drag.current = { id: id!, index, which, before: useEditor.getState().snapshotPath(id!), moved: false };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const segs = node.segments;

  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      {/* Invisible thick hit-lines over each segment: hovering shows an insert
          affordance, clicking inserts an anchor at the hovered parameter. */}
      {segs.map((s, i) => {
        const next = segs[i + 1];
        if (!next) return null;
        const a = toS(s.x, s.y);
        const b = toS(next.x, next.y);
        const c1 = s.cOut ? toS(s.cOut.x, s.cOut.y) : a;
        const c2 = next.cIn ? toS(next.cIn.x, next.cIn.y) : b;
        const d = `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`;
        return (
          <path
            key={`seg${i}`}
            d={d}
            fill="none"
            stroke="transparent"
            strokeWidth={10}
            className="pointer-events-auto cursor-copy"
            onPointerMove={(e) => {
              const sp = { x: e.clientX, y: e.clientY };
              const rect = document.getElementById("oc-canvas-surface")?.getBoundingClientRect();
              const lp = rect ? { x: sp.x - rect.left, y: sp.y - rect.top } : sp;
              const hit = nearestOnSegment(a, c1, c2, b, lp);
              const u = 1 - hit.t;
              const hx = u * u * u * a.x + 3 * u * u * hit.t * c1.x + 3 * u * hit.t * hit.t * c2.x + hit.t * hit.t * hit.t * b.x;
              const hy = u * u * u * a.y + 3 * u * u * hit.t * c1.y + 3 * u * hit.t * hit.t * c2.y + hit.t * hit.t * hit.t * b.y;
              setHoverSeg({ index: i, t: hit.t, x: hx, y: hy });
            }}
            onPointerLeave={() => setHoverSeg((h) => (h?.index === i ? null : h))}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (hoverSeg && hoverSeg.index === i) useEditor.getState().insertAnchor(id!, i, hoverSeg.t);
              setHoverSeg(null);
            }}
          />
        );
      })}
      {/* Insert affordance: a small green dot at the hovered segment point. */}
      {hoverSeg && (
        <circle cx={hoverSeg.x} cy={hoverSeg.y} r={5} fill="#16a34a" stroke="#fff" strokeWidth={1.5} className="pointer-events-none" />
      )}
      {segs.map((s, i) => {
        const a = toS(s.x, s.y);
        const cin = s.cIn ? toS(s.cIn.x, s.cIn.y) : null;
        const cout = s.cOut ? toS(s.cOut.x, s.cOut.y) : null;
        const isCorner = s.corner === true || (!s.cIn && !s.cOut);
        const selected = selAnchors.includes(i);
        return (
          <g key={i}>
            {cin && <line x1={a.x} y1={a.y} x2={cin.x} y2={cin.y} stroke={overlay.selection} strokeWidth={1} />}
            {cout && <line x1={a.x} y1={a.y} x2={cout.x} y2={cout.y} stroke={overlay.selection} strokeWidth={1} />}
            {cin && (
              <circle cx={cin.x} cy={cin.y} r={4} fill="#fff" stroke={overlay.selection} className="pointer-events-auto cursor-move"
                onPointerDown={(e) => begin(e, i, "in")} />
            )}
            {cout && (
              <circle cx={cout.x} cy={cout.y} r={4} fill="#fff" stroke={overlay.selection} className="pointer-events-auto cursor-move"
                onPointerDown={(e) => begin(e, i, "out")} />
            )}
            {/* Corner anchors render as a square, smooth anchors as a circle. A
                selected anchor is filled blue. Double-click flips its type. */}
            {isCorner ? (
              <rect
                x={a.x - 4}
                y={a.y - 4}
                width={8}
                height={8}
                fill={selected ? overlay.selection : "#fff"}
                stroke={overlay.selection}
                strokeWidth={1.5}
                className="pointer-events-auto cursor-move"
                onPointerDown={(e) => begin(e, i, "anchor")}
                onDoubleClick={(e) => { e.stopPropagation(); useEditor.getState().convertAnchor(id!, i); }}
              />
            ) : (
              <circle
                cx={a.x}
                cy={a.y}
                r={5}
                fill={selected ? overlay.selection : "#fff"}
                stroke={overlay.selection}
                strokeWidth={1.5}
                className="pointer-events-auto cursor-move"
                onPointerDown={(e) => begin(e, i, "anchor")}
                onDoubleClick={(e) => { e.stopPropagation(); useEditor.getState().convertAnchor(id!, i); }}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
