// Brand guide form sections (#53), shared by the new-brand wizard and the
// brand edit page: basics, logos, colors, fonts, voice, and controls. Each section edits
// a BrandDraft through onChange and saves nothing itself; the only side effect
// is uploading a logo file as a workspace asset, which a logo needs before it
// can be referenced.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2, Moon, Plus, Sparkles, Trash2, Upload, X } from "lucide-react";
import { searchFonts } from "@hc/text";
import type { BrandControls, BrandLogo, BrandSuggestion } from "@hc/sdk";
import {
  colorRoles, colorsFromHexes, isHex, loadImage, logoPalette, logoPreviewDataUrl, monochromeLogo,
  type BrandDraft, type DraftColor,
} from "@/lib/brandDraft";
import { directUploadWithProgress, oc, resolveAssetUrl } from "@/lib/sdk";
import { fonts } from "@/lib/fontProvider";
import { useToast } from "@/components/ui/Toast";
import { tr } from "@/lib/i18n";
import { userMessage } from "@/lib/errors";

/** assetId -> a displayable URL. Logos picked from disk this session map to
 *  a local object URL, which a canvas can read without a cross-origin taint. */
export type AssetUrls = Record<string, string>;

/** Local object URLs for logos uploaded in this session, by asset id. */
const localLogoSrc = new Map<string, string>();

export function logoSrc(assetId: string, urls: AssetUrls): string | null {
  const local = localLogoSrc.get(assetId);
  if (local) return local;
  const u = urls[assetId];
  return u ? resolveAssetUrl(u) : null;
}

/** Upload a logo file as a workspace asset and remember its local preview. */
export async function uploadLogo(workspaceId: string, file: Blob, filename: string): Promise<{ id: string; url: string }> {
  const asset = await directUploadWithProgress(workspaceId, file, { filename });
  localLogoSrc.set(asset.id, URL.createObjectURL(file));
  return { id: asset.id, url: asset.url };
}

/** A logo's decoded image, or null when it cannot be read (missing, or a
 *  cross-origin image the canvas may not sample). */
export async function logoImage(assetId: string, urls: AssetUrls): Promise<HTMLImageElement | null> {
  const src = logoSrc(assetId, urls);
  if (!src) return null;
  try {
    return await loadImage(src);
  } catch {
    return null;
  }
}

/** A white version of a logo for dark backgrounds, uploaded as an asset, or
 *  null when the logo has no transparent background to work with. */
export async function makeDarkVariant(workspaceId: string, img: HTMLImageElement, label: string): Promise<{ id: string; url: string } | null> {
  const blob = await monochromeLogo(img);
  if (!blob) return null;
  return uploadLogo(workspaceId, blob, `${label || "logo"}-on-dark.png`);
}

/** Ask the AI for a voice and font pairing. `extra` carries what a website
 *  scan saw; the first logo, when readable, goes along as an image. */
export async function suggestIdentity(
  workspaceId: string,
  draft: BrandDraft,
  urls: AssetUrls,
  extra: { headings?: string[]; fonts?: string[] } = {},
): Promise<BrandSuggestion> {
  let logo: string | undefined;
  const first = draft.logos[0];
  if (first) {
    const img = await logoImage(first.assetId, urls);
    try {
      logo = (img && logoPreviewDataUrl(img)) || undefined;
    } catch {
      logo = undefined; // a tainted canvas: suggest without the logo
    }
  }
  return oc.aiBrandSuggest({
    workspaceId,
    name: draft.name.trim() || undefined,
    description: draft.description.trim() || undefined,
    headings: extra.headings,
    fonts: extra.fonts,
    colors: draft.colors.map((c) => c.hex),
    logo,
  });
}

/** Fold a suggestion into a draft. `overwrite` replaces what is there (an
 *  explicit request); otherwise only empty fields are filled. */
export function applySuggestion(d: BrandDraft, s: BrandSuggestion, overwrite: boolean): BrandDraft {
  const pick = <T,>(cur: T, next: T, empty: boolean) => (overwrite || empty ? next : cur);
  return {
    ...d,
    name: d.name.trim() ? d.name : s.name,
    headingFont: pick(d.headingFont, s.fonts.heading || d.headingFont, !d.headingFont.trim()),
    bodyFont: pick(d.bodyFont, s.fonts.body || d.bodyFont, !d.bodyFont.trim()),
    voice: {
      tone: pick(d.voice.tone, s.voice.tone, d.voice.tone.length === 0),
      doSay: pick(d.voice.doSay, s.voice.doSay, d.voice.doSay.length === 0),
      dontSay: pick(d.voice.dontSay, s.voice.dontSay, d.voice.dontSay.length === 0),
      sampleCopy: pick(d.voice.sampleCopy, s.voice.sampleCopy, !d.voice.sampleCopy.trim()),
    },
  };
}

