// Saving a design as a .hyc file (see hycFile.ts for the format and import).
// Its own module because the editor saves from its first load, while import
// brings in the validator (and zod with it), which only import needs (#77).

import type { DesignFile } from "@hc/schema";
import { hycExtension } from "./hycFilePicker";

/** Serialize a design file and hand it to the browser as `<baseName>.hyc`. */
export function downloadHycFile(file: DesignFile, baseName: string): void {
  const safe = (baseName || "design").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "design";
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safe}${hycExtension}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
