// Brand kits tab of the dashboard (#53). Lists the workspace's brand kits and
// opens one as a brand guide (read-only), an edit page, or its version history.
// New kits come from the wizard (#54 adds starting from a logo or a website).
// Members can read every kit; creating, editing, and deleting need
// manage-brand (workspace owner or admin), which the server enforces too.
//
// The open kit lives in the URL (?brand=<id>&tab=edit), so a guide can be
// linked to and survives a refresh on the statically exported page.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import {
  ArrowLeft, BookOpen, Copy, History, Loader2, Palette, Pencil, Plus, Printer, RotateCcw, Star, Trash2,
} from "lucide-react";
import type { BrandKit, BrandKitVersion, UploadedAsset } from "@hc/sdk";
import { colorToHex, draftIsSavable, draftToPatch, duplicatePatch, kitToDraft, type BrandDraft } from "@/lib/brandDraft";
import { oc } from "@/lib/sdk";
import { useToast } from "@/components/ui/Toast";
import { Modal } from "@/components/ui/Modal";
import { tr } from "@/lib/i18n";
import { userMessage } from "@/lib/errors";
import { useDateFormat } from "@/lib/datetime";
import {
  AiSuggestButton, applySuggestion, BasicsSection, ColorSection, ControlsSection, FontSection, LogoSection, VoiceSection,
  logoSrc, suggestIdentity, type AssetUrls,
} from "./BrandForms";
import { BrandGuide } from "./BrandGuide";
import { BrandWizard } from "./BrandWizard";

type Tab = "guide" | "edit" | "history";

export function BrandsView({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [kits, setKits] = useState<BrandKit[] | null>(null);
  const [urls, setUrls] = useState<AssetUrls>({});
  const [aiReady, setAiReady] = useState(false);
  const [wizard, setWizard] = useState(false);

  const openId = typeof router.query.brand === "string" ? router.query.brand : null;
  const rawTab = typeof router.query.tab === "string" ? router.query.tab : "guide";
  const tab: Tab = rawTab === "edit" && canManage ? "edit" : rawTab === "history" && canManage ? "history" : "guide";

  const go = useCallback((brand: string | null, t: Tab = "guide") => {
    const query: Record<string, string> = {};
    if (brand) query.brand = brand;
    if (brand && t !== "guide") query.tab = t;
    void router.push({ pathname: "/dashboard/brands/", query }, undefined, { shallow: true });
  }, [router]);

  const load = useCallback(async () => {
    try {
      const [ks, assets] = await Promise.all([oc.listBrandKits(workspaceId), oc.listAssets(workspaceId).catch(() => [] as UploadedAsset[])]);
      setKits(ks);
      const map: AssetUrls = {};
      for (const a of assets as UploadedAsset[]) map[a.id] = a.url;
      setUrls((cur) => ({ ...map, ...cur }));
    } catch (e) {
      setKits([]);
      toast.error(userMessage(e, tr("brands.couldnt_load_brand_kits")));
    }
  }, [workspaceId, toast]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => { if (!cancelled) { setKits(null); void load(); } });
    // A connected text provider unlocks the AI suggestions; a failed lookup
    // just hides them.
    void oc.getAiEffective(workspaceId)
      .then((eff) => { if (!cancelled) setAiReady(eff.source !== "none" && !!eff.config); })
      .catch(() => { if (!cancelled) setAiReady(false); });
    return () => { cancelled = true; };
  }, [workspaceId, load]);

  const onUrl = useCallback((id: string, url: string) => setUrls((u) => ({ ...u, [id]: url })), []);
  const replaceKit = useCallback((k: BrandKit) => {
    setKits((cur) => {
      const list = cur ?? [];
      const next = list.some((x) => x.id === k.id) ? list.map((x) => (x.id === k.id ? k : x)) : [...list, k];
      // Only one kit is the default; the server already moved the flag.
      return k.isDefault ? next.map((x) => (x.id === k.id ? x : { ...x, isDefault: false })) : next;
    });
  }, []);

  const open = kits?.find((k) => k.id === openId) ?? null;

  if (kits === null) {
    return <div className="grid place-items-center py-16 text-neutral-400"><Loader2 size={20} className="animate-spin" /></div>;
  }

  return (
    <>
      {open ? (
        <BrandDetail
          key={open.id}
          kit={open}
          tab={tab}
          canManage={canManage}
          aiReady={aiReady}
          workspaceId={workspaceId}
          urls={urls}
          onUrl={onUrl}
          onTab={(t) => go(open.id, t)}
          onBack={() => go(null)}
          onChanged={replaceKit}
          onDuplicated={(k) => { replaceKit(k); go(k.id, "edit"); }}
          onDeleted={() => { setKits((cur) => (cur ?? []).filter((x) => x.id !== open.id)); go(null); }}
        />
      ) : (
        <BrandList kits={kits} urls={urls} canManage={canManage} openKit={(id) => go(id)} onNew={() => setWizard(true)} missing={!!openId} />
      )}
      {wizard && (
        <BrandWizard
          workspaceId={workspaceId}
          aiReady={aiReady}
          isFirst={kits.length === 0}
          urls={urls}
          onUrl={onUrl}
          onClose={() => setWizard(false)}
          onCreated={(k) => { replaceKit(k); setWizard(false); go(k.id); }}
        />
      )}
    </>
  );
}

