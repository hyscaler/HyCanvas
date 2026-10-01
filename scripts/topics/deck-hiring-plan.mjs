// Hiring Plan: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: navy and apricot on ivory, a rounded sans for titles and for
// reading, a neat hand face for the notes, one apricot corner on the deep
// pages. Structured and realistic: a plan with an owner and a clock on
// every line, the kind you can hold people to. The signature slide is the
// funnel: five bars narrowing from sourced to signed, each with its count,
// its conversion from the step above, and the line that explains it.

import { text, rect, path, chrome, note, type, mixHex, inkOn, M } from "../lib/deck-kit.mjs";

// --- the funnel --------------------------------------------------------------

const FUNNEL = {
  eyebrow: "The funnel",
  title: "From 1,100 names to 22 signatures",
  // [stage, what happens there, count, count as shown, rate, what the rate reads]
  steps: [
    ["Sourced", "Referrals, inbound and outreach", 1100, "1,100", "50", "per role, across every channel"],
    ["Screened", "Thirty minutes with a recruiter", 220, "220", "20%", "of the sourced pass the screen"],
    ["Interviewed", "The two-hour panel, in one day", 66, "66", "30%", "of screens go on to a panel"],
    ["Offered", "Within 48 hours of the debrief", 26, "26", "39%", "of panels end in an offer"],
    ["Signed", "Seven days from offer to ink", 22, "22", "85%", "of offers are signed"],
  ],
  caption: "Bars on a square-root scale so the bottom stays readable. The counts are the plan for the half; the rates are last year's, with the accept rate held at 85%.",
  note: "at a 15% screen we would need 1,470 names",
};

/** The funnel: five bars stacked down the middle of the page, each as wide
 *  as the square root of its count, navy stepping lighter toward the
 *  bottom and the signed bar in apricot. A pale apricot connector fills
 *  every gap, so the stack reads as one funnel. The stage and what happens
 *  there sit at left; the conversion from the step above at right. */
function funnel(K, i, c) {
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const fill = [{ node: nodes.findIndex((n) => n.text === c.title), label: "Title", hint: "One short line" }];
  const n = c.steps.length;
  const barH = 92, gap = 20;
  const y0 = bodyTop + 12;
  const fx = 470, fw = 980, cx = fx + fw / 2;
  const top = c.steps[0][2];
  const widthOf = (count) => Math.max(128, Math.round(fw * Math.sqrt(count / top)));
  const rows = c.steps.map(([label, sub, count, shown, rate, line], k) => {
    const w = widthOf(count);
    return { label, sub, shown, rate, line, w, x: Math.round(cx - w / 2), y: y0 + k * (barH + gap) };
  });
  // The connectors: one trapezoid per gap, from a bar's bottom edge to the
  // next bar's top edge, in a pale tint of the accent.
  const glow = mixHex(g.panel, g.accent, 0.24);
  rows.slice(0, -1).forEach((r, k) => {
    const s = rows[k + 1];
    nodes.push(path([[r.x, r.y + barH], [r.x + r.w, r.y + barH], [s.x + s.w, s.y], [s.x, s.y]], { fill: glow, closed: true }));
  });
  rows.forEach((r, k) => {
    const last = k === n - 1;
    const fillC = last ? g.accent : mixHex(d.bg, g.bg, k * 0.07);
    nodes.push(rect(r.x, r.y, r.w, barH, fillC, { radius: 10 }));
    nodes.push(text(r.x, r.y, r.w, barH, r.shown, { family: K.display, size: 40, weight: K.dw, color: inkOn(K, fillC), align: "center", vAlign: "middle", lineHeight: 1 }));
    // Left: the stage, numbered, and what happens there.
    nodes.push(text(M, r.y + 16, 40, 26, String(k + 1).padStart(2, "0"), t.eyebrow({ size: 16, letterSpacing: 2 })));
    nodes.push(text(M + 44, r.y + 10, 300, 36, r.label, t.display(28)));
    nodes.push(text(M + 44, r.y + 50, 320, 30, r.sub, t.body(18)));
    // Right: the conversion from the step above, and the line that reads it.
    nodes.push(text(1494, r.y + 6, 330, 46, r.rate, t.numeral(38)));
    nodes.push(text(1494, r.y + 54, 330, 30, r.line, t.body(18)));
  });
  const cy = y0 + n * barH + (n - 1) * gap + 22;
  nodes.push(text(M, cy, 960, 56, c.caption, t.body(18)));
  nodes.push(...note(K, g, c.note));
  return { page: { name: "Funnel", bg: g.bg, nodes }, fill };
}

const signature = { funnel };

