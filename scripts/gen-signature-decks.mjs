// Generate the three signature decks: presentations with an identity of
// their own (a cyan-violet glow, an ampersand monogram, a main-street
// warmth), each expressed as its own look over the library's layouts, with
// one or two slides of its own where the identity lives.
//
//   node scripts/gen-signature-decks.mjs
//   node scripts/build-templates.mjs

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOOKS, buildSpec, specNodes, text, rect, ellipse, button, icon, art, halo, sparkles, footer, mark, type, deepGround, W, H, M, CW } from "./lib/deck-kit.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "scripts", "templates");

// --- looks -------------------------------------------------------------------

/** Northbeam: the dark tech review, cyan and violet on navy. */
const vivid = {
  ...LOOKS.vanta,
  id: "deck-vivid-tech",
  company: "Northbeam",
  deck: "Q3 2026 review",
  kicker: "// q3 2026, product and engineering",
  farewell: "// next steps",
  display: "Manrope", dw: 700, body: "Inter", bw: 400, mono: "JetBrains Mono",
  accentFace: "JetBrains Mono", accentWeight: 500, accentSize: 28,
  paper: { bg: "#0D1528", bg2: "#080D1C", ink: "#F8FAFC", muted: "#94A3B8", line: "#1E2A44", panel: "#121C33", panel2: "#182545", accent: "#22D3EE", accent2: "#A78BFA" },
  deep: { bg: "#0B1220", bg2: "#040812", ink: "#F8FAFC", muted: "#94A3B8", line: "#1B2640", panel: "#111A30", panel2: "#172240", accent: "#22D3EE", accent2: "#8B5CF6" },
  radius: 16,
  ornament: "glow",
  art: { cover: "la-monitor", section: "il-day93-programing", picture: "la-woman-working-2", closing: "la-free-svg-illustration-rocket" },
  peeps: ["op-peep-72", "op-peep-9", "op-peep-56", "op-peep-41", "op-peep-55"],
  scale: { cover: 112, title: 62, section: 220, statement: 76, numeral: 104, quote: 50 },
};

/** Meridian & Co.: cream, ink and forest green, with the ampersand. */
const editorial = {
  ...LOOKS.folio,
  id: "deck-mono-editorial",
  company: "Meridian & Co.",
  deck: "Brand strategy",
  kicker: "A quieter kind of confidence",
  farewell: "Next steps",
  display: "Playfair Display", dw: 600, body: "Inter", bw: 400, mono: null,
  accentFace: "Instrument Serif", accentWeight: 400, accentSize: 44,
  watermark: "&",
  paper: { bg: "#FAF6EF", ink: "#201A17", muted: "#6B6259", line: "#DDD6C8", panel: "#F1EBE0", panel2: "#E7DFD0", accent: "#1D4D3B", accent2: "#B8862B" },
  deep: { bg: "#201A17", bg2: "#100D0B", ink: "#FAF6EF", muted: "#B3AA9C", line: "#3A332C", panel: "#2A2521", panel2: "#363029", accent: "#8FC2A9", accent2: "#E0B95A" },
  radius: 0,
  ornament: "watermark",
  art: { cover: "la-guy-with-glasses", section: "il-day73-writing-tool", picture: "la-doodle", closing: "la-coffee" },
  peeps: ["op-peep-58", "op-peep-47", "op-peep-73", "op-peep-84", "op-peep-86"],
  scale: { cover: 116, title: 66, section: 260, statement: 88, numeral: 112, quote: 56 },
};

/** Locale: the main-street pitch, cream and ink with a red and a sun. */
const locale = {
  ...LOOKS.terra,
  id: "startup-pitch-deck",
  company: "Locale",
  deck: "Seed pitch, July 2026",
  kicker: "Seed round, summer 2026",
  farewell: "The ask",
  display: "Outfit", dw: 800, body: "Inter", bw: 400, mono: null,
  accentFace: "Caveat", accentWeight: 600, accentSize: 42,
  paper: { bg: "#FAF4EC", ink: "#181828", muted: "#5F5B52", line: "#E6DCCB", panel: "#F3EADB", panel2: "#EADFCB", accent: "#EA3139", accent2: "#7C5CFF", sun: "#F9A948" },
  deep: { bg: "#181828", bg2: "#0C0C1A", ink: "#FAF4EC", muted: "#B6B3C4", line: "#2E2E46", panel: "#222238", panel2: "#2B2B46", accent: "#F9A948", accent2: "#FF6B70", accentInk: "#F9A948", sun: "#F9A948" },
  radius: 20,
  ornament: "sun",
  art: { cover: "la-house-illustrations", section: "il-day54-building", picture: "il-day30-cafe", closing: "la-scooter" },
  peeps: ["op-peep-105", "op-peep-53", "op-peep-23", "op-peep-72", "op-peep-9"],
  scale: { cover: 108, title: 62, section: 236, statement: 78, numeral: 100, quote: 52 },
};

