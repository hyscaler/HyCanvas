// The core pure exporter (FR-10/FR-12): a scene-graph -> responsive static
// HTML/CSS renderer. Each node becomes an absolutely-positioned element whose
// left/top/width/height/transform mirror the engine geometry (engine
// scene.ts/render2d.ts), so the static output matches the editor.

import type {
  FrameNode,
  GroupNode,
  ImageNode,
  LineNode,
  Node,
  PathNode,
  ShapeNode,
  StickyNode,
  TextNode,
  Page,
  Transform,
} from "@hc/schema";
import { colorToCss, cssFontFamily, escapeAttr, escapeHtml, fillToCss, safeUrl, style } from "./html";
import { formToHtml } from "./forms";
import { resolveElementLink, type NavContext } from "./nav";
import type { FormBlock } from "./types";

/** A per-breakpoint override on a node (read from an optional `responsive`
 *  field on the scene node; round-trips in the open file format). */
export interface ResponsiveOverride {
  transform?: Partial<Transform>;
  size?: { width?: number; height?: number };
  hidden?: boolean;
}

export type Breakpoint = "tablet" | "mobile";

/** A node may carry per-breakpoint overrides under `responsive`. */
type WithResponsive = Node & {
  responsive?: Partial<Record<Breakpoint, ResponsiveOverride>>;
};

export interface Breakpoints {
  desktop: number;
  tablet: number;
  mobile: number;
}

export const defaultBreakpoints: Breakpoints = { desktop: 1280, tablet: 768, mobile: 390 };

export interface RenderContext {
  /** Resolve an asset id (or a direct url) to a servable URL. */
  resolveAssetUrl: (assetIdOrUrl: string) => string;
  /** Resolve a scene element link to an href (page/anchor/external/email). */
  navContext?: NavContext;
  breakpoints?: Breakpoints;
  /** Form blocks keyed by node id, when forms live outside the scene graph. */
  formsByNodeId?: Record<string, FormBlock>;
}

/** Compose the CSS `transform` for a node from its doc-02 transform. Translation
 *  is expressed via left/top; this carries rotation/scale/skew around the
 *  configured origin (default top-left, matching the engine's `fromTransform`). */
function nodeTransformCss(t: Transform): string {
  const parts: string[] = [];
  if (t.rotation) parts.push(`rotate(${t.rotation}deg)`);
  if (t.scaleX !== 1 || t.scaleY !== 1) parts.push(`scale(${t.scaleX}, ${t.scaleY})`);
  if (t.skewX) parts.push(`skewX(${t.skewX}deg)`);
  if (t.skewY) parts.push(`skewY(${t.skewY}deg)`);
  return parts.join(" ");
}

/** Clamp a text-align value to the CSS allow-list so a hostile value cannot be
 *  interpolated into the `style` attribute. Defaults to `left`. */
function clampAlign(align: string | undefined): "left" | "center" | "right" {
  return align === "center" || align === "right" ? align : "left";
}

function transformOriginCss(t: Transform): string | undefined {
  if (!t.origin) return undefined;
  return `${t.origin.x * 100}% ${t.origin.y * 100}%`;
}

/** Base positioning style every node element gets: absolute box at the node's
 *  transform translation, sized to its box, with rotation/scale via transform. */
function positionStyle(node: Node): Record<string, string | number | undefined> {
  const t = node.transform;
  const tf = nodeTransformCss(t);
  return {
    position: "absolute",
    left: `${t.x}px`,
    top: `${t.y}px`,
    width: `${node.size.width}px`,
    height: `${node.size.height}px`,
    opacity: node.opacity !== 1 ? node.opacity : undefined,
    transform: tf || undefined,
    "transform-origin": tf ? transformOriginCss(t) : undefined,
  };
}

function isContainerNode(node: Node): node is FrameNode | GroupNode {
  return node.type === "frame" || node.type === "group" || node.type === "grid";
}

function wrapLink(inner: string, node: Node, ctx: RenderContext): string {
  if (!node.link || !ctx.navContext) return inner;
  // resolveElementLink already sanitizes url targets; safeUrl here is
  // defense-in-depth in case the resolved href ever carries a scheme.
  const href = safeUrl(resolveElementLink(node.link, ctx.navContext));
  const target = node.link.kind === "url" ? ` target="_blank" rel="noopener"` : "";
  return `<a href="${escapeAttr(href)}"${target}>${inner}</a>`;
}

