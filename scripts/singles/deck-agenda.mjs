// Agenda Slide: one single-slide template, the order of business for a board meeting. See scripts/gen-single-slides.mjs.
//
// The look: a boardroom order paper. Warm navy and copper on ivory, with a
// verdigris green as the second accent (copper, and what copper turns into),
// an Ibarra Real Nova display over a Red Hat Text body, and a fountain-pen
// hand for the notes in the margin. The hairlines ornament rules every page
// top and bottom the way a printed order of business is ruled, with a copper
// disc in the corner. The signature slide is the order of business itself: a
// run of show down a clock rule, each item a block as tall as the minutes it
// gets, with the session card at right and a coffee on it.

import { text, rect, ellipse, button, art, halo, note, chrome, type, deepGround, mixHex, W, M } from "../lib/deck-kit.mjs";

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];

/** A clock label some minutes after a start time given as "HH:MM". */
const clock = (start, mins) => {
  const [h, m] = start.split(":").map(Number);
  const t = h * 60 + m + mins;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

const signature = {
  /** The order of business: a clock rule down the left with the start time
   *  of every item, a block per item as tall as the minutes it gets (with a
   *  floor so five minutes still holds a heading and a line), the owner and
   *  the duration at the block's right, and the session card on the deep
   *  ground at right with a seal, the where and when, and a coffee under a
   *  hand note. */
  orderOfBusiness(K, i, c) {
    const g = K.paper;
    const d = K.deep;
    const t = type(K, g);
    const td = type(K, d);
    const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
    const fill = [];
    const illustrations = [];
    const start = c.start ?? "09:30";
    const gap = 10;
    const hFor = (min) => Math.round(Math.max(86, 40 + min * 4.2));
    const minutes = c.items.map(([, , dur]) => parseInt(dur, 10) || 10);
    const total = minutes.reduce((a, b) => a + b, 0);
    const y0 = bodyTop + 16;
    const runH = minutes.reduce((a, m) => a + hFor(m), 0) + gap * (c.items.length - 1);
    const ruleX = M + 124;
    const bx = M + 156, bw = 1216 - bx;
    const timeStyle = { family: K.body, size: 20, weight: 600, color: g.accentInk ?? g.accent, lineHeight: 1.2 };

    // The clock rule, behind its dots.
    nodes.push(rect(ruleX - 1, y0 + 8, 2, runH + 6, g.line));

    let y = y0, elapsed = 0;
    c.items.forEach(([h, s, dur, owner], k) => {
      const bh = hFor(minutes[k]);
      nodes.push(text(M, y + 4, 100, 26, clock(start, elapsed), timeStyle));
      nodes.push(ellipse(ruleX - 7, y + 8, 14, 14, k === 0 ? g.accent : g.bg, k === 0 ? {} : { stroke: g.accent, strokeWidth: 2.5 }));
      nodes.push(rect(bx, y, bw, bh, g.panel, { radius: K.radius, stroke: g.line, strokeWidth: 1.5 }));
      nodes.push(rect(bx, y, 6, bh, g.accent, { radius: 0 }));
      nodes.push(text(bx + 30, y + 12, 60, 36, ROMAN[k] ?? String(k + 1), t.numeral(28)));
      nodes.push(text(bx + 104, y + 12, 560, 34, h, t.display(26)));
      fill.push({ node: nodes.length - 1, label: `Item ${k + 1}`, hint: "What this item is, in a few words" });
      nodes.push(text(bx + 104, y + 48, 560, 26, s, t.body(18)));
      nodes.push(button(bx + bw - 24 - 104, y + 14, 104, 30, dur, { fill: mixHex(g.panel, g.accent, 0.16), color: g.accentInk ?? g.accent, family: K.body, size: 15, weight: 700 }));
      if (owner) nodes.push(text(bx + bw - 24 - 104 - 16 - 300, y + 17, 300, 24, owner, t.meta({ align: "right", size: 17 })));
      y += bh + gap;
      elapsed += minutes[k];
    });
    const yEnd = y - gap;
    nodes.push(text(M, yEnd + 2, 100, 26, clock(start, elapsed), { ...timeStyle, color: g.muted }));
    nodes.push(ellipse(ruleX - 7, yEnd + 6, 14, 14, g.line));
    nodes.push(text(M + 156, yEnd + 6, 400, 24, `${total} minutes, doors close at ${clock(start, 5)}`, t.meta({ size: 16 })));

    // The session card, on the deep ground.
    const cx = 1300, cy = y0, cw = W - M - cx, ch = runH;
    nodes.push(rect(cx, cy, cw, ch, deepGround(d), { radius: K.radius }));
    nodes.push(rect(cx, cy, cw, 6, d.accent, { radius: 0 }));
    nodes.push(text(cx + 40, cy + 32, cw - 80, 28, c.card.eyebrow, td.eyebrow()));
    nodes.push(text(cx + 40, cy + 62, 300, 78, c.card.big, td.display(64)));
    fill.push({ node: nodes.length - 1, label: "Date", hint: "The day of the meeting" });
    // A copper seal with the quarter in it.
    const sx = cx + cw - 40 - 108, sy = cy + 36;
    nodes.push(ellipse(sx, sy, 108, 108, undefined, { stroke: d.accent, strokeWidth: 3 }));
    nodes.push(ellipse(sx + 9, sy + 9, 90, 90, undefined, { stroke: d.accent, strokeWidth: 1, opacity: 0.6 }));
    nodes.push(text(sx, sy, 108, 108, c.card.seal ?? "Q3", { family: K.display, size: 38, weight: K.dw, color: d.accentInk ?? d.accent, align: "center", vAlign: "middle", lineHeight: 1 }));
    const rowH = 64;
    c.card.meta.forEach(([l, v], k) => {
      const my = cy + 160 + k * rowH;
      nodes.push(text(cx + 40, my, 160, 22, l, td.meta({ size: 16 })));
      nodes.push(text(cx + 40, my + 24, cw - 80, 30, v, td.strong(21)));
      nodes.push(rect(cx + 40, my + rowH - 6, cw - 80, 1, d.line));
    });
    // A coffee in a halo, and the hand note under it, with the halo kept
    // above the note's box so the two never share a line.
    const ay = cy + 160 + c.card.meta.length * rowH + 14;
    const ah = Math.max(96, ch - (ay - cy) - 90);
    nodes.push(...halo(cx + cw / 2, ay + ah / 2, ah + 40, d.accent));
    illustrations.push(art(c.card.art ?? K.art.picture, cx + cw / 2 - 90, ay, 180, ah));
    if (c.card.note) nodes.push(...note(K, d, c.card.note, true, { x: cx + 30, y: cy + ch - 62, w: cw - 60, align: "center" }));
    return { page: { name: "Agenda", bg: g.bg, nodes, illustrations }, fill };
  },
};

export default {
  id: "deck-agenda",
  title: "Agenda Slide",
  base: "atlas",
  rank: 100,
  tags: [
    "slide",
    "agenda",
    "list"
  ],
  styleTags: [
    "professional",
    "classic"
  ],
  meta: {
    company: "Northwind Labs",
    deck: "Quarterly review",
    kicker: "Quarterly review, Q3 2026",
    farewell: "Until Wednesday",
    art: {
      cover: "il-day76-watch-spectacle",
      section: "il-day57-reading-room",
      picture: "il-day79-coffee",
      closing: "la-waitng-illustration"
    }
  },
  look: {
    display: "Ibarra Real Nova", dw: 700,
    body: "Red Hat Text", bw: 400,
    mono: null,
    accentFace: "La Belle Aurore", accentWeight: 400, accentSize: 42,
    charWidth: 0.5,
    paper: { bg: "#F6F0E4", ink: "#1E2540", muted: "#5C5F72", line: "#D9CFBC", panel: "#EEE6D6", panel2: "#E4DAC6", accent: "#B5642F", accent2: "#3F7A72", accentInk: "#8C4418", accent2Ink: "#2E6159", sun: "#D9A26F" },
    deep: { bg: "#26304F", bg2: "#151A30", ink: "#F6F0E4", muted: "#B9BDCC", line: "#3B4667", panel: "#2E3A5C", panel2: "#38456B", accent: "#DC9660", accent2: "#8FC7BB", accentInk: "#E8AB78", sun: "#C97C4B" },
    radius: 4,
    ornament: "hairlines",
    peeps: ["op-peep-100", "op-peep-102", "op-peep-33", "op-peep-44", "op-peep-68"],
    scale: { cover: 104, title: 60, section: 236, statement: 80, numeral: 100, quote: 52 },
  },
  signature,
  slides: [
[
      "raw",
      {
        build: signature.orderOfBusiness,
        eyebrow: "Order of business",
        title: "Ninety minutes, five items",
        start: "09:30",
        items: [
          [
            "Where we are today",
            "The quarter's numbers against plan",
            "15 min",
            "Rhea Castellanos"
          ],
          [
            "What changed this quarter",
            "Wins, misses and what we learned",
            "20 min",
            "Tomas Lindqvist"
          ],
          [
            "Priorities for the next 90 days",
            "Three bets, owners and dates",
            "30 min",
            "Dana Whitfield"
          ],
          [
            "Questions and discussion",
            "Open floor",
            "20 min",
            "Everyone"
          ],
          [
            "Decisions",
            "What we need from this room",
            "5 min",
            "Dana Whitfield"
          ]
        ],
        card: {
          eyebrow: "Quarterly review",
          big: "8 Oct",
          seal: "Q3",
          meta: [
            [
              "Time",
              "09:30 to 11:00"
            ],
            [
              "Room",
              "Room 4B"
            ],
            [
              "Host",
              "Dana Whitfield"
            ],
            [
              "Notes",
              "Shared after the session"
            ]
          ],
          art: "il-day79-coffee",
          note: "coffee is outside from nine"
        }
      }
    ],
  ]
};
