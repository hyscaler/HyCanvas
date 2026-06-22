// Brand-governance core types (FR-6, FR-7, FR-8, FR-10). These
// describe the minimal brand-kit shape the pure linter needs, plus the violation
// and applyable-fix model. The backend BrandKit (its service `types.ts`) and the
// @hc/sdk BrandKit both structurally satisfy `LintBrandKit`, so a single linter
// runs unchanged on the client (live lint) and the server (the export/publish
// gate). No IO, no React, no Nest: pure functions over a DesignFile + a kit.

import type { Color } from "@hc/schema";

/** A swatch within a brand palette (the canonical sRGB Color lives in the color system). */
export interface LintSwatch {
  id: string;
  role: string;
  name?: string;
  value: Color;
}

/** A named color palette inside a kit. */
export interface LintPalette {
  id: string;
  name: string;
  colors: LintSwatch[];
}

/** A brand font association; resolves to a family via the text-engine font registry. */
export interface LintFont {
  id: string;
  role: string;
  fontFamily: string;
}

/** A logo asset with its lint metadata (approved variants, clear space, size). */
export interface LintLogo {
  id: string;
  label: string;
  assetId: string;
  variants?: { dark?: string; light?: string };
  clearSpaceRatio?: number;
  minSizePx?: number;
}

/** The lint-relevant brand controls (slice A locks + slice B lint policy). */
export interface LintControls {
  lockColors: boolean;
  lockFonts: boolean;
  /** off: never lint; warn: surface but allow export; block: gate export. */
  lintPolicy: "off" | "warn" | "block";
}

/** The minimal kit view the linter reads. The backend + SDK BrandKit are
 *  assignable to this (extra fields are ignored). */
export interface LintBrandKit {
  palettes: LintPalette[];
  fonts: LintFont[];
  logos: LintLogo[];
  controls: LintControls;
}

/** A structured, applyable fix suggestion attached to a violation. The editor
 *  reads `kind` to choose the scene-graph op and applies the typed payload:
 *   - snap_color: replace the offending color with the nearest brand swatch.
 *   - swap_font:  replace the offending family with a brand font family.
 *   - fix_contrast: nudge the text fill to `color` (a passing foreground).
 *   - restore_logo: restore uniform aspect / min-size / clear space (manual).
 *  Spacing and some logo issues carry no auto-fix (fix is omitted). */
export type BrandLintFix =
  | { kind: "snap_color"; from: string; to: Color }
  | { kind: "swap_font"; from: string; to: string }
  | { kind: "fix_contrast"; color: Color }
  | { kind: "restore_logo"; reason: "aspect" | "min_size" | "clear_space" };

/** A single brand-governance violation. `nodeId`/`pageId` locate
 *  the offending element so the editor can highlight it. `fix` is present only
 *  when a safe, automatic correction exists. */
export interface BrandLintViolation {
  /** Stable within one lint run (kind + locus + value), so the UI can key/dedupe
   *  and the "fix" endpoint can address a specific violation. */
  id: string;
  kind:
    | "off-brand-color"
    | "off-brand-font"
    | "logo-misuse"
    | "low-contrast"
    | "spacing";
  severity: "info" | "warn" | "error";
  nodeId?: string;
  pageId?: string;
  message: string;
  fix?: BrandLintFix;
}
