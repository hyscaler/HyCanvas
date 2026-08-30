// One-click AI template builder from an uploaded PPTX (F40 E13). All from
// shipped parts: pptxToDesign imports the deck, extractLayoutSet derives the
// reusable layout system (with an optional vision correction pass when the
// workspace has a vision-capable provider), and the theme comes from the
// deck's own dominant palette (contrast-repaired 6-slot derivation) plus its
// dominant fonts mapped onto the loadable catalog. The result is a template
// FILE ready for saveAsTemplate; nothing here mutates the open document.
// Degrades honestly: every fallback is recorded in `losses` so the confirm
// step can tell the user exactly what the template will and will not carry.

import {
  migrate,
  themeFromPalette,
  type DesignFile,
  type Fill,
  type Color,
  type Theme,
} from "@hc/schema";
import {
  deriveThemeSlots,
  extractLayoutSet,
  repairThemeSlots,
  themeSlotNames,
  verifyLayoutCapacities,
  type ExtractPageLike,
} from "@hc/aistudio";
import { pptxToDesign } from "@hc/export";
import { searchFonts } from "@hc/text";
import { refineExtractedLayoutSet } from "@/lib/layoutVision";
import { tr } from "@/lib/i18n";

export interface PptxTemplateResult {
  /** The template file: the imported deck + masters/layouts + theme record. */
  file: DesignFile;
  suggestedTitle: string;
  layoutCount: number;
  theme: Theme | null;
  /** Honest notes about what degraded (no vision pass, font fallbacks, ...). */
  losses: string[];
}