// --- layout primitives -------------------------------------------------------

export function FormSection({ title, hint, right, children }: { title: string; hint?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-neutral-200 bg-surface p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-neutral-800">{title}</h3>
          {hint && <p className="mt-0.5 text-xs text-neutral-500">{hint}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

const inputCls = "w-full rounded-lg border border-neutral-200 bg-surface px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100";
const smallBtn = "inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:border-brand-300 hover:bg-brand-50 disabled:opacity-50";

export function AiSuggestButton({ busy, onClick, label }: { busy: boolean; onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1.5 text-xs font-medium text-brand-ink hover:bg-brand-100 disabled:opacity-60"
      data-testid="brand-ai-suggest"
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
      {busy ? tr("brands.suggesting") : label ?? tr("brands.suggest_with_ai")}
    </button>
  );
}

// --- basics ------------------------------------------------------------------

export function BasicsSection({ draft, onChange }: { draft: BrandDraft; onChange: (d: BrandDraft) => void }) {
  return (
    <FormSection title={tr("brands.basics")} hint={tr("brands.basics_hint")}>
      <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="brand-name">{tr("brands.brand_name")}</label>
      <input
        id="brand-name"
        value={draft.name}
        maxLength={80}
        onChange={(e) => onChange({ ...draft, name: e.target.value })}
        placeholder={tr("brands.brand_name_placeholder")}
        className={inputCls}
        data-testid="brand-name"
      />
      <label className="mb-1 mt-3 block text-xs font-medium text-neutral-600" htmlFor="brand-description">{tr("brands.description")}</label>
      <textarea
        id="brand-description"
        value={draft.description}
        maxLength={600}
        rows={3}
        onChange={(e) => onChange({ ...draft, description: e.target.value })}
        placeholder={tr("brands.description_placeholder")}
        className={inputCls}
      />
      <p className="mt-1 text-[11px] text-neutral-400">{tr("brands.description_not_saved")}</p>
    </FormSection>
  );
}

// --- logos -------------------------------------------------------------------

export function LogoSection({
  workspaceId, draft, onChange, urls, onUrl, candidates, onUseCandidate,
}: {
  workspaceId: string;
  draft: BrandDraft;
  onChange: (d: BrandDraft) => void;
  urls: AssetUrls;
  onUrl: (assetId: string, url: string) => void;
  /** Other logo images a website scan found, offered as alternatives. */
  candidates?: string[];
  onUseCandidate?: (url: string) => void;
}) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const darkRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [darkFor, setDarkFor] = useState<string | null>(null);

  const addFile = async (file: File) => {
    setBusy("add");
    try {
      const a = await uploadLogo(workspaceId, file, file.name);
      onUrl(a.id, a.url);
      const label = file.name.replace(/\.[a-z0-9]+$/i, "") || tr("brands.logo");
      onChange({ ...draft, logos: [...draft.logos, { id: `l-${crypto.randomUUID()}`, label, assetId: a.id }] });
    } catch (e) {
      toast.error(userMessage(e, tr("brands.couldnt_upload_logo")));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const setLogo = (logoId: string, patch: Partial<BrandLogo>) =>
    onChange({ ...draft, logos: draft.logos.map((l) => (l.id === logoId ? { ...l, ...patch } : l)) });

  const setDark = (logoId: string, assetId: string | undefined) =>
    onChange({
      ...draft,
      logos: draft.logos.map((l) => {
        if (l.id !== logoId) return l;
        const variants = { ...(l.variants ?? {}) };
        if (assetId) variants.dark = assetId; else delete variants.dark;
        return { ...l, variants };
      }),
    });

  const uploadDark = async (file: File) => {
    const target = darkFor;
    if (!target) return;
    setBusy(target);
    try {
      const a = await uploadLogo(workspaceId, file, file.name);
      onUrl(a.id, a.url);
      setDark(target, a.id);
    } catch (e) {
      toast.error(userMessage(e, tr("brands.couldnt_upload_logo")));
    } finally {
      setBusy(null);
      setDarkFor(null);
      if (darkRef.current) darkRef.current.value = "";
    }
  };

  const generateDark = async (logoId: string, assetId: string, label: string) => {
    setBusy(logoId);
    try {
      const img = await logoImage(assetId, urls);
      const made = img ? await makeDarkVariant(workspaceId, img, label) : null;
      if (!made) {
        toast.toast(tr("brands.logo_has_no_transparent_background"), "info");
        return;
      }
      onUrl(made.id, made.url);
      setDark(logoId, made.id);
    } catch (e) {
      toast.error(userMessage(e, tr("brands.couldnt_make_dark_version")));
    } finally {
      setBusy(null);
    }
  };

  return (
    <FormSection title={tr("brands.logos")} hint={tr("brands.logos_hint")}>
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void addFile(f); }} />
      <input ref={darkRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadDark(f); }} />
      <div className="grid gap-3 sm:grid-cols-2">
        {draft.logos.map((l) => {
          const src = logoSrc(l.assetId, urls);
          const dark = l.variants?.dark ? logoSrc(l.variants.dark, urls) : null;
          return (
            <div key={l.id} className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-2.5">
              <div className="grid grid-cols-2 gap-2">
                <div className="light flex h-24 items-center justify-center rounded-lg border border-neutral-200 bg-white p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {src ? <img src={src} alt={l.label} className="h-full w-full object-contain" /> : <span className="text-[11px] text-neutral-400">{l.label}</span>}
                </div>
                <div className="flex h-24 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-900 p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {dark ? <img src={dark} alt={`${l.label} ${tr("brands.on_dark")}`} className="h-full w-full object-contain" /> : <span className="text-center text-[11px] text-neutral-400">{tr("brands.no_dark_version")}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  value={l.label}
                  onChange={(e) => onChange({ ...draft, logos: draft.logos.map((x) => (x.id === l.id ? { ...x, label: e.target.value } : x)) })}
                  aria-label={tr("brands.logo_label")}
                  className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-surface px-2 py-1 text-xs outline-none focus:border-brand-400"
                />
                <button
                  type="button"
                  onClick={() => onChange({ ...draft, logos: draft.logos.filter((x) => x.id !== l.id) })}
                  title={tr("brands.remove_logo")}
                  aria-label={tr("brands.remove_logo")}
                  className="grid h-7 w-7 place-items-center rounded-lg text-neutral-400 hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <SizeInput
                  id={`${l.id}-clear`}
                  label={tr("brands.clear_space")}
                  unit="%"
                  max={200}
                  value={l.clearSpaceRatio != null ? Math.round(l.clearSpaceRatio * 100) : undefined}
                  onChange={(v) => setLogo(l.id, { clearSpaceRatio: v != null ? v / 100 : undefined })}
                />
                <SizeInput
                  id={`${l.id}-min`}
                  label={tr("brands.min_width")}
                  unit="px"
                  max={4000}
                  value={l.minSizePx}
                  onChange={(v) => setLogo(l.id, { minSizePx: v })}
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" className={smallBtn} disabled={busy !== null} onClick={() => void generateDark(l.id, l.assetId, l.label)}>
                  {busy === l.id ? <Loader2 size={12} className="animate-spin" /> : <Moon size={12} />} {tr("brands.make_white_version")}
                </button>
                <button type="button" className={smallBtn} disabled={busy !== null} onClick={() => { setDarkFor(l.id); darkRef.current?.click(); }}>
                  <Upload size={12} /> {tr("brands.upload_dark_version")}
                </button>
                {l.variants?.dark && (
                  <button type="button" className={smallBtn} onClick={() => setDark(l.id, undefined)}>
                    <X size={12} /> {tr("brands.remove_dark_version")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy !== null}
          className="grid min-h-32 place-items-center rounded-xl border-2 border-dashed border-neutral-200 p-4 text-sm text-neutral-500 hover:border-brand-300 hover:bg-brand-50 disabled:opacity-60"
          data-testid="brand-add-logo"
        >
          <span className="flex items-center gap-1.5">
            {busy === "add" ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} {tr("brands.upload_logo")}
          </span>
        </button>
      </div>
      {candidates && candidates.length > 0 && onUseCandidate && (
        <div className="mt-3">
          <p className="mb-1.5 text-xs font-medium text-neutral-600">{tr("brands.other_images_on_website")}</p>
          <div className="flex flex-wrap gap-1.5">
            {candidates.slice(0, 6).map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => onUseCandidate(u)}
                title={tr("brands.use_this_logo")}
                className="light flex h-12 w-12 items-center justify-center rounded-lg border border-neutral-200 bg-white p-1 hover:border-brand-400"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={u}
                  alt=""
                  className="h-full w-full object-contain"
                  onError={(e) => { const b = e.currentTarget.closest("button"); if (b) b.style.display = "none"; }}
                />
              </button>
            ))}
          </div>
        </div>
      )}
    </FormSection>
  );
}

/** A small whole-number field for logo sizing; empty clears the value. */
function SizeInput({ id, label, unit, max, value, onChange }: {
  id: string;
  label: string;
  unit: string;
  max: number;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-0.5 block text-[11px] text-neutral-500">{label}</label>
      <div className="flex items-center rounded-lg border border-neutral-200 bg-surface focus-within:border-brand-400">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={0}
          max={max}
          step={1}
          value={value ?? ""}
          onChange={(e) => {
            const n = Math.round(Number(e.target.value));
            onChange(e.target.value === "" || !Number.isFinite(n) || n <= 0 ? undefined : Math.min(max, n));
          }}
          className="min-w-0 flex-1 bg-transparent px-2 py-1 text-xs outline-none"
        />
        <span className="pe-2 text-[11px] text-neutral-400">{unit}</span>
      </div>
    </div>
  );
}

// --- colors ------------------------------------------------------------------

export function ColorSection({ draft, onChange, urls }: { draft: BrandDraft; onChange: (d: BrandDraft) => void; urls: AssetUrls }) {
  const toast = useToast();
  const [hex, setHex] = useState("#2563eb");
  const clean = hex.trim().toLowerCase();
  const setColors = (colors: DraftColor[]) => onChange({ ...draft, colors });
  const update = (id: string, patch: Partial<DraftColor>) => setColors(draft.colors.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const fromLogo = async () => {
    const first = draft.logos[0];
    const img = first ? await logoImage(first.assetId, urls) : null;
    let found: string[] = [];
    try {
      found = img ? logoPalette(img) : [];
    } catch {
      found = [];
    }
    const next = colorsFromHexes(found, draft.colors);
    if (next.length === draft.colors.length) { toast.toast(tr("brands.no_new_colors_in_logo"), "info"); return; }
    setColors(next);
  };

  return (
    <FormSection
      title={tr("brands.colors")}
      hint={tr("brands.colors_hint")}
      right={draft.logos.length > 0 ? <button type="button" className={smallBtn} onClick={() => void fromLogo()}>{tr("brands.take_colors_from_logo")}</button> : undefined}
    >
      {draft.colors.length === 0 && <p className="mb-2 text-xs text-neutral-400">{tr("brands.no_colors_yet")}</p>}
      <ul className="flex flex-col gap-2">
        {draft.colors.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-2">
            <input
              type="color"
              value={isHex(c.hex) ? c.hex : "#000000"}
              onChange={(e) => update(c.id, { hex: e.target.value })}
              aria-label={tr("brands.pick_color")}
              className="oc-color h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-neutral-200"
            />
            <input
              value={c.hex}
              onChange={(e) => { const v = e.target.value.trim(); update(c.id, { hex: v.startsWith("#") ? v : `#${v}` }); }}
              aria-label={tr("brands.hex")}
              spellCheck={false}
              className={`w-28 rounded-lg border px-2 py-1.5 font-mono text-xs uppercase outline-none focus:border-brand-400 ${isHex(c.hex) ? "border-neutral-200" : "border-red-300"}`}
            />
            <select
              value={c.role}
              onChange={(e) => update(c.id, { role: e.target.value })}
              aria-label={tr("brands.color_role")}
              className="rounded-lg border border-neutral-200 bg-surface px-2 py-1.5 text-xs outline-none focus:border-brand-400"
            >
              {[...new Set([...colorRoles, c.role])].map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </select>
            <button
              type="button"
              onClick={() => setColors(draft.colors.filter((x) => x.id !== c.id))}
              aria-label={tr("brands.remove_color")}
              title={tr("brands.remove_color")}
              className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 hover:bg-red-50 hover:text-red-600"
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center gap-2">
        <input
          type="color"
          value={isHex(clean) ? clean : "#000000"}
          onChange={(e) => setHex(e.target.value)}
          aria-label={tr("brands.pick_color")}
          className="oc-color h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-neutral-200"
        />
        <input
          value={hex}
          onChange={(e) => setHex(e.target.value.startsWith("#") || e.target.value === "" ? e.target.value : `#${e.target.value}`)}
          onKeyDown={(e) => { if (e.key === "Enter" && isHex(clean)) { e.preventDefault(); setColors(colorsFromHexes([clean], draft.colors)); } }}
          aria-label={tr("brands.hex")}
          placeholder={"#2563eb"}
          spellCheck={false}
          className="w-28 rounded-lg border border-neutral-200 px-2 py-1.5 font-mono text-xs uppercase outline-none focus:border-brand-400"
        />
        <button
          type="button"
          onClick={() => setColors(colorsFromHexes([clean], draft.colors))}
          disabled={!isHex(clean)}
          className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:bg-neutral-200 disabled:text-neutral-400"
          data-testid="brand-add-color"
        >
          <Plus size={13} /> {tr("brands.add_color")}
        </button>
      </div>
    </FormSection>
  );
}

/** A color role's display name. Roles are stored as data (English ids); only
 *  the known ones have a translated label. */
export function roleLabel(role: string): string {
  switch (role) {
    case "primary": return tr("brands.role_primary");
    case "secondary": return tr("brands.role_secondary");
    case "accent": return tr("brands.role_accent");
    case "neutral": return tr("brands.role_neutral");
    case "background": return tr("brands.role_background");
    case "text": return tr("brands.role_text");
    default: return role;
  }
}

// --- fonts -------------------------------------------------------------------

function FontInput({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  const options = useMemo(() => searchFonts(value).slice(0, 40), [value]);
  useEffect(() => { if (value.trim()) fonts.ensure(value.trim()); }, [value]);
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor={id}>{label}</label>
      <input
        id={id}
        list={`${id}-options`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={tr("brands.font_placeholder")}
        className={inputCls}
      />
      <datalist id={`${id}-options`}>
        {options.map((f) => <option key={f.family} value={f.family} />)}
      </datalist>
      {value.trim() && (
        <p className="mt-1.5 truncate text-lg text-neutral-800" style={{ fontFamily: `'${value.trim()}', sans-serif` }}>
          {tr("brands.font_sample")}
        </p>
      )}
    </div>
  );
}

export function FontSection({ draft, onChange, ai }: { draft: BrandDraft; onChange: (d: BrandDraft) => void; ai?: ReactNode }) {
  return (
    <FormSection title={tr("brands.fonts")} hint={tr("brands.fonts_hint")} right={ai}>
      <div className="grid gap-4 sm:grid-cols-3">
        <FontInput id="brand-font-heading" label={tr("brands.heading_font")} value={draft.headingFont} onChange={(v) => onChange({ ...draft, headingFont: v })} />
        <FontInput id="brand-font-body" label={tr("brands.body_font")} value={draft.bodyFont} onChange={(v) => onChange({ ...draft, bodyFont: v })} />
        <FontInput id="brand-font-accent" label={tr("brands.accent_font")} value={draft.accentFont} onChange={(v) => onChange({ ...draft, accentFont: v })} />
      </div>
    </FormSection>
  );
}

// --- voice -------------------------------------------------------------------

function TagInput({ id, label, values, onChange, placeholder }: { id: string; label: string; values: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [text, setText] = useState("");
  const add = () => {
    const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const have = new Set(values.map((v) => v.toLowerCase()));
    onChange([...values, ...parts.filter((p) => !have.has(p.toLowerCase()))].slice(0, 8));
    setText("");
  };
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor={id}>{label}</label>
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-neutral-200 bg-surface px-2 py-1.5 focus-within:border-brand-400">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700">
            {v}
            <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={tr("brands.remove_item", { item: v })} className="text-neutral-400 hover:text-neutral-700">
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }}
          onBlur={add}
          placeholder={values.length ? "" : placeholder}
          className="min-w-24 flex-1 bg-transparent py-0.5 text-sm outline-none"
        />
      </div>
    </div>
  );
}

function LinesInput({ id, label, values, onChange, placeholder }: { id: string; label: string; values: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  // Edited as text so a half-typed line is not trimmed away mid-keystroke;
  // the list is derived on every change.
  const [text, setText] = useState(values.join("\n"));
  const joined = values.join("\n");
  const [seen, setSeen] = useState(joined);
  if (joined !== seen) { setSeen(joined); setText(joined); }
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={4}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const next = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 10);
          setSeen(next.join("\n"));
          onChange(next);
        }}
        placeholder={placeholder}
        className={inputCls}
      />
    </div>
  );
}

export function VoiceSection({ draft, onChange, ai }: { draft: BrandDraft; onChange: (d: BrandDraft) => void; ai?: ReactNode }) {
  const v = draft.voice;
  const set = (patch: Partial<BrandDraft["voice"]>) => onChange({ ...draft, voice: { ...v, ...patch } });
  return (
    <FormSection title={tr("brands.voice")} hint={tr("brands.voice_hint")} right={ai}>
      <div className="flex flex-col gap-4">
        <TagInput id="brand-tone" label={tr("brands.tone")} values={v.tone} onChange={(tone) => set({ tone })} placeholder={tr("brands.tone_placeholder")} />
        <div className="grid gap-4 sm:grid-cols-2">
          <LinesInput id="brand-do" label={tr("brands.we_say")} values={v.doSay} onChange={(doSay) => set({ doSay })} placeholder={tr("brands.one_per_line")} />
          <LinesInput id="brand-dont" label={tr("brands.we_avoid")} values={v.dontSay} onChange={(dontSay) => set({ dontSay })} placeholder={tr("brands.one_per_line")} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="brand-sample">{tr("brands.sample_copy")}</label>
          <textarea id="brand-sample" rows={3} maxLength={400} value={v.sampleCopy} onChange={(e) => set({ sampleCopy: e.target.value })} placeholder={tr("brands.sample_copy_placeholder")} className={inputCls} />
        </div>
      </div>
    </FormSection>
  );
}

// --- controls ----------------------------------------------------------------

const lintPolicies = [
  { id: "off", label: () => tr("brands.export_check_off"), hint: () => tr("brands.export_check_off_hint") },
  { id: "warn", label: () => tr("brands.export_check_warn"), hint: () => tr("brands.export_check_warn_hint") },
  { id: "block", label: () => tr("brands.export_check_block"), hint: () => tr("brands.export_check_block_hint") },
] as const;

/** Brand controls: lock designs to the kit's colors and fonts, limit new
 *  designs to brand templates, and set how strictly exports are checked. */
export function ControlsSection({ draft, onChange }: { draft: BrandDraft; onChange: (d: BrandDraft) => void }) {
  const c = draft.controls;
  const set = (patch: Partial<BrandControls>) => onChange({ ...draft, controls: { ...c, ...patch } });
  const toggles: { key: "lockColors" | "lockFonts" | "restrictTemplates"; label: string; hint: string }[] = [
    { key: "lockColors", label: tr("brands.lock_colors"), hint: tr("brands.lock_colors_hint") },
    { key: "lockFonts", label: tr("brands.lock_fonts"), hint: tr("brands.lock_fonts_hint") },
    { key: "restrictTemplates", label: tr("brands.restrict_templates"), hint: tr("brands.restrict_templates_hint") },
  ];
  return (
    <FormSection title={tr("brands.controls")} hint={tr("brands.controls_hint")}>
      <div className="flex flex-col gap-3">
        {toggles.map((t) => (
          <label key={t.key} className="flex items-start gap-2.5">
            <input
              type="checkbox"
              checked={c[t.key]}
              onChange={(e) => set({ [t.key]: e.target.checked })}
              className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600"
              data-testid={`brand-control-${t.key}`}
            />
            <span>
              <span className="block text-sm text-neutral-800">{t.label}</span>
              <span className="block text-xs text-neutral-500">{t.hint}</span>
            </span>
          </label>
        ))}
        <fieldset className="mt-1">
          <legend className="mb-1.5 text-sm text-neutral-800">{tr("brands.export_check")}</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {lintPolicies.map((p) => (
              <label
                key={p.id}
                className={`flex cursor-pointer flex-col gap-0.5 rounded-xl border p-2.5 ${c.lintPolicy === p.id ? "border-brand-400 bg-brand-50" : "border-neutral-200 hover:border-brand-300"}`}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-neutral-800">
                  <input type="radio" name="brand-lint-policy" checked={c.lintPolicy === p.id} onChange={() => set({ lintPolicy: p.id })} className="accent-brand-600" />
                  {p.label()}
                </span>
                <span className="text-xs text-neutral-500">{p.hint()}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </FormSection>
  );
}
