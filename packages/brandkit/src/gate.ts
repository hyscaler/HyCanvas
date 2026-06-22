// The pre-export / pre-publish gate. A pure decision over the
// linter's output and the kit's lint policy, consulted by the export path (doc
// 11) and publishing. Server-side defense in depth; the editor uses the
// same function so the warning/block it shows matches what the server enforces.

import type { BrandLintViolation, LintBrandKit } from "./types";
import { lintDesign } from "./lint";
import type { DesignFile } from "@hc/schema";

export interface BrandGateResult {
  /** The effective policy applied (off when no kit / policy off). */
  policy: "off" | "warn" | "block";
  /** All violations found (empty when on-brand or policy is off). */
  violations: BrandLintViolation[];
  /** True when export/publish must be blocked: policy is block AND there is at
   *  least one non-info violation. Info-level (e.g. spacing) never blocks. */
  blocked: boolean;
}

/** Evaluate the brand gate for a design (FR-8). With no kit or policy "off" the
 *  result is always unblocked with no violations. Under "warn" violations are
 *  surfaced but never block; under "block" any error/warn violation blocks. */
export function evaluateBrandGate(
  file: DesignFile,
  kit: LintBrandKit | null,
): BrandGateResult {
  if (!kit || kit.controls.lintPolicy === "off") {
    return { policy: "off", violations: [], blocked: false };
  }
  const violations = lintDesign(file, kit);
  const policy = kit.controls.lintPolicy;
  const blocked =
    policy === "block" && violations.some((v) => v.severity !== "info");
  return { policy, violations, blocked };
}
