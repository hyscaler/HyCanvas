// Localization ratchet (F38 FR-9, FR-11).
//
// Externalizing ~1500 strings is worth little if the next feature adds fifty
// hard-coded ones. These are the checks that keep the catalog honest, and they
// are source-level for the same reason as the right-to-left guards: nobody
// working in English can see any of these regressions.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ROOT = join(SRC, "..", "..");
const CATALOG = JSON.parse(readFileSync(join(SRC, "locales", "en.json"), "utf8")) as Record<string, string>;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if ((name.endsWith(".tsx") || name.endsWith(".ts")) && !name.includes(".test.")) out.push(p);
  }
  return out;
}

const sources = sourceFiles(SRC).map((f) => ({ rel: relative(SRC, f), text: readFileSync(f, "utf8") }));

// The accessibility checker lives in a framework-agnostic package but names
// its messages with catalog keys the dialog resolves (`messageCode`). Those
// keys are real literals, just outside frontend/src, so the orphan check has
// to see them or it would delete every a11y.* entry as unused.
const PACKAGE_KEY_SOURCES = [join(ROOT, "packages", "a11y", "src", "index.ts")];
const packageKeys = PACKAGE_KEY_SOURCES.flatMap((f) => {
  const text = readFileSync(f, "utf8");
  return [...text.matchAll(/messageCode:\s*"([^"]+)"/g)].map((m) => m[1]);
});

