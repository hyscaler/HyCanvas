// Navigation and link resolution (FR-3/FR-4). Pure mapping from the site nav
// model and per-element links (F25 ElementLink) to published-output hrefs.

import type { ElementLink, Page } from "@hc/schema";
import { safeUrl } from "./html";
import type { NavItem, Site } from "./types";

/** Kebab-case a string for use as a URL slug: lowercased, non-alphanumeric runs
 *  collapsed to single hyphens, trimmed of leading/trailing hyphens. */
export function kebab(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Slug for a page: kebab of its name, or `page-N` (1-based) when unnamed. */
export function pageSlug(page: Page, index: number): string {
  const fromName = page.name ? kebab(page.name) : "";
  return fromName || `page-${index + 1}`;
}

/** Resolve the href for a page given a slug. The home page maps to "/", any
 *  other page to "/<slug>/". A trailing slash keeps relative anchors stable. */
export function pageHref(slug: string, isHome: boolean): string {
  return isHome ? "/" : `/${slug}/`;
}

/** Context the nav/link resolvers need: a slug per page id, plus the home id. */
export interface NavContext {
  /** Maps a page id to its slug (already computed, see `pageSlug`). */
  slugForPage: (pageId: string) => string | undefined;
  homePageId?: string;
}

/** Resolve a NavItem to an href string. */
export function resolveNavHref(item: NavItem, ctx: NavContext): string {
  const t = item.target;
  switch (t.kind) {
    case "page": {
      const slug = ctx.slugForPage(t.pageId);
      if (slug === undefined) return "#";
      return pageHref(slug, t.pageId === ctx.homePageId);
    }
    case "anchor": {
      const anchor = t.anchor ?? "";
      if (t.pageId && t.pageId !== ctx.homePageId) {
        const slug = ctx.slugForPage(t.pageId);
        if (slug !== undefined) return `${pageHref(slug, false)}#${anchor}`;
      }
      return `#${anchor}`;
    }
    case "external":
      return safeUrl(t.url);
    default:
      return "#";
  }
}

/** A flattened nav entry ready to emit as a menu link, with nested children. */
export interface ResolvedNavItem {
  label: string;
  href: string;
  children: ResolvedNavItem[];
}

/** Build the resolved nav tree for a site. Hidden items are dropped; a nav item
 *  whose page is hidden from nav simply does not appear in `site.nav`. */
export function buildNav(site: Site, pages: Page[]): ResolvedNavItem[] {
  const slugByPage = pageSlugMap(site, pages);
  const ctx: NavContext = {
    slugForPage: (id) => slugByPage.get(id),
    homePageId: site.homePageId,
  };
  const walk = (items: NavItem[]): ResolvedNavItem[] =>
    items
      .filter((it) => it.visible !== false)
      .map((it) => ({
        label: it.label,
        href: resolveNavHref(it, ctx),
        children: it.children ? walk(it.children) : [],
      }));
  return walk(site.nav ?? []);
}

/** Compute the slug for every page in site order, with a fallback to file order.
 *  Slugs are de-duplicated by appending `-N` so two same-named pages stay
 *  distinct (slug collisions are a hard error in hosting; here we just keep them
 *  stable and unique within the bundle). */
export function pageSlugMap(site: Site, pages: Page[]): Map<string, string> {
  const byId = new Map(pages.map((p) => [p.id, p] as const));
  const order = site.pageOrder && site.pageOrder.length > 0 ? site.pageOrder : pages.map((p) => p.id);
  const out = new Map<string, string>();
  const used = new Set<string>();
  let i = 0;
  for (const id of order) {
    const page = byId.get(id);
    if (!page) continue;
    let slug = pageSlug(page, i);
    if (used.has(slug)) {
      let n = 2;
      while (used.has(`${slug}-${n}`)) n++;
      slug = `${slug}-${n}`;
    }
    used.add(slug);
    out.set(id, slug);
    i++;
  }
  return out;
}

/** Resolve a scene-element link (F25 ElementLink) to an href on the published
 *  site. `page` targets a page id, `anchor` an in-page element id, `url` an
 *  external URL, `email` a mailto. Falls back to "#" for a broken target. */
export function resolveElementLink(link: ElementLink, ctx: NavContext): string {
  switch (link.kind) {
    case "page": {
      const slug = ctx.slugForPage(link.target);
      if (slug === undefined) return "#";
      return pageHref(slug, link.target === ctx.homePageId);
    }
    case "anchor":
      return `#${link.target}`;
    case "email":
      return link.target.startsWith("mailto:") ? link.target : `mailto:${link.target}`;
    case "url":
      return safeUrl(link.target);
    default:
      return "#";
  }
}