// --- signature slides ----------------------------------------------------------

/** The editorial cover: the ampersand at full size, the title beside it,
 *  no picture. The one slide in the catalog that is only type. */
function editorialCover(K, total) {
  const g = K.paper;
  const t = type(K, g);
  const nodes = [
    text(1080, 120, 800, 900, "&", { family: K.display, size: 720, weight: 500, color: "#E1E2D6", align: "right", lineHeight: 1, bleed: true }),
    rect(M, 64, CW, 2, g.line),
    ...mark(K, g),
    text(M, 372, 1000, 60, K.kicker, t.kicker()),
    text(M, 446, 1000, 260, "Positioning, voice,\nand identity", t.display(K.scale.cover, { lineHeight: 1.02 })),
    text(M, 740, 900, 84, "The next chapter of Meridian & Co., prepared by Atelier North.", t.body(28)),
    text(M, 940, 900, 28, "Atelier North  ·  October 2026", t.meta()),
  ];
  const fill = [{ node: 2, label: "Company", hint: "Your company or client" }, { node: 4, label: "Title", hint: "Two short lines" }, { node: 5, label: "Subtitle", hint: "One sentence" }];
  if (total > 1) nodes.push(text(W - M - 240, 940, 240, 28, `01 / ${total}`, t.meta({ align: "right" })));
  return { page: { name: "Cover", bg: g.bg, nodes }, fill };
}

/** The editorial big idea: two lines of type, the second in green. */
function editorialIdea(K0, i) {
  const K = { ...K0, total: 9 };
  const g = K.paper;
  const t = type(K, g);
  const nodes = [
    text(1160, 420, 760, 700, "&", { family: K.display, size: 620, weight: 500, color: "#EDEAE0", align: "right", lineHeight: 1, bleed: true }),
    rect(M, 64, CW, 2, g.line),
    ...footer(K, g, i),
    text(M, 236, 1000, 56, "The idea", t.kicker()),
    text(M, 320, 1560, 240, "The most trusted brands\ndon't chase attention.", t.display(100, { lineHeight: 1.06 })),
    text(M, 570, 1560, 120, "They reward it.", t.display(100, { color: g.accent, lineHeight: 1.06 })),
    text(M, 730, 1200, 90, "Our next chapter trades volume for precision: fewer messages, sharper craft, and a voice that holds its nerve.", t.body(28)),
  ];
  return { page: { name: "The idea", bg: g.bg, nodes } };
}

/** The Locale problem and solution: a deep panel on the left, the answer on
 *  paper at right, the drawing between them. */
function localeSplit(K0, i) {
  const K = { ...K0, total: 9 };
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const td = type(K, d);
  const nodes = [
    rect(0, 0, 900, H, deepGround(d), { bleed: true }),
    ...sparkles(d.sun, 21, 6, { x: 40, y: 40, w: 820, h: 400 }),
    text(M, 130, 700, 28, "The problem", td.eyebrow()),
    text(M, 184, 720, 240, "Selling online is\nstill built for\nbig brands.", td.display(58, { lineHeight: 1.08 })),
    ...[
      ["7 in 10 neighborhood shops still can't take an order online."],
      ["Store builders demand weeks of setup, plugins, and fees."],
      ["Marketplaces skim up to 30% and keep the customer data."],
    ].flatMap(([line], k) => [rect(M, 470 + k * 100, 12, 12, d.sun, { radius: 3 }), text(M + 32, 460 + k * 100, 660, 70, line, td.body(24))]),
    rect(900, 0, 6, H, g.accent, { bleed: true }),
    text(980, 130, 800, 28, "Our solution", t.eyebrow()),
    text(980, 184, 820, 160, "Storefronts that\nbuild themselves.", t.display(58, { lineHeight: 1.08 })),
    text(980, 370, 800, 110, "Locale reads a shop's socials and point-of-sale, then assembles a ready-to-sell storefront: inventory, payments, and same-day delivery included.", t.body(24)),
    ...[["bolt", "Live in one afternoon"], ["coin", "0% commission, one flat fee"], ["user", "You own every customer"]].flatMap(([ic, line], k) => [
      ellipse(980, 520 + k * 76, 44, 44, "#FFE3D6"), icon(ic, 990, 530 + k * 76, 24, g.accent), text(1044, 526 + k * 76, 700, 34, line, t.strong(24)),
    ]),
    ...halo(1560, 800, 300, g.sun),
    ...footer(K, g, i).slice(1),
  ];
  return { page: { name: "Problem and solution", bg: g.bg, nodes, illustrations: [art("il-day82-burger", 1440, 690, 240, 220)] } };
}

