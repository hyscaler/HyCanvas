// Bidirectional text ordering (F38 FR-10).
//
// The open format has carried `ParagraphStyle.direction` ("ltr" | "rtl" |
// "auto") since the text model was written, and nothing ever read it: the
// layout engine laid every paragraph out left to right. For a single run of
// Arabic or Hebrew the browser's own text drawing hid the problem, but a
// paragraph made of several style runs (the normal case the moment anything is
// bolded or coloured) came out with its runs in the wrong order, and every RTL
// paragraph was left-aligned.
//
// This implements the ordering half of the Unicode Bidirectional Algorithm
// (UAX #9): resolve a paragraph's base direction, assign an embedding level to
// each character, and reorder a line's runs into display order. Shaping (the
// joining behaviour of Arabic letterforms) is the renderer's job and is
// handled by the browser for the Canvas2D path.
//
// Deliberately NOT implemented, and documented rather than pretended:
//   - Explicit embedding and override codes (LRE/RLE/LRO/RLO/PDF) and the
//     isolate codes (LRI/RLI/FSI/PDI). These are rare in authored design text
//     and each needs the full stack machine from UAX #9 X1 to X8.
//   - The paired-bracket algorithm (BD16/N0), so a bracket enclosing text of
//     the opposite direction can resolve to the surrounding level rather than
//     the enclosed one.
// Both degrade to plausible ordering rather than to garbage, and neither
// affects the common Arabic, Hebrew, or mixed-with-Latin-and-digits cases.

/** The bidirectional character types this subset distinguishes. */
type BidiClass = "L" | "R" | "AL" | "EN" | "AN" | "ES" | "ET" | "CS" | "NSM" | "B" | "S" | "WS" | "ON";

/** Ranges are checked in order; the first match wins. Kept as explicit code
 *  point ranges so this file has no data dependency and no build step. */
function bidiClass(cp: number): BidiClass {
  // Hebrew, Arabic, Syriac, Thaana, N'Ko, Samaritan and their presentation forms.
  if (cp >= 0x0590 && cp <= 0x05ff) return "R"; // Hebrew
  if (cp >= 0x0600 && cp <= 0x07bf) {
    if (cp >= 0x0660 && cp <= 0x0669) return "AN"; // Arabic-Indic digits
    if (cp >= 0x066b && cp <= 0x066c) return "AN"; // Arabic decimal/thousands separator
    if (cp >= 0x06f0 && cp <= 0x06f9) return "EN"; // Extended Arabic-Indic digits
    if (cp >= 0x0610 && cp <= 0x061a) return "NSM";
    if (cp >= 0x064b && cp <= 0x065f) return "NSM";
    if (cp === 0x0670) return "NSM";
    if (cp >= 0x06d6 && cp <= 0x06dc) return "NSM";
    if (cp >= 0x06df && cp <= 0x06e4) return "NSM";
    return "AL";
  }
  if (cp >= 0x0700 && cp <= 0x085f) return "R"; // Syriac, Thaana, N'Ko, Samaritan, Mandaic
  if (cp >= 0xfb1d && cp <= 0xfb4f) return "R"; // Hebrew presentation forms
  if (cp >= 0xfb50 && cp <= 0xfdff) return "AL"; // Arabic presentation forms A
  if (cp >= 0xfe70 && cp <= 0xfeff) return "AL"; // Arabic presentation forms B

  if (cp >= 0x0030 && cp <= 0x0039) return "EN"; // ASCII digits
  if (cp === 0x002b || cp === 0x002d) return "ES"; // plus, hyphen-minus
  if (cp === 0x0023 || cp === 0x0024 || cp === 0x0025) return "ET"; // # $ %
  if (cp >= 0x00a2 && cp <= 0x00a5) return "ET"; // currency signs
  if (cp === 0x002c || cp === 0x002e || cp === 0x003a || cp === 0x002f) return "CS"; // , . : /

  if (cp === 0x000a || cp === 0x000d || cp === 0x001c || cp === 0x001d || cp === 0x001e || cp === 0x0085) return "B";
  if (cp === 0x0009 || cp === 0x000b || cp === 0x001f) return "S";
  if (cp === 0x0020 || cp === 0x000c || cp === 0x2028 || cp === 0x2029) return "WS";
  if (cp >= 0x3000 && cp <= 0x3000) return "WS";

  // Combining marks that are not Arabic-specific.
  if (cp >= 0x0300 && cp <= 0x036f) return "NSM";
  if (cp >= 0x20d0 && cp <= 0x20ff) return "NSM";

  // Latin, Greek, Cyrillic, CJK, Indic and everything else with a strong
  // left-to-right identity. Punctuation and symbols fall through to ON.
  if (cp >= 0x0041 && cp <= 0x005a) return "L";
  if (cp >= 0x0061 && cp <= 0x007a) return "L";
  if (cp >= 0x00c0 && cp <= 0x058f) return "L"; // Latin-1 supplement through Armenian
  if (cp >= 0x0900 && cp <= 0x1fff) return "L"; // Indic, SE Asian, Georgian, Greek ext
  if (cp >= 0x2c00 && cp <= 0xd7ff) return "L"; // Coptic through Hangul
  if (cp >= 0xf900 && cp <= 0xfaff) return "L"; // CJK compatibility
  if (cp >= 0x10000) return "L"; // supplementary planes, minus the RTL blocks below

  return "ON";
}

