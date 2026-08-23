// UI string localization (F38 FR-9, FR-11).
//
// Companion to `locale.ts`, which owns WHICH locale is in effect and the
// document's `lang`/`dir`. This module owns the WORDS.
//
// Three choices worth stating, because they shape everything else:
//
// 1. The base (English) catalog is BUNDLED and synchronous. There is no state
//    in which the app renders empty strings or raw keys while a catalog loads,
//    which is the usual failure of a fetch-based setup.
//
// 2. Every other locale is a plain JSON file fetched from `/locales/<tag>.json`
//    at runtime, not compiled in. A self-hoster or a translator adds a language
//    by dropping a file next to the binary, with no rebuild and no pull request.
//    That matters for a product whose whole point is being self-hostable and
//    open, and it is why 100+ locales does not mean 100+ bundles.
//
// 3. Missing keys fall back to the base string, never to a blank or a key. A
//    half-translated locale is a normal, shippable state: the translated parts
//    show through and the rest stays English.
//
// The catalog is flat `"section.thing"` keys rather than nested objects so a
// key is greppable in the source exactly as it appears in the file.

import { useSyncExternalStore } from "react";
import base from "@/locales/en.json";
import { resolvedLocale } from "./locale";

export type Catalog = Record<string, string>;

/** The bundled base catalog. Every key the product uses must exist here. */
export const baseCatalog: Catalog = base as Catalog;

const PSEUDO_KEY = "hc-pseudo";

let active: Catalog = {};
let activeTag = "";
let pseudo = false;

// ---------------------------------------------------------------- subscribers

const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version++;
  for (const l of listeners) l();
}

/**
 * Swap the active catalog, emitting ONLY when it actually changed.
 *
 * The root keys its tree on the version, so a gratuitous emit is a full remount.
 * English resolves to the bundled base with no catalog at all, which is the
 * common case, and without this check every page load would mount, emit an
 * identical state, and immediately remount, throwing away component state and
 * running every effect twice.
 */
function setActive(next: Catalog): void {
  if (active === next) return;
  if (Object.keys(active).length === 0 && Object.keys(next).length === 0) {
    active = next;
    return;
  }
  active = next;
  emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ------------------------------------------------------------- pseudolocalize

const PSEUDO_MAP: Record<string, string> = {
  a: "á", b: "b́", c: "ć", d: "d́", e: "é", f: "f́", g: "ǵ", h: "h́", i: "í",
  j: "j́", k: "ḱ", l: "ĺ", m: "ḿ", n: "ń", o: "ó", p: "ṕ", q: "q́", r: "ŕ",
  s: "ś", t: "t́", u: "ú", v: "v́", w: "ẃ", x: "x́", y: "ý", z: "ź",
  A: "Á", B: "B́", C: "Ć", D: "D́", E: "É", F: "F́", G: "Ǵ", H: "H́", I: "Í",
  J: "J́", K: "Ḱ", L: "Ĺ", M: "Ḿ", N: "Ń", O: "Ó", P: "Ṕ", Q: "Q́", R: "Ŕ",
  S: "Ś", T: "T́", U: "Ú", V: "V́", W: "Ẃ", X: "X́", Y: "Ý", Z: "Ź",
};

/**
 * Pseudo-localization for CI and manual review (FR-11). It catches the two
 * bugs a translated build hits that an English build never does:
 *
 *   - a HARD-CODED string, which stays plain ASCII while everything around it
 *     is accented, so it is obvious at a glance and greppable in a screenshot;
 *   - a layout that only fits English, since real translations run longer.
 *     German and Finnish commonly need 30%+ more room, so the text is padded
 *     to force the truncation now rather than after a translator files a bug.
 *
 * Brackets mark the boundaries, which is how a clipped string is spotted: a
 * missing "»" means the end was cut off.
 *
 * Interpolation placeholders are left intact, because mangling them would
 * break the very substitution the pseudo-locale is meant to exercise.
 */
export function pseudoLocalize(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "{") {
      const close = s.indexOf("}", i);
      if (close !== -1) {
        out += s.slice(i, close + 1); // leave {placeholders} alone
        i = close + 1;
        continue;
      }
    }
    out += PSEUDO_MAP[s[i]] ?? s[i];
    i++;
  }
  // ~35% expansion, applied to the letters only so short labels still grow.
  const letters = (s.match(/[A-Za-z]/g) ?? []).length;
  const pad = "·".repeat(Math.ceil(letters * 0.35));
  return `«${out}${pad}»`;
}

