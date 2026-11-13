// The schema-free half of the .hyc helpers (see hycFile.ts): what the file
// pickers accept, reading a picked file, and the title an import lands under.
// Kept apart so a page can render its import buttons without loading the design
// schema and validator, which hycFile.ts pulls in for parsing.

import type { DesignFile } from "@hc/schema";
import { tr } from "@/lib/i18n";
import { CodedError } from "./errors";

export const hycExtension = ".hyc";
/** What the import file pickers accept: .hyc first, plain .json as a fallback
 *  (content is validated, so the name never decides). */
export const hycAccept = ".hyc,.json,application/json";

/** Read a picked File as text (the file pickers hand these straight here). */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new CodedError("errors.file_read_failed", "Could not read the file."));
    reader.readAsText(file);
  });
}

/** The title an imported file lands under: its own title, else the filename
 *  without extension, else a generic fallback. */
export function importedTitle(file: DesignFile, filename: string): string {
  const own = typeof file.title === "string" ? file.title.trim() : "";
  if (own) return own;
  const stem = filename.replace(/\.[^.]*$/, "").trim();
  return stem || tr("app.imported_design");
}
