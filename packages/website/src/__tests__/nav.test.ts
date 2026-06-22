import { describe, expect, it } from "vitest";
import {
  buildNav,
  kebab,
  pageHref,
  pageSlug,
  pageSlugMap,
  resolveElementLink,
  resolveNavHref,
  type NavContext,
} from "../nav";
import type { NavItem } from "../types";
import { page, sampleSite } from "./fixtures";

describe("kebab + pageSlug", () => {
  it("kebab-cases names", () => {
    expect(kebab("Hello World")).toBe("hello-world");
    expect(kebab("  Foo / Bar! ")).toBe("foo-bar");
    expect(kebab("Already-Kebab")).toBe("already-kebab");
  });

  it("falls back to page-N when unnamed", () => {
    expect(pageSlug(page("p", ""), 0)).toBe("page-1");
    expect(pageSlug({ ...page("p", ""), name: undefined }, 4)).toBe("page-5");
  });

  it("uses the kebab of the name", () => {
    expect(pageSlug(page("p", "Contact Us"), 0)).toBe("contact-us");
  });
});

describe("resolveNavHref", () => {
  const ctx: NavContext = {
    slugForPage: (id) => (id === "home" ? "home" : id === "about" ? "about" : undefined),
    homePageId: "home",
  };

  it("resolves a page target to a slug path, home to /", () => {
    const home: NavItem = { id: "1", label: "H", target: { kind: "page", pageId: "home" }, visible: true };
    const about: NavItem = { id: "2", label: "A", target: { kind: "page", pageId: "about" }, visible: true };
    expect(resolveNavHref(home, ctx)).toBe("/");
    expect(resolveNavHref(about, ctx)).toBe("/about/");
  });

  it("resolves an anchor target to #id", () => {
    const item: NavItem = {
      id: "3",
      label: "Sec",
      target: { kind: "anchor", pageId: "home", anchor: "pricing" },
      visible: true,
    };
    expect(resolveNavHref(item, ctx)).toBe("#pricing");
  });

  it("resolves a cross-page anchor to /slug/#id", () => {
    const item: NavItem = {
      id: "3b",
      label: "Sec",
      target: { kind: "anchor", pageId: "about", anchor: "team" },
      visible: true,
    };
    expect(resolveNavHref(item, ctx)).toBe("/about/#team");
  });

  it("resolves an external target to its url", () => {
    const item: NavItem = {
      id: "4",
      label: "Ext",
      target: { kind: "external", url: "https://example.com" },
      visible: true,
    };
    expect(resolveNavHref(item, ctx)).toBe("https://example.com");
  });

  it("falls back to # for a missing page", () => {
    const item: NavItem = { id: "5", label: "X", target: { kind: "page", pageId: "ghost" }, visible: true };
    expect(resolveNavHref(item, ctx)).toBe("#");
  });
});

describe("pageHref", () => {
  it("maps home to / and others to /slug/", () => {
    expect(pageHref("anything", true)).toBe("/");
    expect(pageHref("about", false)).toBe("/about/");
  });
});

describe("buildNav", () => {
  it("drops hidden items and resolves hrefs", () => {
    const site = sampleSite();
    const pages = [page("home", "Home"), page("about", "About")];
    const nav = buildNav(site, pages);
    expect(nav.map((n) => n.label)).toEqual(["Home", "About", "Docs"]);
    expect(nav[0].href).toBe("/");
    expect(nav[1].href).toBe("/about/");
    expect(nav[2].href).toBe("https://docs.example.com");
  });
});

describe("pageSlugMap", () => {
  it("de-duplicates same-named pages", () => {
    const site = { ...sampleSite(), pageOrder: ["a", "b"] };
    const pages = [page("a", "Team"), page("b", "Team")];
    const map = pageSlugMap(site, pages);
    expect(map.get("a")).toBe("team");
    expect(map.get("b")).toBe("team-2");
  });
});

describe("resolveElementLink", () => {
  const ctx: NavContext = {
    slugForPage: (id) => (id === "home" ? "home" : id === "p2" ? "p2" : undefined),
    homePageId: "home",
  };

  it("resolves page/anchor/url/email", () => {
    expect(resolveElementLink({ kind: "page", target: "p2" }, ctx)).toBe("/p2/");
    expect(resolveElementLink({ kind: "page", target: "home" }, ctx)).toBe("/");
    expect(resolveElementLink({ kind: "anchor", target: "sec" }, ctx)).toBe("#sec");
    expect(resolveElementLink({ kind: "url", target: "https://x.com" }, ctx)).toBe("https://x.com");
    expect(resolveElementLink({ kind: "email", target: "a@b.com" }, ctx)).toBe("mailto:a@b.com");
    expect(resolveElementLink({ kind: "email", target: "mailto:a@b.com" }, ctx)).toBe("mailto:a@b.com");
  });

  it("falls back to # for a broken page link", () => {
    expect(resolveElementLink({ kind: "page", target: "ghost" }, ctx)).toBe("#");
  });
});