export default {
  id: "deck-hiring-plan",
  title: "Hiring Plan",
  base: "atlas",
  rank: 68,
  tags: [
    "hiring",
    "recruiting",
    "plan",
    "team"
  ],
  styleTags: ["professional", "friendly", "modern"],
  meta: {
    company: "Harbor & Vale",
    deck: "Hiring plan, H1 2027",
    kicker: "Headcount against the roadmap",
    farewell: "The asks",
    art: {
      cover: "la-conversation-illustration",
      section: "il-121-work-from-home-1",
      picture: "od-sitting-reading",
      closing: "la-flat-character-illustrations"
    }
  },
  look: {
    display: "Nunito", dw: 800,
    body: "Nunito Sans", bw: 400,
    mono: null,
    accentFace: "Patrick Hand", accentWeight: 400, accentSize: 38,
    paper: { bg: "#FBF7EF", ink: "#1B2A4A", muted: "#5C6578", line: "#E1DACB", panel: "#F3EEE3", panel2: "#E9E2D3", accent: "#F2955A", accent2: "#2F4F8F", accentInk: "#B04E14" },
    deep: { bg: "#1F3159", bg2: "#101B38", ink: "#FBF7EF", muted: "#B7C0D6", line: "#35486F", panel: "#293D68", panel2: "#324873", accent: "#F5A468", accent2: "#9DBCF2" },
    radius: 12,
    ornament: "corner",
    peeps: ["op-peep-90", "op-peep-83", "op-peep-89", "op-peep-24", "op-peep-32"],
    scale: { cover: 112, title: 60, section: 236, statement: 80, numeral: 104, quote: 54 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "Twenty-two roles,\ntwo quarters",
        subtitle: "Each role, its quarter and its why, the funnel math from sourcing to signed, the process with time targets, the risks, and what we need from you.",
        presenter: "Dana Whitfield, Head of People  ·  1 December 2026",
        note: "hold us to every date in here"
      }
    ],
    [
      "table",
      {
        eyebrow: "The roles",
        title: "Each role, its quarter, and its why",
        cols: [
          "",
          "Q1",
          "Q2",
          "Why"
        ],
        rows: [
          [
            "Engineering",
            "6",
            "4",
            "Platform rebuild and APAC"
          ],
          [
            "Sales",
            "3",
            "3",
            "Two territories, one pod"
          ],
          [
            "Customer success",
            "2",
            "1",
            "Pods for $100K+ accounts"
          ],
          [
            "Product and design",
            "1",
            "1",
            "Insights, the mobile app"
          ],
          [
            "Operations",
            "1",
            "0",
            "Finance systems, billing"
          ]
        ],
        note: "the Q1 column is the one to argue with"
      }
    ],
    [
      "raw",
      {
        build: signature.funnel,
        ...FUNNEL
      }
    ],
    [
      "section",
      {
        n: "22",
        kicker: "The process behind the number",
        title: "How twenty-two\nget hired",
        blurb: "Four stages, each with an owner and a clock. The funnel math only holds if every clock does.",
        art: "il-121-work-from-home-1",
        note: "a panel in one day, never across a week"
      }
    ],
    [
      "process",
      {
        eyebrow: "The process",
        title: "Stages, owners and time targets",
        steps: [
          [
            "Screen",
            "Recruiter, 30 minutes, within five days of applying. Owner: Talent."
          ],
          [
            "Panel",
            "Two hours in one day, never across a week. Owner: hiring manager."
          ],
          [
            "Decision",
            "Debrief within 24 hours, offer or no within 48. Owner: hiring manager."
          ],
          [
            "Close",
            "Offer to signature in seven days; a call from the exec sponsor for every senior role. Owner: People."
          ]
        ],
        note: "the 48-hour decision is the one we break most"
      }
    ],
    [
      "team",
      {
        eyebrow: "The owners",
        title: "Who is on the hook for what",
        people: [
          [
            "Dana Whitfield",
            "Head of People",
            "Owns the close: every offer out within 48 hours, signed within seven days."
          ],
          [
            "Marcus Obi",
            "VP Engineering",
            "Owns the ten engineering roles and the panel that runs in one day."
          ],
          [
            "Priya Raman",
            "VP Sales",
            "Owns the six territory hires and the enterprise pod, staffed by March."
          ],
          [
            "Elena Sato",
            "Head of Customer Success",
            "Owns the three pod hires and the interviewer hours from her leads."
          ]
        ],
        note: "if a date slips, one of these four says so first"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "Risks",
        title: "Comp bands, competing offers, and timing",
        cards: [
          [
            "coin",
            "Bands are behind the market",
            "Engineering bands are 8% under the latest survey. Ask: adjust in January, not after the first lost offer."
          ],
          [
            "alert-triangle",
            "Two competing offers per senior role",
            "Every platform candidate is talking to two others. Mitigation: seven-day close, and the sponsor call."
          ],
          [
            "clock",
            "Q1 starts in the quiet weeks",
            "Nobody changes jobs in early January. Sourcing starts in December or Q1 slips."
          ]
        ],
        note: "the band fix costs less than one lost offer"
      }
    ],
    [
      "closing",
      {
        title: "Referrals, hours, bands",
        subtitle: "Referrals for the six platform roles, four hours a week of interviewer time from every team lead, and the band adjustment approved in January.",
        rows: [
          [
            "mail",
            "dana@harborvale.example"
          ],
          [
            "world",
            "harborvale.example/careers"
          ],
          [
            "calendar",
            "Sourcing starts: 8 December"
          ]
        ],
        cta: "Refer someone",
        art: "la-flat-character-illustrations",
        note: "the first six names are the hard ones"
      }
    ]
  ]
};
