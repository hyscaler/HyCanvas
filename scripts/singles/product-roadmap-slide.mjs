// Now, Next, Later Roadmap: one single-slide template, a planning wall. See scripts/gen-single-slides.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: white and ink, with a road-sign blue and a warning amber. The
// paper is plain white, the ink near black, and the two colours mean what
// they mean on a road: blue for a route that is committed, amber for a
// stretch that is temporary and may move. The display face is a highway
// sans (the lettering of a road sign), the body a plain public sans, a
// matching mono sets the eyebrows, the dates and the tags, and a marker
// hand writes the one note a planner adds to the wall. Dots as the
// ornament: the grid of the board everything is pinned to. The signature
// slide is the wall itself: three sign plates on posts over one road that
// runs off the page, the work for each stretch pinned under it, a snapshot
// pinned in the corner and a warning sign next to the note about dates.

import { text, rect, ellipse, button, path, photo, art, halo, card, chrome, note, type, deepGround, mixHex, W, M, CW } from "../lib/deck-kit.mjs";

const BLUE = "#0C5BD1";
const AMBER = "#F5A300";

// White paper types in ink (17.9:1), muted (7.6:1), the blue (6.1:1) with a
// deeper blue for small text (7.7:1); the amber is a sign colour only, so a
// dark amber carries any text in it (7.2:1). The deep ground is the sign
// blue itself, white on it (7.3:1) with a pale amber for accent text (5.1:1)
// and a pale sky for the second accent's text (5.0:1).
const PAPER = { bg: "#FFFFFF", ink: "#111820", muted: "#4B5563", line: "#D6DCE3", panel: "#F3F5F8", panel2: "#E6EAF0", accent: BLUE, accentInk: "#0A4DB2", accent2: AMBER, accent2Ink: "#7A4E00" };
const DEEP = { bg: "#0E4FBF", bg2: "#072E7A", ink: "#FFFFFF", muted: "#C5D6F5", line: "#2F6BD3", panel: "#1B5BC9", panel2: "#2A69D2", accent: "#FFB629", accentInk: "#FFD36A", accent2: "#9EC5FF", accent2Ink: "#BBD8FF" };

// --- the signature slide -------------------------------------------------------

/** The three kinds of sign a stretch of the road can carry. Now is a blue
 *  route sign: committed, dated. Next is a white local sign with an ink
 *  border: planned, not yet dated to the week. Later is a temporary amber
 *  sign: exploring, and the dates on it are the ones that move. Each lane's
 *  bar, marker and tag pill take the same colour, so the colour on a card
 *  says how sure we are of it. */
function tones(K) {
  const g = K.paper, d = K.deep;
  return {
    now: { plate: deepGround(d), plateInk: d.ink, stroke: null, bar: g.accent, pill: mixHex(g.panel, g.accent, 0.16), pillInk: g.accentInk ?? g.accent },
    next: { plate: g.bg, plateInk: g.ink, stroke: g.ink, bar: g.ink, pill: g.panel2, pillInk: g.ink },
    later: { plate: g.accent2, plateInk: g.ink, stroke: null, bar: g.accent2, pill: mixHex(g.panel, g.accent2, 0.22), pillInk: g.accent2Ink ?? g.accent2 },
  };
}

/** The planning wall. A sign plate stands on a post at the head of each
 *  lane, with the lane's state and its date window beside it; one road in
 *  ink runs under all three, a dashed centre line down it, a marker where
 *  each post meets it, and an arrowhead at the end where it leaves the
 *  page. The work for each stretch is pinned under the road as cards, a
 *  colour bar and a dated tag on each. A snapshot is pinned top right, in
 *  the ornament's dot grid, and a warning sign stands beside the hand
 *  note about dates. */
