// UI locale and text direction for the application shell (F38 FR-9, FR-10).
//
// The document was hardcoded to `<html lang="en">` with no direction at all, so
// an Arabic or Hebrew speaker got an interface that never mirrored and a page
// that told assistive technology and the browser it was English. That is a
// correctness problem before it is a translation problem: `lang` drives screen
// reader pronunciation, hyphenation, and font selection, and `dir` drives the
// entire layout.
//
// This is deliberately the runtime only. Translated strings arrive with the
// catalog work; until then the UI text is English while `lang` and `dir` are
// honest about what the user asked for, which is strictly better than claiming
// English layout for an Arabic user.
//
// The no-flash snippet at the bottom duplicates the resolution logic as an
// inline script (it has to run before first paint, so it cannot import this
// module); keep the two in sync, exactly as the theme module does.

const STORAGE_KEY = "hc-locale";

/** Right-to-left scripts, by language subtag. Region subtags never change the
 *  direction, so only the primary subtag is consulted. */
const RTL_LANGUAGES = new Set([
  "ar", // Arabic
  "arc", // Aramaic
  "az", // Azeri (Arabic script variants)
  "ckb", // Central Kurdish
  "dv", // Divehi
  "fa", // Persian
  "he", // Hebrew
  "iw", // Hebrew (legacy code, still emitted by some systems)
  "ku", // Kurdish
  "ps", // Pashto
  "sd", // Sindhi
  "ug", // Uyghur
  "ur", // Urdu
  "yi", // Yiddish
]);

/** Is this BCP 47 tag a right-to-left language? */
export function isRtlLocale(tag: string): boolean {
  const primary = tag.toLowerCase().split(/[-_]/)[0];
  return RTL_LANGUAGES.has(primary);
}

/** The direction a locale should lay the interface out in. */
export function directionFor(tag: string): "ltr" | "rtl" {
  return isRtlLocale(tag) ? "rtl" : "ltr";
}

/**
 * The stored UI locale, or null to follow the browser. Kept separate from the
 * ACCOUNT locale on purpose: the account value is a profile preference that
 * syncs across devices, while this is what the shell renders with right now,
 * including before the session is known and for signed-out pages.
 */
export function getLocalePreference(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

/** The locale actually in effect: the stored preference, else the browser's. */
export function resolvedLocale(pref: string | null = getLocalePreference()): string {
  if (pref) return pref;
  if (typeof navigator !== "undefined" && navigator.language) return navigator.language;
  return "en";
}

/**
 * Direction pin for surfaces that render DESIGN CONTENT rather than interface.
 *
 * A design has its own coordinate space, and its overlays (selection handles,
 * guides, rulers, crop frame, comment pins, presence cursors) are positioned in
 * that space. `dir="rtl"` reverses every flex row it applies to, so letting the
 * shell's direction reach the canvas would detach those overlays from the thing
 * they point at and mirror thumbnails of the user's own artwork.
 *
 * This is the direction counterpart of the `light` class that keeps document
 * surfaces out of dark mode, and it follows the same rule from the project
 * conventions: the shell is themed and mirrored, design content is not.
 *
 * Text INSIDE a design still honours its own per-paragraph `direction` from the
 * file format; that is resolved by the text layout engine, not by this
 * attribute. `locale.pins.test.ts` asserts every surface below carries it.
 */
export const designSurfaceDir = "ltr";

/**
 * The direction the interface is currently laid out in.
 *
 * Read from the document rather than recomputed from the locale, because a
 * subtree pinned with `designSurfaceDir` is left-to-right even for a
 * right-to-left user, and pointer maths inside it must agree with what is on
 * screen rather than with the account setting.
 */
export function documentDirection(el?: { dir?: string } | null): "ltr" | "rtl" {
  const target = el ?? (typeof document === "undefined" ? null : document.documentElement);
  return target?.dir === "rtl" ? "rtl" : "ltr";
}

/**
 * Mirror an icon whose meaning is DIRECTIONAL when the interface mirrors: a
 * back arrow, a next chevron, a disclosure triangle, a panel-side glyph. In a
 * right-to-left interface "back" points the other way, so an unmirrored arrow
 * points at where the user came from rather than where the control goes.
 *
 * Only for icons that encode a direction. An icon that merely contains a
 * diagonal (a clock, a pencil, a trash can) must NOT carry this: mirroring it
 * makes it look wrong without making it mean anything.
 */
export const mirrorInRtl = "rtl:-scale-x-100";

/** The two attributes this sets, so the target can be stubbed in a test that
 *  has no DOM. */
export interface LocaleTarget {
  lang: string;
  dir: string;
}

/** Apply `lang` and `dir` to the document element (or a given target). */
export function applyLocale(pref: string | null = getLocalePreference(), target?: LocaleTarget): void {
  const el = target ?? (typeof document === "undefined" ? undefined : document.documentElement);
  if (!el) return;
  const tag = resolvedLocale(pref);
  el.lang = tag;
  el.dir = directionFor(tag);
}

export function setLocalePreference(tag: string | null, target?: LocaleTarget): void {
  if (typeof window !== "undefined") {
    if (tag) window.localStorage.setItem(STORAGE_KEY, tag);
    else window.localStorage.removeItem(STORAGE_KEY);
  }
  applyLocale(tag, target);
}

/**
 * Runs before first paint so the interface never flashes the wrong direction.
 * A mirrored layout arriving one frame late is far more jarring than a colour
 * theme doing the same, because every element moves.
 */
export const localeBootScript = `(function(){try{
var rtl=${JSON.stringify([...RTL_LANGUAGES])};
var t=localStorage.getItem(${JSON.stringify(STORAGE_KEY)})||navigator.language||"en";
var p=t.toLowerCase().split(/[-_]/)[0];
var e=document.documentElement;
e.lang=t;e.dir=rtl.indexOf(p)>=0?"rtl":"ltr";
}catch(_){}})();`;
