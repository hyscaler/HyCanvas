// A real design preview: lazily fetches the design file and renders it to a
// small canvas via @hc/engine, fit-and-centered. Falls back to a gradient tile
// while loading or on error. (A server-side thumbnail pipeline is deferred;
// this gives genuine previews for the handful of cards on screen.)

import { useEffect, useRef, useState } from "react";
import { createScene, renderScene, type CanvasLike, type Viewport } from "@hc/engine";
import { oc } from "@/lib/sdk";
import { imageAssets } from "@/lib/assetProvider";

export function DesignThumb({ designId, templateId, trashed }: { designId?: string; templateId?: string; trashed?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ok, setOk] = useState<boolean | null>(null);

  useEffect(() => {
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
        const dpr = window.devicePixelRatio || 1;
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
  }, [designId, templateId, trashed]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-neutral-100">
      {ok !== true && <div className="oc-gradient absolute inset-0 opacity-90" />}
      <canvas ref={ref} className="relative h-full w-full" />
    </div>
  );
}
