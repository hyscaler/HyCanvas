// Import a PDF (e.g. a PDF export from another design tool) into editable pages. Uses pdf.js to pull
// each page's text runs (position, size) and rebuild them as editable text boxes,
// one design page per PDF page. pdf.js is dynamically imported so it stays out of
// the main bundle and never runs on the server.
//
// Scope: text is extracted as editable elements. Vector graphics and embedded
// images from the PDF are NOT extracted yet (that needs operator-list parsing);
// import the original images separately, or use SVG import for vectors.

import { createNode, type Node } from "@hc/schema";

export interface PdfImportedPage {
  width: number;
  height: number;
  nodes: Node[];
}

// Minimal shape of the pdf.js API we use (defensive: avoids coupling to the
// package's shipped types and keeps this compiling regardless of their changes).
interface PdfTextItem { str?: string; transform?: number[]; width?: number }
interface PdfTextContent { items: PdfTextItem[] }
interface PdfViewport { width: number; height: number }
interface PdfPage {
  getViewport(o: { scale: number }): PdfViewport;
  getTextContent(): Promise<PdfTextContent>;
  cleanup?(): void;
}
interface PdfDocument { numPages: number; getPage(n: number): Promise<PdfPage>; destroy?(): Promise<void> }
interface PdfjsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(src: { data: ArrayBuffer }): { promise: Promise<PdfDocument> };
}

function textNode(str: string, x: number, top: number, fontSize: number, width: number): Node {
  const w = Math.max(8, width);
  return createNode("text", {
    name: str.slice(0, 24),
    transform: { x, y: top, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: w, height: fontSize * 1.4 },
    box: { mode: "fixed", width: w, height: fontSize * 1.4, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "top" },
    content: [{
      runs: [{ text: str, style: { fontFamily: "system", fontStyle: "Regular", fontSize, fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } } } }],
      style: { align: "left", direction: "auto" },
    }],
  } as Partial<Node>);
}

/** Parse a PDF into editable pages (text only). */
export async function pdfToPages(data: ArrayBuffer): Promise<PdfImportedPage[]> {
  const pdfjs = (await import("pdfjs-dist")) as unknown as PdfjsModule;
  // Bundled worker (webpack/Next resolves new URL(..., import.meta.url) to an asset).
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: PdfImportedPage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const nodes: Node[] = [];
    for (const item of content.items) {
      const str = item.str ?? "";
      const tr = item.transform;
      if (!str.trim() || !tr || tr.length < 6) continue;
      // tr = [a,b,c,d,e,f]; vertical scale ~ glyph size; (e,f) = baseline in PDF
      // coords (origin bottom-left, y up). Flip to our top-left, y-down space.
      const fontSize = Math.hypot(tr[2], tr[3]) || Math.hypot(tr[0], tr[1]) || 12;
      const width = item.width && item.width > 0 ? item.width : str.length * fontSize * 0.5;
      const top = vp.height - tr[5] - fontSize * 0.8;
      nodes.push(textNode(str, tr[4], top, fontSize, width));
    }
    pages.push({ width: vp.width, height: vp.height, nodes });
    page.cleanup?.();
  }
  await doc.destroy?.();
  return pages;
}
