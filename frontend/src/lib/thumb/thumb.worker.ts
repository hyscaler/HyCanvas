// Draws a design preview off the main thread (#77).
//
// A dashboard grid shows dozens of cards, and each preview is a full engine
// render plus image decodes. Done on the page's own thread that work lands in
// the middle of scrolling. Here the page hands over the design's first page;
// the worker fetches the (downscaled) images, loads the fonts the text needs,
// renders into an OffscreenCanvas and sends the finished bitmap back.
//
// It only ever answers "here is the bitmap" or "draw this one yourself": an
// SVG image cannot be decoded in a worker, and a browser without fonts in
// workers would set every heading in a fallback face. The page keeps its own
// render path for those.

import { createScene, renderScene, weightFromFontStyle, type AssetProvider, type AssetStatus, type CanvasLike, type Viewport } from "@hc/engine";
import { fontCssUrl, isSystemFont } from "@hc/text";
import type { Node } from "@hc/schema";
import type { ThumbRequest, ThumbResponse } from "./thumbProtocol";

interface WorkerScope {
  onmessage: ((e: MessageEvent<ThumbRequest>) => void) | null;
  postMessage(message: ThumbResponse, transfer?: Transferable[]): void;
  fonts?: FontFaceSet;
}
const scope = self as unknown as WorkerScope;

const IMAGE_TIMEOUT_MS = 12_000;
const FONT_TIMEOUT_MS = 4_000;

class Unsupported extends Error {}

const timeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });

// --- images ----------------------------------------------------------------

