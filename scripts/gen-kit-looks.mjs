// Bake the AI composer's style vocabulary from the presentation templates.
//
// Every topic deck, single slide and kit in scripts/topics, scripts/singles
// and scripts/lib/deck-kit.mjs was designed as one complete visual system: a
// palette on paper and on a deep gradient ground, a display face, a body
// face and an accent face for the kicker, a corner radius, an ornament and
// a type scale. This script harvests each of those systems into
// packages/aistudio/src/kit/looks.ts as a named style the outline model can
// pick for a generated deck, so a deck the AI plans is set in the same
// systems the signature templates are, rather than in a palette derived
// from one hue.
//
// Run: node scripts/gen-kit-looks.mjs
// Then: npm run build -w packages/aistudio && node scripts/gen-kit-vocab.mjs

import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LOOKS } from "./lib/deck-kit.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "packages", "aistudio", "src", "kit", "looks.ts");

// The vocabulary: a style name the model can say, the plan it comes from,
// and one line telling the model what the style is and what it suits. The
// names are moods and materials rather than deck kinds, because a style
// designed for a sales review suits a customer story just as well.
const STYLES = [
  ["campfire", "deck-team-offsite", "cream paper, pine ink, campfire orange and lake blue, rounded, a loose hand for the kicker, ridgelines and stars on the deep ground; offsites, community, outdoors, teams"],
  ["sunny", "deck-all-hands", "warm cream, tomato and cobalt, a rounded friendly display, a sun in the corner; all-hands, celebrations, culture, internal news"],
  ["ledger", "deck-annual-report", "ivory paper, forest green and old gold, a Baskerville serif, a giant numeral watermark; annual reports, finance, heritage, formal reviews"],
  ["parchment", "deck-book-summary", "parchment, bottle green and brick, a Garamond serif with a pilcrow watermark; books, essays, reading groups, ideas, humanities"],
  ["newsprint", "deck-budget-review", "cool white, navy and teal, a newspaper serif, a dot grid; budgets, planning, operations, public sector"],
  ["casebook", "deck-case-study", "white paper, royal blue and gold, a bookish serif with hairline rules; case studies, evidence, customer stories, consulting"],
  ["graphite", "deck-competitive-analysis", "white and graphite with one red, a condensed display and concentric arcs; competitive analysis, strategy, sport, hard news"],
  ["acid", "deck-conference-talk", "acid yellow paper and black, a poster-weight display, one sun; conference talks, manifestos, keynotes, provocation"],
  ["chalkboard", "deck-course-lecture", "chalkboard green paper, cream ink and chalk yellow, a schoolroom hand; lectures, courses, teaching, training"],
  ["harbor", "deck-customer-success", "sand paper, deep teal and burnt orange, a rounded humanist display; customer success, service, accounts, hospitality"],
  ["violet", "deck-design-review", "white paper, violet and slate grey, a tight modern sans, a dot grid; design reviews, product, UX, critique"],
  ["gala", "deck-event-proposal", "midnight blue paper, hot pink and champagne, a Bodoni display and a script kicker; events, galas, invitations, fashion, evenings"],
  ["brass", "deck-gtm-strategy", "stone paper, olive and brass, a warm serif and arcs; go-to-market, strategy, plans, boardrooms"],
  ["peach", "deck-hiring-plan", "ivory paper, peach and navy, a soft rounded sans, one corner triangle; hiring, people, HR, onboarding plans"],
  ["amber", "deck-investor-update", "warm grey paper, amber and charcoal, a plain grotesk, a dot grid; investor updates, monthly reports, candour, numbers"],
  ["magenta", "deck-marketing-plan", "cream paper, magenta and gold, a Didone display, a corner triangle; marketing, campaigns, creative, brand"],
  ["brick", "deck-nonprofit-impact", "linen paper, brick red and sky blue on a terracotta deep ground, a humanist serif; nonprofits, impact, community, causes"],
  ["cobalt", "deck-okr-review", "cool white, orange and cobalt, a geometric sans, diagonal stripes; OKRs, scorecards, quarterly reviews, targets"],
  ["butter", "deck-onboarding", "butter yellow paper, teal and marigold, a round chunky display, floating orbs; onboarding, welcome, tours, friendly product"],
  ["rust", "deck-portfolio", "bone paper, rust and near-black, a characterful grotesk with a monogram watermark; portfolios, studios, design, personal work"],
  ["ember", "deck-product-launch", "sand paper, ember orange and black, a wide heavy display, a corner triangle; launches, countdowns, product reveals, sales kickoffs"],
  ["mint", "deck-product-vision", "lilac white, mint and violet, a geometric sans, arcs; product vision, futures, platforms, technology strategy"],
  ["concrete", "deck-project-kickoff", "concrete grey paper, safety orange and steel blue, a sturdy grotesk with rules; kickoffs, engineering projects, construction, delivery"],
  ["wine", "deck-research-readout", "ivory paper, wine and warm grey, a Caslon serif with a numeral watermark; research readouts, findings, academia, evidence"],
  ["plum", "deck-retrospective", "warm white paper, plum and sage, a humanist sans, orbs; retrospectives, reflection, wellbeing, learning"],
  ["signal", "deck-roadmap-review", "dark slate paper, signal yellow and periwinkle, a condensed sans with mono figures; roadmaps, engineering reviews, dashboards, dark decks"],
  ["copper", "deck-sales-qbr", "cream paper, navy and copper, a Bodoni display, a dot grid; sales reviews, pipeline, revenue, quarterly business"],
  ["terminal", "deck-sprint-demo", "near-black paper, terminal green and parchment, a mono display and a prompt watermark; sprint demos, developer tools, infrastructure, hacker"],
  ["coral", "deck-startup-pitch", "white paper, cobalt and coral with lime on the deep ground, a friendly geometric display; startup pitches, seed rounds, launches, growth"],
  ["lagoon", "deck-webinar", "deep teal paper, salmon and aqua, a wide readable sans, diagonal stripes; webinars, live sessions, online education, dark decks"],
  ["marker", "deck-workshop", "warm white paper, marker yellow and black, a black display, stripes; workshops, facilitation, hands-on sessions, playful"],
  ["linen", "deck-agenda", "linen paper, copper and teal, an old-style serif with hairlines and a script kicker; agendas, quarterly reviews, meetings, classic"],
  ["blush", "deck-closing", "blush paper, tomato and royal blue, a modern grotesk, a corner triangle; closings, thanks, calls to action, upbeat"],
  ["burgundy", "deck-quote", "cream paper, burgundy and steel blue, a Crimson serif with a quotation-mark watermark; quotes, testimonials, literature, editorial"],
  ["opera", "deck-section-divider", "cream paper, plum and gold, a Yeseva display with a section-mark watermark and a script kicker; theatre, arts, luxury, chapters"],
  ["meadow", "deck-stat", "pale green paper, forest and lime, a tall condensed display, stripes; sustainability, agriculture, health, one big number"],
  ["sky", "deck-title-modern", "cool grey paper, sky blue and amber, a modern geometric sans, a soft glow; modern business, SaaS, quarterly, clean"],
  ["marigold", "product-roadmap-slide", "white paper, blue and marigold, an Overpass sans with mono figures, a dot grid; roadmaps, planning, product, now-next-later"],
  ["atlas", "kit-atlas", "warm ivory paper, navy and gold, a Playfair serif with fine rules; corporate, investor, annual review, professional"],
  ["vanta", "kit-vanta", "near-black paper, lime and violet glow, a grotesk display with mono labels; tech, platforms, engineering, developer audiences"],
  ["folio", "kit-folio", "cream paper, vermilion and forest with a sun disc, a Fraunces serif and a hand kicker; editorial, studios, brand, magazines"],
  ["pulse", "kit-pulse", "white paper and an electric blue deep ground, coral and lime, a heavy geometric display, colour blocks; startups, pitches, bold launches, youth"],
  ["terra", "kit-terra", "warm sand paper, terracotta and moss on a pine deep ground, a rounded sans with blobs; community, sustainability, nonprofit, warm"],
  ["slate", "kit-slate", "white paper, one blue and black, a Swiss grotesk with crosshairs and square corners; agencies, proposals, minimal, portfolio"],
];

