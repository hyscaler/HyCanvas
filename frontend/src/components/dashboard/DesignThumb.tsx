// A real design preview: lazily fetches the design file and renders it to a
// small canvas via @hc/engine, fit-and-centered. Falls back to a gradient tile
// while loading or on error. (A server-side thumbnail pipeline is deferred;
// this gives genuine previews for the handful of cards on screen.)

import { useEffect, useRef, useState } from "react";
import { createScene, renderScene, type CanvasLike, type Viewport } from "@hc/engine";
import { oc } from "@/lib/sdk";
import { imageAssets } from "@/lib/assetProvider";

// Nearest scrollable ancestor, used as the observer root: the dashboard grids
// scroll in an inner overflow-y-auto container, and a rootMargin only extends
// past its clip edge when that container itself is the root.
function scrollParent(el: HTMLElement): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
}

export function DesignThumb({ designId, templateId, trashed }: { designId?: string; templateId?: string; trashed?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ok, setOk] = useState<boolean | null>(null);
  // Each preview costs a full design-file download plus an engine render, so
  // it must not start until the card is on (or near) the viewport: a grid of
  // 100 templates or designs would otherwise fetch everything at once.
  // Browsers without IntersectionObserver fall back to rendering eagerly.
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      // Start slightly ahead of the visible area so scrolling rarely catches
      // a card still on its placeholder.
      { root: scrollParent(el), rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    void (async () => {
      try {
        // `trashed` opts into the member-only trash read; without it the file
        // endpoint returns 404 for trashed designs and the card shows only the
        // gradient fallback.
        const file = templateId ? await oc.getTemplateFile(templateId) : await oc.getDesignFile(designId!, trashed ? { trashed: true } : undefined);
        if (cancelled) return;
        const canvas = ref.current;
        if (!canvas) return;
        // Cap the backing resolution: past 2x there is no visible gain on a
        // card-sized preview, only a heavier render.
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const cw = canvas.clientWidth || 260;
        const ch = canvas.clientHeight || 195;
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const page = file.pages[0];
        const zoom = Math.min(cw / page.width, ch / page.height);
        const panX = -((cw - page.width * zoom) / 2) / zoom;
        const panY = -((ch - page.height * zoom) / 2) / zoom;
        const vp: Viewport = { zoom, panX, panY, dpr, width: cw, height: ch };
        imageAssets.registerAll(file.assets ?? []);
        renderScene(createScene(file), ctx as unknown as CanvasLike, vp, { assets: imageAssets });
        setOk(true);
      } catch {
        if (!cancelled) setOk(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [near, designId, templateId, trashed]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-neutral-100">
      {ok !== true && <div className="oc-gradient absolute inset-0 opacity-90" />}
      <canvas ref={ref} className="relative h-full w-full" />
    </div>
  );
}
