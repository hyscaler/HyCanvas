// UI locale and direction (F38 FR-9, FR-10). The document was hardcoded to
// `<html lang="en">` with no `dir`, so an Arabic or Hebrew user got an
// unmirrored interface that also misreported its language to assistive
// technology.
import { describe, expect, it } from "vitest";
import { isRtlLocale, directionFor, resolvedLocale, applyLocale, setLocalePreference, LOCALE_BOOT_SCRIPT } from "./locale";

describe("isRtlLocale", () => {
  it("recognises the right-to-left languages, with or without a region", () => {
    for (const tag of ["ar", "ar-EG", "he", "he-IL", "fa", "fa-IR", "ur", "ps", "ckb", "dv", "yi", "ug", "sd"]) {
      expect(isRtlLocale(tag), tag).toBe(true);
    }
  });

  it("leaves left-to-right languages alone", () => {
    for (const tag of ["en", "en-GB", "fr", "de", "es", "hi", "ja", "zh-Hans", "ko", "ru", "th"]) {
      expect(isRtlLocale(tag), tag).toBe(false);
    }
  });

  it("is case and separator insensitive, because tags arrive in every shape", () => {
    expect(isRtlLocale("AR-eg")).toBe(true);
    expect(isRtlLocale("he_IL")).toBe(true);
    expect(isRtlLocale("HE")).toBe(true);
  });

  it("still recognises the legacy Hebrew code some systems emit", () => {
    // Older platforms emit "iw" rather than "he"; treating it as left-to-right
    // would mirror nothing for those users.
    expect(isRtlLocale("iw")).toBe(true);
    expect(isRtlLocale("iw-IL")).toBe(true);
  });

  it("does not confuse a region that merely looks like an RTL tag", () => {
    // "en-AR" is English as used in Argentina, not Arabic.
    expect(isRtlLocale("en-AR")).toBe(false);
  });
});

describe("directionFor", () => {
  it("maps languages to a document direction", () => {
    expect(directionFor("ar")).toBe("rtl");
    expect(directionFor("en")).toBe("ltr");
    expect(directionFor("")).toBe("ltr");
  });
});

describe("applyLocale", () => {
  // No DOM in this test environment, so the target is injected. The real call
  // passes document.documentElement.
  const target = () => ({ lang: "", dir: "" });

  it("sets lang and dir from the locale", () => {
    const el = target();
    applyLocale("he-IL", el);
    expect(el).toEqual({ lang: "he-IL", dir: "rtl" });

    applyLocale("en-GB", el);
    expect(el).toEqual({ lang: "en-GB", dir: "ltr" });
  });

  it("falls back to the browser locale when nothing is stored", () => {
    const el = target();
    applyLocale(null, el);
    expect(el.lang).toBe(resolvedLocale(null));
    expect(el.dir).toBe(directionFor(resolvedLocale(null)));
  });

  it("applies immediately when the preference is set", () => {
    const el = target();
    setLocalePreference("ar", el);
    expect(el.dir).toBe("rtl");
    setLocalePreference("en", el);
    expect(el.dir).toBe("ltr");
  });
});

describe("LOCALE_BOOT_SCRIPT", () => {
  it("resolves the same way the module does, since it runs before first paint", () => {
    // The snippet is duplicated logic by necessity (it cannot import), so it is
    // executed here against the same cases to keep the two from drifting.
    const run = (stored: string | null, navLang: string) => {
      const el = { lang: "", dir: "" };
      const fn = new Function("localStorage", "navigator", "document", LOCALE_BOOT_SCRIPT);
      fn(
        { getItem: () => stored },
        { language: navLang },
        { documentElement: el },
      );
      return el;
    };
    expect(run("ar", "en-US")).toEqual({ lang: "ar", dir: "rtl" });
    expect(run(null, "he-IL")).toEqual({ lang: "he-IL", dir: "rtl" });
    expect(run(null, "en-US")).toEqual({ lang: "en-US", dir: "ltr" });
    expect(run("iw", "en-US").dir).toBe("rtl");
  });

  it("never throws, whatever the environment does", () => {
    const fn = new Function("localStorage", "navigator", "document", LOCALE_BOOT_SCRIPT);
    expect(() =>
      fn(
        {
          getItem: () => {
            throw new Error("blocked");
          },
        },
        {},
        { documentElement: {} },
      ),
    ).not.toThrow();
  });
});