const mergePalette = (b, ov) => {
  if (!ov) return b;
  const out = { ...b, ...ov };
  if (ov.accent) for (const k of ["accentInk", "accent2Ink", "sun", "lime"]) if (!(k in ov)) delete out[k];
  return out;
};

const plans = new Map();
for (const dir of ["topics", "singles"]) {
  for (const f of readdirSync(join(ROOT, "scripts", dir)).filter((x) => x.endsWith(".mjs")).sort()) {
    const plan = (await import(pathToFileURL(join(ROOT, "scripts", dir, f)).href)).default;
    const base = LOOKS[plan.base];
    if (!base) throw new Error(`${plan.id}: unknown base look ${plan.base}`);
    const o = plan.look ?? {};
    const look = { ...base, ...o, paper: mergePalette(base.paper, o.paper), deep: mergePalette(base.deep, o.deep), art: { ...base.art, ...(o.art ?? {}) }, scale: { ...base.scale, ...(o.scale ?? {}) } };
    plans.set(plan.id, { ...look, ...(plan.meta ?? {}), art: { ...look.art, ...(plan.meta?.art ?? {}) } });
  }
}
for (const L of Object.values(LOOKS)) plans.set(L.id, L);

const palette = (g) => {
  const out = { bg: g.bg, ink: g.ink, muted: g.muted, line: g.line, panel: g.panel, panel2: g.panel2, accent: g.accent, accent2: g.accent2 };
  for (const k of ["bg2", "accentInk", "accent2Ink", "sun", "lime"]) if (g[k]) out[k] = g[k];
  return out;
};