function BrandList({ kits, urls, canManage, openKit, onNew, missing }: {
  kits: BrandKit[];
  urls: AssetUrls;
  canManage: boolean;
  openKit: (id: string) => void;
  onNew: () => void;
  missing: boolean;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => kits.filter((k) => k.name.toLowerCase().includes(q.trim().toLowerCase())), [kits, q]);
  return (
    <section data-testid="brands-list">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-neutral-400">{tr("brands.brand_kits")}</h2>
          <p className="mt-0.5 text-xs text-neutral-500">{tr("brands.list_hint")}</p>
        </div>
        <div className="flex items-center gap-2">
          {kits.length > 3 && (
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={tr("brands.search_brand_kits")}
              aria-label={tr("brands.search_brand_kits")}
              className="h-9 w-48 rounded-lg border border-neutral-200 bg-surface px-3 text-sm outline-none focus:border-brand-400"
            />
          )}
          {canManage && (
            <button type="button" onClick={onNew} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700" data-testid="brands-new">
              <Plus size={15} /> {tr("brands.new_brand_kit")}
            </button>
          )}
        </div>
      </div>
      {missing && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{tr("brands.brand_kit_not_found")}</p>}
      {kits.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-neutral-200 px-6 py-14 text-center">
          <Palette size={28} className="text-neutral-300" />
          <div className="text-sm font-medium text-neutral-700">{tr("brands.no_brand_kits_yet")}</div>
          <p className="max-w-md text-xs text-neutral-500">{canManage ? tr("brands.empty_hint_manager") : tr("brands.empty_hint_member")}</p>
          {canManage && (
            <button type="button" onClick={onNew} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700">
              <Plus size={15} /> {tr("brands.new_brand_kit")}
            </button>
          )}
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((k) => {
            const logo = k.logos[0] ? logoSrc(k.logos[0].assetId, urls) : null;
            const swatches = k.palettes.flatMap((p) => p.colors).slice(0, 6);
            const heading = k.fonts.find((f) => f.role === "heading")?.fontFamily;
            const body = k.fonts.find((f) => f.role === "body")?.fontFamily;
            return (
              <li key={k.id}>
                <button
                  type="button"
                  onClick={() => openKit(k.id)}
                  className="flex w-full flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-surface text-start shadow-sm transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md"
                  data-testid="brand-card"
                >
                  <div className="light flex h-28 items-center justify-center bg-white p-4">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {logo ? <img src={logo} alt="" className="h-full w-full object-contain" /> : <Palette size={28} className="text-neutral-300" />}
                  </div>
                  <div className="flex h-3">
                    {swatches.length ? swatches.map((s) => <span key={s.id} className="flex-1" style={{ background: colorToHex(s.value) }} />) : <span className="flex-1 bg-neutral-100" />}
                  </div>
                  <div className="flex flex-col gap-0.5 px-3.5 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-neutral-900">{k.name}</span>
                      {k.isDefault && <span className="shrink-0 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold text-brand-ink">{tr("brands.default")}</span>}
                    </div>
                    <span className="truncate text-xs text-neutral-500">{[heading, body].filter(Boolean).join(" · ") || tr("brands.no_fonts_yet")}</span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function BrandDetail({
  kit, tab, canManage, aiReady, workspaceId, urls, onUrl, onTab, onBack, onChanged, onDuplicated, onDeleted,
}: {
  kit: BrandKit;
  tab: Tab;
  canManage: boolean;
  aiReady: boolean;
  workspaceId: string;
  urls: AssetUrls;
  onUrl: (id: string, url: string) => void;
  onTab: (t: Tab) => void;
  onBack: () => void;
  onChanged: (k: BrandKit) => void;
  onDuplicated: (k: BrandKit) => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const saved = useMemo(() => kitToDraft(kit), [kit]);

  const setDefault = async () => {
    setBusy("default");
    try {
      onChanged(await oc.setDefaultBrandKit(kit.id));
      toast.success(tr("brands.set_as_default_done"));
    } catch (e) {
      toast.error(userMessage(e, tr("brands.couldnt_save_brand_kit")));
    } finally {
      setBusy(null);
    }
  };

  const duplicate = async () => {
    setBusy("duplicate");
    let created: BrandKit | null = null;
    try {
      created = await oc.createBrandKit(workspaceId, { name: tr("brands.copy_of", { name: kit.name }).slice(0, 80), isDefault: false });
      const filled = await oc.updateBrandKit(created.id, duplicatePatch(kit));
      toast.success(tr("brands.duplicated"));
      onDuplicated(filled);
    } catch (e) {
      if (created) await oc.deleteBrandKit(created.id).catch(() => {});
      toast.error(userMessage(e, tr("brands.couldnt_duplicate")));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("delete");
    try {
      await oc.deleteBrandKit(kit.id);
      toast.success(tr("brands.deleted"));
      onDeleted();
    } catch (e) {
      toast.error(userMessage(e, tr("brands.couldnt_delete")));
    } finally {
      setBusy(null);
      setConfirmDelete(false);
    }
  };

  const tabs: { id: Tab; label: string; icon: typeof BookOpen }[] = [
    { id: "guide", label: tr("brands.guide"), icon: BookOpen },
    ...(canManage ? [{ id: "edit" as const, label: tr("brands.edit"), icon: Pencil }, { id: "history" as const, label: tr("brands.history"), icon: History }] : []),
  ];

  return (
    <section data-testid="brand-detail">
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-neutral-500 hover:text-neutral-800 print:hidden">
        <ArrowLeft size={14} /> {tr("brands.all_brand_kits")}
      </button>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-xl font-semibold text-neutral-900">{kit.name}</h2>
          {kit.isDefault && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-ink">{tr("brands.default")}</span>}
          <span className="text-xs text-neutral-400">{tr("brands.version_n", { n: String(kit.version) })}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 print:hidden">
          <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50">
            <Printer size={13} /> {tr("brands.print")}
          </button>
          {canManage && !kit.isDefault && (
            <button type="button" disabled={busy !== null} onClick={() => void setDefault()} className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50">
              <Star size={13} /> {tr("brands.set_as_default")}
            </button>
          )}
          {canManage && (
            <button type="button" disabled={busy !== null} onClick={() => void duplicate()} className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50">
              {busy === "duplicate" ? <Loader2 size={13} className="animate-spin" /> : <Copy size={13} />} {tr("brands.duplicate")}
            </button>
          )}
          {canManage && (
            <button type="button" disabled={busy !== null} onClick={() => setConfirmDelete(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50">
              <Trash2 size={13} /> {tr("brands.delete")}
            </button>
          )}
        </div>
      </div>

      {tabs.length > 1 && (
        <div className="mb-5 flex gap-1 border-b border-neutral-200 print:hidden" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => onTab(t.id)}
              className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium ${tab === t.id ? "border-brand-600 text-brand-ink" : "border-transparent text-neutral-500 hover:text-neutral-800"}`}
            >
              <t.icon size={14} /> {t.label}
            </button>
          ))}
        </div>
      )}

      {tab === "guide" && <BrandGuide draft={saved} urls={urls} />}
      {tab === "edit" && <BrandEditor kit={kit} saved={saved} aiReady={aiReady} workspaceId={workspaceId} urls={urls} onUrl={onUrl} onSaved={(k) => { onChanged(k); onTab("guide"); }} />}
      {tab === "history" && <BrandHistory kit={kit} onRestored={onChanged} />}

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title={tr("brands.delete_brand_kit_q")}>
        <p className="text-sm text-neutral-600">{tr("brands.delete_brand_kit_body", { name: kit.name })}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => setConfirmDelete(false)} className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50">{tr("brands.cancel")}</button>
          <button type="button" onClick={() => void remove()} disabled={busy === "delete"} className="rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60" data-testid="brand-delete-confirm">
            {tr("brands.delete")}
          </button>
        </div>
      </Modal>
    </section>
  );
}

function BrandEditor({ kit, saved, aiReady, workspaceId, urls, onUrl, onSaved }: {
  kit: BrandKit;
  saved: BrandDraft;
  aiReady: boolean;
  workspaceId: string;
  urls: AssetUrls;
  onUrl: (id: string, url: string) => void;
  onSaved: (k: BrandKit) => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<BrandDraft>(saved);
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const dirty = JSON.stringify({ ...draft, description: "" }) !== JSON.stringify({ ...saved, description: "" });

  const save = async () => {
    setSaving(true);
    try {
      // Patch against the kit as loaded: the server versions every write, and
      // draftToPatch rebuilds the arrays from the stored objects.
      const updated = await oc.updateBrandKit(kit.id, draftToPatch(draft, kit, tr("brands.palette_name")));
      toast.success(tr("brands.saved"));
      onSaved(updated);
    } catch (e) {
      toast.error(userMessage(e, tr("brands.couldnt_save_brand_kit")));
    } finally {
      setSaving(false);
    }
  };

  const suggest = async () => {
    setSuggesting(true);
    try {
      setDraft(applySuggestion(draft, await suggestIdentity(workspaceId, draft, urls), true));
    } catch (e) {
      toast.error(userMessage(e, tr("brands.couldnt_suggest")));
    } finally {
      setSuggesting(false);
    }
  };
  const ai = aiReady ? <AiSuggestButton busy={suggesting} onClick={() => void suggest()} /> : undefined;

  return (
    <div className="flex flex-col gap-4 pb-20" data-testid="brand-editor">
      <BasicsSection draft={draft} onChange={setDraft} />
      <LogoSection workspaceId={workspaceId} draft={draft} onChange={setDraft} urls={urls} onUrl={onUrl} />
      <ColorSection draft={draft} onChange={setDraft} urls={urls} />
      <FontSection draft={draft} onChange={setDraft} ai={ai} />
      <VoiceSection draft={draft} onChange={setDraft} ai={ai} />
      <ControlsSection draft={draft} onChange={setDraft} />
      <div className="sticky bottom-0 -mx-1 flex items-center justify-end gap-2 border-t border-neutral-200 bg-neutral-50/95 px-1 py-3 backdrop-blur">
        {dirty && <span className="me-auto text-xs text-neutral-500">{tr("brands.unsaved_changes")}</span>}
        <button type="button" onClick={() => setDraft(saved)} disabled={!dirty || saving} className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-50">
          {tr("brands.discard")}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving || !draftIsSavable(draft)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
          data-testid="brand-editor-save"
        >
          {saving && <Loader2 size={14} className="animate-spin" />} {tr("brands.save_changes")}
        </button>
      </div>
    </div>
  );
}

function BrandHistory({ kit, onRestored }: { kit: BrandKit; onRestored: (k: BrandKit) => void }) {
  const toast = useToast();
  const df = useDateFormat();
  const [versions, setVersions] = useState<BrandKitVersion[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void oc.listBrandKitVersions(kit.id)
      .then((v) => { if (!cancelled) setVersions(v); })
      .catch(() => { if (!cancelled) setVersions([]); });
    return () => { cancelled = true; };
  }, [kit.id, kit.version]);

  const restore = async (version: number) => {
    setBusy(version);
    try {
      onRestored(await oc.restoreBrandKitVersion(kit.id, version));
      toast.success(tr("brands.restored_version", { n: String(version) }));
    } catch (e) {
      toast.error(userMessage(e, tr("brands.couldnt_restore")));
    } finally {
      setBusy(null);
    }
  };

  if (versions === null) return <div className="py-8 text-center text-neutral-400"><Loader2 size={18} className="inline animate-spin" /></div>;
  if (versions.length === 0) return <p className="text-sm text-neutral-500">{tr("brands.no_history_yet")}</p>;
  return (
    <div>
      <p className="mb-3 text-xs text-neutral-500">{tr("brands.history_hint")}</p>
      <ul className="divide-y divide-neutral-200 rounded-2xl border border-neutral-200 bg-surface">
        {versions.map((v) => (
          <li key={v.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0">
              <div className="text-sm font-medium text-neutral-800">{tr("brands.version_n", { n: String(v.version) })}{v.version === kit.version && <span className="ms-2 text-xs text-neutral-400">{tr("brands.current")}</span>}</div>
              <div className="text-xs text-neutral-500">{df.dateTime(v.createdAt)}</div>
            </div>
            {v.version !== kit.version && (
              <button type="button" onClick={() => void restore(v.version)} disabled={busy !== null} className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50">
                {busy === v.version ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} {tr("brands.restore")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