function wall(K, i, c) {
  const g = K.paper;
  const t = type(K, g);
  const mono = K.mono ?? K.body;
  const tone = tones(K);
  const fill = [];
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 1000 });
  const titleAt = nodes.findIndex((n) => n.kind === "text" && n.text === c.title);
  if (titleAt >= 0) fill.push({ node: titleAt, label: "Title", hint: "One short line" });

  // The snapshot pinned in the corner: a tinted slot, a halo on it that
  // lights the drawing (sized to stay inside the slot, so no disc bulges
  // past its edges), an amber pin through its top edge.
  const px = 1480, py = 56, pw = 344, ph = 168;
  nodes.push(photo(px, py, pw, ph, { angle: 160, stops: [[mixHex(g.panel, g.accent, 0.18), 0], [g.panel, 1]] }, { radius: 10 }));
  nodes.push(...halo(px + pw / 2, py + ph / 2, ph - 18, g.accent));
  nodes.push(ellipse(px + pw / 2 - 9, py - 9, 18, 18, g.accent2));
  nodes.push(ellipse(px + pw / 2 - 3, py - 3, 6, 6, g.ink, { opacity: 0.55 }));
  const illustrations = [art(c.art ?? K.art.picture, px + 16, py + 12, pw - 32, ph - 24)];

  // The lanes: three, across the content width.
  const lanes = c.lanes;
  const gap = 24;
  const cw = (CW - (lanes.length - 1) * gap) / lanes.length;
  const signY = bodyTop, signH = 56, plateW = 172;
  const roadY = signY + signH + 36, roadH = 56;
  const roadEnd = W - M - 48;
  const cardsY = roadY + roadH + 26, cardH = 132, cardGap = 14;

  // The signs and their posts, before the road so the posts run under it.
  lanes.forEach((lane, k) => {
    const x = M + k * (cw + gap);
    const tn = tone[lane.tone] ?? tone.next;
    nodes.push(rect(x, signY, plateW, signH, tn.plate, { radius: 10, ...(tn.stroke ? { stroke: tn.stroke, strokeWidth: 2.5 } : {}) }));
    nodes.push(text(x + 14, signY, plateW - 28, signH, lane.name, t.display(26, { color: tn.plateInk, upper: true, letterSpacing: 3, align: "center", vAlign: "middle", lineHeight: 1 })));
    fill.push({ node: nodes.length - 1, label: `${lane.name}, sign`, hint: "The name of this stretch of the road" });
    nodes.push(text(x + plateW + 20, signY + 6, cw - plateW - 20, 18, lane.sub, { family: mono, size: 13, weight: 600, color: g.muted, upper: true, letterSpacing: 3, lineHeight: 1.2 }));
    nodes.push(text(x + plateW + 20, signY + 28, cw - plateW - 20, 24, lane.when, { family: mono, size: 17, weight: 600, color: g.ink, lineHeight: 1.2 }));
    fill.push({ node: nodes.length - 1, label: `${lane.name}, dates`, hint: "The window this stretch covers" });
    nodes.push(rect(x + 28, signY + signH, 4, roadY - signY - signH, g.ink));
  });

  // The road: one ink band, the lane dashes down its centre (drawn as
  // strips, since a stroke dash is ignored by the export renderers), and
  // the arrowhead that takes it off the edge of the wall.
  nodes.push(rect(M, roadY, roadEnd - M, roadH, g.ink, { radius: 4 }));
  for (let x = M + 24; x + 30 <= roadEnd - 20; x += 52) nodes.push(rect(x, roadY + roadH / 2 - 2, 30, 4, g.bg));
  nodes.push(path([[roadEnd - 6, roadY - 14], [W - M, roadY + roadH / 2], [roadEnd - 6, roadY + roadH + 14]], { fill: g.ink, closed: true, join: "round" }));
  lanes.forEach((lane, k) => {
    const x = M + k * (cw + gap);
    const tn = tone[lane.tone] ?? tone.next;
    nodes.push(ellipse(x + 30 - 12, roadY + roadH / 2 - 12, 24, 24, g.bg));
    nodes.push(ellipse(x + 30 - 6, roadY + roadH / 2 - 6, 12, 12, tn.bar));
  });

  // The work, pinned under each stretch: a card per item with the lane's
  // colour bar, its heading, a dated tag and one line.
  lanes.forEach((lane, k) => {
    const x = M + k * (cw + gap);
    const tn = tone[lane.tone] ?? tone.next;
    lane.items.forEach(([head, line, tag], j) => {
      const y = cardsY + j * (cardH + cardGap);
      nodes.push(card(K, g, x, y, cw, cardH));
      nodes.push(rect(x + 18, y + 20, 6, cardH - 40, tn.bar, { radius: 3 }));
      nodes.push(text(x + 42, y + 18, cw - 42 - 140, 30, head, t.strong(21)));
      fill.push({ node: nodes.length - 1, label: `${lane.name} ${j + 1}`, hint: "What ships in this stretch" });
      nodes.push(button(x + cw - 128, y + 20, 108, 26, tag, { fill: tn.pill, color: tn.pillInk, family: mono, size: 12, weight: 700, letterSpacing: 1, upper: true }));
      nodes.push(text(x + 42, y + 56, cw - 74, 56, line, t.body(17)));
    });
  });

  // The warning sign and the note about dates, bottom right.
  const wx = 1118, wy = 926, r = 22;
  nodes.push(path([[wx, wy - r], [wx + r, wy + r * 0.8], [wx - r, wy + r * 0.8]], { fill: g.accent2, stroke: g.ink, strokeWidth: 3, closed: true, join: "round" }));
  nodes.push(text(wx - 10, wy - 10, 20, 26, "!", { family: K.display, size: 19, weight: K.dw, color: g.ink, align: "center", lineHeight: 1 }));
  nodes.push(...note(K, g, c.note, false, { x: 1160, y: 906, w: 664, align: "left", size: 28 }));
  if (c.note) fill.push({ node: nodes.length - 1, label: "Note", hint: "The one thing to say about the dates" });

  return { page: { name: "Roadmap", bg: g.bg, nodes, illustrations }, fill };
}