/** True for the strong right-to-left classes. */
function isStrongRtl(c: BidiClass): boolean {
  return c === "R" || c === "AL";
}

/**
 * Resolve a paragraph's base direction (UAX #9 P2 and P3). "auto" takes the
 * direction of the first strong character, defaulting to left-to-right when
 * there is none, which is what an empty or digits-only paragraph should do.
 */
export function resolveBaseDirection(text: string, declared: "ltr" | "rtl" | "auto" = "auto"): "ltr" | "rtl" {
  if (declared === "ltr" || declared === "rtl") return declared;
  for (const ch of text) {
    const c = bidiClass(ch.codePointAt(0) as number);
    if (c === "L") return "ltr";
    if (isStrongRtl(c)) return "rtl";
  }
  return "ltr";
}

/**
 * Embedding level per character of a single line, following the resolution
 * rules of UAX #9 (W1 to W7, N1 and N2, I1 and I2) for the subset described in
 * the file header. Returns one level per code UNIT so callers can slice the
 * original string directly; a surrogate pair carries the same level twice.
 */
export function resolveLevels(text: string, base: "ltr" | "rtl"): number[] {
  const baseLevel = base === "rtl" ? 1 : 0;
  const cps: number[] = [];
  const unitsPer: number[] = [];
  for (const ch of text) {
    cps.push(ch.codePointAt(0) as number);
    unitsPer.push(ch.length);
  }
  const n = cps.length;
  const cls: BidiClass[] = cps.map(bidiClass);

  // W1: a non-spacing mark takes the class of the previous character.
  for (let i = 0; i < n; i++) {
    if (cls[i] === "NSM") cls[i] = i === 0 ? (base === "rtl" ? "R" : "L") : cls[i - 1];
  }
  // W2: EN becomes AN when the last strong class was Arabic.
  let lastStrong: BidiClass = base === "rtl" ? "R" : "L";
  for (let i = 0; i < n; i++) {
    const c = cls[i];
    if (c === "L" || c === "R" || c === "AL") lastStrong = c;
    else if (c === "EN" && lastStrong === "AL") cls[i] = "AN";
  }
  // W3: AL is just R from here on.
  for (let i = 0; i < n; i++) if (cls[i] === "AL") cls[i] = "R";
  // W4: a single separator between two numbers of the same kind joins them.
  for (let i = 1; i < n - 1; i++) {
    if (cls[i] === "ES" && cls[i - 1] === "EN" && cls[i + 1] === "EN") cls[i] = "EN";
    if (cls[i] === "CS" && cls[i - 1] === "EN" && cls[i + 1] === "EN") cls[i] = "EN";
    if (cls[i] === "CS" && cls[i - 1] === "AN" && cls[i + 1] === "AN") cls[i] = "AN";
  }
  // W5: a run of European terminators adjacent to European numbers becomes EN.
  for (let i = 0; i < n; i++) {
    if (cls[i] !== "ET") continue;
    let j = i;
    while (j < n && cls[j] === "ET") j++;
    const before = i > 0 && cls[i - 1] === "EN";
    const after = j < n && cls[j] === "EN";
    if (before || after) for (let k = i; k < j; k++) cls[k] = "EN";
    i = j - 1;
  }
  // W6: remaining separators and terminators are neutral.
  for (let i = 0; i < n; i++) if (cls[i] === "ES" || cls[i] === "ET" || cls[i] === "CS") cls[i] = "ON";
  // W7: EN becomes L when the last strong class was L.
  lastStrong = base === "rtl" ? "R" : "L";
  for (let i = 0; i < n; i++) {
    const c = cls[i];
    if (c === "L" || c === "R") lastStrong = c;
    else if (c === "EN" && lastStrong === "L") cls[i] = "L";
  }
  // N1 and N2: a neutral run takes the surrounding direction when both sides
  // agree, and the base direction otherwise. Numbers count as R for this.
  const dirOf = (c: BidiClass): "L" | "R" | null =>
    c === "L" ? "L" : c === "R" || c === "EN" || c === "AN" ? "R" : null;
  for (let i = 0; i < n; i++) {
    if (dirOf(cls[i]) !== null) continue;
    let j = i;
    while (j < n && dirOf(cls[j]) === null) j++;
    const before = i > 0 ? dirOf(cls[i - 1]) : base === "rtl" ? "R" : "L";
    const after = j < n ? dirOf(cls[j]) : base === "rtl" ? "R" : "L";
    const take = before === after && before !== null ? before : base === "rtl" ? "R" : "L";
    for (let k = i; k < j; k++) cls[k] = take;
    i = j - 1;
  }
  // I1 and I2: levels from the resolved classes.
  const levels: number[] = new Array(n).fill(baseLevel);
  for (let i = 0; i < n; i++) {
    const c = cls[i];
    if (baseLevel === 0) {
      if (c === "R") levels[i] = 1;
      else if (c === "EN" || c === "AN") levels[i] = 2;
    } else {
      if (c === "L" || c === "EN" || c === "AN") levels[i] = 2;
    }
  }
  // Expand to code units so callers can index the original string.
  const out: number[] = [];
  for (let i = 0; i < n; i++) for (let u = 0; u < unitsPer[i]; u++) out.push(levels[i]);
  return out;
}

