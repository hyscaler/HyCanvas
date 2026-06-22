import { describe, expect, it } from "vitest";
import { metaTags, robotsTxt, sitemapXml, jsonLd } from "../seo";
import { page, sampleSite } from "./fixtures";

const assetUrls: Record<string, string> = {
  favicon1: "https://cdn.example.com/favicon.png",
  og1: "https://cdn.example.com/og.png",
};
const ctx = { resolveAssetUrl: (id: string) => assetUrls[id], baseUrl: "https://acme.hycanvas.site" };

describe("metaTags", () => {
  it("emits title/description/keywords/canonical/robots from site defaults", () => {
    const site = sampleSite();
    const tags = metaTags(site, page("home", "Home"), ctx);
    expect(tags).toContain("<title>Acme Co - Home</title>");
    expect(tags).toContain('content="We build things"');
    expect(tags).toContain('name="keywords" content="acme, widgets"');
    expect(tags).toContain('name="robots" content="index,follow"');
    expect(tags).toContain('<link rel="canonical" href="https://acme.hycanvas.site/">');
  });

  it("merges per-page SEO overrides over site defaults", () => {
    const site = sampleSite();
    const tags = metaTags(site, page("about", "About"), ctx);
    expect(tags).toContain("<title>About Acme</title>");
    expect(tags).toContain('content="Our story"');
  });

  it("emits Open Graph and Twitter card tags", () => {
    const site = sampleSite();
    const tags = metaTags(site, page("home", "Home"), ctx);
    expect(tags).toContain('property="og:title" content="Acme Social"');
    expect(tags).toContain('property="og:image" content="https://cdn.example.com/og.png"');
    expect(tags).toContain('property="og:type" content="website"');
    expect(tags).toContain('name="twitter:card" content="summary_large_image"');
  });

  it("emits the favicon link", () => {
    const site = sampleSite();
    const tags = metaTags(site, page("home", "Home"), ctx);
    expect(tags).toContain('<link rel="icon" href="https://cdn.example.com/favicon.png">');
  });
});

describe("sitemapXml", () => {
  it("lists every page with the base url", () => {
    const site = sampleSite();
    const pages = [page("home", "Home"), page("about", "About")];
    const xml = sitemapXml(site, pages, "https://acme.hycanvas.site");
    expect(xml).toContain("<?xml");
    expect(xml).toContain("<urlset");
    expect(xml).toContain("<loc>https://acme.hycanvas.site/</loc>");
    expect(xml).toContain("<loc>https://acme.hycanvas.site/about/</loc>");
    expect((xml.match(/<url>/g) ?? []).length).toBe(2);
  });
});

describe("robotsTxt", () => {
  it("allows all and points at the sitemap by default", () => {
    const site = sampleSite();
    const txt = robotsTxt(site, "https://acme.hycanvas.site");
    expect(txt).toContain("User-agent: *");
    expect(txt).toContain("Disallow:\n");
    expect(txt).toContain("Sitemap: https://acme.hycanvas.site/sitemap.xml");
  });

  it("disallows everything when robots is noindex", () => {
    const site = sampleSite();
    site.settings.seo.robots = "noindex,nofollow";
    const txt = robotsTxt(site, "https://acme.hycanvas.site");
    expect(txt).toContain("Disallow: /");
  });
});

describe("jsonLd", () => {
  it("emits a WebSite + WebPage schema.org graph as a script block", () => {
    const out = jsonLd(sampleSite(), page("home", "Home"), ctx);
    expect(out.startsWith('<script type="application/ld+json">')).toBe(true);
    expect(out.endsWith("</script>")).toBe(true);
    const json = out.replace('<script type="application/ld+json">', "").replace("</script>", "").replace(/<\\\//g, "</");
    const data = JSON.parse(json);
    expect(data["@context"]).toBe("https://schema.org");
    const types = data["@graph"].map((g: { "@type": string }) => g["@type"]);
    expect(types).toContain("WebSite");
    expect(types).toContain("WebPage");
    const site = data["@graph"].find((g: { "@type": string }) => g["@type"] === "WebSite");
    expect(site.url).toBe("https://acme.hycanvas.site");
  });

  it("escapes a closing-script sequence so the tag cannot be broken out of", () => {
    const out = jsonLd(sampleSite(), page("x", "</script><img>"), ctx);
    expect(out).not.toContain("</script><img>");
    expect(out.endsWith("</script>")).toBe(true);
  });
});