const signature = { wall };

export default {
  id: "product-roadmap-slide",
  title: "Now, Next, Later Roadmap",
  base: "slate",
  rank: 20,
  tags: [
    "roadmap",
    "product",
    "quarterly",
    "planning",
    "kanban"
  ],
  styleTags: [
    "minimal",
    "modern"
  ],
  meta: {
    company: "Atlas",
    deck: "Product planning, Q3 2026",
    kicker: "now, next, later",
    farewell: "see you at the next review",
    art: {
      cover: "il-day66-travel",
      section: "il-day14-forklift",
      picture: "il-day65-city-road",
      closing: "la-scooter"
    }
  },
  look: {
    display: "Overpass", dw: 800,
    body: "Public Sans", bw: 400,
    mono: "Overpass Mono",
    accentFace: "Permanent Marker", accentWeight: 400, accentSize: 34,
    numeralFace: "Overpass Mono", numeralWeight: 700,
    // Overpass at 800 is a wide face; the estimate stays generous so a
    // title never overruns its box.
    charWidth: 0.6,
    paper: PAPER,
    deep: DEEP,
    radius: 6,
    ornament: "dots",
    peeps: ["op-peep-3", "op-peep-31", "op-peep-44", "op-peep-69", "op-peep-90"],
    scale: { cover: 116, title: 60, section: 236, statement: 78, numeral: 104, quote: 52 },
  },
  signature,
  slides: [
    [
      "raw",
      {
        build: signature.wall,
        eyebrow: "Product roadmap",
        title: "The road ahead for Atlas",
        art: "il-day65-city-road",
        lanes: [
          {
            name: "Now", tone: "now", sub: "Shipping this quarter", when: "Jul to Sep 2026",
            items: [
              ["Realtime co-editing", "Multiplayer cursors, comments and presence in every doc.", "Sep"],
              ["Mobile quick capture", "Send notes and tasks to any project from your phone.", "Aug"],
              ["Granular permissions", "Role-based access, down to a single page.", "Sep"],
            ],
          },
          {
            name: "Next", tone: "next", sub: "In design", when: "Oct to Dec 2026",
            items: [
              ["Workflow automations", "Trigger actions when a task changes status or owner.", "Q4"],
              ["Public API v2", "Webhooks, typed SDKs and saner rate limits.", "Q4"],
              ["Template gallery", "Start any project from a community template.", "Dec"],
            ],
          },
          {
            name: "Later", tone: "later", sub: "Exploring", when: "2027 and beyond",
            items: [
              ["AI meeting recaps", "Summaries and action items, filed to the timeline.", "H1 27"],
              ["Offline mode", "Full editing without a connection; sync on return.", "2027"],
              ["Desktop apps", "Fast, focused native clients for macOS and Windows.", "TBD"],
            ],
          },
        ],
        note: "dates will move, the order won't"
      }
    ],
  ]
};
