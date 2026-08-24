// F28 T19 - AI theme generation with deterministic validation and repair.
//
// One structured model call proposes a deck theme (palette slots + font pair);
// this module owns everything around that call: the JSON schema the model must
// satisfy, the strict hex/font validation of what comes back, the WCAG AA
// contrast gate, and - when a color fails - a deterministic repair path that
// re-derives the failing slots from the surviving ones by stepping lightness
// in OKLCH along a fixed ladder. The ladder derivation is closely adapted from
// an Apache-2.0 reference implementation (see THIRD_PARTY.md); the repair is
// fully deterministic (no retry-until-contrast randomness), so the same model
// output always yields the same theme.
//
// The palette convention is the 6 ordered slots the editor's built-in themes
// already use, and what a swap remaps slot-by-slot:
//   0 primary - the emphasis color (headings, key shapes, generated page bg)
//   1 accent  - a sibling of primary for secondary emphasis
//   2 deep    - a strong dark (light, in dark mode) variation of primary
//   3 tint    - a subtle card/surface tone sitting just off the paper
//   4 ink     - body text on paper
//   5 paper   - the slide background surface

import { contrastRatio, fixToAA, fromHex, oklchToRgb, rgbToOklch, toHex } from "@hc/color";
import type { Color, ColorSwatch, Theme } from "@hc/schema";
import type { DeckTheme } from "./outline";
import { readableTextColor } from "./layout";

export const themeSlotNames = ["primary", "accent", "deep", "tint", "ink", "paper"] as const;
export type ThemeSlotName = (typeof themeSlotNames)[number];
export type ThemeSlots = Record<ThemeSlotName, string>;

/** Families the model may pick from. Every entry exists in the app's bundled
 *  font catalog (open-source webfonts), so a generated theme never names a
 *  font the editor cannot load. */
export const themeFontFamilies = [
  "Inter",
  "Poppins",
  "Playfair Display",
  "Source Sans 3",
  "Raleway",
  "Prata",
  "Lora",
  "Merriweather",
  "Montserrat",
  "Work Sans",
  "DM Sans",
  "DM Serif Display",
  "Space Grotesk",
  "Libre Baskerville",
  "IBM Plex Sans",
  "IBM Plex Serif",
  "Plus Jakarta Sans",
  "Sora",
  "Manrope",
  "Fraunces",
  "Spectral",
  "Nunito",
  "Outfit",
  "Lato",
  "Rubik",
  "Cormorant Garamond",
] as const;

const hexPattern = /^#[0-9a-fA-F]{6}$/;

// The perceptual lightness ladder (descending, light to dark) and the dark
// classification threshold, adapted from the reference palette generator.
export const lightnessLadder = [0.97, 0.93, 0.86, 0.78, 0.7, 0.62, 0.54, 0.46, 0.38, 0.3] as const;
export const isDarkBelow = 0.65;

