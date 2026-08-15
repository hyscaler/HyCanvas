// Web player for a shared deck (doc 28 FR-26, AC-7): engine-drawn slides with
// arrow/click navigation, fullscreen, and real slide-to-slide transitions,
// replacing the scroll-stack render for multi-page designs.
//
// Transitions come from the pure `@hc/engine` compositor (FR-13), which is the
// whole point of that lift: present mode, this player, and headless export all
// composite identically. Entrance/exit animations play through the same
// `poseDesignAt` core the editor and present mode use.
//
// Read-only by construction: it renders pixels from a snapshot, exposes no
// editor capability, and carries the share-link engagement instrumentation.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, Minimize2 } from "lucide-react";
import type { DesignFile } from "@hc/sdk";
import {
  createScene,
  renderScene,
  poseDesignAt,
  renderTransition,
  transitionProgress,
  morphPlan,
  morphDesignAt,
  type CanvasLike,
  type Viewport,
} from "@hc/engine";
import { imageAssets } from "@/lib/assetProvider";
import { useViewBeat } from "@/lib/useViewBeat";
import { AudiencePanel } from "@/components/AudiencePanel";
import { oc } from "@/lib/sdk";
import { nextVisibleIndex, prevVisibleIndex, firstVisibleIndex, visiblePosition, LIVE_STALE_MS } from "@/lib/present";
import { DESIGN_SURFACE_DIR } from "@/lib/locale";
import { tr } from "@/lib/i18n";

type Transition = NonNullable<DesignFile["pages"][number]["transition"]>;

/** A transition in flight: the slide we left and when the blend began. */
type Blend = { fromIndex: number; startedAt: number };

