// F34 publish-as-website dialog. Turns the current design's pages into
// a responsive static-HTML site: a Settings tab (title/slug/SEO/social/password/
// nav/custom code), a LIVE preview tab (renders the home page of the generated
// bundle into an iframe with a device-width switcher), and an Export tab that
// lists the generated files and downloads them.
//
// The whole site model is held in component state, seeded from the design. The
// pure exporter `renderSite` from @hc/website produces the bundle; nothing here
// touches a backend.
//
// DEFERRED (none implemented here): persisting the Site to the
// `sites` table; the BullMQ publish job; S3/CDN hosting at <slug>.hycanvas.site;
// custom domains / DNS / TLS; server-side form submission capture; password
// gating (the toggle only sets the model flag, gating is a serving concern); and
// live-updating embeds. The local preview and file generation work fully now.

import { useMemo, useState } from "react";
import { Globe, Monitor, Tablet, Smartphone, Download, FileCode, Settings as SettingsIcon, Eye } from "lucide-react";
import {
  renderSite,
  kebab,
  type Site,
  type SiteSettings,
  type NavItem,
  type RenderedFile,
} from "@hc/website";
import type { DesignFile, Page } from "@hc/schema";
import { useEditor } from "@/store/editor";
import { resolveAssetUrl as resolveBackendUrl } from "@/lib/sdk";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { tr } from "@/lib/i18n";

type Tab = "settings" | "preview" | "export";
type Device = "desktop" | "tablet" | "mobile";

const DEVICE_WIDTH: Record<Device, number> = { desktop: 1280, tablet: 768, mobile: 390 };

// Shared input styling (Tailwind chrome). Kept as a constant so every field in
// the dialog stays consistent without a global stylesheet edit.
const INPUT_CLS =
  "w-full rounded-lg border border-neutral-300 px-2.5 py-1.5 text-[13px] text-neutral-900 outline-none focus:border-brand-400";

/** Build an asset-url resolver from the design's assets: given an asset id (or a
 *  direct url) return a servable URL. Asset ids map through `doc.assets` to their
 *  stored url, which is then run through the backend resolver so relative content
 *  urls become absolute (matching how the canvas loads images). */
function makeAssetResolver(doc: DesignFile): (assetIdOrUrl: string) => string {
  const byId = new Map(doc.assets.map((a) => [a.id, a.url] as const));
  return (assetIdOrUrl: string): string => {
    if (!assetIdOrUrl) return "";
    const mapped = byId.get(assetIdOrUrl);
    const url = mapped ?? assetIdOrUrl;
    return resolveBackendUrl(url);
  };
}

/** Seed a Site model from the current design: one nav item per page (home first),
 *  slug from the title, sensible SEO defaults. Persistence is deferred. */
function seedSite(doc: DesignFile, designId?: string, workspaceId?: string): Site {
  const pages = doc.pages;
  const homeId = pages[0]?.id ?? "";
  const nav: NavItem[] = pages.map((p, i) => ({
    id: `nav-${p.id}`,
    label: p.name ?? `Page ${i + 1}`,
    target: { kind: "page", pageId: p.id },
    visible: true,
  }));
  return {
    id: undefined,
    workspaceId: workspaceId ?? "",
    designId: designId ?? doc.id,
    title: doc.title || tr("editor.untitled_site"),
    slug: kebab(doc.title || "site") || "site",
    homePageId: homeId,
    pageOrder: pages.map((p) => p.id),
    nav,
    settings: {
      seo: { title: doc.title || undefined },
      social: { twitterCard: "summary_large_image" },
      password: { enabled: false },
      customCode: {},
    },
    status: "draft",
  };
}

