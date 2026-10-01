# Authoring a presentation template on the kit library

This is the reference for anyone (a person or an agent) giving one deck in `scripts/topics/` or one slide in `scripts/singles/` a look and a signature of its own. The library is `scripts/lib/deck-kit.mjs`; read it once, it is the source of truth for everything below.

## What makes a deck read as finished

Every deck follows these, and yours must too:

- Two grounds, and a rhythm between them: a deep gradient ground for the cover, sections, the quote and the closing; a light ground for reading. A dark deck's paper is dark too, one shade lighter than deep.
- One grid, held everywhere: 96 px margin, the eyebrow, title and footer on fixed baselines. The layouts do this for you; a raw slide must respect it.
- Depth by layering on the deep pages: gradient, an ornament, sparkle, a halo, the drawing.
- Light the subject: a halo (two soft discs) behind every hero drawing.
- Sparkle as texture, only where no text sits.
- Several voices of type, each with one job: a display face, a body face, one accent face for the kicker and the hand notes, optionally a mono for labels.
- A warm accent on a cool ground, or the reverse. Two accents at most, plus one reserved colour if the look defines `sun` or `lime`.
- Cards whose chrome carries information: the colour bar and the icon tint mean something.
- Real, specific copy. Short titles, big boxes. Numbering only where order exists.
- No empty slot: every picture slot carries a drawing, every portrait circle a peep.
- One bold move per slide.

A single slide (`scripts/singles/`) is exactly one slide: the plan's `slides` has one entry, a raw slide or one layout with the look's identity on it. It never grows into a deck; a user inserts it into a deck of their own.

## The plan file

`scripts/topics/<id>.mjs` (or `scripts/singles/<id>.mjs`) exports one object:

```js
export default {
  id: "deck-sales-qbr",
  title: "Sales QBR",
  base: "atlas",              // the library look to start from: atlas, vanta, folio, pulse, terra, slate
  rank: 32,                    // gallery order; lower leads. Keep the value you were given.
  tags: [...],
  meta: { company, deck, kicker, farewell, art: { cover, section, picture, closing } },
  look: { ... },               // overrides on the base look, see below. This is where the deck's identity lives.
  signature: { name: (K, i) => ({ page, fill }) },   // optional raw slide builders
  slides: [ [layoutName, content], ... ],
};
```

`slides` is an ordered list of `[layout, content]`. Content is per layout (below); every field has the library's sample as its default, so leave out what you do not need. A raw slide is `["raw", { build: signature.name }]`.

## The look

A look is one object; `look` in the plan overrides any part of the base (palettes, faces, ornament, art, peeps, scale are each merged shallowly). A palette override that sets its own `accent` starts clean: the base's `accentInk`, `accent2Ink`, `sun` and `lime` do not carry over unless you set them. Fields:

```js
{
  display: "Playfair Display", dw: 700,     // display face and weight (titles, numerals)
  body: "Source Sans 3", bw: 400,           // reading face and weight
  mono: null,                               // optional mono for eyebrows, meta and labels (null = use body)
  accentFace: "Cormorant Garamond", accentWeight: 600, accentSize: 40,   // the kicker and hand notes
  numeralFace: "JetBrains Mono", numeralWeight: 700,                      // optional: every figure (figures, chart calls, big stat, agenda numbers) in this face
  charWidth: 0.48,                                                        // optional: average em per character of the display face, for fitting titles (0.56 default; a condensed face is near 0.45, a wide one near 0.62)
  strongWeight: 700,                                                      // optional: the weight of strong body text (600 default; set it for a body face without a 600)
  paper: { bg, ink, muted, line, panel, panel2, accent, accent2, accentInk?, accent2Ink?, sun?, lime? },
  deep:  { bg, bg2, ink, muted, line, panel, panel2, accent, accent2, accentInk?, accent2Ink?, sun?, lime? },
  radius: 8,                                // corner radius of cards and buttons (0 for editorial)
  ornament: "rules",                        // the signature mark, see the vocabulary
  watermark: "&",                           // only for ornament "watermark"
  art: { cover, section, picture, closing },// drawing ids, see scripts/lib/drawings.txt
  peeps: ["op-peep-84", ...],               // five portrait ids for team and quote slots
  scale: { cover: 116, title: 62, section: 236, statement: 80, numeral: 104, quote: 54 },
}
```

