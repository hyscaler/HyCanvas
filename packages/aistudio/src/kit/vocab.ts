// The kit's vocabulary as the outline prompt states it: the styles a deck
// can be set in, the drawings a page can name, the signature forms, and
// the voice fields (kicker, farewell, aside). One string, built from the
// generated tables so the prompt can never name a style the composer does
// not have. The Go door carries the same string (kitvocab_gen.go, written
// by scripts/gen-kit-vocab.mjs from this module's build).

import { KIT_STYLES, kitStyleNames } from "./looks";
import { PACK_KEYWORDS } from "./packset";
import { kitSignatureNames } from "./signature";

/** The drawing keywords the model may name, in vocabulary order. */
export const kitDrawingNames: string[] = Object.keys(PACK_KEYWORDS);

export const kitStyleRule: string =
  "Name a 'style' for the whole deck, one of these complete visual systems (palette, faces, ornament), chosen for the subject and the audience: " +
  kitStyleNames.map((n) => `'${n}' (${KIT_STYLES[n].hint})`).join("; ") + ".";

export const kitVoiceRule: string =
  "Give the deck a voice: an 'organization' (the company, team or event the deck comes from, as the brief names it, else omit), " +
  "a 'kicker' (a short line in the deck's own words that opens the cover and the statement pages, under 40 characters, like a subtitle a person would say: 'Twelve months, one story', 'Relaxed, but on purpose'), " +
  "and a 'farewell' (the closing's first line, under 32 characters: 'Until next year', 'Let's build it'). " +
  "About one page in three carries an 'aside': a hand-written remark of at most 60 characters in the presenter's voice ('bring a hoodie, trust us', 'the number that surprised us'), never a restatement of the slide.";

export const kitDrawingRule: string =
  "Any page may name a 'drawing', one keyword for a full-colour drawing placed in a halo beside its copy: " + kitDrawingNames.map((n) => `'${n}'`).join(", ") + ". " +
  "Name one for the cover, every section and the closing, and for about half the reading pages; a page with an 'image' of treatment 'photo' gets a photograph instead.";

export const kitSignatureRule: string =
  "At most ONE page in the deck may name a 'signature', a form built for its content rather than taken from the catalog: " +
  "'scoreboard' (2-4 stats on a deep board, with a point per stat saying what moved); 'beforeAfter' (exactly 2 columns, the old way and the new); 'funnel' (steps or stats narrowing, each with a figure in 'pairs'); " +
  "'ledger' (2-8 'pairs' of label and figure, the last one a total); 'stickyWall' (3-8 points as notes on a wall); 'matrix' (4 'pairs' or 4 points as quadrants); 'runOfShow' (steps with 'when' as a run sheet); " +
  "'poll' (2-6 'pairs' of label and a percentage or count, drawn to scale); 'definition' (the title as a term, points as its senses, subhead as an example); 'healthGrid' (2-8 'pairs' of item and status such as on track, at risk, blocked). " +
  "'pairs' is a list of {label, value} for these forms and for kpiGrid deltas; give the page the fields its signature needs.";

/** The whole clause the outline prompt carries for the kit. */
export const kitVocabularyRule: string = [kitStyleRule, kitVoiceRule, kitDrawingRule, kitSignatureRule].join(" ");

export const kitSignatures: readonly string[] = kitSignatureNames;