/** Render the inner content (no positioning wrapper) for a node. */
function renderNodeInner(node: Node, ctx: RenderContext): string {
  // A form attached to this node (via ctx, `data.form`, or a "form" type) wins
  // over the node's own type, so a form block placed on any node renders as one.
  const form = formForNode(node, ctx);
  if (form) return formToHtml(form);
  switch (node.type) {
    case "text":
      return renderText(node as TextNode);
    case "image":
      return renderImage(node as ImageNode, ctx);
    case "shape":
      return renderShape(node as ShapeNode);
    case "line":
    case "path":
      return renderVector(node, ctx);
    case "sticky":
      return renderSticky(node as StickyNode);
    case "frame":
    case "group":
    case "grid":
      return renderChildren(node as FrameNode | GroupNode, ctx);
    case "embed":
      return renderEmbed(node, ctx);
    default: {
      // Form blocks may be carried as an unknown "form" node, or supplied via ctx.
      const form = formForNode(node, ctx);
      if (form) return formToHtml(form);
      return ""; // graceful empty positioned box for unknown/unsupported nodes
    }
  }
}

function formForNode(node: Node, ctx: RenderContext): FormBlock | undefined {
  if (ctx.formsByNodeId && ctx.formsByNodeId[node.id]) return ctx.formsByNodeId[node.id];
  // A scene node may carry a form directly under `data.form` or as a "form" type.
  const anyNode = node as unknown as { type: string; fields?: unknown; afterSubmit?: unknown; data?: { form?: FormBlock } };
  if (anyNode.data?.form) return anyNode.data.form;
  if (anyNode.type === "form" && Array.isArray(anyNode.fields) && anyNode.afterSubmit) {
    return anyNode as unknown as FormBlock;
  }
  return undefined;
}

/** Render one node as a positioned element with inline CSS. */
export function renderNode(node: Node, ctx: RenderContext): string {
  if (node.hidden) return "";
  const inner = renderNodeInner(node, ctx);
  const cls = `oc-node oc-${node.type}`;
  const idAttr = node.id ? ` id="${escapeAttr(node.id)}"` : "";
  const el =
    `<div${idAttr} class="${cls}" data-oc-id="${escapeAttr(node.id)}" style="${style(positionStyle(node))}">` +
    inner +
    `</div>`;
  return wrapLink(el, node, ctx);
}

function renderChildren(node: FrameNode | GroupNode, ctx: RenderContext): string {
  let bg = "";
  const fills = (node as FrameNode).fills;
  if (fills && fills.length > 0) {
    bg = `<div class="oc-frame-bg" style="${style({
      position: "absolute",
      inset: "0",
      background: fillToCss(fills[0]),
    })}"></div>`;
  }
  const children = (node.children ?? []).map((c) => renderNode(c, ctx)).join("");
  return bg + children;
}

function renderText(node: TextNode): string {
  const paras = node.content ?? [];
  const pad = node.box?.padding;
  const wrapStyle = style({
    position: "absolute",
    inset: "0",
    padding: pad ? `${pad.t}px ${pad.r}px ${pad.b}px ${pad.l}px` : undefined,
    display: "flex",
    "flex-direction": "column",
    "justify-content":
      node.box?.verticalAlign === "middle"
        ? "center"
        : node.box?.verticalAlign === "bottom"
          ? "flex-end"
          : "flex-start",
  });
  const body = paras
    .map((p) => {
      const align = clampAlign(p.style?.align);
      const runs = (p.runs ?? [])
        .map((r) => {
          const s = r.style;
          const css = style({
            "font-family": s.fontFamily ? cssFontFamily(s.fontFamily) : undefined,
            "font-size": s.fontSize ? `${s.fontSize}px` : undefined,
            "font-style": s.fontStyle && s.fontStyle !== "normal" ? s.fontStyle : undefined,
            color: s.fill?.type === "solid" ? colorToCss(s.fill.color) : undefined,
            "letter-spacing": s.letterSpacing ? `${s.letterSpacing}px` : undefined,
            "text-decoration":
              s.decoration && s.decoration.length > 0 ? s.decoration.join(" ") : undefined,
          });
          return `<span style="${css}">${escapeHtml(r.text)}</span>`;
        })
        .join("");
      return `<p style="${style({ margin: 0, "text-align": align })}">${runs}</p>`;
    })
    .join("");
  return `<div class="oc-text-wrap" style="${wrapStyle}">${body}</div>`;
}

