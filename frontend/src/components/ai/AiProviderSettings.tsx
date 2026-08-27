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
import { ApiError, type AiProviderPreset, type AiConfigView, type AiImageConfigView } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { apiCodeMessage } from "@/lib/errors";
import { confirmAction } from "@/lib/promptDialog";
import { tr } from "@/lib/i18n";

export function AiProviderSettings({
  workspaceId,
  config,
  presets,
  canEdit,
  onSaved,
  onReset,
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
  /** Called after the provider is reset, with no config left. */
  onReset?: () => void;
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
  // Failing to LOAD is not the same as not having loaded yet. Both hide the
  // fields, because rendering them would offer to save a value we never read,
  // but only one of them should be silent. A section that simply is not there
  // reads as a feature that does not exist, which is exactly how a stale
  // backend (404 on a route the frontend already knows) presents itself.
  const [searchFailed, setSearchFailed] = useState(false);
  // The optional SECOND provider, for image work. Seven of the eleven presets
  // cannot generate an image at all, so without this, choosing Claude or Kimi
  // to write with meant giving up generated imagery entirely.
  //
  // Loaded on the same terms as the search record, and for the same reason: the
  // select defaults to "" (meaning "use the main provider"), so saving before
  // the stored value arrives would clear a configured image provider.
  const [imgProvider, setImgProvider] = useState("");
  const [imgModel, setImgModel] = useState("");
  const [imgBaseUrl, setImgBaseUrl] = useState("");
  const [imgKey, setImgKey] = useState("");
  const [imgHasKey, setImgHasKey] = useState(false);
  const [imgStoredProvider, setImgStoredProvider] = useState("");
  // The stored model and host, kept apart from the editable fields. Restoring
  // from the live values instead would restore what switching away had already
  // blanked: a round trip through another provider and back silently dropped a
  // configured model, and dropped a required custom host into a failing save.
  const [imgStoredModel, setImgStoredModel] = useState("");
  const [imgStoredBaseUrl, setImgStoredBaseUrl] = useState("");
  const [replacingImgKey, setReplacingImgKey] = useState(false);
  const [imgFor, setImgFor] = useState<string | null>(null);
  const imageLoaded = !!workspaceId && imgFor === workspaceId;
  const [imgFailed, setImgFailed] = useState(false);
  // The image provider's credentials, checked on demand. "unverified" is a real
  // third answer, not a softened failure: the probe lists models, and a provider
  // without that route cannot be judged either way.
  const [imgCheck, setImgCheck] = useState<"idle" | "checking" | "ok" | "unverified" | "failed">("idle");
  const [imgCheckDetail, setImgCheckDetail] = useState("");
  const [saving, setSaving] = useState(false);
  // A stored key is write-only: the server returns hasKey and never the key
  // itself. An empty box said nothing about whether one existed, so it shows a
  // masked stand-in until the user asks to replace it.
  const [replacingKey, setReplacingKey] = useState(false);

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
    setReplacingKey(false);
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
        setSearchFailed(false);
      },
      () => {
        // Leave it untouched and unsaved rather than guess it is off, but say
        // so: silence here is indistinguishable from the feature being absent.
        if (!cancelled) setSearchFailed(true);
      },
    );
    return () => { cancelled = true; };
  }, [workspaceId]);

  // The dedicated image provider is its own record, fetched here because only
  // this form edits it.
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void oc.getAiImageConfig(workspaceId).then(
      (cfg: AiImageConfigView | null) => {
        if (cancelled) return;
        setImgProvider(cfg?.provider ?? "");
        setImgStoredProvider(cfg?.provider ?? "");
        setImgModel(cfg?.model ?? "");
        setImgStoredModel(cfg?.model ?? "");
        setImgBaseUrl(cfg?.baseUrl ?? "");
        setImgStoredBaseUrl(cfg?.baseUrl ?? "");
        setImgHasKey(!!cfg?.hasKey);
        setImgKey("");
        setReplacingImgKey(false);
        setImgFor(workspaceId);
        setImgFailed(false);
      },
      () => {
        // Leave it untouched and unsaved rather than guess it is unset, but
        // say so, for the same reason as the search record above.
        if (!cancelled) setImgFailed(true);
      },
    );
    return () => { cancelled = true; };
  }, [workspaceId]);

  const selPreset = presets.find((p) => p.id === provider);
  const requiresBaseUrl = !!selPreset?.needsBaseUrl;
  const sameProvider = provider === config?.provider;
  const modelHint = selPreset?.defaultModel ?? "";
  // Only image-capable providers may serve as the image provider; offering a
  // text-only one would store a configuration that can only ever fail (the
  // server refuses it too, with ai_image_unsupported).
  const imageCapable = presets.filter((p) => p.capabilities.image);
  const mainCanImage = selPreset?.capabilities.image ?? true;
  const imgPreset = presets.find((p) => p.id === imgProvider);
  const imgSameProvider = imgProvider === imgStoredProvider;
  const imgShowsStoredKey = imgSameProvider && imgHasKey && !replacingImgKey;

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
    // The image provider is a separate vendor with a separate key. The server
    // rejects a keyless one too, but its generic reason would not name which of
    // the two providers is short a key.
    if (imageLoaded && imgProvider && !imgKey.trim() && !(imgSameProvider && imgHasKey)) {
      toast.error(tr("editor.image_provider_key_required"));
      return;
    }
    if (imageLoaded && imgProvider && !!imgPreset?.needsBaseUrl && !imgBaseUrl.trim()) {
      toast.error(tr("editor.image_provider_base_url_required"));
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
      // The dedicated image provider saves in the same gesture (provider ""
      // clears it and returns images to the main provider), and only once its
      // stored value is known, for the same reason as the search record.
      if (imageLoaded) {
        const img = await oc.setAiImageConfig(workspaceId, {
          provider: imgProvider,
          model: imgModel || undefined,
          baseUrl: imgBaseUrl.trim(),
          ...(imgKey.trim() ? { apiKey: imgKey.trim() } : {}),
        });
        setImgStoredProvider(img?.provider ?? "");
        setImgStoredModel(img?.model ?? "");
        setImgStoredBaseUrl(img?.baseUrl ?? "");
        setImgHasKey(!!img?.hasKey);
        setImgKey("");
        setReplacingImgKey(false);
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

  async function checkImageProvider() {
    if (!workspaceId) return;
    setImgCheck("checking");
    setImgCheckDetail("");
    try {
      const r = await oc.testAiImageConfig(workspaceId);
      setImgCheck(r.verified ? "ok" : "unverified");
    } catch (e) {
      const coded = e instanceof ApiError ? apiCodeMessage(e.body) : null;
      setImgCheck("failed");
      setImgCheckDetail(coded ?? tr("editor.the_image_provider_did_not_answer"));
    }
  }

  async function reset() {
    if (!workspaceId || saving) return;
    // Confirmed because it stops AI for everyone in the workspace, and the key
    // cannot be recovered afterwards - the server never gave it back to us.
    // It also sits next to Save, so a misclick has to be cheap to undo.
    const ok = await confirmAction({
      title: tr("editor.reset_provider"),
      message: tr("editor.reset_provider_confirm"),
      confirmText: tr("editor.reset_provider"),
      danger: true,
    });
    if (!ok) return;
    setSaving(true);
    try {
      // The image provider is part of "the provider" as far as anyone reading
      // this button is concerned, and leaving a second vendor's key behind
      // after being told the provider was reset would be a nasty surprise.
      //
      // It goes FIRST, and its failure is not swallowed: if this cannot be
      // removed, nothing has been removed yet, so the error leaves a coherent
      // configuration rather than a cleared main provider beside a surviving
      // second key that the user believes is gone.
      await oc.deleteAiImageConfig(workspaceId);
      await oc.deleteAiConfig(workspaceId);
      setApiKey("");
      setReplacingKey(false);
      setImgProvider("");
      setImgStoredProvider("");
      setImgModel("");
      setImgStoredModel("");
      setImgBaseUrl("");
      setImgStoredBaseUrl("");
      setImgKey("");
      setImgHasKey(false);
      setReplacingImgKey(false);
      toast.success(tr("editor.ai_provider_reset"));
      onReset?.();
    } catch {
      toast.error(tr("editor.could_not_reset_the_provider"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      {/* Every field carries a VISIBLE label, not just a placeholder: a
          placeholder vanishes as soon as the field has a value, which left a
          saved model name sitting in an unnamed box - confusing to read and a
          3.3.2 failure. */}
      <div className={wide ? "grid grid-cols-1 gap-x-5 gap-y-3.5 sm:grid-cols-2 xl:grid-cols-3" : "flex flex-col gap-2.5"}>
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

        {/* Hidden once a dedicated image provider is chosen: that provider's
            own model field takes over, and two image-model boxes on one form
            is a guessing game about which one is in effect. */}
        {mainCanImage && !imgProvider && (
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

        {/* Only the STORED provider has a stored key. Showing the masked
            stand-in after switching the select claimed a key existed for the
            new provider, and the only hint otherwise was the save being
            refused; an empty field asks for what the save is about to
            require.

            The masked branch is a <div>, not a <label>: a button is a
            labelable element, so a label wrapping one names THE BUTTON. "API
            key" became the accessible name of Replace, and the masked value
            itself had no label at all. */}
        {sameProvider && config?.hasKey && !replacingKey ? (
          <div className={labelCls}>
            <span>{tr("editor.api_key")}</span>
            <span className={`${fieldCls} flex items-center justify-between gap-2`}>
              <span className="truncate tracking-[0.2em] text-neutral-500" aria-label={tr("editor.a_key_is_stored")}>
                {"\u2022".repeat(16)}
              </span>
              <button
                type="button"
                onClick={() => { setReplacingKey(true); setApiKey(""); }}
                className="shrink-0 text-xs font-medium text-brand-ink hover:underline"
              >
                {tr("editor.replace")}
              </button>
            </span>
          </div>
        ) : (
          <label className={labelCls}>
            {tr("editor.api_key")}
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              // "Leave blank to keep" is only true for the provider the key
              // belongs to; on a switched provider a key is required.
              placeholder={sameProvider && config?.hasKey ? tr("editor.api_key_leave_blank_to_keep") : tr("editor.api_key")}
              autoFocus={replacingKey}
              className={fieldCls}
            />
          </label>
        )}

      </div>

      {/* The image provider, a SECOND vendor with its own host and key.
          Presented as a choice rather than buried: for the seven text-only
          presets it is the only way to get generated imagery at all, and the
          hint says so in place of the main form's absent image-model field. */}
      {!imageLoaded && imgFailed && (
        <div className={wide ? "mt-1 border-t border-neutral-200 pt-3.5" : "mt-1 border-t border-neutral-200 pt-2.5"}>
          <p className="text-[11px] text-neutral-500">{tr("editor.image_provider_unavailable")}</p>
        </div>
      )}

      {imageLoaded && (
        // A fieldset, not a div: this section has its own "Provider" select, so
        // without the grouping a screen reader announces two controls called
        // "Provider" with nothing to tell them apart. The legend supplies the
        // context the sighted heading was already giving.
        <fieldset className={wide ? "mt-1 border-t border-neutral-200 pt-3.5" : "mt-1 border-t border-neutral-200 pt-2.5"}>
          <legend className="sr-only">{tr("editor.image_provider")}</legend>
          <div className="mb-2.5 flex flex-col gap-0.5">
            <span aria-hidden className={wide ? "text-sm font-medium text-neutral-700" : "text-[11px] font-medium text-neutral-500"}>
              {tr("editor.image_provider")}
            </span>
            <span className="text-[11px] text-neutral-500">
              {mainCanImage
                ? tr("editor.image_provider_hint")
                : tr("editor.image_provider_needed_hint", { provider: selPreset?.label ?? provider })}
            </span>
          </div>
          <div className={wide ? "grid grid-cols-1 gap-x-5 gap-y-3.5 sm:grid-cols-2 xl:grid-cols-3" : "flex flex-col gap-2.5"}>
            <label className={labelCls}>
              {tr("editor.provider")}
              <select
                value={imgProvider}
                onChange={(e) => {
                  const next = e.target.value;
                  setImgProvider(next);
                  // A model name belongs to its provider, and so does a host:
                  // restore the stored ones only when switching back to the
                  // stored provider, blank them otherwise.
                  const stored = next === imgStoredProvider;
                  setImgModel(stored ? imgStoredModel : "");
                  setImgBaseUrl(stored ? imgStoredBaseUrl : "");
                  setImgKey("");
                  setReplacingImgKey(false);
                  setImgCheck("idle"); // the verdict was about the old provider
                }}
                className={fieldCls}
              >
                <option value="">
                  {mainCanImage ? tr("editor.image_provider_same_as_text") : tr("editor.image_provider_none")}
                </option>
                {imageCapable.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </label>

            {imgProvider && (
              <>
                <label className={labelCls}>
                  {tr("editor.image_model_optional")}
                  <input
                    value={imgModel}
                    onChange={(e) => setImgModel(e.target.value)}
                    placeholder={imgPreset?.defaultImageModel || tr("editor.image_model_optional")}
                    className={fieldCls}
                  />
                </label>

                <label className={labelCls}>
                  {tr("editor.base_url")}
                  <input
                    value={imgBaseUrl}
                    onChange={(e) => setImgBaseUrl(e.target.value)}
                    placeholder={imgPreset?.baseUrl || tr("editor.base_url_https_v1")}
                    className={fieldCls}
                  />
                </label>

                {/* A <div> for the same reason as the main key above. */}
                {imgShowsStoredKey ? (
                  <div className={labelCls}>
                    <span>{tr("editor.api_key")}</span>
                    <span className={`${fieldCls} flex items-center justify-between gap-2`}>
                      <span className="truncate tracking-[0.2em] text-neutral-500" aria-label={tr("editor.a_key_is_stored")}>
                        {"\u2022".repeat(16)}
                      </span>
                      <button
                        type="button"
                        onClick={() => { setReplacingImgKey(true); setImgKey(""); }}
                        className="shrink-0 text-xs font-medium text-brand-ink hover:underline"
                      >
                        {tr("editor.replace")}
                      </button>
                    </span>
                    {/* Beside the key it checks, and only once one is stored:
                        before that there is nothing to check. */}
                    <span className="flex items-center gap-2 text-[11px]">
                      <button
                        type="button"
                        onClick={() => void checkImageProvider()}
                        disabled={imgCheck === "checking"}
                        className="font-medium text-brand-ink hover:underline disabled:opacity-50"
                      >
                        {imgCheck === "checking" ? tr("dashboard.testing") : tr("dashboard.test_connection")}
                      </button>
                      <span
                        aria-live="polite"
                        className={
                          imgCheck === "ok" ? "text-emerald-600" : imgCheck === "failed" ? "text-red-600" : "text-neutral-500"
                        }
                      >
                        {imgCheck === "ok"
                          ? tr("editor.image_provider_key_accepted")
                          : imgCheck === "unverified"
                            ? tr("editor.image_provider_could_not_verify")
                            : imgCheck === "failed"
                              ? imgCheckDetail
                              : ""}
                      </span>
                    </span>
                  </div>
                ) : (
                  <label className={labelCls}>
                    {tr("editor.api_key")}
                    <input
                      type="password"
                      value={imgKey}
                      onChange={(e) => setImgKey(e.target.value)}
                      placeholder={imgSameProvider && imgHasKey ? tr("editor.api_key_leave_blank_to_keep") : tr("editor.api_key")}
                      autoFocus={replacingImgKey}
                      className={fieldCls}
                    />
                  </label>
                )}
              </>
            )}
          </div>
        </fieldset>
      )}

      {/* Web-search grounding is a SEPARATE provider with its own host and key.
          Grouped and labelled as such: interleaved with the model fields, its
          base URL read as a second, unexplained "Base URL" for the model. */}
      {!searchLoaded && searchFailed && (
        <div className={wide ? "mt-1 border-t border-neutral-200 pt-3.5" : "mt-1 border-t border-neutral-200 pt-2.5"}>
          <p className="text-[11px] text-neutral-500">{tr("editor.web_search_unavailable")}</p>
        </div>
      )}

      {searchLoaded && (
        <div className={wide ? "mt-1 border-t border-neutral-200 pt-3.5" : "mt-1 border-t border-neutral-200 pt-2.5"}>
          <div className={wide ? "grid grid-cols-1 gap-x-5 gap-y-3.5 sm:grid-cols-2 xl:grid-cols-3" : "flex flex-col gap-2.5"}>
            <label className={labelCls}>
              {tr("editor.web_search_optional")}
              <select value={searchProvider} onChange={(e) => setSearchProvider(e.target.value)} className={fieldCls}>
                <option value="">{tr("editor.search_off")}</option>
                <option value="tavily">{tr("editor.search_provider_hosted")}</option>
                <option value="searxng">{tr("editor.search_provider_metasearch")}</option>
              </select>
            </label>
            {searchProvider === "searxng" && (
              <label className={labelCls}>
                {tr("editor.search_base_url")}
                <input value={searchUrl} onChange={(e) => setSearchUrl(e.target.value)} placeholder={tr("editor.base_url_https_v1")} className={fieldCls} />
              </label>
            )}
            {searchProvider === "tavily" && (
              <label className={labelCls}>
                {tr("editor.search_api_key")}
                <input type="password" value={searchKey} onChange={(e) => setSearchKey(e.target.value)} placeholder={tr("editor.api_key")} className={fieldCls} />
              </label>
            )}
          </div>
        </div>
      )}

      {/* End-aligned: the form now spans the section, so the action sits at
          the page's end edge, level with the last column. justify-end follows
          the writing direction, so it mirrors correctly in RTL. */}
      {wide ? (
        <div className="mt-2 flex items-center justify-end gap-3">
          {config?.hasKey && onReset && (
            // Beside Save, as its counterpart: one saves the provider, one
            // clears it. Outlined rather than filled so the primary action
            // still reads as primary, and confirmed before it acts.
            <button
              onClick={() => void reset()}
              disabled={saving}
              className="rounded-xl border border-neutral-200 px-4 py-2.5 text-sm font-medium text-neutral-600 transition hover:border-red-300 hover:text-red-600 disabled:opacity-40"
            >
              {tr("editor.reset_provider")}
            </button>
          )}
          {onCancel && (
            <button onClick={onCancel} className="text-xs text-neutral-500 hover:underline">{tr("editor.cancel")}</button>
          )}
          <button
            onClick={() => void save()}
            disabled={!workspaceId || saving}
            className="rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:bg-neutral-200 disabled:text-neutral-400"
          >
            {saving ? tr("editor.saving") : tr("editor.save_provider")}
          </button>
        </div>
      ) : (
        // Stacked, the primary action comes FIRST and fills the panel; Cancel
        // is the quiet way back underneath it. items-stretch matters: centring
        // would leave the block button sized to its text.
        <div className="mt-0.5 flex flex-col items-stretch gap-2">
          <Button block onClick={() => void save()} disabled={!workspaceId || saving}>
            {saving ? tr("editor.saving") : tr("editor.save_provider")}
          </Button>
          {onCancel && (
            <button onClick={onCancel} className="text-xs text-neutral-500 hover:underline">{tr("editor.cancel")}</button>
          )}
        </div>
      )}
    </div>
  );
}
