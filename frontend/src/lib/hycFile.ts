// .hyc: the HyCanvas design file on disk. A .hyc is the open design file
// format (@hc/schema) serialized as readable JSON, so it opens in any text
// editor and round-trips through import untouched. One extension covers every
// document kind (designs, presentations, whiteboards, docs, sheets, video) and
// templates alike: a template IS a design file.
//
// Import notes: files from older builds forward-migrate here (same steps the
// server applies on read), files from NEWER builds are refused with a clear
// message rather than silently dropping fields. Asset references travel as
// they are stored: data-URL assets are fully self-contained, workspace-hosted
// assets keep their URLs (which resolve only on the origin instance).

import { CURRENT_SCHEMA_VERSION, migrate, validate, type DesignFile } from "@hc/schema";
import { tr } from "@/lib/i18n";
import { CodedError } from "./errors";

export const HYC_EXTENSION = ".hyc";
/** What the import file pickers accept: .hyc first, plain .json as a fallback
 *  (content is validated, so the name never decides). */
export const HYC_ACCEPT = ".hyc,.json,application/json";

/** Serialize a design file and hand it to the browser as `<baseName>.hyc`. */
export function downloadHycFile(file: DesignFile, baseName: string): void {
  const safe = (baseName || "design").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "design";
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safe}${HYC_EXTENSION}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Parse + validate + forward-migrate .hyc text. Throws an Error whose message
 *  is safe to show the user when the content is not a usable design file. */
export function parseHycFile(text: string): DesignFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CodedError("errors.hyc_not_json", "This file is not a HyCanvas design file (not valid JSON).");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CodedError("errors.hyc_not_design_file", "This file is not a HyCanvas design file.");
  }
  const file = parsed as DesignFile;
  if (typeof file.schemaVersion !== "number" || !Array.isArray(file.pages) || file.pages.length === 0) {
    throw new CodedError("errors.hyc_missing_fields", "This file is not a HyCanvas design file (missing pages or schema version).");
  }
  if (file.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new CodedError("errors.hyc_newer_version", "This file was made by a newer version of HyCanvas. Update this instance to open it.");
  }
  // Older files forward-migrate (forward-only and idempotent); a current file
  // passes through untouched.
  const migrated = migrate(file);
  // Structural validation with the same validator the server enforces on write,
  // so a hand-edited file that violates an invariant (a node missing its type, a
  // malformed page) is rejected here with a specific reason. Without this the
  // design-import path would surface a cryptic server 422, and the template
  // path (which stores verbatim, no server-side structure check) would persist a
  // poison template that fails on every use and cannot be deleted. Both paths
  // eventually assign their own id/title, so placeholders satisfy the top-level
  // required fields and validation focuses on the document body.
  const probe = { ...migrated, id: (migrated.id as string) || "import-probe", title: (migrated.title as string) || tr("app.imported") } as DesignFile;
  const result = validate(probe);
  if (!result.ok) {
    throw new CodedError("errors.hyc_invalid_design", `This file is not a valid HyCanvas design (${result.message}).`, { detail: result.message });
  }
  return migrated;
}

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
