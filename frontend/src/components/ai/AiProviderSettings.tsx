// The workspace's AI provider configuration, in one place.
//
// It used to live only inside the editor's assistant panel, which made a
// WORKSPACE setting (admin-gated, shared by every member) reachable only by
// opening a design and finding the fourth icon in the tool rail. This component
// is the single implementation; the editor renders it inline for the person who
// just hit the wall, and the workspace administration view renders it where an
// admin would actually look for it.
//
// It owns only form state. The caller owns the loaded config, because the
// editor needs it anyway (to decide what the assistant may offer) and a second
// fetch for the same data would be waste.

import { useEffect, useState } from "react";
import { ApiError, type AiProviderPreset, type AiConfigView } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { apiCodeMessage } from "@/lib/errors";
import { tr } from "@/lib/i18n";

export function AiProviderSettings({
  workspaceId,
  config,
  presets,
  canEdit,
  onSaved,
  onCancel,
  layout = "stack",
}: {
  workspaceId: string | null;
  config: AiConfigView | null;
  presets: AiProviderPreset[];
  /** Writing the config is admin-only server-side. A member who cannot save
   *  sees what is connected instead of a form that would 403. */
  canEdit: boolean;
  onSaved: (config: AiConfigView) => void;
  /** Shown as a Cancel affordance when there is something to go back to. */
  onCancel?: () => void;
  /** "stack" for the editor's narrow tool panel, "wide" for a settings page.
   *  A viewport breakpoint cannot tell those apart: the panel is about 288px
   *  wide even on a large screen. */
  layout?: "stack" | "wide";
}) {
  const toast = useToast();
  const [provider, setProvider] = useState(config?.provider ?? "openai");
  const [model, setModel] = useState(config?.model ?? "");
  const [imageModel, setImageModel] = useState(config?.imageModel ?? "");
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [searchProvider, setSearchProvider] = useState("");
  const [searchUrl, setSearchUrl] = useState("");
  const [searchKey, setSearchKey] = useState("");
  // The workspace whose stored web-search record has actually arrived. Derived
  // rather than a separate flag, so switching workspace invalidates it without
  // a reset written during render or in an effect body.
  //
  // It matters because the fields default to "off": saving before the record
  // loads (or when its fetch failed) would send provider:"" and silently CLEAR
  // a configured search provider. The previous version could not hit this,
  // because one combined fetch gated the whole form.
  const [searchFor, setSearchFor] = useState<string | null>(null);
  const searchLoaded = !!workspaceId && searchFor === workspaceId;
  const [saving, setSaving] = useState(false);

  // Re-arm when the workspace (or its stored config) changes, the render-time
  // adjustment pattern: never show one workspace's provider while another's is
  // loading.
  const armKey = `${workspaceId ?? ""}:${config?.provider ?? ""}:${config?.hasKey ? 1 : 0}`;
  const [armedFor, setArmedFor] = useState(armKey);
  if (armedFor !== armKey) {
    setArmedFor(armKey);
    setProvider(config?.provider ?? "openai");
    setModel(config?.model ?? "");
    setImageModel(config?.imageModel ?? "");
    setBaseUrl(config?.baseUrl ?? "");
    setApiKey("");
  }

  // The optional web-search grounding provider is a separate record; it is
  // fetched here because only this form edits it.
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void oc.getSearchConfig(workspaceId).then(
      (cfg) => {
        if (cancelled) return;
        setSearchProvider(cfg?.provider ?? "");
        setSearchUrl(cfg?.baseUrl ?? "");
        setSearchKey("");
        setSearchFor(workspaceId);
      },
      () => {
        // Leave it untouched and unsaved rather than guess it is off.
      },
    );
    return () => { cancelled = true; };
  }, [workspaceId]);

  const selPreset = presets.find((p) => p.id === provider);
  const requiresBaseUrl = !!selPreset?.needsBaseUrl;
  const sameProvider = provider === config?.provider;
  const modelHint = selPreset?.defaultModel ?? "";

  if (!canEdit) {
    return (
      <div className="flex flex-col gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-2 text-[11px] text-neutral-600">
        <span>
          {config?.hasKey
            ? tr("editor.ai_provider_connected_by_an_admin", { provider: selPreset?.label ?? config.provider })
            : tr("editor.no_ai_provider_ask_an_admin")}
        </span>
      </div>
    );
  }

  async function save() {
    if (!workspaceId || saving) return;
    const url = baseUrl.trim();
    // Endpoint-routed providers are unusable without their URL; the server
    // rejects the save too (ai_base_url_required), but catching it here points
    // at the field without a round trip.
    if (requiresBaseUrl && !url) {
      toast.error(tr("errors.api_ai_base_url_required"));
      return;
    }
    // A provider change must bring the new provider's key (the server rejects
    // it as ai_key_required_for_provider_change); say so before the round trip.
    if (!sameProvider && config?.hasKey && !apiKey.trim()) {
      toast.error(tr("errors.api_ai_key_required_for_provider_change"));
      return;
    }
    setSaving(true);
    try {
      // baseUrl uses PATCH semantics server-side: a rendered field sends its
      // exact value, so emptying a visible field is an explicit clear, and the
      // server drops a stored URL on a provider change.
      const c = await oc.setAiConfig(workspaceId, {
        provider,
        model: model || undefined,
        imageModel: imageModel || undefined,
        baseUrl: url,
        apiKey: apiKey || undefined,
      });
      setApiKey("");
      // The optional web-search provider saves in the same gesture (provider
      // "" clears it), but ONLY once its stored value is known - otherwise an
      // early save would clear a provider the user never touched.
      if (searchLoaded) {
        await oc.setSearchConfig(workspaceId, {
          provider: searchProvider,
          ...(searchProvider === "searxng" ? { baseUrl: searchUrl.trim() } : {}),
          ...(searchKey.trim() ? { apiKey: searchKey.trim() } : {}),
        });
        setSearchKey("");
      }
      toast.success(tr("editor.ai_provider_saved"));
      onSaved(c);
    } catch (e) {
      // Show the server's coded reason when it sent one (e.g. a rejected base
      // URL); the generic save error stays the fallback.
      const coded = e instanceof ApiError ? apiCodeMessage(e.body) : null;
      toast.error(coded ?? tr("editor.could_not_save_ai_settings"));
    } finally {
      setSaving(false);
    }
  }

  const wide = layout === "wide";
  // Two densities for two homes. The settings page follows the app's standard
  // field (the shared Input component's shape), so it sits beside every other
  // form in the product; the editor's 288px tool panel keeps a compact field,
  // where a 44px control would eat the panel.
  const fieldCls = wide
    ? "h-11 w-full rounded-xl border border-neutral-200 bg-surface px-3.5 text-sm text-neutral-900 placeholder:text-neutral-400 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
    : "w-full rounded-lg border border-neutral-200 bg-surface px-2.5 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100";
  const labelCls = wide
    ? "flex min-w-0 flex-col gap-1.5 text-sm font-medium text-neutral-700"
    : "flex min-w-0 flex-col gap-1 text-[11px] font-medium text-neutral-500";

  return (
    <div className="flex flex-col gap-2.5">
      {/* Every field carries a VISIBLE label, not just a placeholder: a
          placeholder vanishes as soon as the field has a value, which left a
          saved model name sitting in an unnamed box - confusing to read and a
          3.3.2 failure. */}
      <div className={wide ? "grid grid-cols-2 gap-x-4 gap-y-3.5" : "flex flex-col gap-2.5"}>
        <label className={labelCls}>
          {tr("editor.provider")}
          <select
            value={provider}
            onChange={(e) => {
              const next = e.target.value;
              setProvider(next);
              // Model names belong to a provider: a stale "deepseek-chat" must
              // never ride into an OpenAI save (the provider would 404 on
              // every call). Switching back restores that provider's models.
              const stored = next === config?.provider;
              setModel(stored ? config?.model ?? "" : "");
              setImageModel(stored ? config?.imageModel ?? "" : "");
              // Same for the host: the server drops a stored URL on a provider
              // change, and the visible field must not put the old host back.
              setBaseUrl(stored ? config?.baseUrl ?? "" : "");
            }}
            className={fieldCls}
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
            {/* A stored provider missing from the catalog (legacy row) stays selectable. */}
            {!selPreset && <option value={provider}>{provider}</option>}
          </select>
        </label>

        <label className={labelCls}>
          {tr("editor.model_optional")}
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={modelHint || tr("editor.model_optional")}
            className={fieldCls}
          />
        </label>

        {(selPreset?.capabilities.image ?? true) && (
          <label className={labelCls}>
            {tr("editor.image_model_optional")}
            <input
              value={imageModel}
              onChange={(e) => setImageModel(e.target.value)}
              placeholder={selPreset?.defaultImageModel || tr("editor.image_model_optional")}
              className={fieldCls}
            />
          </label>
        )}

        {/* Always editable: several presets front more than one host
            (Moonshot's international and mainland platforms issue separate
            keys, and proxies are common), and a hidden field meant a key for
            the other host could only ever 401 with no way to correct it. */}
        <label className={labelCls}>
          {tr("editor.base_url")}
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={selPreset?.baseUrl || tr("editor.base_url_https_v1")}
            className={fieldCls}
          />
        </label>

        <label className={labelCls}>
          {tr("editor.api_key")}
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config?.hasKey ? tr("editor.api_key_leave_blank_to_keep") : tr("editor.api_key")}
            className={fieldCls}
          />
        </label>

        {/* T16: optional web-search grounding. Hidden until its stored value
            is known, so the control never shows "off" for something that is
            on, and a save cannot clear what it never loaded. */}
        {searchLoaded && (
          <label className={labelCls}>
            {tr("editor.web_search_optional")}
            <select value={searchProvider} onChange={(e) => setSearchProvider(e.target.value)} className={fieldCls}>
              <option value="">{tr("editor.search_off")}</option>
              <option value="tavily">{tr("editor.search_provider_hosted")}</option>
              <option value="searxng">{tr("editor.search_provider_metasearch")}</option>
            </select>
          </label>
        )}

        {searchLoaded && searchProvider === "searxng" && (
          <label className={labelCls}>
            {tr("editor.base_url")}
            <input value={searchUrl} onChange={(e) => setSearchUrl(e.target.value)} placeholder={tr("editor.base_url_https_v1")} className={fieldCls} />
          </label>
        )}
        {searchLoaded && searchProvider === "tavily" && (
          <label className={labelCls}>
            {tr("editor.api_key")}
            <input type="password" value={searchKey} onChange={(e) => setSearchKey(e.target.value)} placeholder={tr("editor.api_key")} className={fieldCls} />
          </label>
        )}
      </div>

      <div className={`flex items-center gap-3 ${wide ? "mt-1 justify-end" : "mt-0.5 flex-col"}`}>
        {onCancel && (
          <button onClick={onCancel} className="text-xs text-neutral-500 hover:underline">{tr("editor.cancel")}</button>
        )}
        {wide ? (
          <button
            onClick={() => void save()}
            disabled={!workspaceId || saving}
            className="rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:bg-neutral-200 disabled:text-neutral-400"
          >
            {saving ? tr("editor.saving") : tr("editor.save_provider")}
          </button>
        ) : (
          <Button block onClick={() => void save()} disabled={!workspaceId || saving}>
            {saving ? tr("editor.saving") : tr("editor.save_provider")}
          </Button>
        )}
      </div>
    </div>
  );
}
