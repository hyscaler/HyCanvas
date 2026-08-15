// The browser's own IANA timezone, in a LEAF module with no imports.
//
// This lived in `datetime.ts`, which imports the auth store to read the signed-in
// user's preferences, while the auth store imports this function to seed a new
// account's timezone. That was a value-level import cycle between the two, and
// it stayed harmless only because nothing pulled the auth store in early. Once
// `_app` did, the cycle became reachable from the application entry and the
// dev bundler evaluated `App` against a half-initialised module, so the whole
// tree failed to hydrate.
//
// Keeping it here means the store depends on a leaf instead of on the module
// that depends on the store. `datetime.ts` re-exports it so existing callers
// are unaffected.
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}
