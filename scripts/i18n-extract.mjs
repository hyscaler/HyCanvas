// Externalize hard-coded UI strings into the localization catalog (F38 FR-9).
//
// The frontend carries roughly 1500 user-visible strings. Migrating them by
// hand is neither reliable nor reviewable, so this does the mechanical part and
// leaves the judgement to review: it rewrites plain JSX text nodes and the
// attributes assistive technology speaks into `t("key")` calls, and merges the
// English text into `frontend/src/locales/en.json`.
//
// It is deliberately CONSERVATIVE. Anything with an expression, nested markup,
// or an entity in it is skipped rather than guessed at, because a wrong rewrite
// here is a broken page. Skipped strings are reported so the remainder is a
// known quantity rather than a silent gap.
//
// Usage:
//   node scripts/i18n-extract.mjs <file|dir> [...]      apply
//   node scripts/i18n-extract.mjs --dry <file|dir> [...] report only
//
// Re-running is safe: already-migrated strings are `t("...")` calls and no
// longer match, and identical text in the same area reuses its existing key.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SRC = join(ROOT, "frontend", "src");
const CATALOG = join(SRC, "locales", "en.json");

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const targets = args.filter((a) => !a.startsWith("--"));
if (!targets.length) {
  console.error("usage: node scripts/i18n-extract.mjs [--dry] <file|dir> ...");
  process.exit(1);
}

// Spoken or shown to the user. The last two are this codebase's own component
// props (`<Card title description>`, `<Input label>`) and carry as much visible
// text as the native attributes do. Object literals using `label:` are not
// matched, because the pattern requires an `=`.
const ATTRS = [
  "aria-label", "title", "placeholder", "alt", "aria-description", "aria-roledescription",
  "label", "description",
];

