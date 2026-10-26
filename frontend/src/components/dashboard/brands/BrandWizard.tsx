// New brand wizard (#53, #54). Starts from scratch, from a logo, or from a
// website, then walks through basics, logos, colors, fonts, and voice to a
// review of the finished guide. Starting from a logo or a website fills a
// draft deterministically (colors from the logo's pixels; logo, colors, and
// fonts from the page scan) and, when an AI provider is connected, adds a
// suggested voice and font pairing. Nothing is saved until "Create brand kit";
// the kit is then created and filled in one go, and removed again if the fill
// fails, so a half-made kit is never left behind.

import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, Globe, ImageIcon, Loader2, PenLine, X } from "lucide-react";
import type { BrandKit } from "@hc/sdk";
import {
  colorsFromHexes, draftIsSavable, draftToPatch, emptyDraft, logoPalette, withNeutrals, type BrandDraft,
} from "@/lib/brandDraft";
import { directUploadWithProgress, oc } from "@/lib/sdk";
import { useToast } from "@/components/ui/Toast";
import { tr } from "@/lib/i18n";
import { userMessage } from "@/lib/errors";
import {
  AiSuggestButton, applySuggestion, BasicsSection, ColorSection, ControlsSection, FontSection, LogoSection, VoiceSection,
  logoImage, makeDarkVariant, suggestIdentity, uploadLogo, type AssetUrls,
} from "./BrandForms";
import { BrandGuide } from "./BrandGuide";

const steps = ["basics", "logos", "colors", "fonts", "voice", "review"] as const;
type Step = "start" | (typeof steps)[number];

function stepLabel(s: (typeof steps)[number]): string {
  switch (s) {
    case "basics": return tr("brands.basics");
    case "logos": return tr("brands.logos");
    case "colors": return tr("brands.colors");
    case "fonts": return tr("brands.fonts");
    case "voice": return tr("brands.voice");
    case "review": return tr("brands.review");
  }
}

