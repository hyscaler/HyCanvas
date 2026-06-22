// Style cascade: effective style = defaults -> paragraph baseChar
// -> linked style (with basedOn chain) -> local overrides. Editing a sheet style
// re-resolves every linked run/paragraph.

import type {
  CharStyle,
  Paragraph,
  ParagraphStyle,
  Run,
  TextStyleSheet,
} from "@hc/schema";
import { DEFAULT_CHAR_STYLE, DEFAULT_PARAGRAPH_STYLE } from "./defaults";

// Merge the defined keys of `b` over `a`. `axes` and `features` deep-merge so a
// partial override (e.g. just `wght`) keeps the other axes.
function merge<T extends object>(a: T, b: Partial<T> | undefined): T {
  if (!b) return a;
  const out = { ...a } as Record<string, unknown>;
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    if (
      (k === "axes" || k === "features") &&
      v && typeof v === "object" &&
      out[k] && typeof out[k] === "object"
    ) {
      out[k] = { ...(out[k] as object), ...(v as object) };
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

function resolveSheetChar(
  sheet: TextStyleSheet,
  id: string,
  seen: Set<string> = new Set(),
): Partial<CharStyle> {
  const entry = sheet.charStyles[id];
  if (!entry || seen.has(id)) return {}; // missing or basedOn cycle
  seen.add(id);
  const base = entry.basedOn ? resolveSheetChar(sheet, entry.basedOn, seen) : {};
  return merge(base, entry.style);
}

function resolveSheetParagraph(
  sheet: TextStyleSheet,
  id: string,
  seen: Set<string> = new Set(),
): Partial<ParagraphStyle> {
  const entry = sheet.paragraphStyles[id];
  if (!entry || seen.has(id)) return {};
  seen.add(id);
  const base = entry.basedOn ? resolveSheetParagraph(sheet, entry.basedOn, seen) : {};
  return merge(base, entry.style);
}

/** Effective character style for a run within a paragraph. */
export function resolveCharStyle(
  run: Run,
  paragraph?: Paragraph,
  sheet?: TextStyleSheet,
): CharStyle {
  let s: CharStyle = { ...DEFAULT_CHAR_STYLE };
  if (paragraph?.style.baseChar) s = merge(s, paragraph.style.baseChar);
  if (run.charStyleId && sheet) s = merge(s, resolveSheetChar(sheet, run.charStyleId));
  else s = merge(s, run.style); // inline resolved style
  if (run.overrides) s = merge(s, run.overrides);
  return s;
}

/** Effective paragraph style. */
export function resolveParagraphStyle(
  paragraph: Paragraph,
  sheet?: TextStyleSheet,
): ParagraphStyle {
  let s: ParagraphStyle = { ...DEFAULT_PARAGRAPH_STYLE };
  if (paragraph.paraStyleId && sheet) s = merge(s, resolveSheetParagraph(sheet, paragraph.paraStyleId));
  else s = merge(s, paragraph.style);
  if (paragraph.overrides) s = merge(s, paragraph.overrides);
  return s;
}
