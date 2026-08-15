// Make module-scope UI tables translatable (F38 FR-9).
//
// A `tr()` call at module scope is evaluated once at import, before any catalog
// has loaded, and never again: it would render English whatever language the
// user picks, and an English build cannot show the bug. So the extractor
// refuses to touch module-scope strings, which left every constant table of
// labels, menu items, shortcuts and presets permanently untranslated.
//
// This converts an eligible table from a constant into a function returning the
// same value, so its strings are evaluated at RENDER time and the extractor can
// then externalize them normally.
//
//   const TABS = [{ label: "Account" }]      ->  const tabs = () => [{ label: "Account" }]
//   TABS.map(...)                            ->  tabs().map(...)
//
// Eligibility is deliberately narrow, because a wrong rewrite here is a broken
// page: the binding must be module scope, not exported, an array or object
// literal, contain human-readable text, and be referenced only inside its own
// file. Anything else is left alone and reported.
//
// Usage:
//   node scripts/i18n-unfreeze.mjs --dry <file|dir> [...]
//   node scripts/i18n-unfreeze.mjs <file|dir> [...]

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SRC = join(ROOT, "frontend", "src");

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const targets = args.filter((a) => !a.startsWith("--"));
if (!targets.length) {
  console.error("usage: node scripts/i18n-unfreeze.mjs [--dry] <file|dir> ...");
  process.exit(1);
}

function walk(target, out = []) {
  const p = resolve(target);
  if (statSync(p).isFile()) {
    if (/\.tsx?$/.test(p) && !p.includes(".test.")) out.push(p);
    return out;
  }
  for (const name of readdirSync(p)) {
    const child = join(p, name);
    if (statSync(child).isDirectory()) walk(child, out);
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(child);
  }
  return out;
}

/** Every source file, so "referenced only in its own file" can be checked. */
const allFiles = walk(SRC);
const allText = new Map(allFiles.map((f) => [f, readFileSync(f, "utf8")]));

const human = (v) =>
  /^[A-Z]/.test(v) &&
  v.length >= 2 &&
  /[A-Za-z]{2}/.test(v) &&
  /^[A-Za-z0-9 ,.'’‘“”…()!?%:&+/-]+$/.test(v) &&
  !/^[A-Z0-9 _-]+$/.test(v);

/** Match the closing bracket that balances the one at `open`, skipping strings. */
function matchBracket(src, open) {
  const pairs = { "[": "]", "{": "}" };
  const close = pairs[src[open]];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") i += 2;
        else if (src[i] === q) break;
        else i++;
      }
      continue;
    }
    if (c === src[open]) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const camel = (n) =>
  n.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

let converted = 0;
let skipped = 0;
const report = [];

for (const file of targets.flatMap((t) => walk(t))) {
  let src = allText.get(file) ?? readFileSync(file, "utf8");
  const rel = relative(SRC, file);
  const decl = /^const ([A-Z][A-Z0-9_]*)(\s*:\s*[^=\n]+)?\s*=\s*([[{])/gm;
  const edits = [];
  let m;
  while ((m = decl.exec(src)) !== null) {
    const [whole, name, type, bracket] = m;
    const openAt = m.index + whole.length - 1;
    const closeAt = matchBracket(src, openAt);
    if (closeAt === -1) continue;
    const body = src.slice(openAt, closeAt + 1);

    const strings = [...body.matchAll(/"([^"\n]{2,200})"/g)].map((x) => x[1]);
    if (!strings.some(human)) continue;

    // Exported bindings can be consumed by other files, so converting them
    // would break the importers. A non-exported module-scope const is only
    // reachable from its own file, whatever same-name consts exist elsewhere,
    // so an IMPORT check (not a bare identifier grep, which trips over
    // coincidental same-name locals) is the correct cross-file guard. All
    // export forms count: inline (`export const NAME`), statement
    // (`export { NAME }`, `export { NAME as X }`), and default
    // (`export default NAME`) - the statement/default forms are how a
    // namespace import (`import * as m`) could reach the binding too.
    if (
      new RegExp(`export\\s+const\\s+${name}\\b`).test(src) ||
      new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(src) ||
      new RegExp(`export\\s+default\\s+${name}\\b`).test(src)
    ) {
      skipped++;
      report.push(`  skip ${rel}: ${name} is exported`);
      continue;
    }
    // Named imports, including a mixed default+named clause
    // (`import Foo, { NAME } from ...`).
    const imported = new RegExp(`import\\s+(?:type\\s+)?(?:[\\w$]+\\s*,\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}`);
    const elsewhere = allFiles.some((f) => f !== file && imported.test(allText.get(f)));
    if (elsewhere) {
      skipped++;
      report.push(`  skip ${rel}: ${name} is imported by another file`);
      continue;
    }
    edits.push({ name, type: type ?? "", openAt, closeAt, declStart: m.index, declLen: whole.length });
  }

  if (!edits.length) continue;

  // Apply from the bottom so earlier offsets stay valid.
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    const newName = camel(e.name);
    const ret = e.type ? ` = ()${e.type.replace(/\s+$/, "")} =>` : " = () =>";
    // An arrow returning an OBJECT literal needs parentheses, or `{` opens a
    // function body instead and the whole declaration stops parsing.
    const body = src.slice(e.openAt, e.closeAt + 1);
    const wrapped = body.startsWith("{") ? `(${body})` : body;
    src =
      src.slice(0, e.declStart) +
      `const ${newName}${ret} ` +
      wrapped +
      src.slice(e.closeAt + 1);
    converted++;
  }
  // Rewrite the references, skipping the declarations themselves.
  for (const e of edits) {
    const newName = camel(e.name);
    src = src.replace(new RegExp(`\\b${e.name}\\b`, "g"), `${newName}()`);
    src = src.replace(new RegExp(`const ${newName}\\(\\)`, "g"), `const ${newName}`);
    // `typeof X` in a TYPE position cannot become `typeof x()`; the type of the
    // value is now the function's return type.
    src = src.replace(new RegExp(`typeof ${newName}\\(\\)`, "g"), `ReturnType<typeof ${newName}>`);
  }
  report.push(`  ${rel}: ${edits.map((e) => e.name).join(", ")}`);
  if (!dry) writeFileSync(file, src);
}

for (const line of report) console.log(line);
console.log(`${dry ? "[dry] " : ""}${converted} tables unfrozen, ${skipped} left alone`);