Palette rules:
- `bg` and `bg2` on `deep` are the gradient; `bg2` is the darker end.
- `ink` must read on `bg` and on `panel`; `muted` is a softer ink; `line` is a hairline on the ground.
- `accent` is used for rules, icons, numerals and the kicker. If it does not read as text on its ground (a saturated coral on cobalt vibrates; a bright gold on cream is too light), set `accentInk` on that ground to a darker or calmer sibling; the library uses it for every text in the accent colour, including the small delta pills and role labels. `accent2Ink` does the same for `accent2`, which the figures and team layouts use for every second card.
- Buttons and pills pick their ink by the fill's luminance; you do not choose it.
- Fonts must exist in the catalog (`packages/text/src/font-catalog.generated.ts`); grep `family: "Name"`.
- Check contrast yourself: ink on bg, ink on panel, accent on bg, deep.ink on deep.bg. Keep body text above 4.5:1.

Ornament vocabulary (`ornament`), each with a deep-page and a reading-page form:
- `rules`: an inset hairline frame in the accent, and sparkle. Corporate, quiet.
- `glow`: two radial glows in the accents, a faint grid, sparkle in both accents. Dark tech.
- `hairlines`: a rule top and bottom, a sun disc top right, a small accent square. Editorial. The cover becomes centered with the drawing above the title.
- `blocks`: no marks; the cover and closing get a solid accent block with confetti and a big disc; sections get a left block with the numeral. Bold.
- `blobs`: large soft discs in the accents and `sun`, sparkle. Warm, organic.
- `crosshairs`: registration crosses in the corners, a radial glow. Minimal.
- `watermark`: one enormous glyph (`watermark`) in a tint of the ground, bottom right, and a top rule. Editorial monogram.
- `sun`: a sun disc top right and sparkle in `sun`. Warm, main street.
- `ridges`: soft ridgelines along the bottom, a moon, two layers of stars. Outdoors, evening.
- `arcs`: concentric rings off the top right corner. Technical, calm.
- `dots`: a dot grid over the right third. Engineering, data.
- `stripes`: three diagonal bands in tints of the accent. Sport, speed, events.
- `orbs`: floating discs in the two accents. Playful, product.
- `corner`: one accent triangle in the top right corner (from (1460, 0) to (1920, 460) on a deep page, (1620, 0) to (1920, 300) on paper). Bold, brief. The cover and closing drawings overlap its lower edge a little, by design.

`sun` and `lime` on a palette are used by the ornaments that name them (hairlines, blobs, sun use `sun`; blocks uses `lime` for confetti) and by your raw slides; other ornaments ignore them.

Drawings on a deep ground: the `od-*` line figures are drawn in black and vanish on a dark ground; use them only on paper slides (the picture, checklist and facts slots) or pick an `il-*` or `la-*` drawing for the cover, section and closing. Some `il-*` scenes draw their outlines in dark ink too (a city road, a van), and some carry their pack title as lettering inside the scene (app development, programming, UI/UX); check a deep render before keeping one there. `art()` applies `cleanCard` to every `il-*` drawing, which strips the pack's card and any scene element toned like it; pass `art(id, x, y, w, h, { cleanCard: false })` when a scene loses its mountains or sun.

## Layouts and their content

Every layout takes `note` (a hand note in the accent face: bottom right on a reading page, under the picture on a deep page; a note over about forty characters wraps to two lines, longer than that is cut off, so keep notes short). Deep layouts take `art` (a drawing id) where noted. `[a, b, c]` means an array of those.