// --- plans -------------------------------------------------------------------------

const DECKS = [
  {
    look: vivid, id: "deck-vivid-tech", title: "Vivid Tech Review Deck", rank: 20,
    tags: ["deck", "product", "roadmap", "dark", "tech"], styleTags: ["modern", "bold", "dark"],
    slides: [
      ["cover", { title: "What we shipped,\nwhat's next", subtitle: "The platform team's quarter in review: releases, reliability, and the road to Q1.", presenter: "October 14, 2026  ·  Internal", chips: [["12", "releases"], ["0", "rollbacks"], ["3", "teams"]] }],
      ["agenda", { title: "What we'll cover", items: [["Shipped in Q3", "Twelve releases across three teams", "10 min"], ["Reliability and quality", "The numbers behind zero rollbacks", "10 min"], ["Roadmap for the next two quarters", "Now, next and later, with owners", "15 min"], ["Metrics and asks", "Two numbers, three asks", "10 min"], ["Live demo", "The new deploy pipeline", "10 min"]], card: { eyebrow: "The quarter", big: "90 days", meta: [["Releases", "12 across 3 teams"], ["Rollbacks", "Zero"], ["Demo", "The new deploy pipeline"], ["Host", "Platform squad"]] } }],
      ["section", { n: "01", title: "Shipped in Q3", blurb: "Twelve releases, three that changed how the platform runs." }],
      ["threeCards", { eyebrow: "Shipped in Q3", title: "Three releases that mattered", cards: [["bolt", "The release train", "Every merge ships within the hour, behind a flag, with an automated canary. Deploy frequency tripled."], ["database", "Multi-region reads", "Read replicas in two regions, failover rehearsed monthly. The base of the four-nines target."], ["lock", "SSO and audit logs", "Enterprise sign-in and a searchable audit trail, live for four customers in the first week."]] }],
      ["figures", { eyebrow: "Reliability and quality", title: "The quarter in four numbers", stats: [["4.6 / day", "Deploy frequency", "+156% on Q2", "Up from 1.8 per day, driven by the release train and automated canary checks."], ["99.98%", "Platform uptime", "+0.09 pts", "Failover rework and multi-region reads put four nines within reach."], ["0", "Rollback events", "−4", "Every release behind a flag; the canary caught the two that would have rolled back."], ["9 min", "Median time to cause", "Was 41", "From the first alert to the change named in the channel."]] }],
      ["chart", { eyebrow: "Metrics", title: "Deploys per week, by month", takeaway: "The release train landed in August; September ran at three times the Q2 pace with no rollbacks.", chartType: "bar", categories: ["Jul", "Aug", "Sep"], series: [{ name: "Deploys per week", values: [12, 24, 32] }], calls: [["32", "Deploys per week in September"], ["0", "Rollbacks all quarter"], ["3x", "The Q2 pace"]] }],
      ["columns", { eyebrow: "Roadmap", title: "Next two quarters", intro: "Now, next and later, each with an owning squad. Dates shift; the order does not.", cols: [["Now", "Q4 2026", [["Realtime collaboration", "Multiplayer cursors, presence and comment threads on nodes."], ["Offline-first sync", "Full editing without a connection; sync on return."], ["Owner: Collab squad", "Two engineers, one designer."]]], ["Next", "Q1 2027", [["AI media studio", "Generate and edit images with brand-safe style presets."], ["Batch background removal", "Whole folders at once, queued."], ["Owner: AI squad", "Three engineers."]]], ["Later", "H2 2027", [["Enterprise platform", "SCIM, regional data residency and the audit export."], ["Plugin marketplace", "Third-party panels, reviewed and signed."], ["Owner: Platform squad", "Hiring two."]]]] }],
      ["threeCards", { eyebrow: "Asks", title: "Three asks for next quarter", cards: [["user", "Two backend hires", "The platform squad is two people short of the H2 plan. Both roles are open; referrals close them faster."], ["coin", "SSO budget", "The identity provider contract for the enterprise tier. Pays back on the second customer."], ["message", "Design partner intros", "Three customers willing to test the AI media studio in December, before general release."]] }],
      ["closing", { title: "Help us ship\nthe next quarter", subtitle: "Three asks: two backend hires, SSO budget, and design partner intros. Office hours every Thursday.", rows: [["mail", "platform@northbeam.example"], ["message", "#platform-reviews on Slack"], ["calendar", "Office hours: Thursdays, 15:00"]], cta: "Book roadmap office hours" }],
    ],
  },
  {
    look: editorial, id: "deck-mono-editorial", title: "Editorial Strategy Deck", rank: 100,
    tags: ["deck", "strategy", "serif", "editorial", "minimal"], styleTags: ["editorial", "minimal", "elegant"],
    slides: [
      ["raw", editorialCover(editorial, 9)],
      ["agenda", { eyebrow: "Brand strategy, FY 2026", title: "Agenda", items: [["Where we stand", "Context: the brand today, in numbers", "10 min"], ["What the audience told us", "Research: twelve interviews, one tracker", "15 min"], ["The idea and the voice", "Strategy: the promise, and how it sounds", "20 min"], ["Rolling it out", "Roadmap: identity, channels, the first campaign", "15 min"], ["Decisions", "What we ask of the board today", "10 min"]], card: { eyebrow: "The session", big: "FY26", meta: [["Prepared by", "Atelier North"], ["For", "Meridian & Co. board"], ["When", "12 October, 10:00"], ["Where", "The library"]] } }],
      ["figures", { eyebrow: "Where we stand", title: "The brand today", stats: [["3.2x", "Media efficiency", "After the refresh", "Earned coverage per dollar since the identity refresh."], ["68%", "Unprompted recall", "+14 pts", "Audiences who name Meridian first in category interviews."], ["9 in 10", "Price confidence", "Tracker, May 2026", "Customers who say the brand justifies its premium."], ["1,204", "Tracker sample", "n", "Brand tracker, May 2026, across four markets."]] }],
      ["quote", { text: "I do not remember a single Meridian advert. I remember every Meridian object I have ever held.", name: "A customer, interview nine", role: "Twelve interviews, spring 2026" }],
      ["raw", editorialIdea(editorial, 4)],
      ["twoColumns", { eyebrow: "The voice", title: "How the brand sounds, before and after", left: { eyebrow: "Before", head: "Louder, more often", lines: ["Six campaigns a year, each with a new line", "Superlatives in every headline", "A voice that changed with the agency"], icon: "alert-triangle" }, right: { eyebrow: "After", head: "Fewer words, better ones", lines: ["Two campaigns a year, one idea each", "Plain claims that can be checked", "One voice, written down, kept"], icon: "circle-check" } }],
      ["threeCards", { eyebrow: "The identity", title: "Three things that will not change", cards: [["pencil", "The wordmark", "Set in Playfair, always in ink or cream. No colour versions, no animated versions."], ["palette", "Ink, cream, green", "Three colours, and gold once a year. Every other colour is a photograph."], ["book", "The long caption", "Every object gets its story told in full. Nothing is sold in fewer than forty words."]] }],
      ["timeline", { eyebrow: "Rolling it out", title: "The first year", done: 0, steps: [["Q1", "The voice guide", "Written, tested on three product pages, signed off by the board."], ["Q2", "Identity refresh", "Packaging, the site and the stores, in that order."], ["Q3", "The first campaign", "One idea, two channels, twelve weeks. Measured on recall, not reach."], ["Q4", "The tracker", "The May survey run again. The number we report is unprompted recall."]] }],
      ["closing", { title: "Let's build the\nquiet standard", subtitle: "Three decisions today: the voice guide, the identity budget, and the campaign date. Everything else can wait for Q1.", rows: [["mail", "hello@ateliernorth.example"], ["world", "ateliernorth.example"], ["phone", "+1 415 555 0134"]], cta: "Approve the plan" }],
    ],
  },
  {
    look: locale, id: "startup-pitch-deck", title: "Main Street Startup Pitch", rank: 12,
    tags: ["pitch", "startup", "seed", "investor", "deck"], styleTags: ["warm", "bold", "friendly"],
    slides: [
      ["cover", { title: "Putting main street\nback in business", subtitle: "Locale turns any neighborhood shop into a full online storefront in one afternoon. No code, no commission.", presenter: "Locale  ·  Seed pitch  ·  July 2026" }],
      ["statement", { text: "Seven in ten neighborhood shops still cannot take an order online. The tools were built for brands, not for the bakery on the corner.", source: "Locale merchant survey, 1,100 shops, spring 2026" }],
      ["raw", localeSplit(locale, 2)],
      ["process", { eyebrow: "How it works", title: "From socials to storefront in an afternoon", steps: [["Connect", "The shop signs in with its Instagram and its point-of-sale. Nothing to install."], ["Assemble", "Locale reads the products, the photos and the hours and builds the store."], ["Review", "The owner checks prices and picks a delivery radius. Twenty minutes, on a phone."], ["Sell", "Live by dinner, with payments, pickup and same-day delivery switched on."]] }],
      ["figures", { eyebrow: "Traction", title: "The flywheel is turning", stats: [["2,400", "Shops live", "12 cities", "Grown entirely by word of mouth between neighbouring shops."], ["$1.1M", "Monthly sales volume", "6x since January", "The median shop sells $460 a month through Locale."], ["+22%", "Month over month", "Six months running", "Shops, volume and revenue all growing at the same rate."], ["94%", "Six-month retention", "Of shops", "A shop that sells once through Locale stays."]] }],
      ["chart", { eyebrow: "Traction", title: "Monthly sales volume", takeaway: "Volume has grown every month since launch; every city pays back its launch cost within a quarter.", chartType: "bar", categories: ["Jan", "Feb", "Mar", "Apr", "May", "Jun"], series: [{ name: "Volume ($K)", values: [180, 260, 390, 560, 820, 1100] }], calls: [["$1.1M", "June volume"], ["12", "Cities live"], ["$460", "Median shop, per month"]] }],
      ["threeCards", { eyebrow: "Business model", title: "One flat fee, nothing skimmed", cards: [["coin", "$39 a month per shop", "One price, every feature. Ninety-one percent gross margin at the current scale."], ["shield", "Zero commission", "Marketplaces take up to 30%. We take nothing on the sale, ever. That is the pitch to the shop."], ["user", "The shop owns the customer", "Every order, every address, every repeat. Exported in one click if they ever leave."]] }],
      ["team", { eyebrow: "The team", title: "Built by people who ran the shops", people: [["Sam Whitfield", "Chief Executive", "Ran a three-store bakery for nine years. Built the first Locale for it."], ["Priya Raman", "Chief Technology Officer", "Led checkout at a payments company; shipped to a million merchants."], ["Marcus Obi", "Growth", "Opened the first twelve cities on foot, shop by shop."], ["Elena Sato", "Merchant success", "Every shop's first call. Retention is her number."]] }],
      ["closing", { title: "Raising $1.5M", subtitle: "To bring Locale to forty new cities: 60% product and engineering, 25% city launches, 15% operations and support.", rows: [["mail", "hello@locale.example"], ["world", "locale.example/deck"], ["calendar", "Closing the round by September"]], cta: "Open the data room" }],
    ],
  },
];

for (const d of DECKS) {
  const spec = buildSpec(d.look, {
    id: d.id, title: d.title, tags: d.tags, styleTags: d.styleTags,
    slides: d.slides,
    version: 3,
    created: "2026-07-10T00:00:00.000Z",
    updated: "2026-09-30T00:00:00.000Z",
    rank: d.rank,
  });
  writeFileSync(join(OUT, `${d.id}.json`), JSON.stringify(spec, null, 1) + "\n");
  console.log(`${d.id}: ${spec.pages.length} slides, ${specNodes(spec)} nodes`);
}
