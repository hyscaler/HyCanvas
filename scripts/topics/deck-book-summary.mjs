// Book Club Summary: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: a reading room. Cream paper with a warm ink, a library green
// for the rules, the icons, the numerals and the hand notes, and an oxblood
// for every second card, the two colours of clothbound spines on a shelf.
// The deep pages are the ink itself, a bottle-green black, with gilt for
// the accent the way a spine carries its title in gold leaf, and a pale
// sage for the second tone. A Garamond for the titles, the book face; a
// plain humanist sans for the reading; a thin ballpoint hand for the kicker
// and the notes, the pencil in the margin. The ornament is a watermark, one
// enormous pilcrow, the mark of the paragraph. The signature is the book
// itself: a clothbound cover drawn beside the thesis in one sentence, and
// the three claims as numbered, highlighted marginalia.

import { text, rect, ellipse, icon, chrome, type, deepGround, M } from "../lib/deck-kit.mjs";

// --- the book at a glance ------------------------------------------------------

const BOOK_W = 392, BOOK_H = 600;

const signature = {
  /** The spine: a clothbound book drawn at left (green cloth, a gilt frame,
   *  the title and author in gold leaf, a page block and an oxblood ribbon),
   *  the thesis in one sentence beside it with how to read the book under
   *  it, and at right, past a margin rule, the three claims as numbered
   *  marginalia: a highlighted pencil note over the claim and one line on it. */
  spine(K, i, c) {
    const g = K.paper, d = K.deep;
    const t = type(K, g), td = type(K, d);
    const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
    const fill = [];
    const bx = M, by = bodyTop + 24, bw = BOOK_W, bh = BOOK_H;
    // The book: a shadow, the page block at the fore edge, the cover on top.
    nodes.push(rect(bx + 16, by + 20, bw + 14, bh, g.ink, { opacity: 0.08, radius: 2 }));
    nodes.push(rect(bx + bw, by + 8, 8, bh - 16, g.panel));
    nodes.push(rect(bx + bw + 8, by + 16, 6, bh - 32, g.panel2));
    nodes.push(rect(bx, by, bw, bh, deepGround(d), { radius: 2 }));
    nodes.push(rect(bx, by, 28, bh, d.bg2, { radius: 2 }));
    nodes.push(rect(bx + 28, by, 2, bh, d.accent, { opacity: 0.5 }));
    nodes.push(rect(bx + 60, by + 44, bw - 92, bh - 88, undefined, { stroke: d.accent, strokeWidth: 1.5, opacity: 0.8 }));
    nodes.push(text(bx + 60, by + 128, bw - 92, 124, c.book.title, td.display(50, { align: "center", color: d.accent, lineHeight: 1.1 })));
    fill.push({ node: nodes.length - 1, label: "Book title", hint: "The book's title, two lines" });
    nodes.push(rect(bx + bw / 2 - 28, by + 274, 56, 2, d.accent));
    nodes.push(text(bx + 60, by + 296, bw - 92, 26, c.book.author, td.eyebrow({ align: "center", size: 17, letterSpacing: 5 })));
    fill.push({ node: nodes.length - 1, label: "Author", hint: "Who wrote it" });
    // The publisher's device: a pilcrow in a gilt ring above the imprint.
    nodes.push(ellipse(bx + bw / 2 - 16, by + bh - 138, 32, 32, undefined, { stroke: d.accent, strokeWidth: 1.5 }));
    nodes.push(text(bx + bw / 2 - 16, by + bh - 138, 32, 32, "¶", td.display(18, { align: "center", vAlign: "middle", color: d.accent, lineHeight: 1 })));
    nodes.push(text(bx + 60, by + bh - 92, bw - 92, 24, c.book.imprint, td.meta({ align: "center", size: 15 })));
    nodes.push(rect(bx + bw - 60, by - 6, 16, 150, g.accent2));
    // The thesis: an eyebrow, one sentence in the display face, a short
    // accent rule, a paragraph on the argument, then how to read the book.
    const mx = 548, mw = 602;
    nodes.push(text(mx, by + 6, mw, 28, c.thesisEyebrow, t.eyebrow()));
    nodes.push(text(mx, by + 42, mw, 156, c.thesis, t.display(44, { lineHeight: 1.12 })));
    fill.push({ node: nodes.length - 1, label: "Thesis", hint: "The book's argument in one sentence" });
    nodes.push(rect(mx, by + 222, 72, 4, g.accent));
    nodes.push(text(mx, by + 244, mw, 100, c.summary, t.body(21)));
    c.howToRead.forEach(([ic, line], k) => {
      const ry = by + 372 + k * 54;
      nodes.push(icon(ic, mx, ry + 3, 24, g.accent));
      nodes.push(text(mx + 40, ry, mw - 40, 32, line, t.body(20, { color: g.ink })));
    });
    // The marginalia: a margin rule, then three claims, each a pencil note
    // under a highlighter band, the claim in strong, and one line on it.
    const rx = 1200, nx = 1226, tx = 1266, tw = 558;
    nodes.push(rect(rx, by, 2, bh, g.line));
    c.claims.forEach(([hand, head, line], k) => {
      const ny = by + 20 + k * 176;
      const hw = Math.min(tw, Math.round(hand.length * 40 * 0.38));
      nodes.push(rect(tx - 6, ny + 18, hw + 14, 28, g.sun, { opacity: 0.45, radius: 2 }));
      nodes.push(text(nx, ny - 2, 40, 50, String(k + 1), t.kicker({ size: 40, color: g.accent2 })));
      nodes.push(text(tx, ny, tw, 50, hand, t.kicker({ size: 40 })));
      fill.push({ node: nodes.length - 1, label: `Margin note ${k + 1}`, hint: "A few words, in pencil" });
      nodes.push(text(tx, ny + 58, tw, 30, head, t.strong(20)));
      nodes.push(text(tx, ny + 90, tw, 58, line, t.body(19)));
    });
    nodes.push(icon("pencil", tx, by + 556, 20, g.muted));
    nodes.push(text(tx + 30, by + 552, tw - 30, 26, c.caption, t.meta({ size: 16 })));
    return { page: { name: "The book", bg: g.bg, nodes }, fill };
  },
};