- `cover` `{ title (two lines with \n), subtitle (grows to three lines), presenter (or presenterName and when, joined for you), art, chips [[figure, label]] (three chips under the subtitle: on by default for the glow ornament, on for any ornament when you pass them), year (blocks only), presenterName, when, where (hairlines only), note }`
- `agenda` `{ eyebrow, title, items [[heading, sub, duration]] (five), card { eyebrow, big, meta [[label, value]] (four) }, note }`
- `section` `{ n (the big numeral; pass "" to omit it when the deck has one section), title, blurb, kicker, art, wide (true for a landscape drawing in a 640 by 400 slot), note }`
- `statement` `{ text (one sentence, up to three lines), source, note }`
- `textPicture` `{ eyebrow, title, points [[heading, sub]] (three), art, note }`
- `twoColumns` `{ eyebrow, title, left { eyebrow, head, lines [3], icon }, right { ... } }` (right sits on the deep ground)
- `threeCards` `{ eyebrow, title, cards [[icon, heading, body]] (three), note }`
- `fourCards` `{ eyebrow, title, cards [[icon, heading, line]] (four), note }`
- `figures` `{ eyebrow, title, stats [[figure, label, delta, note]] (four), note }`
- `chart` `{ eyebrow, title, takeaway, chartType ("bar" | "barGrouped" | "line"), categories [..], series [{ name, values [..] }] (one or two), calls [[figure, label]] (three), note }`
- `timeline` `{ eyebrow, title, done (how many steps are complete), steps [[label, heading, body]] (four), note }`
- `process` `{ eyebrow, title, steps [[heading, body]] (four), note }`
- `schedule` `{ eyebrow, title, slots [[time, heading, sub]] (six), after { eyebrow, head (two lines), note }, art }`
- `checklist` `{ eyebrow, title, items [[label, must]] (eight), legend [must, nice], art, note }`
- `facts` `{ eyebrow, title, intro, items [[icon, heading, sub]] (four), art, note }`
- `split` `{ left { eyebrow, head (three lines), lines [3] }, right { eyebrow, head (two lines), body, checks [[icon, line]] (three) }, art }`
- `table` `{ eyebrow, title, cols ["", a, b, c], rows [[label, a, b, c]] (five); a cell "yes" or "no" draws a check or a circle; a cell longer than its column wraps to two smaller lines, note }`
- `team` `{ eyebrow, title, people [[name, role, bio]] (four), peeps [ids], note }`
- `quote` `{ text, name, role, note }` (the page is named "Quote"; pass `pageName` on any slide to rename its page)
- `pricing` `{ eyebrow, title, tiers [[name, price, per, [features x4], hot]] (three), hotLabel, hotCta, ctaPrefix, note }`
- `bigStat` `{ eyebrow, value, caption, delta }`
- `columns` `{ eyebrow, title, intro, cols [[head, sub, [[item, line]] x3]] (three), note }`
- `closing` `{ title, subtitle, rows [[icon, text]] (three), cta, art, note }`
- `raw` `{ build: (K, i, content) => ({ page: { name, bg, nodes, illustrations }, fill }), ...anything else the builder wants }` (the builder receives the whole content object, so copy and notes can live in the plan rather than in the builder)

Icons: any key of `ICON_GLYPHS` in `packages/aistudio/dist/iconset.js` (Tabler names such as `flag`, `shield`, `sparkles`, `coin`, `user`, `calendar`, `mail`, `world`, `phone`, `message`, `clock`, `bolt`, `chart-pie`, `database`, `lock`, `heart`, `trophy`, `map-pin`, `bulb`, `flame`, `flask`, `compass`, `truck`, `key`, `briefcase`, `microphone`, `device-mobile`, `home`, `sun`, `bed`, `circle-check`, `circle`, `alert-triangle`). `users` does not exist; use `user`.

## Raw slides

A raw slide is a page object built with the library's primitives, for the one or two slides only this deck has. Import from the library: `text, rect, ellipse, button, icon, art, path, halo, sparkles, note, footer, mark, chrome, card, type, deepGround, mixHex, inkOn, W, H, M, CW`. The builder receives `K` (the look with meta merged and `K.total` set), the page index `i`, and its content object.

