// The deck's look: one of four house styles the composer can set a deck in.
//
// Seventeen forms in one style read as one template family however good the
// copy. A look changes what the forms are made of, not what they hold: the
// type pairing, the scale of display sizes, the weight and length of rules,
// corners, panels, the treatment of the cover and the other impact pages,
// and whether small labels are set in a mono face. The model names a look
// for the whole deck from the brief's subject and audience; a dial or an
// API field overrides it; a chosen catalog style stands in when nothing
// named one. Brand fonts and a theme the user chose always keep their own
// pairing.

export type DeckLook = "classic" | "editorial" | "bold" | "technical";
export const deckLooks: DeckLook[] = ["classic", "editorial", "bold", "technical"];

export interface LookSpec {
  /** The pairing a deck takes when nothing authored one; null keeps the
   *  theme's. `mono` is the face for small labels and figures when set. */
  fonts: { heading: string; body: string; mono?: string } | null;
  /** Multipliers on the type scale, by size key. */
  scale: Record<string, number>;
  /** Multiplier on the system's corner radius; 0 is square. */
  radius: number;
  /** The accent rule: length in units, thickness in units. */
  ruleLength: number;
  ruleThickness: number;
  /** Eyebrow letter spacing, in ems. */
  tracking: number;
  /** Eyebrow, footer, page number and time markers in the mono face. */
  monoLabels: boolean;
  /** Display figures: weight, and whether they take the mono face. */
  numeralBold: boolean;
  numeralMono: boolean;
  /** Headlines (cover, section, statement) in the bold weight. */
  headlineBold: boolean;
  /** The cover's construction: words beside the picture, words as the
   *  picture, or words reversed out of a colour field. */
  cover: "split" | "typographic" | "field";
  /** Faint column lines behind a reading page. */
  gridLines: boolean;
  /** A panel's construction: the system's tint, a stronger tint of the
   *  primary hue, or the ground outlined by a hairline. */
  panel: "tint" | "strong" | "outline";
  /** What an impact page sits on: the theme's gradient, the flat deep
   *  colour, or the paper. */
  impactFill: "gradient" | "flat" | "paper";
}

export const LOOKS: Record<DeckLook, LookSpec> = {
  classic: {
    fonts: null, scale: {}, radius: 1, ruleLength: 7, ruleThickness: 0.6, tracking: 0.18,
    monoLabels: false, numeralBold: true, numeralMono: false, headlineBold: false,
    cover: "split", gridLines: false, panel: "tint", impactFill: "gradient",
  },
  editorial: {
    fonts: { heading: "Fraunces", body: "Source Serif 4" },
    scale: { coverTitle: 1.18, sectionTitle: 1.12, statement: 1.1, title: 1.05, quote: 1.08, numeral: 0.95 },
    radius: 0, ruleLength: 10, ruleThickness: 0.15, tracking: 0.22,
    monoLabels: false, numeralBold: false, numeralMono: false, headlineBold: false,
    cover: "typographic", gridLines: false, panel: "outline", impactFill: "paper",
  },
  bold: {
    fonts: { heading: "Archivo Black", body: "Inter" },
    scale: { coverTitle: 1.12, sectionTitle: 1.1, statement: 1.12, numeral: 1.2, kpiFigure: 1.15 },
    radius: 0, ruleLength: 8, ruleThickness: 1.2, tracking: 0.14,
    monoLabels: false, numeralBold: true, numeralMono: false, headlineBold: true,
    cover: "field", gridLines: false, panel: "strong", impactFill: "flat",
  },
  technical: {
    fonts: { heading: "Space Grotesk", body: "IBM Plex Sans", mono: "IBM Plex Mono" },
    scale: { title: 0.95, coverTitle: 0.95 },
    radius: 0.5, ruleLength: 7, ruleThickness: 0.35, tracking: 0.12,
    monoLabels: true, numeralBold: true, numeralMono: true, headlineBold: false,
    cover: "split", gridLines: true, panel: "outline", impactFill: "gradient",
  },
};

/** The look a catalog style group stands in for when nothing named one. */
const LOOK_FOR_STYLE: Record<string, DeckLook> = { tech: "technical", bold: "bold", editorial: "editorial" };

export function isDeckLook(v: unknown): v is DeckLook {
  return typeof v === "string" && (deckLooks as string[]).includes(v);
}

/** Resolve the deck's look: an explicit choice (a dial, an API field), then
 *  the one the model named for the deck, then the catalog style's, then
 *  classic. */
export function lookFor(explicit: unknown, named: unknown, catalogStyle: string | undefined): DeckLook {
  if (isDeckLook(explicit)) return explicit;
  if (isDeckLook(named)) return named;
  return (catalogStyle && LOOK_FOR_STYLE[catalogStyle]) || "classic";
}
