// Refinement brush for ImageNode.alphaMask (schema v20): paint on the canvas to
// restore (white) or erase (black) parts of an image's mask with a soft radial
// falloff. Non-destructive, like the background remover that creates the mask:
// the original pixels never change, only the grayscale mask beside them.
//
// Coordinates go pointer -> page (CanvasApi.toPage) -> node-local via the SAME
// inverse the engine's hitTest uses (invert the scene node's world transform,
// then applyToPoint), so the brush lands correctly on rotated, scaled, and
// nested images. Node-local then maps to mask pixels through fitRect, the exact
// crop/fit/focal math drawImageNode samples with.
//
// The stroke paints an offscreen buffer seeded from the current mask (opaque
// white when the node has none). Commits happen on pointerup ONLY: the buffer
// is baked to a grayscale PNG, uploaded, and handed to setImageAlphaMask (one
// undo step per stroke). Committing per pointermove would embed a base64 PNG in
// the CRDT on every mouse packet, the exact problem the upload path exists to
// avoid. clearMaskCache() runs after each commit so the engine rebuilds the
// composite instead of serving the stale one.

import { useEffect, useRef, useState } from "react";
import { Check, Eraser, Paintbrush } from "lucide-react";
import type { ImageNode } from "@hc/schema";
import { locate } from "@hc/editor";
import {
  applyToPoint,
  clearMaskCache,
  fitRect,
  invert,
  type Mat2D,
  type Point,
} from "@hc/engine";
import { useEditor } from "@/store/editor";
import { useBrand } from "@/store/brand";
import { imageAssets } from "@/lib/assetProvider";
import { resolveAssetUrl, uploadAssetWithProgress } from "@/lib/sdk";
import { useCallbackRef } from "@/lib/useCallbackRef";
import type { CanvasApi } from "@/lib/useEditorCanvas";
import { tr } from "@/lib/i18n";

// Working-buffer cap for a NEW mask, mirroring maskedImage's MAX_DIM: the
// engine composites through a buffer this size anyway, so a larger mask buys
// nothing on screen and slows every stamp. An existing mask keeps its own
// resolution (never resampled) below the same cap.
const MAX_DIM = 2048;

type Mapping = {
  world: Mat2D;
  inv: Mat2D;
  dest: { x: number; y: number; width: number; height: number };
  /** Sample rect of the visible region, in SOURCE-image pixels (for the preview draw). */
  src: { x: number; y: number; width: number; height: number };
  /** The same sample rect in MASK-buffer pixels (for painting and the preview mask pass). */
  msk: { x: number; y: number; width: number; height: number };
  sourceAssetId: string;
};

