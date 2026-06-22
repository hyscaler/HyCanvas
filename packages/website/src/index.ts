// @hc/website - pure-logic core for the F34 website builder.
// Framework-agnostic site model, navigation/link resolution, form validation
// and HTML/CSV emission, SEO/sitemap/robots generation, the immutable-release
// model, and the crown-jewel scene-graph -> responsive static HTML/CSS exporter.
// No canvas/React dependency: it relies only on @hc/schema and @hc/color.

export * from "./types";
export * from "./nav";
export * from "./forms";
export * from "./seo";
export * from "./render";
export * from "./release";
export { escapeHtml, escapeAttr, colorToCss, fillToCss } from "./html";
