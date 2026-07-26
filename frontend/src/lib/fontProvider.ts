// Browser font provider: lazy-loads catalog web fonts via the CSS
// Font Loading API and notifies subscribers when a face is ready so the canvas
// reflows from the fallback to the real typeface. Mirrors the imageAssets
// provider pattern. System fonts need no loading. Uploaded/brand fonts (FR-6)
// will register here too once font upload lands.

import type { DesignFile, Node } from "@hc/schema";
import { getFontEntry, fontCssUrl, isSystemFont } from "@hc/text";

const CUSTOM_FONTS_KEY = "oc-custom-fonts";

// The only hosts a webfont stylesheet may load from. fontCssUrl builds URLs on
// exactly these (Bunny is the default, Google optional); a non-empty href off
// this list should be impossible, so we drop it rather than inject it.
const FONT_CSS_HOST_ALLOWLIST = new Set(["fonts.bunny.net", "fonts.googleapis.com"]);

/** True only for an https URL on the webfont-CSS host allowlist. */
function isAllowedFontCssHref(href: string): boolean {
  if (!href) return false;
  try {
    const u = new URL(href);
    return u.protocol === "https:" && FONT_CSS_HOST_ALLOWLIST.has(u.hostname);
  } catch {
    return false;
  }
}

class FontProvider {
  private loaded = new Set<string>();
  private loading = new Set<string>();
  private subs = new Set<() => void>();
  // Uploaded fonts (FR-6): key (lowercased family) -> { family, src (data URL) }.
  private custom = new Map<string, { family: string; src: string }>();

  constructor() {
    if (typeof window === "undefined") return;
    try {
      const saved = JSON.parse(window.localStorage.getItem(CUSTOM_FONTS_KEY) || "[]") as { family: string; src: string }[];
      for (const f of saved) void this.registerCustomFont(f.family, f.src, false);
    } catch { /* ignore corrupt store */ }
  }

  /** Whether a family's web font is loaded and ready to render. */
  isReady(family: string | undefined): boolean {
    return isSystemFont(family) || this.loaded.has((family ?? "").toLowerCase());
  }

  /** Family names of all uploaded custom fonts (for the picker). */
  customFamilies(): string[] {
    return [...this.custom.values()].map((f) => f.family);
  }

  /** Load an uploaded font (data URL) into document.fonts so the canvas can draw
   *  it, and (by default) persist it across sessions. Returns true on success. */
  async registerCustomFont(family: string, src: string, persist = true): Promise<boolean> {
    if (typeof document === "undefined" || typeof FontFace === "undefined") return false;
    const key = family.toLowerCase();
    if (this.loaded.has(key) && this.custom.has(key)) return true; // already registered
    try {
      const face = new FontFace(family, `url(${src})`);
      await face.load();
      (document as unknown as { fonts: { add: (f: FontFace) => void } }).fonts.add(face);
      this.loaded.add(key);
      this.custom.set(key, { family, src });
      if (persist) this.persistCustom();
      this.notify();
      return true;
    } catch {
      return false;
    }
  }

  private persistCustom(): void {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(CUSTOM_FONTS_KEY, JSON.stringify([...this.custom.values()])); } catch { /* quota: skip persistence */ }
  }

  /** Ensure a family is loading/loaded; repaints subscribers when it arrives. */
  ensure(family: string | undefined): void {
    if (isSystemFont(family) || typeof document === "undefined") return;
    const key = family!.toLowerCase();
    if (this.loaded.has(key) || this.loading.has(key)) return;
    const entry = getFontEntry(family!);
    if (!entry) return;
    this.loading.add(key);

    const probe = entry.weights.includes(400) ? 400 : entry.weights[0];
    // Actually fetch the face into document.fonts (canvas text does NOT trigger
    // font loading on its own), then repaint. document.fonts.load only works
    // once the @font-face rule exists, so it must run AFTER the stylesheet
    // loads, not before.
    const fetchFace = () => {
      void document.fonts
        .load(`${probe} 16px "${family}"`)
        .then(() => {
          this.loading.delete(key);
          this.loaded.add(key);
          this.notify();
        })
        .catch(() => {
          this.loading.delete(key);
        });
    };

    const id = `oc-font-${key.replace(/\s+/g, "-")}`;
    const existing = document.getElementById(id) as HTMLLinkElement | null;
    if (existing) {
      // Stylesheet already injected; the @font-face is (or will shortly be)
      // registered, so loading can start now.
      fetchFace();
      return;
    }
    const href = fontCssUrl(family!, entry.weights);
    // Defense in depth before the DOM sink: fontCssUrl only returns URLs on the
    // fixed webfont-CSS host allowlist (Bunny / Google), so anything else means
    // the input was not a catalog family and we do not inject a stylesheet.
    if (!isAllowedFontCssHref(href)) {
      this.loading.delete(key);
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.id = id;
    link.href = href;
    // Only load the face once the @font-face rules from the stylesheet exist.
    link.addEventListener("load", fetchFace);
    link.addEventListener("error", () => this.loading.delete(key));
    document.head.appendChild(link);
  }

  /** Preload every font family referenced by a design's text nodes. */
  ensureForDoc(doc: DesignFile): void {
    // Cross-device uploaded fonts: register any FontRef that carries a URL (an
    // uploaded font asset) so the canvas can draw it on this device too. Local
    // localStorage persistence is skipped (the design is the source of truth).
    const refs = (doc as unknown as { fonts?: { family?: string; url?: string; source?: string }[] }).fonts;
    if (Array.isArray(refs)) {
      for (const f of refs) {
        if (f.url && f.family && !this.loaded.has(f.family.toLowerCase())) {
          void this.registerCustomFont(f.family, f.url, false);
        }
      }
    }
    const walk = (nodes: Node[]) => {
      for (const n of nodes) {
        if (n.type === "text") {
          for (const para of (n as unknown as { content: { runs: { style: { fontFamily?: string } }[] }[] }).content) {
            for (const run of para.runs) this.ensure(run.style.fontFamily);
          }
        }
        const kids = (n as unknown as { children?: Node[] }).children;
        if (Array.isArray(kids)) walk(kids);
      }
    };
    for (const page of doc.pages) walk(page.children);
  }

  onChange(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  private notify(): void {
    for (const cb of this.subs) cb();
  }
}

/** Shared font provider for the editor canvas and export. */
export const fonts = new FontProvider();
