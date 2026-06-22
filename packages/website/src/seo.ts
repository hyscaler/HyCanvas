// SEO/social meta, sitemap, and robots.txt generation (FR-7). Pure string
// builders that merge per-page overrides over the site defaults.

import type { Page } from "@hc/schema";
import { escapeAttr } from "./html";
import { pageHref, pageSlugMap } from "./nav";
import type { Site } from "./types";

export interface MetaContext {
  /** Resolve an asset id (favicon / OG image) to a URL; absent -> omit the tag. */
  resolveAssetUrl?: (assetId: string) => string | undefined;
  /** Base URL for absolute canonical/OG tags, e.g. https://slug.hycanvas.site. */
  baseUrl?: string;
}

function metaTag(name: string, content: string | undefined): string {
  if (!content) return "";
  return `<meta name="${escapeAttr(name)}" content="${escapeAttr(content)}">`;
}

function propTag(property: string, content: string | undefined): string {
  if (!content) return "";
  return `<meta property="${escapeAttr(property)}" content="${escapeAttr(content)}">`;
}

/** Build the <head> meta tags for one page, merging per-page SEO overrides over
 *  the site defaults and emitting Open Graph + Twitter + favicon tags. */
export function metaTags(site: Site, page: Page, ctx: MetaContext = {}): string {
  const seo = site.settings.seo ?? {};
  const override = seo.perPage?.[page.id] ?? {};
  const social = site.settings.social ?? {};

  const title = override.title ?? seo.title ?? page.name ?? site.title;
  const description = override.description ?? seo.description;
  const keywords = override.keywords ?? seo.keywords;
  const canonical = override.canonical ?? seo.canonical;
  const robots = override.robots ?? seo.robots;

  const tags: string[] = [];
  if (title) tags.push(`<title>${escapeAttr(title)}</title>`);
  tags.push(metaTag("description", description));
  if (keywords && keywords.length > 0) tags.push(metaTag("keywords", keywords.join(", ")));
  tags.push(metaTag("robots", robots));
  if (canonical) tags.push(`<link rel="canonical" href="${escapeAttr(canonical)}">`);

  // Favicon link (asset url resolved by the caller).
  if (site.settings.faviconAssetId && ctx.resolveAssetUrl) {
    const url = ctx.resolveAssetUrl(site.settings.faviconAssetId);
    if (url) tags.push(`<link rel="icon" href="${escapeAttr(url)}">`);
  }

  // Open Graph + Twitter card.
  tags.push(propTag("og:title", social.ogTitle ?? title));
  tags.push(propTag("og:description", social.ogDescription ?? description));
  tags.push(propTag("og:type", "website"));
  if (canonical) tags.push(propTag("og:url", canonical));
  if (social.ogImageAssetId && ctx.resolveAssetUrl) {
    const url = ctx.resolveAssetUrl(social.ogImageAssetId);
    if (url) tags.push(propTag("og:image", url));
  }
  const twitterCard = social.twitterCard ?? "summary_large_image";
  tags.push(metaTag("twitter:card", twitterCard));
  tags.push(metaTag("twitter:title", social.ogTitle ?? title));
  tags.push(metaTag("twitter:description", social.ogDescription ?? description));

  return tags.filter(Boolean).join("\n");
}

/** schema.org JSON-LD structured data (WebSite + WebPage) for richer search
 *  results (FR-7). Returns a ready-to-embed <script type="application/ld+json">
 *  block, or "" when there is nothing meaningful to describe. */
export function jsonLd(site: Site, page: Page, ctx: MetaContext = {}): string {
  const seo = site.settings.seo ?? {};
  const override = seo.perPage?.[page.id] ?? {};
  const title = override.title ?? seo.title ?? page.name ?? site.title;
  const description = override.description ?? seo.description;
  const url = override.canonical ?? seo.canonical ?? ctx.baseUrl;
  const graph: Record<string, unknown>[] = [
    { "@type": "WebSite", name: site.title, ...(ctx.baseUrl ? { url: ctx.baseUrl } : {}) },
  ];
  const webPage: Record<string, unknown> = { "@type": "WebPage", name: title };
  if (description) webPage.description = description;
  if (url) webPage.url = url;
  graph.push(webPage);
  const doc = { "@context": "https://schema.org", "@graph": graph };
  // JSON.stringify already escapes the characters that matter inside a script
  // body except "</" which could close the tag early; neutralize it.
  const json = JSON.stringify(doc).replace(/<\//g, "<\\/");
  return `<script type="application/ld+json">${json}</script>`;
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

/** Generate a sitemap.xml listing every visible page at its absolute URL. */
export function sitemapXml(site: Site, pages: Page[], baseUrl: string): string {
  const slugs = pageSlugMap(site, pages);
  const order = site.pageOrder && site.pageOrder.length > 0 ? site.pageOrder : pages.map((p) => p.id);
  const urls: string[] = [];
  for (const id of order) {
    const slug = slugs.get(id);
    if (slug === undefined) continue;
    const href = pageHref(slug, id === site.homePageId);
    urls.push(`  <url>\n    <loc>${escapeAttr(joinUrl(baseUrl, href))}</loc>\n  </url>`);
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${urls.join("\n")}\n` +
    `</urlset>\n`
  );
}

/** Generate robots.txt. Disallows everything when SEO robots is "noindex";
 *  otherwise allows all and points at the sitemap. */
export function robotsTxt(site: Site, baseUrl: string): string {
  const robots = site.settings.seo?.robots ?? "";
  const disallowAll = /noindex|disallow/i.test(robots);
  const lines = ["User-agent: *"];
  lines.push(disallowAll ? "Disallow: /" : "Disallow:");
  lines.push(`Sitemap: ${joinUrl(baseUrl, "/sitemap.xml")}`);
  return lines.join("\n") + "\n";
}
