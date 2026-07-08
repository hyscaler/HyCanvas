// Print (native path). Renders the design's pages to a hidden print
// frame at a print-grade resolution and opens the operating-system print dialog,
// which itself handles printer choice, copies, page range, and "Save as PDF".
// The previous print-on-demand ordering wizard (catalog / quote / fulfillment)
// was removed: it could not complete an order (no payment provider or print
// vendor wired), so it dead-ended. A print-ready PDF is available via Download.

import { useState } from "react";
import { Printer } from "lucide-react";
import { createScene, renderScene, type CanvasLike, type Viewport } from "@hc/engine";
import { useEditor } from "@/store/editor";
import { imageAssets } from "@/lib/assetProvider";
import { useToast } from "@/components/ui/Toast";

const TARGET_DPI = 200; // print-grade raster resolution
const MAX_DIM = 4200; // cap any single page's pixel dimension (memory/perf)

/** Render one page to an opaque (white-backed) offscreen canvas at `scale`. */
function renderPageCanvas(doc: import("@hc/schema").DesignFile, index: number, scale: number): HTMLCanvasElement | null {
  const pg = doc.pages[index];
  if (!pg) return null;
  const w = Math.max(1, Math.round(pg.width * scale));
  const h = Math.max(1, Math.round(pg.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  const vp: Viewport = { zoom: scale, panX: 0, panY: 0, dpr: 1, width: w, height: h };
  renderScene(createScene(doc, index), ctx as unknown as CanvasLike, vp, { assets: imageAssets });
  return canvas;
}

/** Render the chosen pages and open the OS print dialog via a hidden iframe. */
function nativePrint(doc: import("@hc/schema").DesignFile, indices: number[], onDone: () => void, onError: () => void): void {
  try {
    const sourceDpi = doc.dpi ?? 96;
    const first = doc.pages[indices[0]];
    if (!first) { onError(); return; }
    // One scale for all pages: aim for TARGET_DPI, capped so no page exceeds MAX_DIM.
    const want = TARGET_DPI / sourceDpi;
    const maxSide = Math.max(...indices.map((i) => Math.max(doc.pages[i].width, doc.pages[i].height)));
    const scale = Math.max(1, Math.min(want, MAX_DIM / Math.max(1, maxSide)));

    const urls: string[] = [];
    for (const i of indices) {
      const c = renderPageCanvas(doc, i, scale);
      if (c) urls.push(c.toDataURL("image/png")); // throws on a cross-origin tainted canvas
    }
    if (!urls.length) { onError(); return; }

    // @page size from the first page's physical size (CSS can't vary per page);
    // other pages are contained to fit, which is correct for uniform documents.
    const wIn = (first.width / sourceDpi).toFixed(3);
    const hIn = (first.height / sourceDpi).toFixed(3);
    const body = urls.map((u) => `<div class="pg"><img src="${u}" alt=""></div>`).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${(doc.title || "design").replace(/[<>&]/g, "")}</title>
<style>
  @page { size: ${wIn}in ${hIn}in; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .pg { width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; page-break-after: always; break-after: page; }
  .pg:last-child { page-break-after: auto; break-after: auto; }
  img { max-width: 100%; max-height: 100%; display: block; }
</style></head><body>${body}</body></html>`;

    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(iframe);
    const cw = iframe.contentWindow;
    const cd = iframe.contentDocument;
    if (!cw || !cd) { document.body.removeChild(iframe); onError(); return; }

    let cleaned = false;
    const cleanup = () => { if (cleaned) return; cleaned = true; try { document.body.removeChild(iframe); } catch { /* already gone */ } };
    cw.onafterprint = cleanup;

    cd.open();
    cd.write(html);
    cd.close();

    // Data URLs render synchronously, but give the frame a beat to lay out.
    setTimeout(() => {
      try {
        cw.focus();
        cw.print();
      } catch {
        onError();
      } finally {
        onDone();
        // Fallback cleanup for browsers that never fire onafterprint.
        setTimeout(cleanup, 60000);
      }
    }, 250);
  } catch {
    onError();
  }
}

export function PrintDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.ReactElement | null {
  const toast = useToast();
  const doc = useEditor((s) => s.doc);
  const activePage = useEditor((s) => s.activePage);
  useEditor((s) => s.rev); // re-read the live doc on edits
  const [scope, setScope] = useState<"all" | "current">("all");
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const pageCount = doc.pages.length;
  const indices = scope === "current" || pageCount <= 1 ? [Math.min(activePage, pageCount - 1)] : doc.pages.map((_, i) => i);

  function go() {
    setBusy(true);
    nativePrint(
      doc,
      indices,
      () => { setBusy(false); onClose(); },
      () => { setBusy(false); toast.error("Couldn't prepare the print, an external image may have blocked it. Download as PDF instead."); },
    );
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30" onClick={onClose}>
      <div role="dialog" aria-label="Print" className="w-80 rounded-2xl bg-surface p-5 shadow-2xl ring-1 ring-black/5" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 flex items-center gap-2 text-base font-semibold text-neutral-900">
          <Printer size={18} className="text-neutral-500" /> Print
        </h2>
        <p className="mb-4 text-[12px] text-neutral-500">Opens your system print dialog. Choose a printer, or pick &ldquo;Save as PDF&rdquo; there to get a file.</p>

        {pageCount > 1 && (
          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-medium text-neutral-500">Pages</label>
            <div className="flex gap-1">
              <button type="button" onClick={() => setScope("all")} className={`flex-1 rounded-lg py-1.5 text-xs font-medium transition ${scope === "all" ? "bg-brand-600 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}>All {pageCount} pages</button>
              <button type="button" onClick={() => setScope("current")} className={`flex-1 rounded-lg py-1.5 text-xs font-medium transition ${scope === "current" ? "bg-brand-600 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}>Current page</button>
            </div>
            <p className="mt-1.5 text-[11px] text-neutral-400">You can also pick a page range in the print dialog.</p>
          </div>
        )}

        <div className="flex justify-end gap-2 text-sm">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-neutral-600 hover:bg-neutral-100">Cancel</button>
          <button onClick={go} disabled={busy} className="flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-50">
            <Printer size={15} /> {busy ? "Preparing…" : "Print"}
          </button>
        </div>
      </div>
    </div>
  );
}