function renderImage(node: ImageNode, ctx: RenderContext): string {
  // Run the resolved asset URL through safeUrl as defense-in-depth so a
  // resolver that returns a javascript:/data: URL cannot reach the <img src>.
  const url = safeUrl(ctx.resolveAssetUrl(node.source?.assetId ?? ""));
  const objectFit =
    node.fit === "cover"
      ? "cover"
      : node.fit === "stretch"
        ? "fill"
        : node.fit === "none"
          ? "none"
          : "contain";
  const focal = node.focalPoint;
  const imgStyle = style({
    width: "100%",
    height: "100%",
    "object-fit": objectFit,
    "object-position": focal ? `${focal.x * 100}% ${focal.y * 100}%` : undefined,
    display: "block",
  });
  const alt = node.alt ?? node.name ?? "";
  return `<img src="${escapeAttr(url)}" alt="${escapeAttr(alt)}" loading="lazy" style="${imgStyle}">`;
}

function shapeBackground(node: ShapeNode): string {
  return node.fills && node.fills.length > 0 ? fillToCss(node.fills[0]) : "transparent";
}

function borderRadiusCss(node: ShapeNode): string | undefined {
  if (node.shape === "ellipse") return "50%";
  const cr = node.cornerRadius;
  if (cr) return `${cr.topLeft}px ${cr.topRight}px ${cr.bottomRight}px ${cr.bottomLeft}px`;
  return undefined;
}

function strokeCss(node: ShapeNode): string | undefined {
  const s = node.stroke;
  if (!s) return undefined;
  const color = s.fill.type === "solid" ? colorToCss(s.fill.color) : "currentColor";
  return `${s.width}px solid ${color}`;
}

function renderShape(node: ShapeNode): string {
  // rect/ellipse render as a styled box; polygons/stars/custom fall back to SVG.
  if (node.shape === "rect" || node.shape === "ellipse" || node.shape === "custom") {
    const css = style({
      position: "absolute",
      inset: "0",
      background: shapeBackground(node),
      "border-radius": borderRadiusCss(node),
      border: strokeCss(node),
    });
    return `<div class="oc-shape-box" style="${css}"></div>`;
  }
  return renderShapeSvg(node);
}

function renderShapeSvg(node: ShapeNode): string {
  const { width: w, height: h } = node.size;
  const pts = polyPoints(node);
  const fill = node.fills && node.fills[0]?.type === "solid" ? colorToCss(node.fills[0].color) : "none";
  const stroke = node.stroke?.fill.type === "solid" ? colorToCss(node.stroke.fill.color) : "none";
  const sw = node.stroke?.width ?? 0;
  const d = pts.map((p) => `${p.x},${p.y}`).join(" ");
  return (
    `<svg class="oc-shape-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ` +
    `style="position:absolute;inset:0" preserveAspectRatio="none">` +
    `<polygon points="${escapeAttr(d)}" fill="${escapeAttr(fill)}" stroke="${escapeAttr(stroke)}" stroke-width="${sw}"/>` +
    `</svg>`
  );
}

/** Polygon vertices for star/polygon/triangle (mirrors engine render2d). */
function polyPoints(node: ShapeNode): { x: number; y: number }[] {
  const { width: w, height: h } = node.size;
  if (node.shape === "triangle") {
    return [
      { x: w / 2, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ];
  }
  const sides = Math.max(3, Math.floor(node.sides ?? 5));
  const star = node.shape === "star";
  const inner = star ? (node.innerRadius ?? 0.5) : 1;
  const count = star ? sides * 2 : sides;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const ang = -Math.PI / 2 + (Math.PI * 2 * i) / count;
    const r = star && i % 2 === 1 ? inner : 1;
    out.push({ x: w / 2 + Math.cos(ang) * (w / 2) * r, y: h / 2 + Math.sin(ang) * (h / 2) * r });
  }
  return out;
}