export function DeckPlayer({ doc, token, password }: { doc: DesignFile; token?: string; password?: string }) {
  const [index, setIndex] = useState(() => firstVisibleIndex(doc.pages));
  const [fullscreen, setFullscreen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bufA = useRef<HTMLCanvasElement | null>(null);
  const bufB = useRef<HTMLCanvasElement | null>(null);
  const blend = useRef<Blend | null>(null);
  const slideStart = useRef<number>(0);
  const raf = useRef<number | null>(null);

  useViewBeat({ token, password, enabled: !!token, getPageId: () => doc.pages[index]?.id ?? null });

  // Slide-follow (doc 28): while the presenter is live, offer to follow. The
  // player polls the audience state (viewers hold no socket); a fresh live row
  // (< LIVE_STALE_MS) shows the banner, and following mirrors the presenter's slide.
  const [live, setLive] = useState<{ slide: number; at: number } | null>(null);
  const [following, setFollowing] = useState(false);
  const followingRef = useRef(false);
  useEffect(() => {
    followingRef.current = following;
  }, [following]);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    // Poll callbacks run async (never synchronously in the effect body), so
    // the setState calls here satisfy the effects rule.
    const poll = async () => {
      try {
        const st = await oc.audienceState(token, { voterKey: "follow-probe", password });
        if (cancelled) return;
        const fresh = st.live && Date.now() - new Date(st.live.updatedAt).getTime() < LIVE_STALE_MS ? st.live : null;
        setLive(fresh ? { slide: fresh.slide, at: Date.now() } : null);
        if (fresh && followingRef.current) {
          const target = Math.max(0, Math.min(fresh.slide, doc.pages.length - 1));
          setIndex((cur) => (cur === target ? cur : target));
        }
      } catch {
        if (!cancelled) setLive(null);
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [token, password, doc.pages.length]);

  const total = doc.pages.length;
  const { position, total: visibleTotal } = visiblePosition(doc.pages, index);

  const go = useCallback(
    (dir: 1 | -1) => {
      setIndex((cur) => {
        const next = dir === 1 ? nextVisibleIndex(doc.pages, cur) : prevVisibleIndex(doc.pages, cur);
        if (next === cur) return cur;
        // A page's transition plays when advancing TO it (mirrors present mode).
        const arriving = doc.pages[next]?.transition;
        blend.current = dir === 1 && arriving ? { fromIndex: cur, startedAt: performance.now() } : null;
        slideStart.current = performance.now();
        return next;
      });
    },
    [doc.pages],
  );

  // Keyboard: arrows/space/page keys navigate, Home/End jump, F toggles
  // fullscreen. Nothing here mutates the design.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
        case " ":
        case "PageDown":
          e.preventDefault();
          go(1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
          e.preventDefault();
          go(-1);
          break;
        case "f":
        case "F":
          void toggleFullscreen();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  async function toggleFullscreen() {
    const el = wrapRef.current;
    if (!el) return;
    try {
      if (!document.fullscreenElement) {
        await el.requestFullscreen();
        setFullscreen(true);
      } else {
        await document.exitFullscreen();
        setFullscreen(false);
      }
    } catch {
      /* fullscreen can be refused; the player still works windowed */
    }
  }
  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // The render loop: pose the slide, composite a transition when one is in
  // flight, otherwise draw the posed slide straight through.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
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
      if (!ctx || !stage || !page) return;
      // Size the canvas to the page's aspect and let flexbox center it, exactly
      // as present mode does. `panX/panY` are page-space, so a zoom-only
      // viewport draws the page flush into a page-shaped canvas.
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const avail = { w: stage.clientWidth * 0.94, h: stage.clientHeight * 0.94 };
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
      const arriving = page.transition as Transition | undefined;
      const dur = arriving?.durationMs ?? 0;
      const elapsed = b ? now - b.startedAt : 0;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, cw, ch);

      if (b && arriving && elapsed < dur) {
        const p = transitionProgress(elapsed, dur);
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
          // Magic Move: hide the shared elements in both buffers so the pure
          // compositor cross-fades only the non-shared content; the tweened
          // layer is drawn on top afterwards (same split as present mode).
          const morph = arriving.type === "morph" ? morphPlan(doc, b.fromIndex, doc, index) : null;
          const restore: { n: { hidden?: boolean }; prev: boolean | undefined }[] = [];
          if (morph) {
            for (const n of morph.fromNodes.values()) { restore.push({ n, prev: n.hidden }); (n as { hidden?: boolean }).hidden = true; }
            for (const n of morph.toNodes.values()) { restore.push({ n, prev: n.hidden }); (n as { hidden?: boolean }).hidden = true; }
          }
          drawPosed(ca, b.fromIndex, Number.MAX_SAFE_INTEGER, vp); // leaving slide, fully settled
          drawPosed(cb, index, elapsed, vp); // arriving slide begins its entrance
          for (const r of restore) r.n.hidden = r.prev;

          renderTransition(ctx as unknown as CanvasLike, arriving, {
            from: A,
            to: B,
            width: cw,
            height: ch,
            progress: p,
          });

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

  const isDeck = total > 1;

  return (
    <div
      ref={wrapRef}
      className="relative flex min-h-0 w-full flex-1 flex-col bg-neutral-900"
      dir={DESIGN_SURFACE_DIR}
      data-testid="deck-player"
    >
      <div ref={stageRef} className="grid min-h-0 flex-1 place-items-center overflow-hidden p-2">
        <canvas
          ref={canvasRef}
          className="cursor-pointer shadow-2xl"
          onClick={() => go(1)}
          aria-label={`Slide ${position} of ${visibleTotal}`}
        />
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-3 p-4">
        <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-black/60 px-2 py-1.5 text-white backdrop-blur">
          {isDeck && (
            <>
              <button
                type="button"
                aria-label={tr("app.previous_slide")}
                onClick={() => go(-1)}
                className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/15"
              >
                <ChevronLeft size={18} />
              </button>
              <span className="min-w-16 select-none text-center text-xs font-medium tabular-nums" data-testid="slide-counter">
                {position} / {visibleTotal}
              </span>
              <button
                type="button"
                aria-label={tr("app.next_slide")}
                onClick={() => go(1)}
                className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/15"
              >
                <ChevronRight size={18} />
              </button>
            </>
          )}
          <button
            type="button"
            aria-label={fullscreen ? tr("app.exit_fullscreen") : tr("app.enter_fullscreen")}
            onClick={() => void toggleFullscreen()}
            className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/15"
          >
            {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </div>
      </div>
      {/* Live audience (doc 28): share-link viewers can react, ask questions,
          and vote on the presenter's polls. Only on tokened (shared) views. */}
      {token && <AudiencePanel token={token} password={password} />}
      {token && live && (
        <button
          onClick={() => {
            const next = !following;
            setFollowing(next);
            if (next && live) {
              const target = Math.max(0, Math.min(live.slide, doc.pages.length - 1));
              setIndex((cur) => (cur === target ? cur : target));
            }
          }}
          className={`fixed left-1/2 top-4 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium shadow-xl backdrop-blur transition ${
            following ? "bg-red-600/90 text-white" : "bg-neutral-900/85 text-white hover:bg-neutral-800"
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${following ? "animate-pulse bg-white" : "bg-red-500"}`} />
          {following ? tr("app.following_the_presenter_click_to_stop") : tr("app.presenter_is_live_follow_along")}
        </button>
      )}
    </div>
  );
}