const styles = {};
for (const [name, id, hint] of STYLES) {
  const K = plans.get(id);
  if (!K) throw new Error(`style ${name}: no plan ${id}`);
  const s = {
    name, from: id, hint,
    display: K.display, dw: K.dw, body: K.body, bw: K.bw, mono: K.mono ?? null,
    accentFace: K.accentFace, accentWeight: K.accentWeight, accentSize: K.accentSize,
    paper: palette(K.paper), deep: palette(K.deep),
    radius: K.radius, ornament: K.ornament,
    scale: { cover: K.scale.cover, title: K.scale.title, section: K.scale.section, statement: K.scale.statement, numeral: K.scale.numeral, quote: K.scale.quote },
    art: { cover: K.art.cover, section: K.art.section, picture: K.art.picture, closing: K.art.closing },
    peeps: K.peeps,
  };
  for (const k of ["charWidth", "numeralFace", "numeralWeight", "strongWeight", "watermark"]) if (K[k] !== undefined && K[k] !== null) s[k] = K[k];
  styles[name] = s;
}

const header = `// Generated by scripts/gen-kit-looks.mjs. Do not edit by hand.
//
// The AI composer's style vocabulary: every presentation template's visual
// system, harvested as a named style the outline model can pick for a
// generated deck. A style is one complete system: a palette on paper and on
// a deep gradient ground, the display, body and accent faces, a corner
// radius, an ornament, a type scale and the drawings the template used. The
// composer sets a generated deck in one of these the way the template was
// set, so the deck reads as designed rather than derived.

import type { KitStyle } from "./look";

export const KIT_STYLES: Record<string, KitStyle> = ${JSON.stringify(styles, null, 1)};

/** The style names, in vocabulary order. */
export const kitStyleNames: string[] = ${JSON.stringify(Object.keys(styles))};
`;
writeFileSync(OUT, header);
console.log(`wrote ${OUT}: ${Object.keys(styles).length} styles`);