`path(points, { stroke, strokeWidth, fill, closed, cap, join })` draws a line or a region from points in page space (a dash pattern is stored but neither renderer draws it, so a dashed or dotted line is a row of short rects or small ellipses): `[[x, y], ...]` for straight segments, or `{ x, y, cIn: {x, y}, cOut: {x, y} }` for curves (cubic handles). Use it for a curve, an arrow, a connector or a chart line instead of a trail of ellipses; a rotated thin `rect` is still fine for a straight rule.

The deep-page note sits at (1140, 872) by default; a raw slide that fills the bottom right passes its own spot: `note(K, g, str, true, { x, y, w, align })`.

Rules for a raw slide:
- Page is 1920 by 1080; margin `M` is 96; content width `CW` is 1728. Nothing outside the page unless it declares `bleed: true`.
- On a reading page, start from `chrome(K, K.paper, i, eyebrow, title)` (it returns `{ nodes, bodyTop }` with the ornament, eyebrow, title and footer in place) and add below `bodyTop`.
- On a deep page, start with `...ornamentDeep(K, K.deep)` and end with `...footer(K, K.deep, i)`; use `deepGround(K.deep)` as `bg`.
- Type roles come from `type(K, g)`: `display(size)`, `body(size)`, `strong(size)`, `eyebrow()`, `meta()`, `numeral(size)`, `kicker()`.
- Text boxes must be tall enough for their lines: height about `size * 1.1 * lines`. Estimate width as `chars * size * charWidth` (0.56 unless the look sets `charWidth`); the body face has its own width, near 0.52 for most sans faces, so estimate body lines with that rather than a condensed display's.
- A text may be struck through (`strike: true`) or underlined (`underline: true`); use a struck figure for a "before" value rather than a rect drawn over it.
- Picture slots are shapes (`photo(...)` or a `rect`/`ellipse` named "Photo"), never frames; put the drawing on top with `illustrations: [art(id, x, y, w, h)]`.
- Fillable fields are `{ node: <index into nodes>, label, hint }`; a button's label is `<index>-label`.

## Drawings

`scripts/lib/drawings.txt` lists every bundled drawing with its compiled size. Choose for the subject of the slide, not the deck. Prefer under 150 KB; never over 300 KB. `il-*` are flat colourful objects and scenes, `la-*` flat characters and scenes, `od-*` two-tone line figures, `op-*` portrait busts (use only for `peeps`).

## The loop

Work on one deck. Do not edit the library, other decks, the compiler or the seed. Use a scratch directory of your own under the session scratchpad, named after your deck.

```sh
node scripts/gen-topic-decks.mjs --only <id>          # or gen-single-slides.mjs --only <id>
mkdir -p $SCR/specs $SCR/png && cp scripts/templates/<id>.json $SCR/specs/
TEMPLATE_SPECS=$SCR/specs TEMPLATE_SEED=$SCR/seed.json node scripts/build-templates.mjs
(cd backend && go run ./cmd/render-templates -seed $SCR/seed.json -out $SCR/png -edge 640)
```

Then assemble the PNGs into one contact sheet (Python with PIL is available) and look at it with the Read tool. The renderer draws every face as one wide fallback sans, so a condensed display face (Anton, Barlow Condensed, Oswald) shows its titles wrapping on the sheet when they would fit in the real face; when the look sets `charWidth` below 0.5, judge such a wrap by the estimate, not the sheet, and confirm nothing else overlaps. Fix what it shows: text running into text, a title wrapping into a subtitle, a drawing over text, a colour that does not read, an empty slot. Render again. Stop when a sheet shows nothing wrong; two or three rounds is normal. The renderer uses a fallback font, so judge layout and colour, not typography.

Keep the compiled file under 1.2 MB (`wc -c scripts/templates/<id>.json`).

## What a finished deck has

1. Its own look: a palette pair and faces chosen for the subject, a distinct ornament, and `accentInk` where the accent would vibrate as text.
2. One signature slide (a raw slide) that could not belong to another deck.
3. Drawings chosen per slide for the subject of that slide, and a portrait set.
4. A hand note on most reading slides and on the cover or closing, in the deck's voice; the kicker on section pages.
5. Six to ten slides in an order that follows the reader's questions, opening with the cover and ending with one action.
6. A clean contact sheet.
