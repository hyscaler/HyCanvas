// Webinar Deck: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: a webinar watched on a laptop. Both grounds are dark teal, the
// reading pages one shade lighter than the cover, so nothing glares on a
// small screen. Coral is the live colour (the leading answer, the rules,
// the button) and a bright aqua is the second voice. A wide, open sans for
// the titles and a plain screen sans for the body, both chosen to stay
// legible at laptop scale; a brush hand for the kicker and the asides, the
// voice of the host talking over the slides. The ornament is three
// diagonal bands, the energy of a live event.

import { text, rect, ellipse, footer, note, ornamentDeep, type, deepGround, mixHex, estWidth, W, M } from "../lib/deck-kit.mjs";

// --- the signature slide -------------------------------------------------------

/** The live poll: the question in large type at left over the share of the
 *  room that has answered, four answer bars at right with the running
 *  percentages, the leading answer in coral and the rest in aqua, a live
 *  pill with the attendance top right, and a strip of the chat coming in
 *  under the bars. The audience answers by typing a letter in the chat;
 *  the note says so. */
const signature = {
  poll(K, i, c) {
    const g = K.deep;
    const t = type(K, g);
    const nodes = [...ornamentDeep(K, g)];
    const fill = [];
    const coral = g.accentInk ?? g.accent;
    const aqua = g.accent2Ink ?? g.accent2;
    const cw = K.charWidth ?? 0.56;

    // The reading grid's eyebrow baseline, kept on the deep ground.
    nodes.push(text(M, 88, 1000, 28, c.eyebrow, t.eyebrow()));

    // The live pill, top right: a pulsing dot and who is in the room.
    const pw = 300, px = W - M - pw, py = 78;
    nodes.push(rect(px, py, pw, 44, mixHex(g.bg, g.accent, 0.2), { radius: 22 }));
    nodes.push(ellipse(px + 16, py + 10, 24, 24, g.accent, { opacity: 0.3 }));
    nodes.push(ellipse(px + 22, py + 16, 12, 12, g.accent));
    nodes.push(text(px + 54, py + 11, pw - 70, 24, c.live, t.strong(18, { color: coral })));
    fill.push({ node: nodes.length - 1, label: "Attendance", hint: "Who is in the room" });

    // The question, large, at left, with a rule and a line under it.
    const qSize = 66;
    const qLines = c.question.split("\n").length;
    const qH = Math.round(qSize * 1.1 * qLines) + 8;
    const qy = 232;
    nodes.push(text(M, qy, 780, qH, c.question, t.display(qSize, { lineHeight: 1.06 })));
    fill.push({ node: nodes.length - 1, label: "Poll question", hint: "One question, up to three short lines" });
    nodes.push(rect(M, qy + qH + 26, 120, 4, g.accent));
    nodes.push(text(M, qy + qH + 56, 720, 70, c.lead, t.body(22)));

    // Answered so far: the share of the room as a figure, the count beside
    // it, and a thin bar that echoes the answer bars.
    const ay = 660;
    nodes.push(text(M, ay, 600, 24, c.answeredLabel, t.eyebrow({ size: 15, letterSpacing: 3 })));
    nodes.push(text(M, ay + 34, 220, 64, `${c.answered[0]}%`, t.numeral(56, { color: aqua })));
    nodes.push(text(M + 150, ay + 62, 560, 30, c.answered[1], t.meta({ size: 19 })));
    fill.push({ node: nodes.length - 1, label: "Answered so far", hint: "How many of the room have answered" });
    nodes.push(rect(M, ay + 118, 720, 10, g.panel2, { radius: 5 }));
    nodes.push(rect(M, ay + 118, Math.round((720 * c.answered[0]) / 100), 10, g.accent2, { radius: 5 }));

    // Four answer bars at right: a lettered disc, the label, the figure,
    // then a track and the fill. Filled rects only: the server renderer
    // fills a path and never strokes one.
    const bx = 960, bw = W - M - bx;
    const max = Math.max(...c.answers.map((a) => a[1]));
    c.answers.forEach(([label, pct], k) => {
      const y = 196 + k * 128;
      const lead = pct === max;
      const tone = lead ? g.accent : g.accent2;
      const toneInk = lead ? coral : aqua;
      nodes.push(ellipse(bx, y - 2, 40, 40, mixHex(g.bg, tone, 0.28)));
      nodes.push(text(bx, y - 2, 40, 40, String.fromCharCode(65 + k), { family: K.display, size: 19, weight: K.dw, color: toneInk, align: "center", vAlign: "middle", lineHeight: 1 }));
      nodes.push(text(bx + 58, y, 580, 36, label, t.strong(26)));
      fill.push({ node: nodes.length - 1, label: `Answer ${String.fromCharCode(65 + k)}`, hint: "One short answer" });
      nodes.push(text(bx + bw - 200, y - 10, 200, 52, `${pct}%`, t.numeral(44, { align: "right", color: toneInk })));
      nodes.push(rect(bx, y + 56, bw, 26, g.panel2, { radius: 13 }));
      nodes.push(rect(bx, y + 56, Math.max(26, Math.round((bw * pct) / 100)), 26, tone, { radius: 13 }));
    });

    // The chat strip under the bars: a hairline, a label, and three
    // answers as they come in.
    const sy = 704;
    nodes.push(rect(bx, sy, bw, 1, g.line));
    nodes.push(text(bx, sy + 18, 400, 24, c.chatLabel, t.eyebrow({ size: 15, letterSpacing: 3 })));
    let cx = bx;
    c.chat.forEach((line) => {
      const w = Math.round(estWidth(line, 17, cw * 0.9)) + 44;
      nodes.push(rect(cx, sy + 54, w, 40, g.panel2, { radius: 20 }));
      nodes.push(text(cx + 22, sy + 63, w - 44, 24, line, t.strong(17, { weight: 500, color: g.muted })));
      cx += w + 12;
    });

    nodes.push(...note(K, g, c.note, true, { x: W - M - 820, y: 866, w: 820, align: "right" }));
    nodes.push(...footer(K, g, i));
    return { page: { name: "Live poll", bg: deepGround(g), nodes }, fill };
  },
};

