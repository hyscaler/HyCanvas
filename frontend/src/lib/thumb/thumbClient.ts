// The page's side of the preview worker: one shared worker, requests matched
// to answers by id. Every failure (no Worker or OffscreenCanvas, a worker that
// will not start, a design it cannot draw faithfully, a timeout) rejects, and
// the caller draws the preview itself, as it always could.

import type { ThumbRequest, ThumbResponse } from "./thumbProtocol";

const REQUEST_TIMEOUT_MS = 25_000;

let worker: Worker | null | undefined; // undefined: not started; null: unavailable
let seq = 0;
const pending = new Map<number, { resolve: (b: ImageBitmap) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function failAll(reason: string): void {
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
  pending.clear();
}

function start(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") throw new Error("unsupported");
    const w = new Worker(new URL("./thumb.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<ThumbResponse>) => {
      const p = pending.get(e.data.id);
      if (!p) { if (e.data.ok) e.data.bitmap.close(); return; }
      pending.delete(e.data.id);
      clearTimeout(p.timer);
      if (e.data.ok) p.resolve(e.data.bitmap);
      else p.reject(new Error(e.data.reason));
    };
    // A worker that fails to load or throws at top level never answers: stop
    // using it for the rest of the session.
    w.onerror = () => { worker = null; failAll("preview worker failed"); };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/** Draw a preview in the worker. Rejects when the page should draw it. */
export function renderThumbInWorker(req: Omit<ThumbRequest, "id">): Promise<ImageBitmap> {
  const w = start();
  if (!w) return Promise.reject(new Error("no preview worker"));
  const id = ++seq;
  return new Promise<ImageBitmap>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("preview timed out")); }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      w.postMessage({ ...req, id } satisfies ThumbRequest);
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error("could not send to the preview worker"));
    }
  });
}
