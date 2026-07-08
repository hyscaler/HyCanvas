// HyCanvas brand theme: the SINGLE SOURCE OF TRUTH for product/app colors.
//
// To rebrand the whole app, edit the values here and run `npm run gen:theme`
// (the frontend build runs it automatically). The generator writes the CSS
// tokens into src/styles/globals.css (and, in later phases, the canvas/engine
// theme and the Go presence palette), so you change colors in ONE place.
//
// This is the PRODUCT accent (the app shell). It is intentionally separate from
// the per-workspace Brand Kit, which themes user design content, not the app.
//
// Plain ESM (no types, no deps) so both Node (the generator) and the Next app
// can import it. Hex values are sRGB. Scales follow Tailwind's 50..950 steps.

export const theme = {
  name: "HyCanvas",

  // Primary brand accent. brand-600 is the main interactive color (buttons,
  // active states); brand-500 drives focus rings. Currently: Plum.
  brand: {
    50: "#FBEFF7",
    100: "#F6DDEE",
    200: "#EDBBDC",
    300: "#E195C7",
    400: "#CF67A8",
    500: "#B73E88",
    600: "#9B2C72",
    700: "#7E2059",
    800: "#681A49",
    900: "#54163B",
    950: "#3E1030",
  },

  // Secondary accent (used sparingly + as the gradient end). Currently fuchsia.
  accent: {
    50: "#FCEAF4",
    100: "#FAD5E9",
    200: "#F4AFD3",
    300: "#EE8FC2",
    400: "#E07AB8",
    500: "#D6409A",
    600: "#B82F80",
    700: "#8E2563",
    800: "#6B1C4A",
    900: "#4F1537",
    950: "#350D24",
  },

  // Identity gradient stops, promoted to first-class tokens (neutral names so
  // they survive any rebrand). `mid` references the brand scale so it tracks the
  // primary automatically. start/end are bespoke so the sweep can be richer than
  // a single scale step. Currently: deep plum -> plum -> magenta.
  gradient: {
    angle: "135deg",
    start: "#6D1E50",
    mid: "var(--color-brand-600)",
    end: "#C84B9A",
  },

  // Dark mode for the APP CHROME only (design content is never themed; the
  // Brand Kit owns that). The app runs light by default; setting `dark` on
  // <html> swaps these token values via the generated `.dark` region in
  // globals.css. `page` is the document background, `surface` the elevated
  // card/popover color (both are white in light mode). The neutral ramp
  // mirrors Tailwind's neutral scale in reverse so the ~2k existing
  // `neutral-*` call sites read correctly on dark without edits. `brand`
  // remaps ONLY the light tint steps (chip/hover/ring backgrounds); solid
  // accent steps (500+) keep their light-mode values so buttons and the
  // gradient stay identical. `brandInk` is the accent TEXT color on chrome
  // (light mode uses brand-700); it exists because text and backgrounds share
  // scale steps and cannot be swapped wholesale.
  // Tailwind's default neutral scale, restated so the generator can emit the
  // `.light` escape hatch (document surfaces like sheets and present mode pin
  // themselves light even when the app chrome is dark). Keep in sync with
  // Tailwind; these are not brand colors.
  neutral: {
    50: "#fafafa",
    100: "#f5f5f5",
    200: "#e5e5e5",
    300: "#d4d4d4",
    400: "#a3a3a3",
    500: "#737373",
    600: "#525252",
    700: "#404040",
    800: "#262626",
    900: "#171717",
    950: "#0a0a0a",
  },

  dark: {
    page: "#111114",
    surface: "#1b1b20",
    neutral: {
      50: "#161619",
      100: "#1e1e23",
      200: "#2a2a31",
      300: "#3a3a42",
      400: "#8f8f9a",
      500: "#a5a5b0",
      600: "#c2c2cb",
      700: "#d8d8de",
      800: "#e8e8ed",
      900: "#f4f4f6",
      950: "#fbfbfc",
    },
    brand: {
      50: "#2b1424",
      100: "#3a1b30",
      200: "#4e2340",
    },
    brandInk: "#E195C7",
  },

  // Editor canvas overlay colors. The engine paints to Canvas2D and cannot read
  // CSS, so these are also pushed in as data in a later phase. `selection` is a
  // deliberate cool hue kept DISTINCT from the brand so selections stay legible
  // against brand-colored content (it is not meant to track the accent).
  overlay: {
    selection: "#2563eb",
    guideSubtle: "#3b82f6",
    guideActive: "#06b6d4",
    guideConflict: "#f43f5e",
    penPreview: "#a855f7",
    ruler: "#9ca3af",
  },

  // Collaborator presence palette (assigned per user by a stable hash). Shared
  // with the Go backend via the generator in a later phase. Order is meaningful:
  // changing it reassigns existing users' colors, so append rather than reorder.
  presence: {
    palette: [
      "#ef4444",
      "#f97316",
      "#eab308",
      "#22c55e",
      "#06b6d4",
      "#3b82f6",
      "#8b5cf6",
      "#ec4899",
      "#14b8a6",
      "#a855f7",
    ],
    fallback: "#ef4444",
  },

  // Avatar swatches for collaborators (a distinct rainbow for telling people
  // apart; not brand colors). Centralized here; consumed by lib/avatar.ts.
  avatars: [
    "#e11d48",
    "#ea580c",
    "#d97706",
    "#16a34a",
    "#0891b2",
    "#2563eb",
    "#7c3aed",
    "#db2777",
  ],

  // Engine asset-state colors: a neutral placeholder and an error red for
  // missing/unloaded media. NOT brand colors. The engine (packages/engine
  // render2d.ts) keeps these inline to stay dependency-free and avoid touching
  // its fragile render path; this block is the canonical record and
  // scripts/check-theme-tokens.mjs verifies render2d.ts still matches.
  engine: {
    placeholderFill: "rgba(0, 0, 0, 0.06)",
    placeholderStroke: "rgba(0, 0, 0, 0.25)",
    missingFill: "rgba(220, 38, 38, 0.10)",
    missingStroke: "rgba(220, 38, 38, 0.6)",
  },
};

export default theme;