export default {
  id: "deck-book-summary",
  title: "Book Club Summary",
  base: "folio",
  rank: 78,
  tags: [
    "book",
    "summary",
    "education",
    "discussion"
  ],
  meta: {
    company: "Meridian Studio",
    deck: "Book club, November",
    kicker: "This month's book",
    farewell: "Argue with us",
    art: {
      cover: "il-day57-reading-room",
      section: "la-conversation-illustration",
      picture: "od-sitting-reading",
      closing: "il-day22-owl"
    }
  },
  look: {
    display: "EB Garamond", dw: 600,
    body: "Lato", bw: 400,
    mono: null,
    accentFace: "Reenie Beanie", accentWeight: 400, accentSize: 48,
    strongWeight: 700,
    charWidth: 0.48,
    paper: { bg: "#F4EBDA", ink: "#1E1A14", muted: "#5E5648", line: "#D8CCB4", panel: "#EBE1CB", panel2: "#E0D4BA", accent: "#2F5F3F", accent2: "#8C3A2E", sun: "#C9A24E" },
    deep: { bg: "#17281E", bg2: "#0B140F", ink: "#F4EBDA", muted: "#B7C3B2", line: "#2C4436", panel: "#1F3527", panel2: "#284232", accent: "#D9B45E", accent2: "#A6CFA0" },
    radius: 4,
    ornament: "watermark",
    watermark: "¶",
    peeps: ["op-peep-3", "op-peep-31", "op-peep-43", "op-peep-50", "op-peep-94"],
    scale: { cover: 112, title: 64, section: 236, statement: 80, numeral: 100, quote: 56 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "The Slow\nCompany",
        subtitle: "Ines Marlow, 2025. The thesis in one line: the companies that last are the ones that decide slowly and act fast, not the reverse.",
        presenterName: "Aisha Bello",
        when: "19 November 2026, studio kitchen, 18:00",
        note: "bring your copy, pencil in hand"
      }
    ],
    [
      "raw",
      {
        build: signature.spine,
        eyebrow: "The book",
        title: "One sentence, three claims",
        book: { title: "The Slow\nCompany", author: "Ines Marlow", imprint: "Harrow Press, 2025" },
        thesisEyebrow: "The thesis, in one sentence",
        thesis: "The companies that last decide slowly and act fast, not the reverse.",
        summary: "Marlow states it once, then defends it for three hundred pages: the decision is the expensive part, so spend the time there, and then move.",
        howToRead: [
          ["book", "312 pages, about six hours"],
          ["bookmark", "Start with chapter six, then go back"],
          ["pencil", "Read part three with a pencil"]
        ],
        claims: [
          ["decide slowly", "Deciding is the expensive part.", "Most companies rush the call, then spend a year executing the wrong one."],
          ["then move fast", "Speed belongs after the decision.", "Once the call is made nobody is relitigating, so the slow company outruns everyone."],
          ["two people, one week", "Slow means few people.", "A decision made by twelve people is not slow, it is stuck."]
        ],
        caption: "Pencil notes from Aisha's copy"
      }
    ],
    [
      "statement",
      {
        text: "Chapter six earns the book its name: a firm waits eleven months to enter a market, then owns it in two.",
        source: "The best chapter, and the one to read first",
        note: "read six even if you skip the rest"
      }
    ],
    [
      "section",
      {
        n: "",
        kicker: "The pushback",
        title: "Where the argument thins",
        blurb: "Two places where the evidence is thinner than the prose, and one of them is where we live.",
        note: "this is where the cake came out"
      }
    ],
    [
      "twoColumns",
      {
        eyebrow: "The weak spots",
        title: "Two thin places, one of them ours",
        left: {
          eyebrow: "Thin",
          head: "Survivorship everywhere",
          lines: [
            "Every example is a company that won",
            "The slow companies that died are absent",
            "Marlow admits it in the afterword, briefly"
          ],
          icon: "alert-triangle"
        },
        right: {
          eyebrow: "Thinner",
          head: "Small companies get one paragraph",
          lines: [
            "The advice assumes a decade of runway",
            "A startup that decides slowly runs out of money",
            "Our own situation is closer to that paragraph"
          ],
          icon: "alert-triangle"
        },
        note: "we are the paragraph on page 210"
      }
    ],
    [
      "quote",
      {
        text: "Nobody remembers how long the decision took. Everybody remembers whether it was right.",
        name: "Ines Marlow",
        role: "The Slow Company, chapter three",
        note: "page 41, underlined twice"
      }
    ],
    [
      "team",
      {
        eyebrow: "The room",
        title: "Four readers, four verdicts",
        people: [
          ["Aisha Bello", "5 / 5, read it twice", "Chose it, defends it, admits chapter nine is filler."],
          ["Tomas Reyes", "3 / 5, skimmed part three", "Wants the missing chapter on the companies that waited and died."],
          ["Priya Raman", "4 / 5, pencil in hand", "Underlined page 41 twice, argued with page 210 in the margin."],
          ["Ben Okafor", "2 / 5, stopped at seven", "Calls it one good essay stretched to a book. He is not entirely wrong."]
        ],
        note: "scores argued over cake, not settled"
      }
    ],
    [
      "closing",
      {
        title: "Three questions",
        subtitle: "Which decision are we rushing right now? Which one are we calling slow when it is really stuck? And who are the two people who should make it?",
        rows: [
          [
            "message",
            "#book-club on Slack"
          ],
          [
            "mail",
            "aisha@meridian.example"
          ],
          [
            "calendar",
            "Next book chosen: 26 November"
          ]
        ],
        cta: "Vote for the next book",
        note: "the shortlist is on the fridge"
      }
    ]
  ]
};