/** A run of text sharing one embedding level, in logical order. */
export interface BidiRun {
  /** Index into the source string (code units). */
  start: number;
  end: number;
  level: number;
}

/** Split a line into level runs, then reorder them for display (UAX #9 L2:
 *  reverse each maximal run of levels at or above each level, highest first). */
export function reorderRuns(levels: number[]): BidiRun[] {
  const runs: BidiRun[] = [];
  for (let i = 0; i < levels.length; ) {
    let j = i;
    while (j < levels.length && levels[j] === levels[i]) j++;
    runs.push({ start: i, end: j, level: levels[i] });
    i = j;
  }
  if (runs.length === 0) return runs;
  let highest = 0;
  let lowestOdd = Number.MAX_SAFE_INTEGER;
  for (const r of runs) {
    if (r.level > highest) highest = r.level;
    if (r.level % 2 === 1 && r.level < lowestOdd) lowestOdd = r.level;
  }
  for (let lvl = highest; lvl >= lowestOdd && lvl > 0; lvl--) {
    for (let i = 0; i < runs.length; i++) {
      if (runs[i].level < lvl) continue;
      let j = i;
      while (j < runs.length && runs[j].level >= lvl) j++;
      const slice = runs.slice(i, j).reverse();
      runs.splice(i, j - i, ...slice);
      i = j - 1;
    }
  }
  return runs;
}

/** A piece of a line to be drawn, carrying which source item it came from. */
export interface OrderedPiece<T> {
  /** The item (style run) this piece belongs to. */
  item: T;
  /** The substring to draw, already in logical order within the piece. */
  text: string;
  /** Even is left-to-right, odd is right-to-left. */
  level: number;
}

/**
 * Reorder a line's style runs into display order.
 *
 * The renderer draws each returned piece left to right at increasing x, so the
 * bidi ordering lives here rather than in every renderer. Within a piece the
 * text is left in logical order, because the text drawing API (Canvas2D
 * `fillText`, and the same for the headless path) applies the character-level
 * ordering and Arabic shaping itself for a single homogeneous run.
 */
export function orderLinePieces<T extends { text: string }>(
  items: T[],
  base: "ltr" | "rtl",
): OrderedPiece<T>[] {
  if (items.length === 0) return [];
  const full = items.map((i) => i.text).join("");
  if (base === "ltr" && !hasRtl(full)) {
    // Fast path: nothing to reorder, and the overwhelmingly common case.
    return items.map((item) => ({ item, text: item.text, level: 0 }));
  }
  const levels = resolveLevels(full, base);
  const runs = reorderRuns(levels);
  // Map source offsets back to items.
  const bounds: { item: T; start: number; end: number }[] = [];
  let at = 0;
  for (const item of items) {
    bounds.push({ item, start: at, end: at + item.text.length });
    at += item.text.length;
  }
  const out: OrderedPiece<T>[] = [];
  for (const run of runs) {
    // A level run can span several style runs; emit one piece per overlap so
    // each piece keeps a single style.
    for (const b of bounds) {
      const s = Math.max(run.start, b.start);
      const e = Math.min(run.end, b.end);
      if (s >= e) continue;
      out.push({ item: b.item, text: full.slice(s, e), level: run.level });
    }
  }
  // Within a right-to-left level run the style pieces themselves must also be
  // visited in reverse, because the run was reversed as a whole above.
  const merged: OrderedPiece<T>[] = [];
  for (let i = 0; i < out.length; ) {
    let j = i;
    while (j < out.length && out[j].level === out[i].level) j++;
    const slice = out.slice(i, j);
    merged.push(...(out[i].level % 2 === 1 ? slice.reverse() : slice));
    i = j;
  }
  return merged;
}

/** Does this text contain any strong right-to-left character? */
export function hasRtl(text: string): boolean {
  for (const ch of text) {
    if (isStrongRtl(bidiClass(ch.codePointAt(0) as number))) return true;
  }
  return false;
}