/** Is the pseudo-locale on? Enabled by `?pseudo=1` or a stored flag. */
export function isPseudo(): boolean {
  return pseudo;
}

export function setPseudo(on: boolean): void {
  pseudo = on;
  if (typeof window !== "undefined") {
    if (on) window.localStorage.setItem(PSEUDO_KEY, "1");
    else window.localStorage.removeItem(PSEUDO_KEY);
  }
  emit();
}

// ------------------------------------------------------------------ interpolation

/**
 * Substitute `{name}` placeholders. An ABSENT parameter leaves the placeholder
 * visible rather than printing "undefined": a visible `{count}` is a bug report,
 * where "undefined" reads as a broken product to the user and is easy to miss
 * in review.
 */
export function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/**
 * Plural selection via `Intl.PluralRules`, so a locale gets the categories it
 * actually has. English needs two forms and Arabic needs six; hardcoding
 * `n === 1 ? a : b` cannot express that, and it is the reason plural keys are
 * suffixed (`key.one`, `key.other`) rather than being two separate keys.
 */
function pluralKey(key: string, count: number, tag: string, from: Catalog): string {
  let category = "other";
  try {
    category = new Intl.PluralRules(tag).select(count);
  } catch {
    category = count === 1 ? "one" : "other";
  }
  const exact = `${key}.=${count}`; // an explicit override, e.g. "zero items"
  if (exact in from || exact in baseCatalog) return exact;
  const wanted = `${key}.${category}`;
  if (wanted in from || wanted in baseCatalog) return wanted;
  return `${key}.other`;
}

// ----------------------------------------------------------------- translate

/**
 * Look a key up in the active catalog, then the base, then fall back to the key
 * itself. Returning the KEY rather than an empty string is deliberate: a blank
 * label is invisible in review and ships, while "editor.save" is obviously
 * wrong the moment anyone looks at the screen.
 */
export function translate(key: string, params?: Record<string, unknown>): string {
  let k = key;
  if (params && typeof params.count === "number") {
    k = pluralKey(key, params.count, activeTag || resolvedLocale(), active);
  }
  const raw = active[k] ?? baseCatalog[k];
  if (raw === undefined) return key;
  const filled = interpolate(raw, params);
  // Pseudo applies to the baseCatalog text only: a real translation is already proof
  // that the string was externalized, so mangling it would only hide it.
  return pseudo && active[k] === undefined ? pseudoLocalize(filled) : filled;
}

/**
 * Translate a DYNAMIC key, falling back to text the caller already has.
 *
 * Most keys are literals the extractor can see and the catalog test can verify.
 * Data tables are the exception: a sticker library is 300 rows built at module
 * scope, where a `tr()` call would be evaluated once at import and frozen in
 * English forever. Those rows carry a stable `id` instead, the key is derived
 * from it at RENDER time, and the English already in the row is the fallback,
 * so an untranslated or misspelled key degrades to correct English rather than
 * showing a raw key.
 */
export function trOr(key: string, fallback: string, params?: Record<string, unknown>): string {
  const out = translate(key, params);
  return out === key ? fallback : out;
}

/**
 * The short name used at every call site.
 *
 * Named `tr`, not the conventional `t`, for a boring but decisive reason: this
 * codebase already binds `t` as a local 306 times, for times, transforms and
 * toasts. An import named `t` is shadowed in a large fraction of the files that
 * need it, and the failure is silent at the call site and only shows up as a
 * type error somewhere else. `tr` collides in three narrow scopes instead.
 *
 * This is the plain function, not a hook, so it can be called from anywhere a
 * string is needed: a component, a helper, a `useMemo`, a constant array of
 * menu items built at module scope. Requiring a hook is what makes string
 * externalization stall in practice, because roughly a third of the strings in
 * this app are not inside a component body.
 *
 * The catch a hook would have solved is re-rendering when the language changes.
 * That is handled once, at the root: `_app.tsx` keys the tree on
 * `useI18nVersion()`, so switching language remounts the app and every string
 * is re-read. Changing language is a deliberate, rare action, so paying a full
 * remount for it is a much better trade than a hook at 1400 call sites.
 */
