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
      },
      () => {},
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
      // "" clears it); its coded rejections surface like the AI config's.
      await oc.setSearchConfig(workspaceId, {
        provider: searchProvider,
        ...(searchProvider === "searxng" ? { baseUrl: searchUrl.trim() } : {}),
        ...(searchKey.trim() ? { apiKey: searchKey.trim() } : {}),
      });
      setSearchKey("");
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

  return (
    <div className="flex flex-col gap-2">
      <select
        value={provider}
        aria-label={tr("editor.provider")}
        onChange={(e) => {
          const next = e.target.value;
          setProvider(next);
          // Model names belong to a provider: a stale "deepseek-chat" must
          // never ride into an OpenAI save (the provider would 404 on every
          // call). Switching back to the stored provider restores its models.
          const stored = next === config?.provider;
          setModel(stored ? config?.model ?? "" : "");
          setImageModel(stored ? config?.imageModel ?? "" : "");
          // Same for the host: the server drops a stored URL on a provider
          // change, and the visible field must not put the old host back.
          setBaseUrl(stored ? config?.baseUrl ?? "" : "");
        }}
        className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
      >
        {presets.map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
        {/* A stored provider missing from the catalog (legacy row) stays selectable. */}
        {!selPreset && <option value={provider}>{provider}</option>}
      </select>
      <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={modelHint ? `Model (optional, default ${modelHint})` : tr("editor.model_optional")} className="rounded border border-neutral-300 px-2 py-1.5 text-sm" />
      {(selPreset?.capabilities.image ?? true) && (
        <input value={imageModel} onChange={(e) => setImageModel(e.target.value)} placeholder={selPreset?.defaultImageModel ? `Image model (optional, default ${selPreset.defaultImageModel})` : tr("editor.image_model_optional")} className="rounded border border-neutral-300 px-2 py-1.5 text-sm" />
      )}
      {/* Always editable: several presets front more than one host (Moonshot's
          international and mainland platforms issue separate keys, and
          proxies are common), and a hidden field meant a key for the other
          host could only ever 401 with no way to correct it. */}
      <input
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder={!requiresBaseUrl && selPreset?.baseUrl ? tr("editor.base_url_optional_default", { url: selPreset.baseUrl }) : tr("editor.base_url_https_v1")}
        aria-label={tr("editor.base_url")}
        className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
      />
      <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={config?.hasKey ? tr("editor.api_key_leave_blank_to_keep") : tr("editor.api_key")} className="rounded border border-neutral-300 px-2 py-1.5 text-sm" />
      {/* T16: optional web-search grounding provider. */}
      <label className="mt-1 flex flex-col gap-1 text-[11px] text-neutral-500">
        {tr("editor.web_search_optional")}
        <select value={searchProvider} onChange={(e) => setSearchProvider(e.target.value)} className="rounded border border-neutral-300 px-2 py-1.5 text-sm text-neutral-800">
          <option value="">{tr("editor.search_off")}</option>
          <option value="tavily">{tr("editor.search_provider_hosted")}</option>
          <option value="searxng">{tr("editor.search_provider_metasearch")}</option>
        </select>
      </label>
      {searchProvider === "searxng" && (
        <input value={searchUrl} onChange={(e) => setSearchUrl(e.target.value)} placeholder={tr("editor.base_url_https_v1")} className="rounded border border-neutral-300 px-2 py-1.5 text-sm" />
      )}
      {searchProvider === "tavily" && (
        <input type="password" value={searchKey} onChange={(e) => setSearchKey(e.target.value)} placeholder={tr("editor.api_key")} className="rounded border border-neutral-300 px-2 py-1.5 text-sm" />
      )}
      <Button block onClick={() => void save()} disabled={!workspaceId || saving}>
        {saving ? tr("editor.saving") : tr("editor.save_provider")}
      </Button>
      {onCancel && (
        <button onClick={onCancel} className="text-xs text-neutral-500 hover:underline">{tr("editor.cancel")}</button>
      )}
    </div>
  );
}
