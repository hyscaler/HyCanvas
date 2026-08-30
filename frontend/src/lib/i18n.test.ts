// UI string localization (F38 FR-9, FR-11).
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  baseCatalog,
  catalogChain,
  interpolate,
  loadCatalog,
  pseudoLocalize,
  registerCatalog,
  resetI18n,
  setPseudo,
  translate,
  tr,
} from "./i18n";

beforeEach(() => resetI18n());
afterEach(() => {
  resetI18n();
  vi.unstubAllGlobals();
});

describe("interpolate", () => {
  it("substitutes named placeholders", () => {
    expect(interpolate("Hello {name}", { name: "Ada" })).toBe("Hello Ada");
    expect(interpolate("{a} and {b}", { a: "1", b: "2" })).toBe("1 and 2");
  });

  it("leaves a placeholder visible when the parameter is missing", () => {
    // "undefined" reads as a broken product and slips through review; a visible
    // {count} is self-reporting.
    expect(interpolate("You have {count} left", {})).toBe("You have {count} left");
  });

  it("passes numbers and zero through", () => {
    expect(interpolate("{n} items", { n: 0 })).toBe("0 items");
  });
});

describe("pseudoLocalize", () => {
  it("accents the text and marks both ends", () => {
    const out = pseudoLocalize("Save");
    expect(out.startsWith("«")).toBe(true);
    expect(out.endsWith("»")).toBe(true);
    expect(out).not.toContain("Save"); // every letter was substituted
  });

  it("expands the string so an English-only layout truncates in CI, not later", () => {
    expect(pseudoLocalize("Settings").length).toBeGreaterThan("Settings".length + 2);
  });

  it("leaves interpolation placeholders intact", () => {
    // Mangling these would break the very substitution the pseudo-locale exists
    // to exercise.
    expect(pseudoLocalize("Hello {name}, you have {count}")).toContain("{name}");
    expect(pseudoLocalize("Hello {name}, you have {count}")).toContain("{count}");
  });
});

describe("translate", () => {
  it("falls back to the base catalog for a key the locale has not translated", () => {
    registerCatalog("xx", { "settings.settings": "Réglages" });
    return loadCatalog("xx").then(() => {
      expect(translate("settings.settings")).toBe("Réglages");
      // Not in the "xx" catalog, so the bundled English shows through: a
      // half-translated locale is a normal, shippable state.
      const anyBaseKey = Object.keys(baseCatalog)[0];
      expect(translate(anyBaseKey)).toBe(baseCatalog[anyBaseKey]);
    });
  });

  it("returns the key itself when nothing has it", () => {
    // A blank label is invisible in review and ships; a visible key does not.
    expect(translate("nope.not.a.key")).toBe("nope.not.a.key");
  });

  it("is exported as tr, the name used at call sites", () => {
    expect(tr).toBe(translate);
  });
});

describe("plurals", () => {
  beforeEach(() => {
    registerCatalog("de", {
      "t.n.one": "{count} item",
      "t.n.other": "{count} items",
      "t.z.=0": "nothing at all",
      "t.z.one": "{count} thing",
      "t.z.other": "{count} things",
    });
  });

  it("picks the category the locale actually has", async () => {
    await loadCatalog("de");
    expect(translate("t.n", { count: 1 })).toBe("1 item");
    expect(translate("t.n", { count: 5 })).toBe("5 items");
    expect(translate("t.n", { count: 0 })).toBe("0 items");
  });

  it("honours an explicit exact-count override", async () => {
    await loadCatalog("de");
    expect(translate("t.z", { count: 0 })).toBe("nothing at all");
    expect(translate("t.z", { count: 1 })).toBe("1 thing");
  });

  it("does not treat a non-count parameter as a plural", async () => {
    registerCatalog("nl", { "t.plain": "Hi {name}" });
    await loadCatalog("nl");
    expect(translate("t.plain", { name: "Ada" })).toBe("Hi Ada");
  });
});

describe("catalogChain", () => {
  it("tries the region first, then the bare language", () => {
    // A Brazilian user should get generic Portuguese rather than falling all
    // the way back to English.
    expect(catalogChain("pt-BR")).toEqual(["pt-br", "pt"]);
    expect(catalogChain("fr")).toEqual(["fr"]);
    expect(catalogChain("he_IL")).toEqual(["he-il", "he"]);
  });
});

describe("loadCatalog", () => {
  it("needs no request for plain English, which is bundled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await loadCatalog("en");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("needs no request for en-US either, which IS the base", async () => {
    // The source strings are American English. This regressed once: fixing
    // en-GB made the DEFAULT locale 404 for en-us.json on every app boot.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await loadCatalog("en-US");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not re-fetch a regional file it already knows is missing", async () => {
    // "es-ES" tries es-es.json once; after the 404 the session remembers.
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/es.json")
        ? ({ ok: true, json: async () => ({ "a.b": "Hola" }) } as Response)
        : ({ ok: false } as Response),
    );
    vi.stubGlobal("fetch", fetchMock);
    await loadCatalog("es-ES");
    const first = fetchMock.mock.calls.length;
    await loadCatalog("es-ES");
    expect(fetchMock.mock.calls.length).toBe(first); // both hits from cache
    expect(translate("a.b")).toBe("Hola");
  });

  it("still lets a regional English have its own catalog", async () => {
    // "en-GB" is not the base: it carries British spellings and must be able to
    // override them, falling back to the bundled base for everything else.
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/en-gb.json")
        ? ({ ok: true, json: async () => ({ "a.b": "Colour" }) } as Response)
        : ({ ok: false } as Response),
    );
    vi.stubGlobal("fetch", fetchMock);
    await loadCatalog("en-GB");
    expect(translate("a.b")).toBe("Colour");
  });

  it("falls back to the bare language file when the regional one is absent", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/pt.json")
        ? ({ ok: true, json: async () => ({ "a.b": "Olá" }) } as Response)
        : ({ ok: false } as Response),
    );
    vi.stubGlobal("fetch", fetchMock);
    await loadCatalog("pt-BR");
    expect(translate("a.b")).toBe("Olá");
  });

  it("stays on English when the catalog cannot be fetched", async () => {
    // A missing translation file must not break the app: the base catalog is
    // already correct English.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    await loadCatalog("de-DE");
    const anyBaseKey = Object.keys(baseCatalog)[0];
    expect(translate(anyBaseKey)).toBe(baseCatalog[anyBaseKey]);
  });

  it("does not let a slow earlier request clobber the locale in effect now", async () => {
    // Switching de -> fr quickly must land on fr even if de resolves last.
    let releaseDe: (r: Response) => void = () => {};
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("de")) return new Promise<Response>((r) => (releaseDe = r));
      return Promise.resolve({ ok: true, json: async () => ({ "a.b": "Bonjour" }) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    const dePending = loadCatalog("de");
    await loadCatalog("fr");
    releaseDe({ ok: true, json: async () => ({ "a.b": "Guten Tag" }) } as Response);
    await dePending;

    expect(translate("a.b")).toBe("Bonjour");
  });
});

describe("pseudo mode", () => {
  it("mangles base strings but leaves a real translation alone", async () => {
    registerCatalog("zz", { "settings.settings": "Réglages" });
    await loadCatalog("zz");
    setPseudo(true);
    // Translated: already proof the string was externalized, so it is untouched.
    expect(translate("settings.settings")).toBe("Réglages");
    // Untranslated: mangled, so a hard-coded string stands out beside it.
    const baseOnly = Object.keys(baseCatalog).find((k) => k !== "settings.settings")!;
    expect(translate(baseOnly)).toContain("«");
  });
});