export function BrandWizard({
  workspaceId, aiReady, isFirst, urls, onUrl, onClose, onCreated,
}: {
  workspaceId: string;
  aiReady: boolean;
  /** The workspace has no kits yet (the first kit becomes the default). */
  isFirst: boolean;
  urls: AssetUrls;
  onUrl: (assetId: string, url: string) => void;
  onClose: () => void;
  onCreated: (kit: BrandKit) => void;
}) {
  const toast = useToast();
  const [step, setStep] = useState<Step>("start");
  const [draft, setDraft] = useState<BrandDraft>(() => ({ ...emptyDraft(), isDefault: isFirst }));
  const [busy, setBusy] = useState<string | null>(null);
  const [site, setSite] = useState("");
  // What a website scan saw, kept to ground a later AI suggestion and to
  // offer the other logo images it found.
  const [scan, setScan] = useState<{ headings: string[]; fonts: string[]; logoUrls: string[] } | null>(null);
  const [saving, setSaving] = useState(false);

  const suggest = async (d: BrandDraft, overwrite: boolean, extra = scan): Promise<BrandDraft> => {
    const s = await suggestIdentity(workspaceId, d, urls, { headings: extra?.headings, fonts: extra?.fonts });
    return applySuggestion(d, s, overwrite);
  };

  const runSuggest = async () => {
    setBusy("suggest");
    try {
      setDraft(await suggest(draft, true));
    } catch (e) {
      toast.error(userMessage(e, tr("brands.couldnt_suggest")));
    } finally {
      setBusy(null);
    }
  };

  /** Add a logo from a file: upload it, take its colors, and make a white
   *  version for dark grounds when the logo has a transparent background. */
  const startFromLogo = async (file: File) => {
    setBusy("logo");
    try {
      const a = await uploadLogo(workspaceId, file, file.name);
      onUrl(a.id, a.url);
      const label = file.name.replace(/\.[a-z0-9]+$/i, "");
      const img = await logoImage(a.id, urls);
      const dark = img ? await makeDarkVariant(workspaceId, img, label).catch(() => null) : null;
      if (dark) onUrl(dark.id, dark.url);
      let d: BrandDraft = {
        ...draft,
        name: draft.name || label.replace(/[-_]+/g, " ").replace(/\blogo\b/i, "").trim(),
        logos: [{ id: `l-${crypto.randomUUID()}`, label: label || tr("brands.logo"), assetId: a.id, ...(dark ? { variants: { dark: dark.id } } : {}) }],
        colors: withNeutrals(colorsFromHexes(img ? logoPalette(img) : [], draft.colors)),
      };
      setDraft(d);
      if (aiReady) {
        setBusy("suggest");
        try {
          d = await suggest(d, false, null);
          setDraft(d);
        } catch (e) {
          toast.error(userMessage(e, tr("brands.couldnt_suggest")));
        }
      }
      setStep("basics");
    } catch (e) {
      toast.error(userMessage(e, tr("brands.couldnt_read_that_logo")));
    } finally {
      setBusy(null);
    }
  };

  /** Import one logo image found on a website as a workspace asset. */
  const importLogo = async (u: string): Promise<{ id: string; url: string } | null> => {
    try {
      if (u.startsWith("data:image/")) {
        const blob = await (await fetch(u)).blob();
        const a = await directUploadWithProgress(workspaceId, blob, { filename: "logo" });
        return { id: a.id, url: a.url };
      }
      const a = await oc.importAssetFromUrl(workspaceId, u);
      return { id: a.id, url: a.url };
    } catch {
      return null;
    }
  };

  const startFromWebsite = async () => {
    const target = site.trim();
    if (!target || busy) return;
    setBusy("site");
    try {
      const r = await oc.aiBrandFromUrl({ workspaceId, url: /^https?:\/\//i.test(target) ? target : `https://${target}` });
      const found = {
        headings: Array.isArray(r.headings) ? r.headings : [],
        fonts: Array.isArray(r.fonts) ? r.fonts : [],
        logoUrls: Array.isArray(r.logoUrls) ? r.logoUrls : [],
      };
      setScan(found);
      let logo: { id: string; url: string } | null = null;
      for (const u of found.logoUrls.slice(0, 3)) {
        logo = await importLogo(u);
        if (logo) break;
      }
      if (logo) onUrl(logo.id, logo.url);
      let d: BrandDraft = {
        ...draft,
        name: draft.name || (r.name ?? "").slice(0, 80),
        description: draft.description || (r.description ?? ""),
        colors: withNeutrals(colorsFromHexes(Array.isArray(r.colors) ? r.colors : [], draft.colors)),
        headingFont: draft.headingFont || found.fonts[0] || "",
        bodyFont: draft.bodyFont || found.fonts[1] || found.fonts[0] || "",
        logos: logo ? [{ id: `l-${crypto.randomUUID()}`, label: (r.name ?? "").slice(0, 80) || tr("brands.logo"), assetId: logo.id }] : draft.logos,
      };
      setDraft(d);
      if (aiReady) {
        setBusy("suggest");
        try {
          d = await suggest(d, false, found);
          setDraft(d);
        } catch (e) {
          toast.error(userMessage(e, tr("brands.couldnt_suggest")));
        }
      }
      setStep("basics");
    } catch (e) {
      toast.error(userMessage(e, tr("brands.couldnt_read_that_website")));
    } finally {
      setBusy(null);
    }
  };

  const pickCandidate = async (u: string) => {
    setBusy("logo");
    const a = await importLogo(u);
    setBusy(null);
    if (!a) { toast.error(tr("brands.couldnt_upload_logo")); return; }
    onUrl(a.id, a.url);
    setDraft((d) => ({ ...d, logos: [...d.logos, { id: `l-${crypto.randomUUID()}`, label: d.name || tr("brands.logo"), assetId: a.id }] }));
  };

  const create = async () => {
    if (!draftIsSavable(draft)) { setStep("basics"); toast.error(tr("brands.name_required")); return; }
    setSaving(true);
    let created: BrandKit | null = null;
    try {
      created = await oc.createBrandKit(workspaceId, { name: draft.name.trim().slice(0, 80), isDefault: draft.isDefault });
      const filled = await oc.updateBrandKit(created.id, draftToPatch(draft, created, tr("brands.palette_name")));
      toast.success(tr("brands.brand_kit_created"));
      onCreated(filled);
    } catch (e) {
      if (created) await oc.deleteBrandKit(created.id).catch(() => {});
      toast.error(userMessage(e, tr("brands.couldnt_create_brand_kit")));
    } finally {
      setSaving(false);
    }
  };

  const idx = step === "start" ? -1 : steps.indexOf(step);
  const ai = aiReady ? <AiSuggestButton busy={busy === "suggest"} onClick={() => void runSuggest()} /> : undefined;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-neutral-50" role="dialog" aria-modal="true" aria-label={tr("brands.new_brand_kit")} data-testid="brand-wizard">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-200 bg-surface px-4 py-3 sm:px-6">
        <h2 className="text-base font-semibold text-neutral-900">{tr("brands.new_brand_kit")}</h2>
        <button type="button" onClick={onClose} aria-label={tr("brands.close")} className="grid h-8 w-8 place-items-center rounded-lg text-neutral-500 hover:bg-neutral-100">
          <X size={18} />
        </button>
      </header>

      {step !== "start" && (
        <nav className="border-b border-neutral-200 bg-surface px-4 sm:px-6" aria-label={tr("brands.steps")}>
          <ol className="mx-auto flex max-w-4xl gap-1 overflow-x-auto py-2">
            {steps.map((s, i) => (
              <li key={s}>
                <button
                  type="button"
                  onClick={() => setStep(s)}
                  aria-current={s === step ? "step" : undefined}
                  className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ${s === step ? "bg-brand-600 text-white" : i < idx ? "text-brand-ink hover:bg-brand-50" : "text-neutral-500 hover:bg-neutral-100"}`}
                >
                  <span className={`grid h-4 w-4 place-items-center rounded-full text-[10px] ${s === step ? "bg-white/25" : "bg-neutral-200 text-neutral-600"}`}>
                    {i < idx ? <Check size={10} /> : i + 1}
                  </span>
                  {stepLabel(s)}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}

      <main className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          {step === "start" && (
            <>
              <div>
                <h3 className="text-xl font-semibold text-neutral-900">{tr("brands.how_do_you_want_to_start")}</h3>
                <p className="mt-1 text-sm text-neutral-500">{tr("brands.start_hint")}</p>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <button
                  type="button"
                  onClick={() => setStep("basics")}
                  disabled={busy !== null}
                  className="flex flex-col items-start gap-2 rounded-2xl border border-neutral-200 bg-surface p-5 text-start hover:border-brand-300 hover:shadow-sm disabled:opacity-60"
                  data-testid="brand-start-blank"
                >
                  <PenLine size={20} className="text-brand-ink" />
                  <span className="text-sm font-semibold text-neutral-900">{tr("brands.start_from_scratch")}</span>
                  <span className="text-xs text-neutral-500">{tr("brands.start_from_scratch_hint")}</span>
                </button>
                <label className={`flex cursor-pointer flex-col items-start gap-2 rounded-2xl border border-neutral-200 bg-surface p-5 hover:border-brand-300 hover:shadow-sm ${busy ? "pointer-events-none opacity-60" : ""}`}>
                  <input type="file" accept="image/*" className="hidden" data-testid="brand-start-logo" onChange={(e) => { const f = e.target.files?.[0]; if (f) void startFromLogo(f); e.target.value = ""; }} />
                  {busy === "logo" || (busy === "suggest" && !scan) ? <Loader2 size={20} className="animate-spin text-brand-ink" /> : <ImageIcon size={20} className="text-brand-ink" />}
                  <span className="text-sm font-semibold text-neutral-900">{tr("brands.start_from_logo")}</span>
                  <span className="text-xs text-neutral-500">{aiReady ? tr("brands.start_from_logo_hint_ai") : tr("brands.start_from_logo_hint")}</span>
                </label>
                <div className="flex flex-col items-start gap-2 rounded-2xl border border-neutral-200 bg-surface p-5">
                  {busy === "site" || (busy === "suggest" && scan) ? <Loader2 size={20} className="animate-spin text-brand-ink" /> : <Globe size={20} className="text-brand-ink" />}
                  <span className="text-sm font-semibold text-neutral-900">{tr("brands.start_from_website")}</span>
                  <span className="text-xs text-neutral-500">{aiReady ? tr("brands.start_from_website_hint_ai") : tr("brands.start_from_website_hint")}</span>
                  <form className="mt-1 flex w-full gap-1.5" onSubmit={(e) => { e.preventDefault(); void startFromWebsite(); }}>
                    <input
                      value={site}
                      onChange={(e) => setSite(e.target.value)}
                      placeholder={tr("brands.website_placeholder")}
                      aria-label={tr("brands.company_website")}
                      className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-surface px-2 py-1.5 text-sm outline-none focus:border-brand-400"
                      data-testid="brand-start-website"
                    />
                    <button type="submit" disabled={!site.trim() || busy !== null} className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:bg-neutral-200 disabled:text-neutral-400">
                      {tr("brands.go")}
                    </button>
                  </form>
                </div>
              </div>
              {busy === "suggest" && <p className="text-sm text-neutral-500">{tr("brands.drafting_voice_and_fonts")}</p>}
              {!aiReady && <p className="text-xs text-neutral-500">{tr("brands.ai_not_connected_hint")}</p>}
            </>
          )}

          {step === "basics" && <BasicsSection draft={draft} onChange={setDraft} />}
          {step === "logos" && (
            <LogoSection
              workspaceId={workspaceId}
              draft={draft}
              onChange={setDraft}
              urls={urls}
              onUrl={onUrl}
              candidates={scan?.logoUrls}
              onUseCandidate={(u) => void pickCandidate(u)}
            />
          )}
          {step === "colors" && <ColorSection draft={draft} onChange={setDraft} urls={urls} />}
          {step === "fonts" && <FontSection draft={draft} onChange={setDraft} ai={ai} />}
          {step === "voice" && <VoiceSection draft={draft} onChange={setDraft} ai={ai} />}
          {step === "review" && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-neutral-200 bg-surface p-4">
                <div>
                  <div className="text-lg font-semibold text-neutral-900">{draft.name || tr("brands.untitled_brand")}</div>
                  <p className="text-xs text-neutral-500">{tr("brands.review_hint")}</p>
                </div>
                <label className="flex items-center gap-2 text-sm text-neutral-700">
                  <input type="checkbox" checked={draft.isDefault} onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} className="h-4 w-4 accent-brand-600" />
                  {tr("brands.make_default")}
                </label>
              </div>
              <ControlsSection draft={draft} onChange={setDraft} />
              <BrandGuide draft={draft} urls={urls} />
            </>
          )}
        </div>
      </main>

      {step !== "start" && (
        <footer className="border-t border-neutral-200 bg-surface px-4 py-3 sm:px-6">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setStep(idx <= 0 ? "start" : steps[idx - 1])}
              className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
            >
              <ArrowLeft size={15} /> {tr("brands.back")}
            </button>
            {step === "review" ? (
              <button
                type="button"
                onClick={() => void create()}
                disabled={saving || !draftIsSavable(draft)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
                data-testid="brand-wizard-create"
              >
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {tr("brands.create_brand_kit")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setStep(steps[idx + 1])}
                disabled={step === "basics" && !draftIsSavable(draft)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
                data-testid="brand-wizard-next"
              >
                {tr("brands.next")} <ArrowRight size={15} />
              </button>
            )}
          </div>
        </footer>
      )}
    </div>
  );
}
