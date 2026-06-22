// Small HTML/CSS string helpers shared by the renderer. Kept here so the package
// has no @hc/engine (canvas) dependency: the few color/fill helpers it needs are
// replicated from engine/src/color.ts so the static output matches engine paint.

import type { Color, Fill } from "@hc/schema";
import { clamp01 } from "@hc/color";

/** Escape text for safe insertion into HTML element content. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape a string for use inside a double-quoted HTML attribute. */
export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Sanitize a URL destined for an href/src so it cannot smuggle script.
 * Strips control characters and whitespace, then allows only a safe scheme
 * set: http, https, mailto, tel; relative paths (starting with `/`, `./`,
 * `../`); and pure in-page anchors (`#...`). Protocol-relative `//host` is
 * rejected (treated as unsafe). Anything else (javascript:, data:, vbscript:,
 * file:, etc.) collapses to `"#"`. The returned value still must be passed
 * through `escapeAttr` before placing it in an attribute.
 */
export function safeUrl(url: string | undefined): string {
  if (!url) return "#";
  // Remove control chars (incl. tab/newline) and all whitespace, which browsers
  // would otherwise ignore inside a scheme (e.g. `java\nscript:`).
  // eslint-disable-next-line no-control-regex
  const cleaned = url.replace(/[\u0000-\u0020]/g, "").trim();
  if (cleaned === "") return "#";

  // Pure anchor or relative paths are always safe.
  if (cleaned.startsWith("#")) return cleaned;
  if (cleaned.startsWith("/")) {
    // Reject protocol-relative `//host` which navigates off-site over an
    // attacker-chosen scheme.
    if (cleaned.startsWith("//")) return "#";
    return cleaned;
  }
  if (cleaned.startsWith("./") || cleaned.startsWith("../")) return cleaned;

  // If there is a scheme, it must be in the allow-list. A `:` that appears
  // after a `/`, `?`, or `#` is part of a relative path, not a scheme.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (schemeMatch) {
    const slash = cleaned.indexOf("/");
    const query = cleaned.indexOf("?");
    const hash = cleaned.indexOf("#");
    const colon = schemeMatch[0].length - 1;
    const beforeColon = (idx: number) => idx === -1 || idx > colon;
    if (beforeColon(slash) && beforeColon(query) && beforeColon(hash)) {
      const scheme = schemeMatch[1].toLowerCase();
      const allowed =
        scheme === "http" || scheme === "https" || scheme === "mailto" || scheme === "tel";
      return allowed ? cleaned : "#";
    }
  }

  // No scheme and not anchored/rooted: a bare relative reference (e.g.
  // `page/index.html` or `contact`). Treat as a relative path.
  return cleaned;
}

/**
 * Sanitize a font-family name for embedding inside a CSS declaration that is
 * itself placed in a double-quoted `style="..."` attribute. Strips characters
 * that could break out of the single-quoted CSS string or the declaration:
 * quotes, angle brackets, semicolons, braces, backslashes, and newlines.
 * Returns `'<clean>', sans-serif`, or plain `sans-serif` when empty.
 */
export function cssFontFamily(name?: string): string {
  if (!name) return "sans-serif";
  const clean = name.replace(/["'<>;{}\\\r\n]/g, "").trim();
  if (clean === "") return "sans-serif";
  return `'${clean}', sans-serif`;
}

function rgba(r: number, g: number, b: number, a: number): string {
  const c = (n: number) => Math.round(clamp01(n) * 255);
  return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${clamp01(a)})`;
}

/** Canonical sRGB to a CSS rgba() string (mirrors engine `colorToCss`). */
export function colorToCss(color: Color): string {
  const s = color.srgb;
  return rgba(s.r, s.g, s.b, s.a);
}

/** A CSS `background` value for a fill. Solid -> rgba; linear/radial/conic ->
 *  a real CSS gradient; pattern/image -> transparent (drawn as <img>/asset). */
export function fillToCss(fill: Fill | undefined): string {
  if (!fill) return "transparent";
  switch (fill.type) {
    case "solid":
      return colorToCss(fill.color);
    case "gradient": {
      const stops = fill.stops ?? [];
      if (stops.length === 0) return "transparent";
      const list = stops
        .map((s) => `${colorToCss(s.color)} ${Math.round(clamp01(s.position) * 100)}%`)
        .join(", ");
      if (fill.gradient === "radial") return `radial-gradient(circle, ${list})`;
      if (fill.gradient === "conic") return `conic-gradient(from ${fill.angle ?? 0}deg, ${list})`;
      if (fill.gradient === "mesh") {
        // CSS has no mesh gradient; approximate with the first point's color.
        const pts = fill.mesh?.points ?? [];
        return pts.length > 0 ? colorToCss(pts[0].color) : "transparent";
      }
      return `linear-gradient(${(fill.angle ?? 0) + 90}deg, ${list})`;
    }
    case "pattern":
    case "image":
      return "transparent";
    default:
      return "transparent";
  }
}

/** Serialize a style object to a CSS declaration string, skipping empty values.
 *  Defense-in-depth: a double-quote in any value would close the surrounding
 *  `style="..."` attribute, so quotes are stripped from serialized values. */
export function style(props: Record<string, string | number | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === "") continue;
    const val = typeof v === "string" ? v.replace(/"/g, "") : v;
    parts.push(`${k}:${val}`);
  }
  return parts.join(";");
}
