// Every shipped catalog, loaded through the real runtime (F38 FR-9).
// Not a translation review: proves each file parses, resolves through the
// lookup chain, keeps placeholders intact, and covers the whole base catalog.
import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, registerCatalog, loadCatalog, translate, resetI18n } from "./i18n";

const DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "public", "locales");
const load = (tag: string) => JSON.parse(readFileSync(join(DIR, `${tag}.json`), "utf8")) as Record<string, string>;

const FULL = ["es", "fr", "de", "pt-br", "ja", "zh-cn", "hi"];

describe.each(FULL)("catalog %s", (tag) => {
  const cat = load(tag);

  beforeEach(async () => {
    resetI18n();
    registerCatalog(tag, cat);
    await loadCatalog(tag);
  });

  it("covers every key in the base catalog", () => {
    const missing = Object.keys(BASE).filter((k) => !(k in cat));
    expect(missing).toEqual([]);
  });

  it("keeps every {placeholder} intact", () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
    const broken = Object.keys(cat).filter((k) => k in BASE && ph(BASE[k]) !== ph(cat[k]));
    expect(broken).toEqual([]);
  });

  it("resolves a core editor string in the language, not English", () => {
    // "Undo" is in every design tool's muscle memory; if this one is still
    // English the catalog never loaded.
    expect(translate("editor.undo")).toBe(cat["editor.undo"]);
    expect(translate("editor.undo")).not.toBe("");
  });

  it("keeps brand names and key chords as authored", () => {
    // The brand survives inside a translated sentence, letter for letter.
    expect(translate("settings.how_the_hycanvas_interface_looks_on_this_dev")).toContain("HyCanvas");
    expect(translate("app.ctrl")).toBe("Ctrl");
  });
});

describe("catalog en-gb", () => {
  it("carries only spellings that differ from the base", () => {
    const gb = load("en-gb");
    // Every entry must genuinely differ, or it is dead weight the per-key
    // fallback would have handled.
    const same = Object.keys(gb).filter((k) => k in BASE && gb[k] === BASE[k]);
    expect(same).toEqual([]);
    expect(gb["dashboard.favorites"]).toBe("Favourites");
  });
});
