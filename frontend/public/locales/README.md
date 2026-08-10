# UI translations

Each file here is one locale's UI catalog, named by its BCP 47 tag in lower
case: `fr.json`, `pt-br.json`, `ar.json`.

Adding a language needs no rebuild and no code change. Drop a JSON file in this
directory and the app picks it up for users on that locale.

On a self-hosted install the production build is a single binary with the
frontend baked in, so instead put the file in a `locales` directory beside the
binary (or point `LOCALES_DIR` at one). A file there overrides the built-in
copy, which is what makes a translation a drop-in rather than a recompile.

## Format

A flat object of key to translated string, using the keys from the base catalog
at `frontend/src/locales/en.json`:

```json
{
  "settings.settings": "Réglages",
  "settings.appearance": "Apparence"
}
```

## Rules

- **Partial files are fine.** Any key you leave out falls back to the English
  base, so a catalog is useful from its first line. There is no need to
  translate everything before shipping it.
- **Keep `{placeholders}` exactly as they appear.** They are substituted at
  runtime, and a renamed or dropped placeholder shows up verbatim to the user.
- **Plurals use a category suffix**: `key.one`, `key.other`, and whichever of
  `zero` / `two` / `few` / `many` your language needs. The category is chosen by
  the platform's own rules for your locale, so supply the ones it asks for
  rather than mirroring English. `key.=0` overrides an exact count when a
  language wants a special phrasing for none.
- **Regional falls back to generic.** A user on `pt-BR` gets `pt-br.json` if it
  exists and `pt.json` otherwise, so shared translations belong in the generic
  file.

## Checking your work

Load the app with `?pseudo=1` to render every UNTRANSLATED string in accented
text between `«` and `»`. Anything still in plain English is either missing from
your catalog or hard-coded in the source.