/** Index of the ladder step nearest to a lightness value. */
function ladderIndexNearest(l: number): number {
  let best = 0;
  let bestD = Math.abs(lightnessLadder[0] - l);
  for (let i = 1; i < lightnessLadder.length; i++) {
    const d = Math.abs(lightnessLadder[i] - l);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/** The ladder lightness `distance` steps from `l`, toward dark or light,
 *  clamped at the ladder's ends. Deterministic by construction. */
export function ladderStep(l: number, distance: number, dir: "darker" | "lighter"): number {
  const idx = ladderIndexNearest(l);
  const next = dir === "darker" ? idx + distance : idx - distance;
  return lightnessLadder[Math.max(0, Math.min(lightnessLadder.length - 1, next))];
}

/** Any subset of palette seeds; missing or invalid slots are derived. */
export type ThemeSeedColors = Partial<ThemeSlots>;

function parseHex(v: string | undefined): Color | null {
  if (!v || !hexPattern.test(v.trim())) return null;
  return fromHex(v.trim());
}

/**
 * Derive the full 6-slot palette from any subset of seeds - the deterministic
 * repair path. Provided (valid) slots are kept verbatim; every other slot is
 * computed from the survivors by stepping lightness in OKLCH:
 *  - paper sits at the mode's end of the ladder with a whisper of primary hue,
 *  - tint one ladder step off paper (toward dark on light paper and the
 *    reverse on dark - the surfaces-invert-with-mode rule),
 *  - deep is a primary variation at the far ladder end, reversed for light
 *    themes, and accent a primary variation one step lighter,
 *  - ink is the layout engine's own readable ink over paper (AA-forced).
 */
export function deriveThemeSlots(seeds: ThemeSeedColors, mode: "light" | "dark" = "light"): ThemeSlots {
  const primary = parseHex(seeds.primary) ?? fromHex("#1f3a93")!;
  const pOk = rgbToOklch(primary);
  const paper =
    parseHex(seeds.paper) ?? oklchToRgb({ l: mode === "dark" ? 0.22 : 0.985, c: Math.min(pOk.c, 0.02), h: pOk.h });
  const paperDark = rgbToOklch(paper).l < isDarkBelow;
  const tint =
    parseHex(seeds.tint) ??
    oklchToRgb({
      l: ladderStep(rgbToOklch(paper).l, 1, paperDark ? "lighter" : "darker"),
      c: Math.min(pOk.c, 0.05),
      h: pOk.h,
    });
  const deep =
    parseHex(seeds.deep) ??
    oklchToRgb({ l: paperDark ? lightnessLadder[2] : lightnessLadder[8], c: Math.min(pOk.c, 0.14), h: pOk.h });
  const accent = parseHex(seeds.accent) ?? oklchToRgb({ l: ladderStep(pOk.l, 1, "lighter"), c: pOk.c, h: pOk.h });
  const ink = parseHex(seeds.ink) ?? readableTextColor([paper]);
  return {
    primary: toHex(primary),
    accent: toHex(accent),
    deep: toHex(deep),
    tint: toHex(tint),
    ink: toHex(ink),
    paper: toHex(paper),
  };
}

/** The contrast pairs a theme must clear, with their thresholds: body ink on
 *  paper and on the card tint (AA normal), primary emphasis on paper (AA
 *  large). Returns the failing pair names (empty = passes). */
export function themeContrastFailures(slots: ThemeSlots): ThemeSlotName[] {
  const c = (a: string, b: string) => contrastRatio(fromHex(a)!, fromHex(b)!);
  const failing: ThemeSlotName[] = [];
  if (c(slots.ink, slots.paper) < 4.5) failing.push("ink");
  if (c(slots.ink, slots.tint) < 4.5) failing.push("tint");
  if (c(slots.primary, slots.paper) < 3.0) failing.push("primary");
  return failing;
}

/** Repair a palette in place of rejecting it: re-derive each failing slot from
 *  the passing ones, then force the stragglers. Always returns a palette with
 *  zero contrast failures. */
export function repairThemeSlots(slots: ThemeSlots, mode: "light" | "dark"): ThemeSlots {
  let failing = themeContrastFailures(slots);
  if (!failing.length) return slots;
  // Re-derive the failing slots (keep the passing ones as seeds).
  const seeds: ThemeSeedColors = { ...slots };
  for (const name of failing) delete seeds[name];
  let out = deriveThemeSlots(seeds, mode);
  failing = themeContrastFailures(out);
  // Deterministic last resort: nudge primary to AA-large, re-anchor tint on
  // paper, and force ink through the layout engine's readable pick.
  if (failing.includes("primary")) {
    out = { ...out, primary: toHex(fixToAA(fromHex(out.primary)!, fromHex(out.paper)!, 3.0)) };
  }
  if (failing.includes("ink")) {
    out = { ...out, ink: toHex(readableTextColor([fromHex(out.paper)!])) };
  }
  if (themeContrastFailures(out).includes("tint")) {
    out = { ...out, tint: out.paper };
  }
  return out;
}

// --- The model contract ------------------------------------------------------

/** JSON schema for the one structured theme call. Hexes are strict 6-digit;
 *  fonts are constrained to the loadable allowlist. */
export function generatedThemeSchema(): Record<string, unknown> {
  const hex = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["name", "mode", "colors", "fontHeading", "fontBody"],
    properties: {
      name: { type: "string", maxLength: 40, description: "a short, evocative theme name" },
      mode: { type: "string", enum: ["light", "dark"] },
      colors: {
        type: "object",
        additionalProperties: false,
        required: ["primary", "accent", "ink", "paper"],
        properties: { primary: hex, accent: hex, deep: hex, tint: hex, ink: hex, paper: hex },
      },
      fontHeading: { type: "string", enum: [...themeFontFamilies] },
      fontBody: { type: "string", enum: [...themeFontFamilies] },
    },
  };
}

// i18n-ignore: model system prompt, never translated.
export function themeGenSystemPrompt(): string {
  return [
    "You design a cohesive visual theme for a slide deck: a small color palette and a font pairing.",
    "Return ONLY JSON matching the schema. Colors are strict 6-digit hex like #1a2b3c.",
    "Slots: paper is the slide background surface; ink is body text on paper (needs WCAG AA, 4.5:1 against paper);",
    "primary is the emphasis color for headings and key shapes (at least 3:1 against paper);",
    "accent is a sibling of primary for secondary emphasis; tint is a subtle card surface sitting just off paper;",
    "deep is a strong dark variation of primary (a light one in dark mode).",
    "Choose mode dark only when the request calls for a dark look.",
    "Use a real brand's colors only when the request names a brand you are confident about; otherwise pick colors that fit the topic and mood.",
    "Pick fonts only from the allowed list, pairing a distinctive heading with a readable body.",
  ].join(" ");
}

// i18n-ignore: model prompt content, never translated.
export function themeGenUserPrompt(
  description: string | undefined,
  context: { deckTitle?: string; brandPalette?: string[] } = {},
): string {
  const parts: string[] = [];
  parts.push(
    description?.trim()
      ? `Design a theme for: ${description.trim()}`
      : "Design a tasteful, professional theme for this deck.",
  );
  if (context.deckTitle) parts.push(`Deck title: ${context.deckTitle}`);
  if (context.brandPalette?.length) parts.push(`Workspace brand colors (prefer these): ${context.brandPalette.join(", ")}`);
  return parts.join("\n");
}

function slotSwatches(id: string, slots: ThemeSlots): ColorSwatch[] {
  return themeSlotNames.map((name) => {
    const c = fromHex(slots[name])!;
    return { id: `${id}-${name}`, name, color: c };
  });
}

/**
 * Turn the model's raw structured reply into a valid Theme record: strict hex
 * and font validation (anything invalid is dropped and re-derived), the full
 * palette derived from what survives, and contrast failures repaired
 * deterministically. Never throws; garbage in still yields a readable theme.
 */
export function buildGeneratedTheme(raw: unknown, opts: { id: string }): Theme {
  const r = (raw ?? {}) as {
    name?: unknown;
    mode?: unknown;
    colors?: Record<string, unknown>;
    fontHeading?: unknown;
    fontBody?: unknown;
  };
  const mode: "light" | "dark" = r.mode === "dark" ? "dark" : "light";
  const seeds: ThemeSeedColors = {};
  for (const name of themeSlotNames) {
    const v = r.colors?.[name];
    if (typeof v === "string" && hexPattern.test(v.trim())) seeds[name] = v.trim().toLowerCase();
  }
  const slots = repairThemeSlots(deriveThemeSlots(seeds, mode), mode);
  const allow = new Set<string>(themeFontFamilies.map((f) => f.toLowerCase()));
  const font = (v: unknown): string | undefined =>
    typeof v === "string" && allow.has(v.trim().toLowerCase())
      ? themeFontFamilies.find((f) => f.toLowerCase() === (v as string).trim().toLowerCase())
      : undefined;
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 40) : undefined;
  return {
    id: opts.id,
    name,
    colors: slotSwatches(opts.id, slots),
    fontHeading: font(r.fontHeading) ?? "Inter",
    fontBody: font(r.fontBody) ?? "Inter",
  };
}