async function loadImage(url: string): Promise<ImageBitmap | null> {
  const res = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!res.ok) return null;
  const blob = await res.blob();
  // No SVG decoder in a worker: the page has one.
  if (/svg/i.test(blob.type) || /^data:image\/svg/i.test(url)) throw new Unsupported("svg image");
  try {
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

// --- fonts -----------------------------------------------------------------

// What has been asked for already, so a grid of cards in one typeface fetches
// its stylesheet once.
const fontCss = new Map<string, Promise<void>>();

/** Register every face a webfont stylesheet declares (nothing is downloaded
 *  until a face is actually used: fonts.load below picks the subsets the text
 *  needs by unicode-range). */
function registerStylesheet(family: string, css: string, fonts: FontFaceSet): void {
  for (const block of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
    const prop = (name: string) => new RegExp(`${name}\\s*:\\s*([^;}]+)`, "i").exec(block)?.[1]?.trim();
    const src = prop("src");
    if (!src) continue;
    try {
      fonts.add(new FontFace(family, src, {
        style: prop("font-style") ?? "normal",
        weight: prop("font-weight") ?? "400",
        ...(prop("unicode-range") ? { unicodeRange: prop("unicode-range") } : {}),
      }));
    } catch { /* a face the browser rejects is simply not used */ }
  }
}

interface FaceUse { family: string; weight: number; italic: boolean; text: string }

/** The faces the page's text is set in, with a sample of the text in each. */
function facesUsed(nodes: Node[]): FaceUse[] {
  const uses = new Map<string, FaceUse>();
  const walk = (list: Node[]) => {
    for (const n of list) {
      if (n.type === "text") {
        const content = (n as unknown as { content?: { runs?: { text?: string; style?: { fontFamily?: string; fontStyle?: string; axes?: Record<string, number> } }[] }[] }).content ?? [];
        for (const para of content) {
          for (const run of para.runs ?? []) {
            const family = run.style?.fontFamily;
            if (!family || isSystemFont(family)) continue;
            const weight = run.style?.axes?.wght ?? weightFromFontStyle(run.style?.fontStyle);
            const italic = (run.style?.axes?.ital ?? 0) >= 0.5 || /italic|oblique/i.test(run.style?.fontStyle ?? "");
            const key = `${family}|${weight}|${italic ? 1 : 0}`;
            const use = uses.get(key) ?? { family, weight, italic, text: "" };
            if (use.text.length < 400) use.text += run.text ?? "";
            uses.set(key, use);
          }
        }
      }
      const kids = (n as unknown as { children?: Node[] }).children;
      if (Array.isArray(kids)) walk(kids);
    }
  };
  walk(nodes);
  return [...uses.values()];
}

async function loadFonts(nodes: Node[], uploaded: ThumbRequest["fonts"]): Promise<void> {
  const uses = facesUsed(nodes);
  if (uses.length === 0) return;
  const fonts = scope.fonts;
  if (!fonts || typeof FontFace === "undefined") throw new Unsupported("no fonts in workers");

  const uploadedBy = new Map(uploaded.map((f) => [f.family.toLowerCase(), f.url]));
  const families = new Map<string, Set<number>>();
  for (const u of uses) {
    if (!families.has(u.family)) families.set(u.family, new Set());
    families.get(u.family)!.add(u.weight);
  }
  const ready: Promise<void>[] = [];
  for (const [family, weights] of families) {
    const custom = uploadedBy.get(family.toLowerCase());
    const key = custom ? `file|${family}|${custom}` : `css|${family}|${[...weights].sort().join(",")}`;
    if (!fontCss.has(key)) {
      fontCss.set(key, (async () => {
        if (custom) {
          const face = new FontFace(family, `url(${JSON.stringify(custom)})`);
          fonts.add(face);
          await face.load();
          return;
        }
        const href = fontCssUrl(family, [...weights]);
        if (!href) return; // not a catalog family: nothing to load, falls back
        const res = await fetch(href, { mode: "cors", credentials: "omit" });
        if (res.ok) registerStylesheet(family, await res.text(), fonts);
      })().catch(() => { fontCss.delete(key); }));
    }
    ready.push(fontCss.get(key)!);
  }
  await Promise.all(ready);
  await Promise.all(uses.map((u) => fonts.load(`${u.italic ? "italic " : ""}${u.weight} 16px ${JSON.stringify(u.family)}`, u.text || "A").catch(() => [])));
}

// --- render ----------------------------------------------------------------

async function render(req: ThumbRequest): Promise<ImageBitmap> {
  if (typeof OffscreenCanvas === "undefined") throw new Unsupported("no OffscreenCanvas");
  const page = req.file.pages[0];
  const images = new Map<string, ImageBitmap | null>();
  const loads = req.assets.map(async (a) => {
    images.set(a.id, await timeout(loadImage(a.url).catch((e) => { if (e instanceof Unsupported) throw e; return null; }), IMAGE_TIMEOUT_MS, null));
  });
  // An Unsupported image fails the whole request (the page draws it); fonts
  // that are merely slow do not hold the preview back.
  const fontsReady = !req.webFonts ? Promise.resolve("ok" as const) : timeout(loadFonts(page.children, req.fonts).then(() => "ok" as const, (e) => (e instanceof Unsupported ? e : ("ok" as const))), FONT_TIMEOUT_MS, "ok" as const);
  await Promise.all(loads);
  const fr = await fontsReady;
  if (fr instanceof Unsupported) throw fr;

  const assets: AssetProvider = {
    image: (id) => images.get(id) ?? null,
    status: (id): AssetStatus => (images.get(id) ? "ready" : "missing"),
    onChange: () => () => {},
  };
  const { width: cw, height: ch, dpr } = req;
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(cw * dpr)), Math.max(1, Math.round(ch * dpr)));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Unsupported("no 2d context");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const zoom = Math.min(cw / page.width, ch / page.height);
  const vp: Viewport = { zoom, panX: -((cw - page.width * zoom) / 2) / zoom, panY: -((ch - page.height * zoom) / 2) / zoom, dpr, width: cw, height: ch };
  renderScene(createScene(req.file), ctx as unknown as CanvasLike, vp, { assets });
  for (const b of images.values()) b?.close();
  return canvas.transferToImageBitmap();
}

scope.onmessage = (e) => {
  const req = e.data;
  render(req).then(
    (bitmap) => scope.postMessage({ id: req.id, ok: true, bitmap }, [bitmap]),
    (err) => scope.postMessage({ id: req.id, ok: false, reason: err instanceof Error ? err.message : "failed" }),
  );
};
