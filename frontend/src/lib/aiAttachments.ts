// Turning a dropped or picked file into grounding text for AI generation.
//
// Shared by the editor's assistant panel and the dashboard's brief composer:
// both let a user attach the documents a design should be built from, and the
// rules for what can be read, how a scanned PDF is refused, and how many
// sources a generation may carry must be identical in both. They diverged once
// by simply not existing in one of them.

import { oc } from "@/lib/sdk";
import { pdfFileToTextWithScanCheck } from "@/lib/pdfImport";
import { tr } from "@/lib/i18n";
import { ApiError } from "@hc/sdk";
import { apiCodeMessage } from "@/lib/errors";

/** One piece of grounding content: a file's text, a fetched page, or a paste. */
export interface AiSource {
  name: string;
  text: string;
}

/** How many sources one generation may carry (they share a token budget). */
export const maxAiSources = 8;

/** Characters kept per source. A whole book would crowd out every other source
 *  and the brief itself. */
const maxSourceChars = 60_000;

/** File types the extractor can read. Kept beside the pickers' accept lists so
 *  a drop and a pick agree about what can be attached. */
export const attachableFile = /\.(txt|md|markdown|pdf|docx|pptx|xlsx)$/i;

export const attachableAccept =
  ".txt,.md,.markdown,.pdf,.docx,.pptx,.xlsx,text/plain,text/markdown,application/pdf," +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document," +
  "application/vnd.openxmlformats-officedocument.presentationml.presentation," +
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface ExtractOutcome {
  sources: AiSource[];
  /** Human-readable reasons, one per file that could not be read. Callers
   *  surface these: a file that silently fails to attach reads as a bug. */
  errors: string[];
  /** Files rejected before reading, because the extractor cannot read them. */
  rejected: number;
}

/** Read a batch of files into grounding sources, honoring the remaining room.
 *  Never throws: one unreadable file must not take the whole batch down. */
export async function extractAiSources(picked: File[], room: number): Promise<ExtractOutcome> {
  const usable = picked.filter((f) => attachableFile.test(f.name));
  const out: ExtractOutcome = { sources: [], errors: [], rejected: picked.length - usable.length };
  for (const f of usable.slice(0, Math.max(0, room))) {
    try {
      const text = await readOne(f);
      if (text === null) continue; // already reported
      const trimmed = text.trim();
      if (!trimmed) {
        out.errors.push(`${tr("editor.no_readable_text_in_that_file")} (${f.name})`);
        continue;
      }
      out.sources.push({ name: f.name, text: trimmed.slice(0, maxSourceChars) });
    } catch (err) {
      // Server rejections carry a stable code (too large / unsupported /
      // unreadable); name the reason when there is one.
      const coded = err instanceof ApiError ? apiCodeMessage(err.body) : null;
      out.errors.push(`${coded ?? tr("editor.couldnt_read_that_file")} (${f.name})`);
    }
  }
  if (usable.length > Math.max(0, room)) {
    out.errors.push(tr("editor.attachment_limit_reached", { max: maxAiSources }));
  }
  return out;
}

/** Read one file, or null when it was refused with its own message. */
async function readOne(f: File): Promise<string | null> {
  if (/\.pdf$/i.test(f.name) || f.type === "application/pdf") {
    // Scanned-PDF detection: an image-only PDF has no text layer to ground on,
    // and OCR is out of scope, so say so rather than attach an empty source.
    const { text, scanned } = await pdfFileToTextWithScanCheck(f);
    if (scanned) throw new Error(tr("editor.pdf_looks_scanned_no_text_layer"));
    return text;
  }
  if (/\.(docx|pptx|xlsx)$/i.test(f.name)) {
    const buf = await f.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    const r = await oc.aiExtractFile({ filename: f.name, mimeType: f.type || undefined, dataBase64: btoa(binary) });
    return r.text;
  }
  return f.text();
}
