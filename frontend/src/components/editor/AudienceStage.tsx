// The audience-facing slide surface for the second-display presenter view
// (doc 28 FR-15, AC-3). Renders ONLY the slide: no HUD, no notes, no tools.
//
// It loads the design once, then follows the presenter's slide index over a
// BroadcastChannel, compositing slide-to-slide transitions through the same
// pure `@hc/engine` helper present mode, the web player, and animated export
// use, so the projection matches what the presenter sees.

import { useEffect, useRef, useState } from "react";
import type { DesignFile } from "@hc/sdk";
import {
  createScene,
  renderScene,
  poseDesignAt,
  renderTransition,
  renderTransitionPair,
  transitionPairDurationMs,
  pairEnterTransition,
  transitionProgress,
  morphPlan,
  morphDesignAt,
  type CanvasLike,
  type Viewport,
} from "@hc/engine";
import { imageAssets } from "@/lib/assetProvider";
import { fonts } from "@/lib/fontProvider";
import { oc } from "@/lib/sdk";
import { subscribeAudience, type AudienceState } from "@/lib/audienceWindow";
import { designSurfaceDir } from "@/lib/locale";
import { tr } from "@/lib/i18n";

type Blend = { fromIndex: number; startedAt: number };

export function AudienceStage({ designId, initialSlide }: { designId: string; initialSlide: number }) {
  const [doc, setDoc] = useState<DesignFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(initialSlide);
  const [blank, setBlank] = useState<"black" | "white" | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bufA = useRef<HTMLCanvasElement | null>(null);
  const bufB = useRef<HTMLCanvasElement | null>(null);
  const blend = useRef<Blend | null>(null);
  const slideStart = useRef(0);
  const raf = useRef<number | null>(null);

  // Load the design once; the channel only ever carries a slide index.
  useEffect(() => {
    let cancelled = false;
    void oc
      .getDesignFile(designId)
      .then((f) => {
        if (cancelled) return;
        // The audience window is a fresh page: preload the design's web fonts
        // (canvas text never triggers font loading itself), or every slide
        // shows fallback faces. The rAF loop repaints as faces arrive.
        fonts.ensureForDoc(f);
        imageAssets.registerAll(f.assets ?? []);
        setDoc(f);
      })
      .catch(() => {
        if (!cancelled) setError(tr("editor.could_not_open_this_design"));
      });
    return () => {
      cancelled = true;
    };
  }, [designId]);

  // Follow the presenter. A slide change starts the arriving page's transition,
  // mirroring present mode (a transition plays when advancing TO a slide).
  useEffect(() => {
    return subscribeAudience(designId, (s: AudienceState) => {
      if (s.closed) {
        window.close();
        return;
      }
      setBlank(s.blank ?? null);
      setIndex((cur) => {
        if (s.index === cur) return cur;
        blend.current = s.index > cur ? { fromIndex: cur, startedAt: performance.now() } : null;
        slideStart.current = performance.now();
        return s.index;
      });
    });
  }, [designId]);

  // The render loop: identical compositing to present mode and the player.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !doc) return;
    if (!bufA.current) bufA.current = document.createElement("canvas");
    if (!bufB.current) bufB.current = document.createElement("canvas");
    slideStart.current = performance.now();

    const drawPosed = (ctx: CanvasRenderingContext2D, pageIndex: number, tMs: number, vp: Viewport) => {
      const posed = poseDesignAt(doc, pageIndex, tMs);
      try {
        renderScene(createScene(posed, pageIndex), ctx as unknown as CanvasLike, vp, { assets: imageAssets });
      } catch {
        /* a cross-origin image can throw; keep the frame */
      }
    };

    const frame = () => {
      const ctx = canvas.getContext("2d");
      const stage = stageRef.current;
      const page = doc.pages[index];
      if (!ctx || !stage || !page) {
        raf.current = requestAnimationFrame(frame);
        return;
      }
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const avail = { w: stage.clientWidth, h: stage.clientHeight };
      if (avail.w <= 0 || avail.h <= 0) {
        raf.current = requestAnimationFrame(frame);
        return;
      }
      const scale = Math.min(avail.w / page.width, avail.h / page.height);
      const cssW = Math.round(page.width * scale);
      const cssH = Math.round(page.height * scale);
      if (canvas.style.width !== `${cssW}px`) canvas.style.width = `${cssW}px`;
      if (canvas.style.height !== `${cssH}px`) canvas.style.height = `${cssH}px`;
      const cw = Math.max(1, Math.round(cssW * dpr));
      const ch = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== cw) canvas.width = cw;
      if (canvas.height !== ch) canvas.height = ch;
      const vp: Viewport = { zoom: scale, panX: 0, panY: 0, dpr, width: cw, height: ch };

      const now = performance.now();
      const b = blend.current;
      const arriving = page.transition;
      // v22: the leaving page's exit transition opens/extends the window too.
      const exitT = b ? (doc.pages[b.fromIndex] as { transitionOut?: import("@hc/schema").PageTransition } | undefined)?.transitionOut : undefined;
      const dur = transitionPairDurationMs(arriving, exitT);
      const elapsed = b ? now - b.startedAt : 0;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, cw, ch);

      if (b && dur > 0 && elapsed < dur) {
        const enterT = pairEnterTransition(arriving);
        const p = transitionProgress(elapsed, enterT.type === "none" ? dur : enterT.durationMs, enterT.easing);
        const pExit = exitT ? transitionProgress(elapsed, exitT.durationMs, exitT.easing) : p;
        const A = bufA.current!;
        const B = bufB.current!;
        for (const buf of [A, B]) {
          if (buf.width !== cw) buf.width = cw;
          if (buf.height !== ch) buf.height = ch;
        }
        const ca = A.getContext("2d");
        const cb = B.getContext("2d");
        if (ca && cb) {
          for (const c of [ca, cb]) {
            c.setTransform(1, 0, 0, 1, 0, 0);
            c.clearRect(0, 0, cw, ch);
            c.fillStyle = "#ffffff";
            c.fillRect(0, 0, cw, ch);
          }
          const morph = enterT.type === "morph" ? morphPlan(doc, b.fromIndex, doc, index) : null;
          const restore: { n: { hidden?: boolean }; prev: boolean | undefined }[] = [];
          if (morph) {
            for (const n of morph.fromNodes.values()) { restore.push({ n, prev: n.hidden }); (n as { hidden?: boolean }).hidden = true; }
            for (const n of morph.toNodes.values()) { restore.push({ n, prev: n.hidden }); (n as { hidden?: boolean }).hidden = true; }
          }
          drawPosed(ca, b.fromIndex, Number.MAX_SAFE_INTEGER, vp);
          drawPosed(cb, index, elapsed, vp);
          for (const r of restore) r.n.hidden = r.prev;

          renderTransitionPair(ctx as unknown as CanvasLike, enterT, exitT, { from: A, to: B, width: cw, height: ch, progress: p, exitProgress: pExit });

          if (morph && morph.ids.length) {
            const posed = morphDesignAt(morph, doc, index, p);
            try {
              renderScene(createScene(posed, index), ctx as unknown as CanvasLike, vp, { assets: imageAssets });
            } catch {
              /* cross-origin image */
            }
          }
        }
      } else {
        if (b) blend.current = null;
        drawPosed(ctx, index, now - slideStart.current, vp);
      }
      raf.current = requestAnimationFrame(frame);
    };
    raf.current = requestAnimationFrame(frame);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [doc, index]);

  if (error) {
    return <div className="grid min-h-screen place-items-center bg-black text-sm text-neutral-400">{error}</div>;
  }

  return (
    // The audience display IS the page's main content: one landmark holding
    // the projected slide, with an offscreen heading so the window announces
    // what it is rather than reading as an unlabelled canvas.
    <main className="relative h-screen w-screen overflow-hidden bg-black" dir={designSurfaceDir} data-testid="audience-stage">
      <h1 className="sr-only">{tr("editor.audience_display")}</h1>
      <div ref={stageRef} className="grid h-full w-full place-items-center">
        <canvas ref={canvasRef} data-testid="audience-canvas" aria-label={tr("editor.presented_slide")} role="img" />
      </div>
      {/* Blanking covers the projection without disturbing the presenter. */}
      {blank && (
        <div
          className={`absolute inset-0 ${blank === "black" ? "bg-black" : "bg-white"}`}
          data-testid="audience-blank"
          aria-hidden
        />
      )}
    </main>
  );
}