export default {
  id: "deck-webinar",
  title: "Webinar Deck",
  base: "vanta",
  rank: 86,
  tags: [
    "webinar",
    "online",
    "presentation",
    "marketing"
  ],
  styleTags: ["modern", "friendly", "dark"],
  meta: {
    company: "Nova Systems",
    deck: "Webinar: incidents without the scramble",
    kicker: "live, forty minutes, questions in the chat",
    farewell: "before you close the tab",
    art: {
      cover: "il-121-work-from-home-1",
      section: "il-day41-desktop",
      picture: "il-day17-walkie-talkie",
      closing: "la-youtube-illustration"
    }
  },
  look: {
    display: "Lexend", dw: 700,
    body: "DM Sans", bw: 400,
    mono: null,
    accentFace: "Mansalva", accentWeight: 400, accentSize: 38,
    charWidth: 0.6,
    // Coral reads on the dark teal ground (5.3:1) but drops to 4.3:1 on a
    // card, so the paper pages type in a lighter coral. Aqua reads everywhere.
    paper: { bg: "#0D343A", ink: "#F1F8F6", muted: "#A9C7C4", line: "#245259", panel: "#14424A", panel2: "#1B4F57", accent: "#FF7B66", accent2: "#5FD8CA", accentInk: "#FF9A88" },
    deep: { bg: "#082A30", bg2: "#031316", ink: "#F1F8F6", muted: "#9FC0BD", line: "#1B474E", panel: "#0F3940", panel2: "#16464E", accent: "#FF7B66", accent2: "#5FD8CA" },
    radius: 12,
    ornament: "stripes",
    peeps: ["op-peep-3", "op-peep-15", "op-peep-31", "op-peep-44", "op-peep-68"],
    scale: { cover: 108, title: 58, section: 220, statement: 76, numeral: 96, quote: 50 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "Incidents without\nthe scramble",
        subtitle: "What changed in the last year, a method you can use on Monday, one real case walked through live, and where to go deeper after today.",
        presenter: "Tomas Reyes and Priya Raman  ·  Live, 28 October, 16:00",
        chips: [
          [
            "40",
            "minutes"
          ],
          [
            "1",
            "live case"
          ],
          [
            "Q&A",
            "at the end"
          ]
        ],
        art: "il-121-work-from-home-1",
        note: "cameras optional, questions not"
      }
    ],
    [
      "agenda",
      {
        eyebrow: "Agenda",
        title: "Four sections, forty minutes",
        items: [
          [
            "The landscape",
            "What changed in the last year, and why the old runbook broke",
            "8 min"
          ],
          [
            "The method",
            "Correlate, explain, decide: the framework in plain words",
            "10 min"
          ],
          [
            "Live example",
            "One real incident from our own platform, start to finish",
            "15 min"
          ],
          [
            "Q&A",
            "Your questions, and the offer for attendees",
            "7 min"
          ],
          [
            "Recording",
            "In your inbox within the hour",
            "After"
          ]
        ],
        card: {
          eyebrow: "Live",
          big: "28 Oct",
          meta: [
            [
              "Time",
              "16:00, forty minutes"
            ],
            [
              "Hosts",
              "Tomas and Priya"
            ],
            [
              "Questions",
              "In the chat, any time"
            ],
            [
              "Recording",
              "Sent to every registrant"
            ]
          ]
        },
        note: "joining late? the recording has chapters"
      }
    ],
    [
      "raw",
      {
        build: signature.poll,
        eyebrow: "Live poll  ·  before we start",
        live: "Live  ·  2,030 attending",
        question: "How did your\nlast incident\nstart?",
        lead: "Pick the closest. One answer per person; the bars update as the chat comes in.",
        answeredLabel: "Answered so far",
        answered: [63, "1,284 of 2,030 in the room"],
        answers: [
          ["An alert fired", 38],
          ["A customer told us", 27],
          ["Someone noticed a graph", 21],
          ["We still do not know", 14]
        ],
        chatLabel: "From the chat",
        chat: [
          "B, and the customer was not polite",
          "A, for once",
          "D. Still do not know."
        ],
        note: "type a letter in the chat, the bars follow"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "The landscape",
        title: "What changed in the last year",
        cards: [
          [
            "database",
            "More systems, fewer people",
            "The median platform team runs three times the services it did in 2023 with the same headcount."
          ],
          [
            "bolt",
            "Deploys every hour",
            "Continuous delivery means the cause of an incident is usually something that changed in the last sixty minutes."
          ],
          [
            "alert-triangle",
            "Alerts nobody reads",
            "Teams told us they mute a third of their alerts. The signal is there; the reading is not."
          ]
        ],
        note: "from our survey of 212 platform teams, spring 2026"
      }
    ],
    [
      "process",
      {
        eyebrow: "The method",
        title: "Correlate, explain, decide",
        steps: [
          [
            "Correlate",
            "Every deploy, config change and alert on one timeline. If it is not on the timeline, it did not happen."
          ],
          [
            "Explain",
            "Read the timeline backwards from the first symptom. The cause is almost always the last change before it."
          ],
          [
            "Decide",
            "Roll back or roll forward, in under five minutes, with the evidence in the channel."
          ],
          [
            "Write it down",
            "The narrative, drafted from the timeline, becomes the review. No blank page on Monday."
          ]
        ],
        note: "four steps, none of them a new dashboard"
      }
    ],
    [
      "section",
      {
        n: "03",
        title: "Live example",
        blurb: "We leave the slides here. One real incident from our own platform, at the speed it happened.",
        kicker: "screen share starts here",
        art: "il-day41-desktop"
      }
    ],
    [
      "textPicture",
      {
        eyebrow: "Live example",
        title: "One real incident, walked through",
        points: [
          [
            "14:02",
            "A deploy changes the cache key format. Nothing alerts; the cache simply starts missing."
          ],
          [
            "14:09",
            "P95 latency doubles. The alert fires. The timeline shows one change in the last hour."
          ],
          [
            "14:11",
            "Rollback decided from the timeline alone. Latency recovers by 14:14. The narrative is drafted before the channel calms down."
          ]
        ],
        art: "il-day17-walkie-talkie",
        note: "five minutes, alert to recovery"
      }
    ],
    [
      "quote",
      {
        text: "I ran it on Tuesday's outage.\nThe narrative was written before\nthe channel had calmed down.",
        name: "Marta Lindqvist",
        role: "Site reliability lead, Brightline Logistics. Attended the June session",
        note: "a real outage, not a rehearsal"
      }
    ],
    [
      "twoColumns",
      {
        eyebrow: "Q&A and the offer",
        title: "Ask now, then take it home",
        left: {
          eyebrow: "Questions",
          head: "Ask in the chat, we read every one",
          lines: [
            "Upvote a question to move it up the list",
            "Anything unanswered gets a written reply by Friday",
            "Both hosts stay ten minutes after the end"
          ],
          icon: "message"
        },
        right: {
          eyebrow: "For attendees",
          head: "Thirty days with the narrative feature on",
          lines: [
            "The incident playbook, as a PDF, today",
            "Thirty days of the platform, no card needed",
            "A working session with one of our engineers"
          ],
          icon: "gift"
        },
        note: "the playbook link is in the chat now"
      }
    ],
    [
      "closing",
      {
        title: "Go deeper",
        subtitle: "Every attendee gets the incident playbook and thirty days of the platform with the narrative feature on. Questions now.",
        rows: [
          [
            "world",
            "novasystems.example/webinar"
          ],
          [
            "mail",
            "webinar@novasystems.example"
          ],
          [
            "calendar",
            "Next session: 25 November"
          ]
        ],
        cta: "Claim the thirty days",
        art: "la-youtube-illustration",
        note: "no card, no sales call, thirty days"
      }
    ]
  ]
};
