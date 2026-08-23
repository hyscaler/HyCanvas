// The shipped Hindi catalog, loaded through the real runtime. This is not a
// translation review; it proves the actual file resolves through the actual
// lookup chain, and that editor strings come out in Hindi with interpolation
// and fallback behaving.
import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseCatalog, registerCatalog, loadCatalog, translate, resetI18n } from "./i18n";

const hi = JSON.parse(
  readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "public", "locales", "hi.json"), "utf8"),
) as Record<string, string>;

describe("the shipped Hindi catalog", () => {
  beforeEach(async () => {
    resetI18n();
    registerCatalog("hi", hi);
    await loadCatalog("hi-IN"); // regional tag falls back to the generic file
  });

  it("covers every key in the base catalog", () => {
    // 100% by design: identifiers that must stay as authored (brand names,
    // example emails, database defaults) are present with identical values,
    // so a gap here is a NEW string a future change added without a Hindi
    // entry, not a deliberate omission.
    const missing = Object.keys(baseCatalog).filter((k) => !(k in hi));
    expect(missing).toEqual([]);
  });

  it("resolves editor strings in Hindi through the runtime", () => {
    expect(translate("editor.undo")).toBe("पूर्ववत करें");
    expect(translate("editor.save")).toBe("सहेजें");
    expect(translate("editor.add_page")).toBe("पृष्ठ जोड़ें");
  });

  it("interpolates inside a translated template", () => {
    expect(translate("editor.name_animated", { name: "तारा" })).toBe("तारा (एनिमेटेड)");
  });

  it("keeps keyboard keys and brand names as authored", () => {
    // A Hindi keyboard still prints Ctrl; a brand is a name, not a word.
    expect(translate("app.ctrl")).toBe("Ctrl");
    // The brand survives inside a translated sentence, letter for letter.
    expect(translate("settings.how_the_hycanvas_interface_looks_on_this_dev")).toContain("HyCanvas");
  });

  it("keeps technical defaults byte-identical", () => {
    // These render into config forms; a translated database name or host
    // would be actively wrong, so they are carried as themselves.
    expect(translate("installation.postgres")).toBe("postgres");
    expect(translate("installation.localhost")).toBe("localhost");
    expect(translate("installation.you_example_com")).toBe("you@example.com");
  });

  it("translates the dashboard", () => {
    expect(translate("dashboard.create_a_design")).toBe("डिज़ाइन बनाएँ");
    expect(translate("dashboard.trash_is_empty")).toBe("कचरा खाली है।");
  });
});