export function MaskRefineOverlay({ api, id }: { api: CanvasApi; id: string }) {
  useEditor((s) => s.rev);
  useEditor((s) => s.viewport);
  useEditor((s) => s.activePage); // the active-page check below must re-run on page switch
  const setMaskRefining = useEditor((s) => s.setMaskRefining);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<"restore" | "erase">("erase");
  const [brushSize, setBrushSize] = useState(24); // screen px radius
  // The working mask as WHITE + alpha (alpha = keep fraction). Painting is then
  // two composite ops (source-over to restore, destination-out to erase) and the
  // preview is a plain destination-in, with no per-pixel pass anywhere in the
  // stroke path. The grayscale PNG the document stores is baked at commit time.
  const bufRef = useRef<HTMLCanvasElement | null>(null);
  const strokeRef = useRef<{ pointerId: number; rMask: number; last: Point; mode: "restore" | "erase" } | null>(null);
  const cursorRef = useRef<Point | null>(null); // overlay-local screen px
  // Uploads are serialized: each commit's PNG already contains every stroke so
  // far, so out-of-order responses would otherwise let an OLDER buffer win.
  const commitChain = useRef<Promise<void>>(Promise.resolve());

  const imageNode = (): ImageNode | null => {
    const loc = locate(useEditor.getState().doc, id);
    return loc?.node.type === "image" ? (loc.node as unknown as ImageNode) : null;
  };

  // Everything needed to move between page, node-local, source and mask pixels.
  // Recomputed per event so pan/zoom/undo mid-session stay correct.
  const mapping = (): Mapping | null => {
    const sn = api.scene()?.getSceneNode(id);
    const buf = bufRef.current;
    const img = imageNode();
    if (!sn || !buf || !img) return null;
    const natW = img.source.naturalWidth || 1;
    const natH = img.source.naturalHeight || 1;
    const crop = img.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    const fr = fitRect(natW * crop.width, natH * crop.height, img.size.width, img.size.height, img.fit, img.focalPoint);
    if (fr.dest.width <= 0 || fr.dest.height <= 0) return null;
    const m = sn.worldTransform;
    const world: Mat2D = { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] };
    const inv = invert(world);
    if (!inv) return null;
    // The region of the source the node box shows (drawImageNode's sample rect),
    // in source pixels, then scaled onto the mask buffer's own pixel grid.
    const sx = (crop.x + fr.source.x * crop.width) * natW;
    const sy = (crop.y + fr.source.y * crop.height) * natH;
    const sw = fr.source.width * crop.width * natW;
    const sh = fr.source.height * crop.height * natH;
    const kx = buf.width / natW;
    const ky = buf.height / natH;
    return {
      world,
      inv,
      dest: fr.dest,
      src: { x: sx, y: sy, width: sw, height: sh },
      msk: { x: sx * kx, y: sy * ky, width: sw * kx, height: sh * ky },
      sourceAssetId: img.source.assetId,
    };
  };

  // Page-space point -> mask-buffer pixels: hitTest's inverse into node-local,
  // then through the fit's dest rect into the sampled region of the mask.
  const toMask = (page: Point, mp: Mapping): Point => {
    const local = applyToPoint(mp.inv, page);
    const u = (local.x - mp.dest.x) / mp.dest.width;
    const v = (local.y - mp.dest.y) / mp.dest.height;
    return { x: mp.msk.x + u * mp.msk.width, y: mp.msk.y + v * mp.msk.height };
  };

  // Screen-px brush radius -> mask px, averaging the two axes so a non-uniform
  // scale paints a sensible circle rather than degenerating on one axis.
  const maskRadius = (mp: Mapping): number => {
    const z = api.viewport().zoom || 1;
    const rLocal = (brushSize / z) * ((Math.hypot(mp.inv.a, mp.inv.b) + Math.hypot(mp.inv.c, mp.inv.d)) / 2);
    return Math.max(1, rLocal * ((mp.msk.width / mp.dest.width) + (mp.msk.height / mp.dest.height)) / 2);
  };

  // One soft brush stamp: a radial alpha falloff, white over the buffer to
  // restore, punched out of it to erase.
  const stamp = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, m: "restore" | "erase") => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.65, "rgba(255,255,255,0.7)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.globalCompositeOperation = m === "restore" ? "source-over" : "destination-out";
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  };

  // Live preview: the image drawn through the node's full world transform with
  // the WORKING mask applied, plus the brush cursor ring. All composite ops at
  // screen resolution, so it stays cheap per pointermove.
  const draw = useCallbackRef(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(rect.width * dpr));
    const bh = Math.max(1, Math.round(rect.height * dpr));
    if (cv.width !== bw) cv.width = bw;
    if (cv.height !== bh) cv.height = bh;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    const mp = mapping();
    const buf = bufRef.current;
    if (mp && buf) {
      const img = imageAssets.status(mp.sourceAssetId) === "ready"
        ? (imageAssets.image(mp.sourceAssetId) as CanvasImageSource | null)
        : null;
      if (img) {
        const z = api.viewport().zoom || 1;
        const t = api.toScreen({ x: mp.world.e, y: mp.world.f });
        // node-local -> screen: the world matrix scaled by zoom, translated by
        // the node origin's screen position (page->screen is translate+scale).
        ctx.setTransform(dpr * z * mp.world.a, dpr * z * mp.world.b, dpr * z * mp.world.c, dpr * z * mp.world.d, dpr * t.x, dpr * t.y);
        try {
          ctx.drawImage(img, mp.src.x, mp.src.y, mp.src.width, mp.src.height, mp.dest.x, mp.dest.y, mp.dest.width, mp.dest.height);
          // destination-in is safe on the whole overlay canvas: the image is the
          // only thing drawn so far, and it and the mask cover the same dest rect.
          ctx.globalCompositeOperation = "destination-in";
          ctx.drawImage(buf, mp.msk.x, mp.msk.y, mp.msk.width, mp.msk.height, mp.dest.x, mp.dest.y, mp.dest.width, mp.dest.height);
        } catch {
          // A mid-load decode error just skips one preview frame.
        }
        ctx.globalCompositeOperation = "source-over";
      }
    }
    // Brush cursor ring, in screen space. Two strokes so it reads on any pixels.
    const c = cursorRef.current;
    if (c) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.beginPath();
      ctx.arc(c.x, c.y, brushSize, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(c.x, c.y, brushSize + 1.5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  });

  // Redraw after every commit/render pass (rev, viewport, brush changes).
  useEffect(() => {
    draw();
  });

  // Seed the working buffer once per node: the current mask converted
  // luminance -> alpha (the same reading maskedImage.ts and the Go compositor
  // give it), or opaque white when the node has none yet.
  useEffect(() => {
    bufRef.current = null;
    const img = imageNode();
    if (!img) return;
    const mask = img.alphaMask;
    const natW = img.source.naturalWidth || 1;
    const natH = img.source.naturalHeight || 1;
    const seed = () => {
      const el = mask && imageAssets.status(mask.assetId) === "ready"
        ? (imageAssets.image(mask.assetId) as (CanvasImageSource & { naturalWidth?: number; naturalHeight?: number }) | null)
        : null;
      let w = mask?.width || el?.naturalWidth || 0;
      let h = mask?.height || el?.naturalHeight || 0;
      if (!w || !h) {
        const scale = Math.min(1, MAX_DIM / Math.max(natW, natH, 1));
        w = Math.max(1, Math.round(natW * scale));
        h = Math.max(1, Math.round(natH * scale));
      }
      const cap = Math.min(1, MAX_DIM / Math.max(w, h));
      w = Math.max(1, Math.round(w * cap));
      h = Math.max(1, Math.round(h * cap));
      let c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      let ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      let seededFromMask = false;
      if (el) {
        try {
          ctx.drawImage(el, 0, 0, w, h);
          const data = ctx.getImageData(0, 0, w, h);
          const px = data.data;
          for (let i = 0; i < px.length; i += 4) {
            // Rec. 601 luma x alpha, matching maskedImage.ts / the Go export.
            const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
            px[i + 3] = Math.round((lum * px[i + 3]) / 255);
            px[i] = 255;
            px[i + 1] = 255;
            px[i + 2] = 255;
          }
          ctx.putImageData(data, 0, 0);
          seededFromMask = true;
        } catch {
          // A cross-origin mask without CORS taints the canvas, and a tainted
          // buffer could never be committed (toDataURL throws). Start over on a
          // FRESH canvas: refining from opaque white beats a brush that cannot
          // save, and matches how the engine degrades (draws unmasked).
          c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          ctx = c.getContext("2d", { willReadFrequently: true });
          if (!ctx) return;
        }
      }
      if (!seededFromMask) {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
      }
      bufRef.current = c;
      // Strokes are ignored until the buffer exists (onPointerDown checks the
      // mapping, which requires it); nothing else re-renders on seed, so a
      // redraw here is all the late (asset-was-still-loading) path needs.
      draw();
    };
    if (mask && imageAssets.status(mask.assetId) === "loading") {
      const off = imageAssets.onChange((aid) => {
        if (aid !== mask.assetId) return;
        off();
        seed();
      });
      return off;
    }
    seed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const paintSegment = (page: Point) => {
    const mp = mapping();
    const st = strokeRef.current;
    const ctx = bufRef.current?.getContext("2d");
    if (!mp || !st || !ctx) return;
    const p = toMask(page, mp);
    const dx = p.x - st.last.x;
    const dy = p.y - st.last.y;
    // Stamps spaced a third of the radius apart read as one continuous stroke.
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(1, st.rMask / 3)));
    for (let i = 1; i <= n; i++) stamp(ctx, st.last.x + (dx * i) / n, st.last.y + (dy * i) / n, st.rMask, st.mode);
    st.last = p;
  };

  // Bake the working buffer (white + alpha) to the opaque grayscale PNG the
  // document stores, upload it, and attach it. One undo step per stroke.
  const commitStroke = () => {
    const buf = bufRef.current;
    if (!buf) return;
    let dataUrl: string;
    try {
      const out = document.createElement("canvas");
      out.width = buf.width;
      out.height = buf.height;
      const octx = out.getContext("2d");
      if (!octx) return;
      // The buffer's color is white everywhere by construction, so gray = alpha:
      // black underneath, the buffer composited over it.
      octx.fillStyle = "#000";
      octx.fillRect(0, 0, out.width, out.height);
      octx.drawImage(buf, 0, 0);
      dataUrl = out.toDataURL("image/png");
    } catch {
      return; // tainted buffer; the seed path already fell back to white to avoid this
    }
    const w = buf.width;
    const h = buf.height;
    const workspaceId = useBrand.getState().workspaceId;
    commitChain.current = commitChain.current.then(async () => {
      // A real uploaded asset, never a data URL, for the same reason the
      // background remover uploads: inline base64 lands in the CRDT, every
      // snapshot, and every collaborator. The data URL is the offline fallback.
      let url = dataUrl;
      if (workspaceId) {
        try {
          const asset = await uploadAssetWithProgress(workspaceId, {
            filename: `mask-${Date.now()}.png`,
            dataBase64: dataUrl.split(",")[1] ?? "",
          });
          // Resolve the server-relative upload url, or the mask 404s against
          // the frontend origin in dev and the stroke never shows.
          url = resolveAssetUrl(asset.url);
        } catch {
          // Upload failed: keep the inline mask rather than losing the stroke.
        }
      }
      useEditor.getState().setImageAlphaMask(id, url, w, h);
      // Drop the engine's cached composites, or it keeps serving the stale one.
      clearMaskCache();
      // A rejected link would poison the chain (every later commit's .then
      // callback silently never runs), so no failure may escape a link.
    }).catch(() => {});
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || strokeRef.current) return;
    const mp = mapping();
    if (!mp) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = toMask(api.toPage(localPoint(e)), mp);
    strokeRef.current = { pointerId: e.pointerId, rMask: maskRadius(mp), last: p, mode };
    const ctx = bufRef.current?.getContext("2d");
    if (ctx) stamp(ctx, p.x, p.y, strokeRef.current.rMask, mode);
    cursorRef.current = localPoint(e);
    draw();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    cursorRef.current = localPoint(e);
    if (strokeRef.current?.pointerId === e.pointerId) paintSegment(api.toPage(localPoint(e)));
    draw();
  };
  const endStroke = (e: React.PointerEvent) => {
    if (strokeRef.current?.pointerId !== e.pointerId) return;
    strokeRef.current = null;
    commitStroke();
  };

  // Escape or Enter closes the tool (strokes are already committed per-stroke).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        setMaskRefining(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setMaskRefining]);

  // Leave the mode if the node stops being a refinable image (deleted, or a
  // collaborator replaced it), or if it is no longer on the ACTIVE page (the
  // user switched pages): locate() searches every page, but the coordinate
  // mapping and the preview both go through the active page's scene, so an
  // off-page node would leave a blank, inert overlay pinned to the screen.
  const exists = !!imageNode() && !!api.scene()?.getSceneNode(id);
  useEffect(() => {
    if (!exists) setMaskRefining(null);
  }, [exists, setMaskRefining]);
  if (!exists) return null;

  // Toolbar under the node's page-space bounds, like the crop overlay's.
  const bounds = api.scene()?.getBounds(id) ?? null;
  const btl = bounds ? api.toScreen({ x: bounds.x, y: bounds.y }) : { x: 12, y: 12 };
  const bh = bounds ? bounds.height * (api.viewport().zoom || 1) : 0;
  const modeBtn = (on: boolean) =>
    `flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${on ? "bg-neutral-900 text-surface" : "text-neutral-600 hover:bg-neutral-100"}`;

  return (
    <>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 z-20 h-full w-full"
        style={{ cursor: "none", touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
        onPointerLeave={() => {
          cursorRef.current = null;
          draw();
        }}
      />
      <div
        className="absolute z-30 flex items-center gap-2 rounded-xl border border-neutral-200 bg-surface px-3 py-2 shadow-lg"
        style={{ left: btl.x, top: btl.y + bh + 10 }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button onClick={() => setMode("erase")} aria-pressed={mode === "erase"} className={modeBtn(mode === "erase")} title={tr("editor.erase")}>
          <Eraser size={14} /> {tr("editor.erase")}
        </button>
        <button onClick={() => setMode("restore")} aria-pressed={mode === "restore"} className={modeBtn(mode === "restore")} title={tr("editor.restore")}>
          <Paintbrush size={14} /> {tr("editor.restore")}
        </button>
        <span className="mx-0.5 h-5 w-px bg-neutral-200" />
        <span className="text-xs text-neutral-500">{tr("editor.brush_size")}</span>
        <input
          type="range"
          min={4}
          max={100}
          step={1}
          value={brushSize}
          onChange={(e) => setBrushSize(Number(e.target.value))}
          className="w-28"
          aria-label={tr("editor.brush_size")}
        />
        <button
          onClick={() => setMaskRefining(null)}
          className="flex items-center gap-1 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-surface hover:bg-neutral-700"
        >
          <Check size={14} /> {tr("editor.done")}
        </button>
      </div>
    </>
  );
}