/** A stable id for a derived theme: a small hash over its inputs, so the same
 *  generation yields the same id and re-applying it is a no-op. */
export function themeIdFor(prefix: string, parts: string[]): string {
  let h = 7;
  for (const s of parts) for (const ch of s) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return `${prefix}-${(h >>> 0).toString(36)}`;
}

/**
 * The Theme record for a generated deck (T19 d): its slots carry the EXACT
 * colors the layout engine painted - the background stop(s) and the readable
 * ink readableTextColor() picked over them - so a later theme swap remaps
 * precisely the pixels this generation produced. The remaining slots are
 * ladder variations for future styling.
 */
export function themeRecordFromDeckTheme(deck: DeckTheme, opts: { name?: string } = {}): Theme {
  const bg = fromHex(deck.background.color ?? "#ffffff") ?? { srgb: { r: 1, g: 1, b: 1, a: 1 } };
  const bg2 = deck.background.kind === "gradient" && deck.background.color2 ? fromHex(deck.background.color2) : null;
  const refs = bg2 ? [bg, bg2] : [bg];
  const ink = readableTextColor(refs);
  const pOk = rgbToOklch(bg);
  const derived = deriveThemeSlots({ primary: toHex(bg), ink: toHex(ink), paper: toHex(bg) }, pOk.l < isDarkBelow ? "dark" : "light");
  const slots: ThemeSlots = { ...derived, accent: bg2 ? toHex(bg2) : derived.accent };
  const id = themeIdFor("theme-gen", [slots.primary, slots.accent, slots.ink, deck.fontHeading ?? "", deck.fontBody ?? ""]);
  return {
    id,
    name: opts.name,
    colors: slotSwatches(id, slots),
    fontHeading: deck.fontHeading,
    fontBody: deck.fontBody,
  };
}