export function WebsiteDialog({
  open,
  onClose,
  designId,
  workspaceId,
}: {
  open: boolean;
  onClose: () => void;
  designId?: string;
  workspaceId?: string;
}): React.ReactElement | null {
  const toast = useToast();
  const doc = useEditor((s) => s.doc);
  // `rev` bumps on every document mutation; recomputing on it keeps the live
  // preview in sync if the design changes while the dialog is open.
  const rev = useEditor((s) => s.rev);

  const [tab, setTab] = useState<Tab>("settings");
  const [device, setDevice] = useState<Device>("desktop");
  // The dialog is mounted only while open (EditorApp gates it), so it remounts
  // fresh each open and the lazy initializer reseeds from the current design.
  const [site, setSite] = useState<Site>(() => seedSite(doc, designId, workspaceId));

  // The pure exporter output. Recomputed whenever the site model or the design
  // (rev) changes. `renderSite` is synchronous and cheap for typical page counts.
  const result = useMemo(() => {
    if (!open) return { files: [] as RenderedFile[] };
    try {
      const ctx = { resolveAssetUrl: makeAssetResolver(doc) };
      return renderSite(site, doc.pages as Page[], ctx);
    } catch {
      return { files: [] as RenderedFile[] };
    }
    // doc identity changes on every mutation via the store, but we depend on rev
    // explicitly so a same-identity mutation still recomputes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, site, rev]);

  const homeHtml = useMemo(() => {
    const home = result.files.find((f) => f.path === "index.html");
    return home?.body ?? "<!DOCTYPE html><html><body></body></html>";
  }, [result]);

  if (!open) return null;

  // --- settings mutators (immutable updates) ---
  const patchSite = (p: Partial<Site>) => setSite((s) => ({ ...s, ...p }));
  const patchSettings = (p: Partial<SiteSettings>) =>
    setSite((s) => ({ ...s, settings: { ...s.settings, ...p } }));
  const patchSeo = (p: Partial<SiteSettings["seo"]>) =>
    setSite((s) => ({ ...s, settings: { ...s.settings, seo: { ...s.settings.seo, ...p } } }));
  const patchCustomCode = (p: Partial<NonNullable<SiteSettings["customCode"]>>) =>
    setSite((s) => ({
      ...s,
      settings: { ...s.settings, customCode: { ...s.settings.customCode, ...p } },
    }));
  const toggleNavVisible = (id: string) =>
    setSite((s) => ({
      ...s,
      nav: s.nav.map((n) => (n.id === id ? { ...n, visible: !n.visible } : n)),
    }));
  const setNavLabel = (id: string, label: string) =>
    setSite((s) => ({ ...s, nav: s.nav.map((n) => (n.id === id ? { ...n, label } : n)) }));

  function download(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // nested paths (page slugs) flatten to a hyphenated filename for a flat dir.
    a.download = filename.replace(/\//g, "-");
    a.click();
    URL.revokeObjectURL(url);
  }

  // No zip dependency is available, so "Download site" emits each generated file
  // individually via Blob (staggered so browsers honour multiple downloads). The
  // primary single-file path downloads just the home index.html.
  function downloadHome() {
    download(new Blob([homeHtml], { type: "text/html;charset=utf-8" }), "index.html");
    toast.success(tr("editor.downloaded_index_html"));
  }

  function downloadAll() {
    if (result.files.length === 0) {
      toast.error(tr("editor.nothing_to_download_yet"));
      return;
    }
    result.files.forEach((f, i) => {
      setTimeout(() => download(new Blob([f.body], { type: f.contentType }), f.path), i * 120);
    });
    toast.success(`Downloading ${result.files.length} files (no zip lib; files arrive individually)`);
  }

  const byteLen = (s: string) => new Blob([s]).size;
  const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Globe size={18} className="text-brand-ink" />
            <h2 className="text-base font-semibold text-neutral-900">{tr("editor.publish_as_website")}</h2>
          </div>
          <div className="flex items-center gap-1 rounded-lg bg-neutral-100 p-1 text-sm">
            {(
              [
                ["settings", tr("editor.settings"), SettingsIcon],
                ["preview", tr("editor.preview"), Eye],
                ["export", tr("editor.export"), FileCode],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition " +
                  (tab === id ? "bg-surface text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-800")
                }
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100">
            {tr("editor.close")}
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "settings" && (
            <div className="grid grid-cols-2 gap-6 p-5">
              {/* Site */}
              <section className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">{tr("editor.site")}</h3>
                <Field label={tr("editor.title")}>
                  <input
                    className={INPUT_CLS}
                    value={site.title}
                    onChange={(e) => patchSite({ title: e.target.value })}
                  />
                </Field>
                <Field label={tr("editor.slug")} hint=".hycanvas.site (hosting deferred)">
                  <div className="flex items-center gap-1">
                    <input
                      className={`${INPUT_CLS} flex-1`}
                      value={site.slug}
                      onChange={(e) => patchSite({ slug: e.target.value })}
                      onBlur={(e) => patchSite({ slug: kebab(e.target.value) || "site" })}
                    />
                    <span className="shrink-0 text-xs text-neutral-400">.hycanvas.site</span>
                  </div>
                </Field>
                <Field label={tr("editor.password_protect")} hint="serving-layer gate; deferred">
                  <input
                    type="checkbox"
                    checked={site.settings.password?.enabled ?? false}
                    onChange={(e) => patchSettings({ password: { enabled: e.target.checked } })}
                  />
                </Field>
              </section>

              {/* SEO */}
              <section className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">SEO</h3>
                <Field label={tr("editor.title")}>
                  <input
                    className={INPUT_CLS}
                    value={site.settings.seo.title ?? ""}
                    onChange={(e) => patchSeo({ title: e.target.value || undefined })}
                  />
                </Field>
                <Field label={tr("editor.description")}>
                  <textarea
                    className={`${INPUT_CLS} h-16 resize-none`}
                    value={site.settings.seo.description ?? ""}
                    onChange={(e) => patchSeo({ description: e.target.value || undefined })}
                  />
                </Field>
                <Field label={tr("editor.keywords")} hint="comma separated">
                  <input
                    className={INPUT_CLS}
                    value={(site.settings.seo.keywords ?? []).join(", ")}
                    onChange={(e) =>
                      patchSeo({
                        keywords: e.target.value
                          .split(",")
                          .map((k) => k.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </Field>
              </section>

              {/* Navigation */}
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                  Navigation ({site.nav.filter((n) => n.visible).length}/{site.nav.length} shown)
                </h3>
                <p className="text-[11px] text-neutral-400">{tr("editor.auto_built_from_the_design_pages_toggle_visi")}</p>
                <ul className="space-y-1.5">
                  {site.nav.map((n) => (
                    <li key={n.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={n.visible}
                        onChange={() => toggleNavVisible(n.id)}
                        title={tr("editor.show_in_nav")} aria-label={tr("editor.show_in_nav")}
                      />
                      <input
                        className={`${INPUT_CLS} flex-1`}
                        value={n.label}
                        onChange={(e) => setNavLabel(n.id, e.target.value)}
                      />
                      {n.target.kind === "page" && n.target.pageId === site.homePageId && (
                        <span className="shrink-0 rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-ink">
                          {tr("editor.home")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>

              {/* Custom code */}
              <section className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">{tr("editor.custom_code")}</h3>
                <p className="text-[11px] text-amber-700">{tr("editor.injected_only_into_the_published_site_untrus")}</p>
                <Field label={tr("editor.head")}>
                  <textarea
                    className={`${INPUT_CLS} h-16 resize-none font-mono text-xs`}
                    placeholder="<!-- analytics, meta, etc. -->"
                    value={site.settings.customCode?.head ?? ""}
                    onChange={(e) => patchCustomCode({ head: e.target.value })}
                  />
                </Field>
                <Field label={tr("editor.end_of_body")}>
                  <textarea
                    className={`${INPUT_CLS} h-16 resize-none font-mono text-xs`}
                    placeholder="<!-- widgets, scripts -->"
                    value={site.settings.customCode?.bodyEnd ?? ""}
                    onChange={(e) => patchCustomCode({ bodyEnd: e.target.value })}
                  />
                </Field>
              </section>
            </div>
          )}

          {tab === "preview" && (
            <div className="flex flex-col gap-3 p-5">
              <div className="flex items-center justify-center gap-1 rounded-lg bg-neutral-100 p-1 text-sm">
                {(
                  [
                    ["desktop", Monitor],
                    ["tablet", Tablet],
                    ["mobile", Smartphone],
                  ] as const
                ).map(([id, Icon]) => (
                  <IconButton key={id} active={device === id} onClick={() => setDevice(id)} title={id}>
                    <Icon size={16} />
                  </IconButton>
                ))}
                <span className="ms-2 text-xs text-neutral-400">{DEVICE_WIDTH[device]}px home page</span>
              </div>
              <div className="grid place-items-center rounded-xl border border-neutral-200 bg-neutral-50 p-3">
                <iframe
                  title={tr("editor.site_preview")}
                  srcDoc={homeHtml}
                  style={{ width: device === "desktop" ? "100%" : `${DEVICE_WIDTH[device]}px` }}
                  className="h-[60vh] w-full rounded-md border border-neutral-300 bg-surface shadow-sm"
                  sandbox="allow-same-origin"
                />
              </div>
              <p className="text-center text-[11px] text-neutral-400">
                {tr("editor.live_local_preview_of_the_generated_static_h")}
              </p>
            </div>
          )}

          {tab === "export" && (
            <div className="flex flex-col gap-3 p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-neutral-700">
                  Generated bundle ({result.files.length} files)
                </h3>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={downloadHome}>
                    <Download size={14} /> {tr("editor.home_only")}
                  </Button>
                  <Button size="sm" onClick={downloadAll}>
                    <Download size={14} /> {tr("editor.download_site")}
                  </Button>
                </div>
              </div>
              <div className="overflow-hidden rounded-lg border border-neutral-200">
                <table className="w-full text-sm">
                  <thead className="bg-neutral-50 text-start text-xs text-neutral-400">
                    <tr>
                      <th className="px-3 py-2 font-medium">{tr("editor.path")}</th>
                      <th className="px-3 py-2 font-medium">{tr("editor.type")}</th>
                      <th className="px-3 py-2 text-end font-medium">{tr("editor.size")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.files.map((f) => (
                      <tr key={f.path} className="border-t border-neutral-100">
                        <td className="px-3 py-1.5 font-mono text-xs text-neutral-800">{f.path}</td>
                        <td className="px-3 py-1.5 text-xs text-neutral-500">{f.contentType.split(";")[0]}</td>
                        <td className="px-3 py-1.5 text-end text-xs text-neutral-500">{fmtBytes(byteLen(f.body))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-neutral-400">
                No zip library is bundled, so &ldquo;Download site&rdquo; saves each file individually. The publish job, CDN
                hosting, and custom domains are deferred.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A labelled settings row. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-medium text-neutral-600">{label}</span>
        {hint && <span className="text-[10px] text-neutral-400">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
