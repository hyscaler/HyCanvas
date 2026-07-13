// crop overlay: the node box is a fixed frame; the user pans and
// zooms the source image behind it. The region inside the frame becomes the new
// crop (normalized to the source). The image always covers the frame, so the
// crop region's aspect matches the frame and "cover" reproduces it exactly.

import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import type { ImageNode } from "@hc/schema";
import { locate, worldMatrix } from "@hc/editor";
import { useEditor } from "@/store/editor";
import { imageAssets } from "@/lib/assetProvider";
import type { CanvasApi } from "@/lib/useEditorCanvas";

export function CropOverlay({ api, id }: { api: CanvasApi; id: string }) {
  // Track edits/pan/zoom so the frame stays glued to the node.
  useEditor((s) => s.rev);
  useEditor((s) => s.viewport);
  const setCropping = useEditor((s) => s.setCropping);
  const doc = useEditor.getState().doc;
  const loc = locate(doc, id);
  const wm = worldMatrix(doc, id);
  // The overlay positions an axis-aligned <img> in screen space, so it only
  // matches the render when the node's FULL world matrix (including any parent
  // group) is an unrotated, unscaled, unflipped translation.
  const axisAligned =
    !!wm && Math.abs(wm.a - 1) < 1e-6 && Math.abs(wm.d - 1) < 1e-6 && Math.abs(wm.b) < 1e-6 && Math.abs(wm.c) < 1e-6;

  // UnknownNode is not discriminated by `type`, so cast once we've checked it.
  const node = loc?.node.type === "image" ? (loc.node as unknown as ImageNode) : null;
  const src = node?.source ?? null;
  const url = src ? imageAssets.url(src.assetId) : null;

  // Frame rectangle in screen space (axis-aligned; crop targets unrotated images).
  const ftl = wm ? api.toScreen({ x: wm.e, y: wm.f }) : { x: 0, y: 0 };
  const fw = node ? node.size.width * api.viewport().zoom : 0;
  const fh = node ? node.size.height * api.viewport().zoom : 0;

  const natW = src ? src.naturalWidth || 1 : 1;
  const natH = src ? src.naturalHeight || 1 : 1;
  const minScale = Math.max(fw / natW, fh / natH);

  // Transform of the source image relative to the frame top-left.
  const [t, setT] = useState(() => {
    const crop = node?.crop;
    if (crop && crop.width > 0) {
      const scale = fw / (crop.width * natW);
      return { scale, offX: -crop.x * natW * scale, offY: -crop.y * natH * scale };
    }
    return { scale: minScale, offX: (fw - natW * minScale) / 2, offY: (fh - natH * minScale) / 2 };
  });

  const drag = useRef<{ x: number; y: number; offX: number; offY: number } | null>(null);

  const clamp = (offX: number, offY: number, scale: number) => {
    const iw = natW * scale;
    const ih = natH * scale;
    return {
      offX: Math.min(0, Math.max(fw - iw, offX)),
      offY: Math.min(0, Math.max(fh - ih, offY)),
    };
  };

  function onDown(e: React.PointerEvent) {
    e.stopPropagation();
    drag.current = { x: e.clientX, y: e.clientY, offX: t.offX, offY: t.offY };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
  function onMove(e: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const next = clamp(d.offX + (e.clientX - d.x), d.offY + (e.clientY - d.y), t.scale);
    setT((p) => ({ ...p, ...next }));
  }
  function onUp() {
    drag.current = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  }

  function setZoom(mult: number) {
    const scale = minScale * mult;
    // Keep the image point under the frame center fixed while zooming.
    const cx = (fw / 2 - t.offX) / t.scale;
    const cy = (fh / 2 - t.offY) / t.scale;
    const next = clamp(fw / 2 - cx * scale, fh / 2 - cy * scale, scale);
    setT({ scale, ...next });
  }

  function apply() {
    const crop = {
      x: Math.max(0, -t.offX / t.scale / natW),
      y: Math.max(0, -t.offY / t.scale / natH),
      width: Math.min(1, fw / t.scale / natW),
      height: Math.min(1, fh / t.scale / natH),
    };
    useEditor.getState().setImageCrop(id, crop);
    setCropping(null);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCropping(null);
      else if (e.key === "Enter") apply();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  // Exit crop mode if the image isn't axis-aligned (e.g. inside a rotated group
  // selected via the layers panel); the overlay can't represent it.
  useEffect(() => {
    if (node && wm && !axisAligned) setCropping(null);
  }, [node, wm, axisAligned, setCropping]);

  if (!node || !wm || !url || !axisAligned) return null;

  const iw = natW * t.scale;
  const ih = natH * t.scale;

  return (
    <>
      {/* Dimmed full image (context outside the crop frame). */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt=""
        draggable={false}
        className="pointer-events-none absolute select-none opacity-35"
        style={{ left: ftl.x + t.offX, top: ftl.y + t.offY, width: iw, height: ih }}
      />
      {/* Bright, clipped image inside the frame; drag to pan. */}
      <div
        onPointerDown={onDown}
        className="absolute cursor-move overflow-hidden ring-2 ring-white"
        style={{ left: ftl.x, top: ftl.y, width: fw, height: fh }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt=""
          draggable={false}
          className="pointer-events-none absolute max-w-none select-none"
          style={{ left: t.offX, top: t.offY, width: iw, height: ih }}
        />
        {/* Rule-of-thirds guides. */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/3 top-0 h-full w-px bg-surface/40" />
          <div className="absolute left-2/3 top-0 h-full w-px bg-surface/40" />
          <div className="absolute left-0 top-1/3 h-px w-full bg-surface/40" />
          <div className="absolute left-0 top-2/3 h-px w-full bg-surface/40" />
        </div>
      </div>
      {/* Toolbar below the frame. */}
      <div
        className="absolute z-30 flex items-center gap-3 rounded-xl border border-neutral-200 bg-surface px-3 py-2 shadow-lg"
        style={{ left: ftl.x, top: ftl.y + fh + 10 }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className="text-xs text-neutral-500">Zoom</span>
        <input
          type="range"
          min={1}
          max={3}
          step={0.01}
          defaultValue={Math.max(1, t.scale / minScale)}
          onChange={(e) => setZoom(Number(e.target.value))}
          className="w-32"
        />
        {/* text-surface, not text-white: neutral-900 flips light in dark mode,
            so the label must flip with it to stay readable. */}
        <button onClick={apply} className="flex items-center gap-1 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-surface hover:bg-neutral-700">
          <Check size={14} /> Done
        </button>
        <button onClick={() => setCropping(null)} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100">
          <X size={14} /> Cancel
        </button>
      </div>
    </>
  );
}