/** Every `tr("...")` call site in the app. */
function usedKeys(): Map<string, string> {
  const used = new Map<string, string>();
  for (const { rel, text } of sources) {
    for (const m of text.matchAll(/\btr\(\s*"([^"]+)"/g)) used.set(m[1], rel);
    // Error codes are referenced by throw sites, not tr() literals; the
    // display boundary resolves them dynamically. `errors.*` is a reserved
    // code namespace, so ANY quoted errors.* literal counts as a reference
    // (a code can sit in a ternary or a variable before reaching CodedError).
    for (const m of text.matchAll(/new CodedError\(\s*"([^"]+)"/g)) used.set(m[1], rel);
    for (const m of text.matchAll(/"(errors\.[a-z0-9_.]+)"/g)) used.set(m[1], rel);
  }
  for (const k of packageKeys) used.set(k, "packages/a11y");
  return used;
}

/**
 * Namespaces whose keys are built at RUNTIME from a data row's stable id, so no
 * literal `tr("...")` call exists for them. These are the tables that live at
 * module scope, where an inline `tr()` would be evaluated once at import and
 * frozen in English. Keep this list short: every entry is a gap in the orphan
 * check above.
 */
const DYNAMIC_PREFIXES = ["stickers.", "errors.api_", "editor.node_type_", "editor.effect_", "editor.dial_", "editor.theme_name_", "editor.action_"];

describe("catalog", () => {
  it("has an entry for every key the app asks for", () => {
    // A missing key renders as the key itself, which is visible but ugly. This
    // catches it before a user does.
    const lacks = (catalog: Record<string, string>, key: string) =>
      // Plural keys are stored with a category suffix and looked up by stem.
      !(key in catalog) && !Object.keys(catalog).some((k) => k.startsWith(`${key}.`));
    let missing = [...usedKeys()].filter(([key]) => lacks(CATALOG, key));
    if (missing.length) {
      // This has flaked in a full concurrent run (all three suites at once)
      // while passing standalone and against a disk check, so a candidate is
      // re-checked against a FRESH read before the suite goes red. A key that
      // is genuinely absent is absent in both reads, so the guard keeps its
      // teeth; only a torn read is forgiven.
      const fresh = JSON.parse(readFileSync(join(SRC, "locales", "en.json"), "utf8")) as Record<string, string>;
      missing = missing.filter(([key]) => lacks(fresh, key));
    }
    expect(missing.map(([key, rel]) => `${key} (${rel})`)).toEqual([]);
  });

  it("only allows a dynamic namespace that is genuinely built at runtime", () => {
    // The allowance below is the one hole in the orphan check, so it has to
    // earn its place: each prefix must actually appear in a template-literal
    // key somewhere, or it is just a dead namespace hiding behind an exemption.
    for (const prefix of DYNAMIC_PREFIXES) {
      const built = sources.some(({ text }) => text.includes(`\`${prefix}`));
      expect(built, `no runtime key is built from "${prefix}"`).toBe(true);
    }
  });

  it("carries no keys the app no longer uses", () => {
    // Orphans are what make a catalog rot: translators keep paying for strings
    // that no longer render anywhere.
    const used = usedKeys();
    const orphans = Object.keys(CATALOG).filter((k) => {
      if (used.has(k)) return false;
      if (DYNAMIC_PREFIXES.some((p) => k.startsWith(p))) return false;
      const stem = k.replace(/\.(one|other|zero|two|few|many|=\d+)$/, "");
      return !used.has(stem);
    });
    expect(orphans).toEqual([]);
  });

  it("has no blank values", () => {
    expect(Object.entries(CATALOG).filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
  });

  it("keys every entry to an area prefix, so a key names its own location", () => {
    expect(Object.keys(CATALOG).filter((k) => !/^[a-z0-9]+\./.test(k))).toEqual([]);
  });
});

describe("schema values are never translated", () => {
  it("keeps design-file values out of the catalog", () => {
    // `fontStyle: "Regular"` is a VALUE the engine resolves and the design file
    // stores, not a label. Translating it breaks font resolution and makes the
    // saved document depend on the author's interface language, which the
    // zero-data-loss rules forbid. The extractor caught 17 of these once.
    const fields =
      /\b([a-zA-Z]*[fF]ont[a-zA-Z]*|weight|family|easing|codec|mimeType|mime|unit|locale|currency)\s*:\s*tr\(/;
    const offenders = sources
      .filter(({ text }) => fields.test(text))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});

describe("no hard-coded user-visible strings", () => {
  it("leaves nothing for the extractor to find", () => {
    // The extractor is the single definition of what counts as a translatable
    // string. Running it in dry mode here means the rule cannot drift between
    // the tool that applies it and the test that enforces it.
    const runExtractor = () =>
      execFileSync(
        "node",
        [
          join(ROOT, "scripts", "i18n-extract.mjs"),
          "--dry",
          // lib and store were outside this check at first, which is exactly how
          // 60 user-visible strings there stayed hard-coded without anyone
          // noticing. A ratchet only holds what it is pointed at.
          join(SRC, "components"),
          join(SRC, "pages"),
          join(SRC, "lib"),
          join(SRC, "store"),
        ],
        { encoding: "utf8" },
      );
    // This scan has gone red intermittently in a FULL concurrent run (all three
    // suites at once, usually right after a source edit) while passing on its
    // own and against an independent disk check. The cause is in the harness,
    // not the catalog, so a non-zero count is re-scanned once before the suite
    // fails: a genuinely hard-coded string is found by both scans, and only a
    // torn read is forgiven.
    let out = runExtractor();
    // "unseen" counts prose the REWRITE pattern cannot match (its text run
    // excludes ; = " ' and a backtick). Those are reported rather than rewritten
    // and must be counted here, or the ratchet reports clean over strings it
    // never examined, which is exactly how 26 of them survived to August 2026.
    const count = (text: string) => {
      const m = text.match(/\[dry\] (\d+) text nodes \+ (\d+) attributes \+ (\d+) expressions \+ (\d+) unseen/);
      expect(m, `unexpected extractor output:\n${text}`).toBeTruthy();
      return Number(m![1]) + Number(m![2]) + Number(m![3]) + Number(m![4]);
    };
    let found = count(out);
    if (found > 0) {
      out = runExtractor();
      found = count(out);
    }
    expect(found, `${found} hard-coded strings:\n${out}`).toBe(0);
  });

  it("never calls tr() at module scope, where it would freeze at import", () => {
    // A module-level `tr()` is evaluated once, before any catalog has loaded,
    // and never again. It stays English whatever language the user picks, and
    // an English build cannot show the bug. Move the KEY into the data and
    // translate at the render site instead.
    const offenders: string[] = [];
    for (const { rel, text } of sources) {
      for (const m of text.matchAll(/\btr\(\s*"/g)) {
        const before = text.slice(0, m.index);
        const heads = [...before.matchAll(/(?:^|\n)(?:export )?(?:default )?(?:async )?(?:const|let|var|function|class) /g)];
        if (!heads.length) continue;
        const head = before.slice(heads[heads.length - 1].index!);
        if (!/=>|\bfunction\b|\)\s*\{/.test(head)) {
          offenders.push(`${rel}: ${before.split("\n").length}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// The API half of FR-9. The Go backend cannot localize its own error prose, so
// it ships a stable `code` and the client resolves `errors.api_<code>`. That
// only works while the two sides agree, and nothing else checks the seam: a new
// coded error compiles, passes every Go test, and silently reaches users in
// English because the catalog was never told about it.
//
// Go-side rules (a code must exist, be literal, and be unique per message) are
// enforced in backend/internal/httpapi/problem_code_test.go. This is the other
// half: every code that exists must be translatable.
describe("api error codes", () => {
  const BACKEND = join(ROOT, "backend", "internal");

  function goFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) goFiles(p, out);
      else if (name.endsWith(".go") && !name.endsWith("_test.go")) out.push(p);
    }
    return out;
  }

  const codes = new Set<string>();
  for (const f of goFiles(BACKEND)) {
    const src = readFileSync(f, "utf8");
    // The code is the last argument of a 6-argument call, so it is the string
    // literal immediately before the closing paren.
    for (const m of src.matchAll(/\b(?:problemWithCode|ProblemCode)\([\s\S]*?"([a-z0-9_]+)"\s*\)/g)) {
      codes.add(m[1]);
    }
  }

  it("finds the codes at all", () => {
    // Guards against the scan silently matching nothing after a refactor, which
    // would make every assertion below vacuously pass.
    expect(codes.size).toBeGreaterThan(100);
  });

  it("has a catalog entry for every problem code the API can return", () => {
    const missing = [...codes].filter((c) => !(`errors.api_${c}` in CATALOG)).sort();
    expect(missing, `add errors.api_<code> for: ${missing.join(", ")}`).toEqual([]);
  });

  it("carries no errors.api_* key for a code the API no longer returns", () => {
    const orphans = Object.keys(CATALOG)
      .filter((k) => k.startsWith("errors.api_"))
      .map((k) => k.slice("errors.api_".length))
      .filter((c) => !codes.has(c))
      .sort();
    expect(orphans, `remove or re-point: ${orphans.join(", ")}`).toEqual([]);
  });
});
