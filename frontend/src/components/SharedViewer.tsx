// Read-only viewer for a shared design opened via a share link.
// Renders the design's pages through @hc/engine onto plain canvases. Client-only
// (browser canvas + engine). This is the anonymous, account-free open path; it
// is a static read-only render of the latest snapshot. Full anonymous realtime
// editing over the WS gateway is a known limitation (the gateway still requires
// a session), so this surface intentionally renders pixels, not an editor.

import { useEffect, useRef, useState } from "react";
import type { DesignFile } from "@hc/sdk";
import { createScene, renderScene, type CanvasLike, type Viewport } from "@hc/engine";
import { imageAssets } from "@/lib/assetProvider";
import { useViewBeat } from "@/lib/useViewBeat";
import { DeckPlayer } from "@/components/DeckPlayer";
import { VideoWatch } from "@/components/VideoWatch";
import { DESIGN_SURFACE_DIR } from "@/lib/locale";

function PageCanvas({ doc, index, onVisible }: { doc: DesignFile; index: number; onVisible?: (index: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Report visibility so the parent can attribute engagement to the page the
  // viewer is actually looking at (FR-14 per-page engagement).
  useEffect(() => {
    const el = ref.current;
    if (!el || !onVisible || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting && e.intersectionRatio >= 0.5) onVisible(index);
      },
      { threshold: [0.5] },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [index, onVisible]);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const pg = doc.pages[index];
    const w = Math.max(1, Math.round(pg.width));
    const h = Math.max(1, Math.round(pg.height));
    const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const vp: Viewport = { zoom: dpr, panX: 0, panY: 0, dpr: 1, width: canvas.width, height: canvas.height };
    renderScene(createScene(doc, index), ctx as unknown as CanvasLike, vp, { assets: imageAssets });
  }, [doc, index]);
  return <canvas ref={ref} className="rounded-lg shadow-md" />;
}

export function SharedViewer({
  doc,
  token,
  password,
}: {
  doc: DesignFile;
  /** The share-link token, so an anonymous view is recorded for insights. */
  token?: string;
  password?: string;
}) {
  // A shared video plays in a lightweight watch player (P7.9), not the page
  // scroll/deck views.
  if ((doc.meta as { kind?: string } | undefined)?.kind === "video") {
    return <VideoWatch doc={doc} token={token} password={password} />;
  }
  // Multi-page designs are decks: render the real web player (engine-drawn
  // slides, navigation, fullscreen, transitions) instead of a scroll stack
  // (doc 28 FR-26). Single-page designs stay a plain scroll render.
  if (doc.pages.length > 1) {
    return <DeckPlayer doc={doc} token={token} password={password} />;
  }
  return <ScrollViewer doc={doc} token={token} password={password} />;
}

function ScrollViewer({
  doc,
  token,
  password,
}: {
  doc: DesignFile;
  token?: string;
  password?: string;
}) {
  const [visiblePage, setVisiblePage] = useState(0);
  // Anonymous engagement instrumentation: record a view +
  // heartbeats keyed to the share-link token, attributing time to the page the
  // visitor is currently looking at. No-op when no token is provided.
  useViewBeat({
    token,
    password,
    enabled: !!token,
    getPageId: () => doc.pages[visiblePage]?.id ?? null,
  });
  return (
    <div className="flex flex-1 flex-col items-center gap-6 overflow-auto py-8" dir={DESIGN_SURFACE_DIR}>
      {doc.pages.map((_, i) => (
        <PageCanvas key={i} doc={doc} index={i} onVisible={setVisiblePage} />
      ))}
    </div>
  );
}
