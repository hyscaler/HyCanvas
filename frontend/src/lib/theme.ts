// App-chrome theme preference (light / dark / follow-the-OS) and the contrast
// preference (normal / high / follow-the-OS), two orthogonal axes. The choices
// are stored in localStorage ("hc-theme", "hc-contrast") and applied as `dark`
// and `hc` classes on <html>, which the generated `.dark` / `.hc` token
// overrides in globals.css key off. Design content is never themed; this is
// the application shell only.
//
// The no-flash snippet in _document.tsx duplicates the resolution logic as an
// inline script (it must run before first paint, so it cannot import this
// module); keep the two in sync.

export type ThemePreference = "system" | "light" | "dark";
export type ContrastPreference = "system" | "normal" | "high";
export type MotionPreference = "system" | "reduce" | "full";

const STORAGE_KEY = "hc-theme";
const CONTRAST_KEY = "hc-contrast";
const MOTION_KEY = "hc-motion";

export function getThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function getContrastPreference(): ContrastPreference {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(CONTRAST_KEY);
  return v === "normal" || v === "high" ? v : "system";
}

export function getMotionPreference(): MotionPreference {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(MOTION_KEY);
  return v === "reduce" || v === "full" ? v : "system";
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function systemPrefersContrast(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-contrast: more)").matches;
}

/** The mode actually in effect (preference with "system" resolved). */
export function resolvedTheme(pref: ThemePreference = getThemePreference()): "light" | "dark" {
  return pref === "system" ? (systemPrefersDark() ? "dark" : "light") : pref;
}

/** The contrast actually in effect (preference with "system" resolved). */
export function resolvedContrast(pref: ContrastPreference = getContrastPreference()): "normal" | "high" {
  return pref === "system" ? (systemPrefersContrast() ? "high" : "normal") : pref;
}

/** Whether nonessential animation should be SKIPPED right now: the in-app
 *  preference resolved over the OS setting. JS consumers (present mode's
 *  slide transitions, the deck export planner) read this instead of
 *  matchMedia directly, so the in-app override reaches them too. */
export function prefersReducedMotion(): boolean {
  const pref = getMotionPreference();
  if (pref !== "system") return pref === "reduce";
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function applyTheme(pref: ThemePreference = getThemePreference()): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolvedTheme(pref) === "dark");
  document.documentElement.classList.toggle("hc", resolvedContrast() === "high");
  // Motion is CLASS-driven only for the explicit overrides; the "system"
  // state leaves both classes off and the CSS media query does the work.
  const motion = getMotionPreference();
  document.documentElement.classList.toggle("motion-reduce", motion === "reduce");
  document.documentElement.classList.toggle("motion-full", motion === "full");
}

export function setThemePreference(pref: ThemePreference): void {
  if (pref === "system") window.localStorage.removeItem(STORAGE_KEY);
  else window.localStorage.setItem(STORAGE_KEY, pref);
  applyTheme(pref);
}

export function setContrastPreference(pref: ContrastPreference): void {
  if (pref === "system") window.localStorage.removeItem(CONTRAST_KEY);
  else window.localStorage.setItem(CONTRAST_KEY, pref);
  applyTheme();
}

export function setMotionPreference(pref: MotionPreference): void {
  if (pref === "system") window.localStorage.removeItem(MOTION_KEY);
  else window.localStorage.setItem(MOTION_KEY, pref);
  applyTheme();
}

/** Track OS scheme/contrast changes while either preference is "system".
 *  Returns a disposer; call once from _app. */
export function watchSystemTheme(): () => void {
  if (typeof window === "undefined") return () => {};
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  const contrast = window.matchMedia("(prefers-contrast: more)");
  const onScheme = () => {
    if (getThemePreference() === "system") applyTheme("system");
  };
  const onContrast = () => {
    if (getContrastPreference() === "system") applyTheme();
  };
  scheme.addEventListener("change", onScheme);
  contrast.addEventListener("change", onContrast);
  return () => {
    scheme.removeEventListener("change", onScheme);
    contrast.removeEventListener("change", onContrast);
  };
}

/** Inline no-flash source for _document.tsx (runs before first paint). */
export const themeBootScript = `(function(){try{var v=localStorage.getItem("${STORAGE_KEY}");var d=v==="dark"||(v!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);if(d)document.documentElement.classList.add("dark");var c=localStorage.getItem("${CONTRAST_KEY}");var h=c==="high"||(c!=="normal"&&matchMedia("(prefers-contrast: more)").matches);if(h)document.documentElement.classList.add("hc");var m=localStorage.getItem("${MOTION_KEY}");if(m==="reduce")document.documentElement.classList.add("motion-reduce");else if(m==="full")document.documentElement.classList.add("motion-full");}catch(e){}})();`;