/** Area prefix for keys, so a key reads as its own location. */
function areaOf(rel) {
  const m = rel.match(/^components\/([^/]+)\//);
  if (m && m[1] !== "ui") return m[1];
  if (rel.startsWith("components/ui/")) return "ui";
  if (rel.startsWith("pages/")) return "page";
  return "app";
}

function slug(text) {
  const s = text
    .toLowerCase()
    .replace(/[''']/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 44)
    .replace(/_+$/, "");
  return s || "text";
}

/**
 * Translatable text is text a person reads. Pure punctuation, bare numbers, and
 * anything carrying JSX syntax are not, and a rewrite of those is either
 * pointless or actively wrong.
 */
function translatable(text) {
  const t = text.trim();
  if (t.length < 2) return false;
  if (!/[A-Za-z]/.test(t)) return false; // numbers, symbols, separators
  if (/[{}<>&|]/.test(t)) return false; // expression or markup, not plain text
  // Code punctuation. A generic like `useState<Foo>(x)` puts real code between
  // a `>` and a `<`, and it was rewritten as if it were prose until these were
  // rejected. Quotes, semicolons, assignment and brackets never appear in a
  // plain JSX text node.
  if (/["'`;=[\]]/.test(t)) return false;
  if (/\?\?|=>|\+\+/.test(t)) return false;
  // An expression fragment between two tags, e.g. `) : manageable ? (` sitting
  // between a `</button>` and a `<button`. Prose does not begin with closing
  // punctuation, and " ? " / " : " with spaces around them is ternary syntax
  // rather than English (a real question mark has no space before it).
  if (/^[)(:?,&|+*/%.]/.test(t)) return false;
  if (/ \? | : /.test(t)) return false;
  if (/^[A-Z_]+$/.test(t)) return false; // SCREAMING_CASE constants
  if (/^https?:\/\//.test(t)) return false;
  if (!/[A-Za-z]{2}/.test(t)) return false; // single stray letters
  return true;
}

/**
 * JSX text nodes the rewrite pattern cannot see, because its run excludes the
 * five characters listed at the call site. Relaxed on exactly those five and
 * nothing else, and stricter about what counts as prose (two words, sentence
 * case), because this only has to be right enough to fail a build and point a
 * person at the line. Returns the offending text, never rewrites.
 */
function unseenProse(src) {
  const out = [];
  const re = /([^\s=!<>-]|\n[ \t]*)>(\s*)([^<>{}\n]+?)(\s*)</g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const t = m[3].trim();
    if (!/[;="'`]/.test(t)) continue; // the rewrite pass already covers these
    if (t.length < 6 || !/\s/.test(t) || !/^[A-Z]/.test(t)) continue;
    if (!/[A-Za-z]{2}/.test(t)) continue;
    if (/=>|\?\?|\+\+|===|!==/.test(t)) continue;
    if (/^(import|export|const|let|return|function)\b/.test(t)) continue;
    if (/\breturn\b|\btypeof\b|\bawait\b/.test(t)) continue;
    out.push(t);
  }
  return out;
}

/**
 * Ranges covered by comments, so prose in a comment is never mistaken for a
 * string the user reads. Quotes are tracked too, because a "//" inside a string
 * does not start a comment.
 */
function commentMask(src) {
  const mask = new Array(src.length).fill(false);
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") mask[i++] = true;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i);
      const stop = end === -1 ? src.length : end + 2;
      while (i < stop) mask[i++] = true;
      continue;
    }
    i++;
  }
  return mask;
}

/**
 * Is this offset inside a function body?
 *
 * A `tr()` call at MODULE scope is evaluated once at import, before any catalog
 * has loaded, and never again. It would be permanently English no matter what
 * language the user picks, and the bug is invisible in an English build. So the
 * expression pass only rewrites strings inside a function, and module-level
 * constant tables are left for a hand migration that moves the key to the
 * render site.
 */
function insideFunction(src, at) {
  const heads = [...src.slice(0, at).matchAll(/(?:^|\n)(?:export )?(?:default )?(?:async )?(?:const|let|var|function|class) /g)];
  if (!heads.length) return false;
  const head = src.slice(heads[heads.length - 1].index, at);
  return /=>|\bfunction\b|\)\s*\{/.test(head);
}

/** Prose a person reads, as opposed to an identifier, a path or a data value. */
function proseLiteral(v, singleWordOk = false) {
  if (v.length < 2 || v.length > 200) return false;
  if (!/^[A-Z]/.test(v)) return false;
  // A single word is usually an enum value ("Regular", "Primary"), so it needs
  // the caller to confirm the position renders it. "Save", "Play" and "Dark"
  // are labels and were being skipped wholesale before this.
  if (!/ /.test(v) && !singleWordOk) return false;
  if (!/ /.test(v) && v.length < 2) return false;
  if (!/^[A-Za-z0-9 ,.'’‘“”…()!?%:&+\/-]+$/.test(v)) return false;
  if (/^[A-Z0-9 _-]+$/.test(v)) return false; // SCREAMING CASE
  if (/\bhttps?:|\.(png|jpg|svg|json|ts|tsx|css)\b/.test(v)) return false;
  if (/^[A-Z]\d/.test(v)) return false; // SVG path data ("M50 94C30 ...")
  // `Region/City` with no spaces is an identifier, not prose. IANA timezone
  // ids reach `Intl` and the stored profile, so translating one breaks time
  // display outright.
  if (/^[A-Za-z_]+\/[A-Za-z_]+/.test(v) && !/ /.test(v)) return false;
  return true;
}

/**
 * Text sent to a MODEL, not shown to a person. Translating a system prompt
 * would change what the model is asked to do, which is a functional change
 * disguised as a localization one.
 */
function modelPromptField(before) {
  // Far more reliable than matching the wording: a value assigned to one of
  // these fields is an instruction to a model whatever it happens to say, and
  // "Shorten the following text" reads exactly like a UI label.
  return /\b(prompt|system|systemPrompt|userPrompt|instruction|instructions)\s*:\s*$/.test(before);
}

function modelPrompt(v) {
  return (
    /^(You are|Return ONLY|Respond|Output only|Given the|Rewrite|Summarize|Shorten|Expand|Reply with)\b/.test(v) ||
    /\b(no preamble|no explanation|no markdown|do not include|the following text)\b/i.test(v)
  );
}

/**
 * Positions where a capitalised SINGLE word is a discriminant rather than a
 * label: an enum value, a variant name, a node kind, or a SCHEMA value such
 * as `fontStyle: "Regular"`, which is written into the user's design file and
 * must never change with the interface language. Multi-word strings in
 * these positions are still treated as prose.
 */
const ENUMISH_BEFORE = /\b(value|kind|variant|type|mode|status|op|id|preset|format|align|position|side|placement|role|state|shape|[a-zA-Z]*[fF]ont[a-zA-Z]*|weight|family|easing|codec|mimeType|mime|unit|locale|currency)\s*[:=]\s*$/;

/**
 * Fields whose value is DATA whatever its shape: a font family ("Playfair
 * Display" is two words and still not prose), an easing curve, a mime type.
 * Unlike ENUMISH_BEFORE this rejects multi-word strings too.
 */
const DATA_FIELD_BEFORE = /\b([a-zA-Z]*[fF]ont[a-zA-Z]*|family|easing|codec|mimeType|mime|unit|locale|currency|timezone|tz|acronym|suffix)\s*[:=]\s*$/;

/** Positions where a string is data or markup, never a label. */
const EXPR_EXCLUDE_BEFORE =
  /(?:===|!==|==|!=|\bcase\b|\bfrom\b|\bimport\b|\b(?:className|style|href|src|id|type|role|key|name|accept|autoComplete|htmlFor|rel|target|method|encType|inputMode|pattern|data-[\w-]+)=|\b(?:getItem|setItem|removeItem|querySelector|querySelectorAll|getElementById|createElement|setAttribute|getAttribute|includes|startsWith|endsWith|matchMedia|addEventListener|removeEventListener)\(|console\.\w+\(|new Error\()\s*$/;

const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
/** Reverse index so identical text in an area reuses one key. */
const byAreaText = new Map();
for (const [k, v] of Object.entries(catalog)) byAreaText.set(`${k.split(".")[0]}\x1f${v}`, k);

function keyFor(area, text) {
  const memo = `${area}\x1f${text}`;
  const seen = byAreaText.get(memo);
  if (seen) return seen;
  const stem = `${area}.${slug(text)}`;
  let key = stem;
  let n = 2;
  while (key in catalog) key = `${stem}_${n++}`;
  catalog[key] = text;
  byAreaText.set(memo, key);
  return key;
}

function files(target) {
  const p = resolve(target);
  if (statSync(p).isFile()) return /\.tsx?$/.test(p) ? [p] : [];
  const out = [];
  for (const name of readdirSync(p)) {
    const child = join(p, name);
    if (statSync(child).isDirectory()) out.push(...files(child));
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(child);
  }
  return out;
}

let totalText = 0;
let totalAttr = 0;
let totalExpr = 0;
let totalUnseen = 0;
let skipped = 0;
const touched = [];

for (const file of targets.flatMap(files)) {
  const rel = relative(SRC, file);
  if (rel.includes(".test.")) continue;
  const area = areaOf(rel);
  const before = readFileSync(file, "utf8");
  let src = before;
  let nText = 0;
  let nAttr = 0;

  const isJsx = file.endsWith(".tsx");

  // Attributes first: they are unambiguous, being a quoted value on a known
  // attribute name.
  for (const attr of isJsx ? ATTRS : []) {
    const rx = new RegExp(`\\b${attr}="([^"\\n]+)"`, "g");
    src = src.replace(rx, (whole, text) => {
      if (!translatable(text)) {
        skipped++;
        return whole;
      }
      nAttr++;
      return `${attr}={tr(${JSON.stringify(keyFor(area, text.trim()))})}`;
    });
  }

  // JSX text nodes: a run of plain text between two tags. `translatable`
  // rejects anything containing JSX syntax, which is what keeps a comparison
  // like `a > b && <X/>` from being mistaken for text.
  // The text itself must be a SINGLE line: surrounding whitespace may wrap, but
  // content spanning a newline is code, not prose. That one constraint is what
  // separates `<p>\n  Hello\n</p>` from a pair of unrelated generics.
  // A tag close is either a non-space character (`</button>`) or a `>` alone on
  // its own line, which is how a tag with multi-line attributes ends. Requiring
  // the former only silently skipped the text of every such tag. A comparison
  // operator is never alone on a line, so this stays unambiguous.
  // The leading character must CLOSE A TAG. Without it, the `>` of an arrow
  // (`=> Partial<CharStyle>`) or of a comparison (`a > b`) reads as the end of
  // an element and the code after it as prose.
  if (isJsx) src = src.replace(/([^\s=!<>-]|\n[ \t]*)>(\s*)([^<>{}\n;="'`]+?)(\s*)</g, (whole, pre, lead, text, tail) => {
    if (!translatable(text)) {
      skipped++;
      return whole;
    }
    nText++;
    return `${pre}>${lead}{tr(${JSON.stringify(keyFor(area, text.trim()))})}${tail}<`;
  });

  // Expression pass: prose in ternaries, toasts, call arguments and object
  // fields, which the JSX passes cannot see because the string is not a text
  // node. Only inside a function body, and only where the surrounding syntax
  // says the string is a label rather than data.
  let nExpr = 0;
  {
    const mask = commentMask(src);
    // NOTE the character class: `[^"\\n]` would exclude the LETTER n, not a
    // newline, and silently skipped every string containing an "n" until it was
    // caught by counting what the pass left behind.
    const rx = /"([^"\n]{2,200})"/g; // 2, not 5: "On", "Off" and "Play" are labels
    let m;
    const edits = [];
    while ((m = rx.exec(src)) !== null) {
      if (mask[m.index]) continue;
      // Explicit opt-out for text that must stay exactly as authored: native
      // language names in a language picker, IANA ids, brand wordmarks.
      // Honoured on the line itself, the line above, or on the declaration
      // this string sits inside, so it covers a whole multi-line table.
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      const prevStart = src.lastIndexOf("\n", lineStart - 2) + 1;
      const lineEnd = src.indexOf("\n", m.index);
      if (src.slice(prevStart, lineEnd === -1 ? src.length : lineEnd).includes("i18n-ignore")) continue;
      // The nearest declaration INCLUDING indented ones, so a marked local
      // (`const system = [...]` inside a function) shields its whole literal.
      const heads = [...src.slice(0, m.index).matchAll(/(?:^|\n)[ \t]*(?:export )?(?:default )?(?:async )?(?:const|let|var|function|class) /g)];
      if (heads.length) {
        const at = heads[heads.length - 1].index;
        const declLineStart = src.lastIndexOf("\n", at) + 1;
        const declPrevStart = src.lastIndexOf("\n", declLineStart - 2) + 1;
        const declLineEnd = src.indexOf("\n", at + 1);
        if (src.slice(declPrevStart, declLineEnd === -1 ? src.length : declLineEnd).includes("i18n-ignore")) continue;
      }
      const value = m[1];
      const singleWordOk = !ENUMISH_BEFORE.test(src.slice(Math.max(0, m.index - 60), m.index));
      if (!proseLiteral(value, singleWordOk) || modelPrompt(value)) continue;
      const before = src.slice(Math.max(0, m.index - 90), m.index);
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 2);
      if (EXPR_EXCLUDE_BEFORE.test(before) || modelPromptField(before) || DATA_FIELD_BEFORE.test(before)) continue;
      // The second argument of new CodedError(code, message) is the ENGLISH
      // log message; the code is what gets translated, at the display
      // boundary. Externalizing the message would translate the logs.
      if (/new CodedError\("[^"]*",\s*$/.test(before)) continue;
      // `this.name = "CodedError"` and friends: an assignment to a .name
      // property is an identity, not a label. (An object literal's `name:`
      // field is unaffected - that is a colon, not an equals.)
      if (/\.name\s*=\s*$/.test(before)) continue;
      // An object KEY, not a value. A ternary's FIRST branch is also followed
      // by a colon (`dark ? "Light mode" : "Dark mode"`), and reading that as a
      // key left one arm of every two-state label untranslated, so a trailing
      // `?` means this is a branch rather than a key.
      if (/^\s*:/.test(after) && !/\?\s*$/.test(before)) continue;
      if (!insideFunction(src, m.index)) continue;
      edits.push([m.index, m[0].length, value]);
    }
    for (let i = edits.length - 1; i >= 0; i--) {
      const [at, len, value] = edits[i];
      const call = `tr(${JSON.stringify(keyFor(area, value.trim()))})`;
      // A JSX ATTRIBUTE value needs braces: `tooltip="x"` becomes
      // `tooltip={tr("k")}`, not `tooltip=tr("k")`, which is a syntax error.
      // This catches attributes the named list above does not know about.
      const isJsxAttr = /(?:^|\s)[\w-]+=$/.test(src.slice(Math.max(0, at - 40), at));
      src = src.slice(0, at) + (isJsxAttr ? `{${call}}` : call) + src.slice(at + len);
      nExpr++;
    }
  }

  // Detection only, never a rewrite, and it MUST run before the early exit
  // below: every clean file leaves there, so a detection pass placed after it
  // would silently never run (it did, until a mutation test caught it).
  //
  // The text-node pattern above excludes ; = " ' and a backtick from the run
  // itself, on the stated reasoning that those "never appear in a plain JSX
  // text node". That is false for prose: English UI text uses semicolons and
  // apostrophes, and EVERY HTML entity ends in ";". Such a node never matched,
  // so it was not even counted as skipped, and this tool reported a clean run
  // over strings it had never examined (26 of them, found August 2026).
  // Widening the REWRITE is not worth the risk of a bad automated edit across
  // hundreds of files, so these are reported and fixed by hand; reporting them
  // is what makes the ratchet in i18n.catalog.test.ts honest rather than green.
  if (isJsx) {
    const unseen = unseenProse(src);
    totalUnseen += unseen.length;
    for (const t of unseen) console.log(`  ${rel}: UNSEEN ${JSON.stringify(t)}`);
  }

  if (nText + nAttr + nExpr === 0) continue;

  // Import `tr` once, after the last top-level import so a multi-line import
  // is never split down the middle.
  if (!/from "@\/lib\/i18n"/.test(src)) {
    const lines = src.split("\n");
    let last = -1;
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (depth === 0 && /^import\b/.test(l)) {
        depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
        if (depth === 0) last = i;
      } else if (depth > 0) {
        depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
        if (depth === 0) last = i;
      }
    }
    lines.splice(last + 1, 0, 'import { tr } from "@/lib/i18n";');
    src = lines.join("\n");
  }

  totalText += nText;
  totalAttr += nAttr;
  totalExpr += nExpr;
  touched.push(`${rel}: ${nText} text, ${nAttr} attributes, ${nExpr} expressions`);
  if (!dry) writeFileSync(file, src);
}

if (!dry) {
  const sorted = Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(CATALOG, JSON.stringify(sorted, null, 2) + "\n");
}

for (const line of touched) console.log("  " + line);
console.log(
  `${dry ? "[dry] " : ""}${totalText} text nodes + ${totalAttr} attributes + ${totalExpr} expressions + ${
    totalUnseen
  } unseen -> ${Object.keys(catalog).length} catalog keys across ${touched.length} files (${skipped} non-translatable skipped)`,
);