export const tr = translate;

/** Changes whenever the catalog or the pseudo flag changes. Key the app root on
 *  this so a language switch re-reads every string. */
export function useI18nVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

/** React binding for callers that prefer an explicit hook. */
export function useT(): typeof translate {
  useI18nVersion();
  return translate;
}

// ------------------------------------------------------------ catalog loading

const cache = new Map<string, Catalog>();
/** Candidates that 404ed this session, so they are not re-fetched. */
const missing = new Set<string>();

/** Register a catalog directly. Used by tests and by anything that already has
 *  the JSON in hand. */
export function registerCatalog(tag: string, catalog: Catalog): void {
  cache.set(normalize(tag), catalog);
}

function normalize(tag: string): string {
  return tag.toLowerCase().replace("_", "-");
}

/**
 * The lookup chain for a tag: the full tag, then the bare language. "pt-BR"
 * tries `pt-br.json` then `pt.json`, so a Brazilian user still gets Portuguese
 * from a generic catalog instead of falling all the way back to English.
 */
export function catalogChain(tag: string): string[] {
  const t = normalize(tag);
  const lang = t.split("-")[0];
  return t === lang ? [t] : [t, lang];
}

/**
 * Load and activate the catalog for a locale. English is the bundled base, so
 * it activates with no request at all. A failed fetch is not an error state:
 * the base catalog is already correct English, so the app stays usable and the
 * failure is logged rather than surfaced.
 */
export async function loadCatalog(tag: string): Promise<void> {
  activeTag = tag;
  // "en" is the bundled base, so it is never a file to fetch. Dropping it from
  // the chain rather than short-circuiting on it is what lets a REGIONAL
  // English still have a catalog: "en-GB" tries `en-gb.json` for its own
  // spellings and falls back to the bundled base per key, instead of being
  // mistaken for the base and given no catalog at all.
  // "en-us" is ALSO the base: the source strings are written in American
  // English, so an en-us.json could never say anything the base does not.
  // Without this, the DEFAULT locale fired a 404 for en-us.json on every
  // single app boot.
  const chain = catalogChain(tag).filter((c) => c !== "en" && c !== "en-us");
  if (chain.length === 0) {
    setActive({});
    return;
  }
  for (const candidate of chain) {
    const hit = cache.get(candidate);
    if (hit) {
      setActive(hit);
      return;
    }
  }
  for (const candidate of chain) {
    // A candidate that already 404ed this session is skipped: only successes
    // were cached before, so a missing regional file (es-es.json for "es-ES")
    // was re-fetched on every language change.
    if (missing.has(candidate)) continue;
    try {
      // "no-cache" revalidates against the server (a 304 costs almost
      // nothing) instead of trusting whatever copy the browser holds.
      // "force-cache" served a STALE catalog forever: a translator could
      // update a file, or a self-hoster drop in a new one, and returning
      // users would keep the old strings until they cleared their cache.
      const res = await fetch(`/locales/${candidate}.json`, { cache: "no-cache" });
      if (!res.ok) {
        missing.add(candidate);
        continue;
      }
      const json = (await res.json()) as Catalog;
      cache.set(candidate, json);
      // Guard against a slower earlier request finishing last and clobbering
      // the locale the user is actually on now.
      if (activeTag === tag) setActive(json);
      return;
    } catch {
      // fall through to the next candidate, then to English
    }
  }
  if (activeTag === tag) setActive({});
}

/** Boot: pick up the pseudo flag, then load the active locale's catalog. */
export function initI18n(tag: string = resolvedLocale()): void {
  if (typeof window !== "undefined") {
    const q = new URLSearchParams(window.location.search).get("pseudo");
    if (q === "1") pseudo = true;
    else if (q === "0") setPseudo(false);
    else pseudo = window.localStorage.getItem(PSEUDO_KEY) === "1";
  }
  void loadCatalog(tag);
}

/** Test seam: drop all loaded state. */
export function resetI18n(): void {
  active = {};
  activeTag = "";
  pseudo = false;
  cache.clear();
  missing.clear();
  emit();
}