/** Render a line or path node as inline SVG (selectable, crisp at any scale). */
function renderVector(node: Node, _ctx: RenderContext): string {
  const { width: w, height: h } = node.size;
  if (node.type === "line") {
    const ln = node as LineNode;
    const pts = ln.points ?? [];
    if (pts.length < 2) return "";
    const d = pts.map((p) => `${p.x},${p.y}`).join(" ");
    const stroke = ln.stroke?.fill.type === "solid" ? colorToCss(ln.stroke.fill.color) : "#000";
    const sw = ln.stroke?.width ?? 1;
    return (
      `<svg class="oc-line" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ` +
      `style="position:absolute;inset:0;overflow:visible" preserveAspectRatio="none">` +
      `<polyline points="${escapeAttr(d)}" fill="none" stroke="${escapeAttr(stroke)}" stroke-width="${sw}"/>` +
      `</svg>`
    );
  }
  const pn = node as PathNode;
  const segs = pn.segments ?? [];
  if (segs.length < 2) return "";
  const contourD = (ss: typeof segs, closed: boolean): string => {
    let d = `M ${ss[0].x} ${ss[0].y}`;
    for (let i = 1; i < ss.length; i++) {
      const from = ss[i - 1];
      const to = ss[i];
      if (from.cOut || to.cIn) {
        const c1 = from.cOut ?? { x: from.x, y: from.y };
        const c2 = to.cIn ?? { x: to.x, y: to.y };
        d += ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${to.x} ${to.y}`;
      } else {
        d += ` L ${to.x} ${to.y}`;
      }
    }
    if (closed) d += " Z";
    return d;
  };
  const parts = [contourD(segs, !!pn.closed)];
  // Extra contours of a compound path join the same path data;
  // fill-rule="evenodd" makes interior contours cut holes.
  for (const c of pn.contours ?? []) {
    if (c.segments.length >= 2) parts.push(contourD(c.segments, c.closed));
  }
  const rule = parts.length > 1 ? ` fill-rule="evenodd"` : "";
  const fill = pn.fills && pn.fills[0]?.type === "solid" ? colorToCss(pn.fills[0].color) : "none";
  const stroke = pn.stroke?.fill.type === "solid" ? colorToCss(pn.stroke.fill.color) : "none";
  const sw = pn.stroke?.width ?? 0;
  return (
    `<svg class="oc-path" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ` +
    `style="position:absolute;inset:0;overflow:visible" preserveAspectRatio="none">` +
    `<path d="${escapeAttr(parts.join(" "))}"${rule} fill="${escapeAttr(fill)}" stroke="${escapeAttr(stroke)}" stroke-width="${sw}"/>` +
    `</svg>`
  );
}

function renderSticky(node: StickyNode): string {
  const bg = fillToCss(node.fill);
  const cardStyle = style({
    position: "absolute",
    inset: "0",
    background: bg,
    "border-radius": "8px",
    padding: "12px",
    color: colorToCss(node.textColor),
    "font-family": cssFontFamily(node.fontFamily),
    "text-align": clampAlign(node.align),
    "white-space": "pre-wrap",
    "box-sizing": "border-box",
  });
  return `<div class="oc-sticky-card" style="${cardStyle}">${escapeHtml(node.text ?? "")}</div>`;
}

function renderEmbed(node: Node, _ctx: RenderContext): string {
  const e = node as unknown as { src?: string };
  if (!e.src) return "";
  const css = style({ position: "absolute", inset: "0", width: "100%", height: "100%", border: "0" });
  return `<iframe class="oc-embed" src="${escapeAttr(safeUrl(e.src))}" style="${css}" loading="lazy"></iframe>`;
}

/** Render a page's scene to a positioned HTML fragment (the page wrapper). */
export function renderPageHtml(page: Page, ctx: RenderContext): string {
  const wrapStyle = style({
    position: "relative",
    width: `${page.width}px`,
    height: `${page.height}px`,
    margin: "0 auto",
    overflow: "hidden",
    background: page.background ? fillToCss(page.background) : "#ffffff",
  });
  const children = (page.children ?? []).map((c) => renderNode(c, ctx)).join("");
  return `<div class="oc-page" data-oc-page="${escapeAttr(page.id)}" style="${wrapStyle}">${children}</div>`;
}

/** Collect nodes (depth-first) that carry per-breakpoint overrides. */
function nodesWithOverrides(page: Page): WithResponsive[] {
  const out: WithResponsive[] = [];
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      const wr = n as WithResponsive;
      if (wr.responsive) out.push(wr);
      const kids = (n as { children?: Node[] }).children;
      if (kids) walk(kids);
    }
  };
  walk(page.children ?? []);
  return out;
}

function overrideToCss(node: WithResponsive, ov: ResponsiveOverride): string {
  if (ov.hidden) return `[data-oc-id="${cssEscape(node.id)}"]{display:none}`;
  const t = node.transform;
  const decls: string[] = [];
  if (ov.transform?.x !== undefined) decls.push(`left:${ov.transform.x}px`);
  if (ov.transform?.y !== undefined) decls.push(`top:${ov.transform.y}px`);
  if (ov.size?.width !== undefined) decls.push(`width:${ov.size.width}px`);
  if (ov.size?.height !== undefined) decls.push(`height:${ov.size.height}px`);
  const merged = { ...t, ...ov.transform } as Transform;
  const tf = nodeTransformCss(merged);
  if (ov.transform && (ov.transform.rotation !== undefined || ov.transform.scaleX !== undefined || ov.transform.scaleY !== undefined) && tf) {
    decls.push(`transform:${tf}`);
  }
  if (decls.length === 0) return "";
  return `[data-oc-id="${cssEscape(node.id)}"]{${decls.join(";")}}`;
}

function cssEscape(id: string): string {
  return id.replace(/["\\]/g, "\\$&");
}

/** Base + media-query CSS for one page's responsive behavior. When nodes carry
 *  per-breakpoint overrides we emit those; otherwise the page scales
 *  proportionally to the viewport width within each breakpoint. */
export function renderResponsiveCss(page: Page, ctx: RenderContext): string {
  const bp = ctx.breakpoints ?? defaultBreakpoints;
  const withOv = nodesWithOverrides(page);
  const blocks: string[] = [];

  const sel = `[data-oc-page="${cssEscape(page.id)}"]`;

  for (const breakpoint of ["tablet", "mobile"] as Breakpoint[]) {
    const maxWidth = breakpoint === "tablet" ? bp.tablet : bp.mobile;
    const rules: string[] = [];
    let hasOverride = false;
    for (const node of withOv) {
      const ov = node.responsive?.[breakpoint];
      if (!ov) continue;
      const css = overrideToCss(node, ov);
      if (css) {
        rules.push(`  ${sel} ${css}`);
        hasOverride = true;
      }
    }
    if (!hasOverride) {
      // No manual overrides: scale the whole page down proportionally so it
      // fits the breakpoint width (transform-origin top-center keeps it centered).
      const scale = maxWidth / page.width;
      rules.push(
        `  ${sel}{transform:scale(${Math.min(1, scale).toFixed(4)});transform-origin:top center}`,
      );
    }
    blocks.push(`@media (max-width:${maxWidth}px){\n${rules.join("\n")}\n}`);
  }

  return blocks.join("\n");
}

/** A file in the rendered static bundle. */
export interface RenderedFile {
  path: string;
  contentType: string;
  body: string;
}

export interface RenderSiteResult {
  files: RenderedFile[];
}

// Imported lazily-by-value to avoid a cycle: seo/nav are siblings.
import { metaTags, robotsTxt, sitemapXml } from "./seo";
import { buildNav, pageHref, pageSlugMap, type ResolvedNavItem } from "./nav";
import type { Site } from "./types";

const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
.oc-page{position:relative}
.oc-node{position:absolute}
.oc-nav{display:flex;gap:16px;align-items:center;padding:12px 20px}
.oc-nav a{text-decoration:none;color:inherit}
.oc-nav-toggle{display:none;background:none;border:0;font-size:24px;cursor:pointer}
.oc-form{display:flex;flex-direction:column;gap:12px}
.oc-field{display:flex;flex-direction:column;gap:4px}
@media (max-width:768px){
  .oc-nav-toggle{display:block}
  .oc-nav ul{display:none;flex-direction:column;width:100%}
  .oc-nav.oc-open ul{display:flex}
}
`;

const RUNTIME_JS = `(function(){
  // Nav toggle (mobile collapse).
  var toggle=document.querySelector('.oc-nav-toggle');
  var nav=document.querySelector('.oc-nav');
  if(toggle&&nav){toggle.addEventListener('click',function(){nav.classList.toggle('oc-open');});}
  // Smooth in-page anchor scroll for element links and nav anchors.
  document.addEventListener('click',function(e){
    var a=e.target.closest&&e.target.closest('a[href^="#"]');
    if(!a)return;
    var id=a.getAttribute('href').slice(1);
    var el=id&&document.getElementById(id);
    if(el){e.preventDefault();el.scrollIntoView({behavior:'smooth'});}
  });
  // Form submit: progressive enhancement hook (the serving layer handles POST).
  document.querySelectorAll('form[data-oc-form]').forEach(function(f){
    f.addEventListener('submit',function(){
      // honeypot-filled submissions are dropped server-side; nothing to do here.
    });
  });
})();`;

function navHtml(items: ResolvedNavItem[], siteTitle: string): string {
  if (items.length === 0) return "";
  const li = (it: ResolvedNavItem): string => {
    const sub =
      it.children.length > 0
        ? `<ul class="oc-subnav">${it.children.map(li).join("")}</ul>`
        : "";
    return `<li><a href="${escapeAttr(it.href)}">${escapeHtml(it.label)}</a>${sub}</li>`;
  };
  return (
    `<nav class="oc-nav" data-oc-nav>` +
    `<span class="oc-brand">${escapeHtml(siteTitle)}</span>` +
    `<button class="oc-nav-toggle" aria-label="Menu" aria-expanded="false">&#9776;</button>` +
    `<ul>${items.map(li).join("")}</ul>` +
    `</nav>`
  );
}

function pageDocument(args: {
  site: Site;
  page: Page;
  ctx: RenderContext;
  nav: ResolvedNavItem[];
  baseUrl: string;
}): string {
  const { site, page, ctx, nav, baseUrl } = args;
  const meta = metaTags(site, page, { resolveAssetUrl: ctx.resolveAssetUrl, baseUrl });
  const head = site.settings.customCode?.head ?? "";
  const bodyEnd = site.settings.customCode?.bodyEnd ?? "";
  const passwordNote = site.settings.password?.enabled
    ? `<!-- oc:password-protected (gate enforced at serving layer) -->`
    : "";
  const body = renderPageHtml(page, ctx);
  const respCss = renderResponsiveCss(page, ctx);
  return (
    `<!DOCTYPE html>\n<html lang="en">\n<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<link rel="stylesheet" href="/site.css">\n` +
    meta +
    `\n` +
    (respCss ? `<style>\n${respCss}\n</style>\n` : "") +
    head +
    `\n</head>\n<body>\n` +
    passwordNote +
    navHtml(nav, site.title) +
    body +
    `<script src="/runtime.js"></script>\n` +
    bodyEnd +
    `\n</body>\n</html>\n`
  );
}

/** Render an entire site to a static bundle: one HTML file per page (home at
 *  index.html), a shared site.css, sitemap.xml, robots.txt, and runtime.js. */
export function renderSite(site: Site, pages: Page[], ctx: RenderContext): RenderSiteResult {
  const baseUrl = ctx.navContext && (ctx as { baseUrl?: string }).baseUrl
    ? ((ctx as { baseUrl?: string }).baseUrl as string)
    : `https://${site.slug}.hycanvas.site`;

  const slugs = pageSlugMap(site, pages);
  const navCtx: NavContext = ctx.navContext ?? {
    slugForPage: (id) => slugs.get(id),
    homePageId: site.homePageId,
  };
  const fullCtx: RenderContext = { ...ctx, navContext: navCtx };
  const nav = buildNav(site, pages);

  const files: RenderedFile[] = [];
  const order = site.pageOrder && site.pageOrder.length > 0 ? site.pageOrder : pages.map((p) => p.id);
  const byId = new Map(pages.map((p) => [p.id, p] as const));

  for (const id of order) {
    const page = byId.get(id);
    if (!page) continue;
    const isHome = id === site.homePageId;
    const slug = slugs.get(id) ?? id;
    const path = isHome ? "index.html" : `${slug}/index.html`;
    const html = pageDocument({ site, page, ctx: fullCtx, nav, baseUrl });
    files.push({ path, contentType: "text/html; charset=utf-8", body: html });
  }

  files.push({ path: "site.css", contentType: "text/css; charset=utf-8", body: BASE_CSS });
  files.push({ path: "runtime.js", contentType: "text/javascript; charset=utf-8", body: RUNTIME_JS });
  files.push({
    path: "sitemap.xml",
    contentType: "application/xml; charset=utf-8",
    body: sitemapXml(site, pages, baseUrl),
  });
  files.push({
    path: "robots.txt",
    contentType: "text/plain; charset=utf-8",
    body: robotsTxt(site, baseUrl),
  });

  return { files };
}

// Re-export for convenience.
export { pageHref };
