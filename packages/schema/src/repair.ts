// Repairs for files an earlier writer got subtly wrong. Unlike a migration a
// repair is not keyed on the schema version: the file already claims the
// current version, so it runs on every load and import, works in place so an
// unknown key survives, and is idempotent.

import type { DesignFile } from "./schema";
import { roundedCorners } from "./factory";
import { walkNodes } from "./visitor";

/** A shape radius written as a bare number. The format's radius is the
 *  per-corner record, and every renderer reads that record, so a number drew
 *  square corners and failed validation on import. The AI composer and two
 *  editor writers (the accent rule, the image placeholder) wrote the number
 *  before 2026-09-29; a file they touched is put right here. */
export function repairCornerRadius(file: DesignFile): DesignFile {
  for (const page of file.pages ?? []) {
    walkNodes(page.children ?? [], (node) => {
      const n = node as { cornerRadius?: unknown };
      if (typeof n.cornerRadius === "number" && Number.isFinite(n.cornerRadius)) {
        n.cornerRadius = roundedCorners(n.cornerRadius);
      }
    });
  }
  return file;
}
