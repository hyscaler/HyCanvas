// App-chrome theme preference (light / dark / follow-the-OS). The choice is
// stored in localStorage ("hc-theme") and applied as a `dark` class on <html>,
// which the generated `.dark` token overrides in globals.css key off. Design
// content is never themed; this is the application shell only.
//
// The no-flash snippet in _document.tsx duplicates the resolution logic as an
// inline script (it must run before first paint, so it cannot import this
// module); keep the two in sync.

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "hc-theme";

export function getThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** The mode actually in effect (preference with "system" resolved). */
export function resolvedTheme(pref: ThemePreference = getThemePreference()): "light" | "dark" {
  return pref === "system" ? (systemPrefersDark() ? "dark" : "light") : pref;
}

export function applyTheme(pref: ThemePreference = getThemePreference()): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolvedTheme(pref) === "dark");
}

export function setThemePreference(pref: ThemePreference): void {
  if (pref === "system") window.localStorage.removeItem(STORAGE_KEY);
  else window.localStorage.setItem(STORAGE_KEY, pref);
  applyTheme(pref);
}

/** Track OS scheme changes while the preference is "system". Returns a
 *  disposer; call once from _app. */
export function watchSystemTheme(): () => void {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (getThemePreference() === "system") applyTheme("system");
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** Inline no-flash source for _document.tsx (runs before first paint). */
export const THEME_BOOT_SCRIPT = `(function(){try{var v=localStorage.getItem("${STORAGE_KEY}");var d=v==="dark"||(v!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);if(d)document.documentElement.classList.add("dark");}catch(e){}})();`;