function hex6(c: Color): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${h(c.srgb.r)}${h(c.srgb.g)}${h(c.srgb.b)}`;
}

function saturation(c: Color): number {
  const { r, g, b } = c.srgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function luminance(c: Color): number {
  return 0.2126 * c.srgb.r + 0.7152 * c.srgb.g + 0.0722 * c.srgb.b;
}

/** Count every solid color in the file (page backgrounds weigh more: they set
 *  the deck's mood), returning candidates by frequency. */
function collectColors(file: DesignFile): { color: Color; count: number }[] {
  const counts = new Map<string, { color: Color; count: number }>();
  const add = (c: Color | undefined, weight: number) => {
    if (!c) return;
    const key = hex6(c);
    const cur = counts.get(key);
    if (cur) cur.count += weight;
    else counts.set(key, { color: c, count: weight });
  };
  const addFill = (fill: Fill | undefined, weight: number) => {
    const f = fill as unknown as { type?: string; color?: Color; stops?: { color: Color }[] } | undefined;
    if (!f) return;
    if (f.type === "solid" && f.color) add(f.color, weight);
    else if (Array.isArray(f.stops)) for (const st of f.stops) add(st.color, weight);
  };
  const walk = (n: unknown, weight: number) => {
    const rec = n as { fills?: Fill[]; stroke?: { color?: Color; fill?: Fill }; content?: { runs: { style?: { fill?: Fill } } [] }[]; children?: unknown[] };
    for (const f of rec.fills ?? []) addFill(f, weight);
    if (rec.stroke) {
      add(rec.stroke.color, weight);
      addFill(rec.stroke.fill, weight);
    }
    for (const par of rec.content ?? []) for (const run of par.runs) addFill(run.style?.fill, weight);
    for (const kid of rec.children ?? []) walk(kid, weight);
  };
  for (const page of file.pages) {
    addFill((page as unknown as { background?: Fill }).background, 6);
    for (const child of page.children) walk(child, 1);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

/** The deck's dominant fonts: heading = the family carrying the largest text,
 *  body = the most frequent family, both mapped onto the loadable catalog. */
function collectFonts(file: DesignFile, losses: string[]): { heading?: string; body?: string } {
  const freq = new Map<string, number>();
  let headingFamily: string | undefined;
  let headingSize = 0;
  const walk = (n: unknown) => {
    const rec = n as { content?: { runs: { text?: string; style?: { fontFamily?: string; fontSize?: number } }[] }[]; children?: unknown[] };
    for (const par of rec.content ?? []) {
      for (const run of par.runs) {
        const fam = run.style?.fontFamily;
        if (!fam || fam === "system") continue;
        freq.set(fam, (freq.get(fam) ?? 0) + (run.text?.length ?? 1));
        const size = run.style?.fontSize ?? 0;
        if (size > headingSize) {
          headingSize = size;
          headingFamily = fam;
        }
      }
    }
    for (const kid of rec.children ?? []) walk(kid);
  };
  for (const page of file.pages) for (const child of page.children) walk(child);

  const loadable = (fam: string | undefined): string | undefined => {
    if (!fam) return undefined;
    const hit = searchFonts(fam).find((f) => f.family.toLowerCase() === fam.toLowerCase());
    if (hit) return hit.family;
    losses.push(`font "${fam}" is not in the catalog; the template falls back to Inter`);
    return "Inter"; // i18n-ignore: font family name
  };
  const byFreq = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  return { heading: loadable(headingFamily), body: loadable(byFreq[0]?.[0]) };
}

/** Derive the template's theme record from the deck's own colors and fonts:
 *  seed slots from the dominant saturated colors, contrast-repair, and name
 *  it after the deck. Null when the deck carries no usable color at all. */
function deriveTheme(file: DesignFile, run: string, losses: string[]): Theme | null {
  const candidates = collectColors(file);
  if (!candidates.length) {
    losses.push("no solid colors found; the template carries no theme");
    return null;
  }
  const vivid = candidates.filter((c) => saturation(c.color) > 0.15);
  const primary = (vivid[0] ?? candidates[0]).color;
  const accent = (vivid[1] ?? vivid[0] ?? candidates[0]).color;
  const deep = [...(vivid.length ? vivid : candidates)].sort((a, b) => luminance(a.color) - luminance(b.color))[0].color;
  const bg = candidates[0].color; // backgrounds weigh heaviest, so index 0 leans background
  const mode = luminance(bg) < 0.35 ? "dark" : "light";
  const slots = repairThemeSlots(
    deriveThemeSlots({ primary: hex6(primary), accent: hex6(accent), deep: hex6(deep) }, mode),
    mode,
  );
  const fonts = collectFonts(file, losses);
  const fromHex6 = (hexv: string): Color => {
    const n = parseInt(hexv.slice(1), 16);
    return { srgb: { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 } };
  };
  return themeFromPalette(
    `theme-pptx-${run}`,
    themeSlotNames.map((slot) => ({ id: `theme-pptx-${run}-${slot}`, name: slot, color: fromHex6(slots[slot]) })),
    { name: file.title, fontHeading: fonts.heading, fontBody: fonts.body },
  );
}

/** Build a reusable template from PPTX bytes. `workspaceId` gates the vision
 *  correction pass; null runs the geometric extraction only. */
export async function buildTemplateFromPptx(workspaceId: string | null, bytes: Uint8Array, name: string): Promise<PptxTemplateResult> {
  const losses: string[] = [];
  const file = migrate(await pptxToDesign(bytes, { title: name })) as DesignFile;
  if (!file.pages.length) throw new Error("the PPTX contained no slides");

  const run = crypto.randomUUID().slice(0, 6);

  // The layout system: geometric extraction, optionally vision-corrected.
  const set = extractLayoutSet(file.pages as unknown as ExtractPageLike[]);
  let layouts = set.layouts;
  if (layouts.length && workspaceId) {
    try {
      const { layouts: corrected, refined } = await refineExtractedLayoutSet(workspaceId, structuredClone(file), set);
      layouts = corrected;
      if (!refined) losses.push("no vision-capable model; layouts come from geometric extraction only");
    } catch {
      losses.push("the vision pass failed; layouts come from geometric extraction only");
    }
  } else if (layouts.length) {
    losses.push("no workspace provider; layouts come from geometric extraction only");
  }
  if (!layouts.length) {
    losses.push("no reusable layouts could be extracted (slides may be image-only); the template carries pages and theme only");
  }

  const masterId = "master-default";
  const rec = file as unknown as {
    masters?: { id: string; name: string; placeholders: unknown[] }[];
    layouts?: unknown[];
    theme?: Theme;
    meta?: Record<string, unknown>;
  };
  if (layouts.length) {
    const verified = layouts.map((l, i) => {
      const v = verifyLayoutCapacities(l, l.sourcePageSize);
      return {
        id: `layout-ext-${run}-${i + 1}`,
        masterId,
        name: v.name,
        ...(v.background ? { background: structuredClone(v.background) } : {}),
        placeholders: structuredClone(v.placeholders),
      };
    });
    if (!(rec.masters ?? []).some((m) => m.id === masterId)) {
      rec.masters = [...(rec.masters ?? []), { id: masterId, name: tr("app.default"), placeholders: [] }];
    }
    rec.layouts = [...((rec.layouts as unknown[]) ?? []), ...verified];
    // Link each source page to its extracted layout, so applying the template
    // (and generating on it) starts layout-linked.
    for (let i = 0; i < set.assignments.length; i++) {
      const a = set.assignments[i];
      if (a !== null && file.pages[i]) {
        (file.pages[i] as unknown as { layoutId?: string }).layoutId = verified[a]?.id;
      }
    }
  }

  const theme = deriveTheme(file, run, losses);
  if (theme) rec.theme = theme;
  rec.meta = rec.meta ?? {};

  return {
    file,
    suggestedTitle: file.title?.trim() || name.replace(/\.pptx$/i, "") || "Imported template",
    layoutCount: layouts.length,
    theme,
    losses,
  };
}
