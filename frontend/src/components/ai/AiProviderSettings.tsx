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

import { useEffect, useId, useState } from "react";
import { ApiError, type AiModelInfo, type AiProviderPreset, type AiConfigView, type AiImageConfigView } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { apiCodeMessage } from "@/lib/errors";
import { confirmAction } from "@/lib/promptDialog";
import { tr } from "@/lib/i18n";
import { aiCapabilityGaps, newAiGaps, type AiGap } from "@/lib/aiCapabilityGaps";
import { ModelSuggestInput } from "./ModelSuggestInput";

/** The field a failed connection test points at, so the form can mark it. */
function fieldForCode(code: string | undefined): "key" | "model" | "baseUrl" | null {
  switch (code) {
    case "ai_provider_auth_failed":
    case "ai_key_required":
    case "ai_secret_required":
    case "ai_key_required_for_provider_change":
      return "key";
    case "ai_provider_model_not_found":
    case "ai_provider_model_forbidden":
      return "model";
    case "ai_provider_unreachable":
    case "ai_base_url_required":
      return "baseUrl";
    default:
      return null;
  }
}

/** Literal keys, so the catalog check can see every one of them in use. */
function gapLine(gap: AiGap): string {
  switch (gap) {
    case "image":
      return tr("editor.ai_gap_image");
    case "editImage":
      return tr("editor.ai_gap_edit_image");
    case "describeImage":
      return tr("editor.ai_gap_describe_image");
  }
}

/** A provider missing from the catalog is treated as capable, as the server does. */
const PERMISSIVE_CAPS = { text: true, image: true, describeImage: true, editImage: true };

/** A fetched model catalog, tied to the connection it came from. */
interface ModelCatalog {
  sig: string;
  state: "loading" | "ok" | "none" | "failed";
  /** Chat models, for the model field. */
  models: AiModelInfo[];
  /** Image models, for the image model field beside it (main provider only). */
  imageModels: AiModelInfo[];
  detail?: string;
}

/** The line under a model field that says what the catalog holds. */
function catalogNote(c: ModelCatalog | null, models: AiModelInfo[]): string {
  if (!c) return "";
  switch (c.state) {
    case "ok":
      return tr("editor.models_available", { count: String(models.length) });
    case "none":
      return tr("editor.models_not_listed");
    case "failed":
      return `${tr("editor.models_fetch_failed")}: ${c.detail ?? ""}`;
    default:
      return "";
  }
}

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
  /** `tested` is true when the saved values just passed a connection test,
   *  so a caller that checks health after a save need not spend tokens again. */
  onSaved: (config: AiConfigView, tested: boolean) => void;
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
  // The second credential, for a provider that signs its requests rather than
  // sending a token. Never round-tripped: like the key, the server returns only
  // whether one is stored.
  const [apiSecret, setApiSecret] = useState("");
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
  const [imgSecret, setImgSecret] = useState("");
  const [imgHasKey, setImgHasKey] = useState(false);
  const [imgHasSecret, setImgHasSecret] = useState(false);
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
  // The connection test's verdict on the settings as typed (#46). It carries
  // the signature of the values it judged, so editing any field retires it
  // rather than leaving a stale "works" or "failed" beside different values.
  const [verdict, setVerdict] = useState<
    { sig: string; state: "checking" | "ok" | "failed"; detail?: string; code?: string } | null
  >(null);
  // A stored key is write-only: the server returns hasKey and never the key
  // itself. An empty box said nothing about whether one existed, so it shows a
  // masked stand-in until the user asks to replace it.
  const [replacingKey, setReplacingKey] = useState(false);
  // The provider's model catalog, fetched on demand once the connection
  // details are in, and offered under the model fields. It carries the
  // signature of the connection it was fetched with, so a change of provider,
  // host or key retires it rather than offering another provider's models.
  // "none" is a provider with no catalog on this route: the field stays free
  // text and says so.
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [imgCatalog, setImgCatalog] = useState<ModelCatalog | null>(null);
  const modelInputId = useId();
  const imageModelInputId = useId();
  const imgModelInputId = useId();

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
    setApiSecret("");
    setReplacingKey(false);
  }

  // A provider with a stored key gets its catalog fetched as the form opens,
  // so the model field offers real names before anything is typed. Free on
  // every provider, so it costs the workspace nothing. Typed changes retire
  // it through the connection signature and the button fetches again.
  const storedProvider = config?.provider ?? "";
  const storedHasKey = !!config?.hasKey;
  const storedBaseUrl = config?.baseUrl ?? "";
  useEffect(() => {
    if (!workspaceId || !storedHasKey || !storedProvider || !canEdit) return;
    let cancelled = false;
    const ws = workspaceId;
    // The same signature the form computes for these untouched fields, so
    // the list shows until something is typed. A save that changes the host
    // re-runs this, because the stored host is part of it.
    const sig = JSON.stringify([ws, storedProvider, storedBaseUrl.trim(), "", "", true]);
    const preset = presets.find((p) => p.id === storedProvider);
    const wantsImages = (preset?.capabilities.image ?? true);
    // No "loading" mark here: the fetch is quiet and the button stays
    // available; the answer lands when it lands.
    void Promise.all([
      oc.listAiModels(ws, undefined, "text"),
      wantsImages ? oc.listAiModels(ws, undefined, "image") : Promise.resolve(null),
    ]).then(
      ([text, images]) => {
        if (cancelled) return;
        setCatalog({ sig, state: text.supported ? "ok" : "none", models: text.models, imageModels: images?.models ?? [] });
      },
      (e: unknown) => {
        if (cancelled) return;
        const coded = e instanceof ApiError ? apiCodeMessage(e.body) : null;
        setCatalog({ sig, state: "failed", models: [], imageModels: [], detail: coded ?? tr("dashboard.the_provider_did_not_answer") });
      },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the stored record identifies the fetch; presets only name capabilities
  }, [workspaceId, storedProvider, storedHasKey, storedBaseUrl, canEdit]);

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
        setImgHasSecret(!!cfg?.hasSecret);
        setImgKey("");
        setImgSecret("");
        setReplacingImgKey(false);
        setImgFor(workspaceId);
        setImgFailed(false);
        setImgCheck("idle"); // a verdict belongs to the values it was made about
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
  const requiresSecret = !!selPreset?.needsSecret;
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
  const imgLabel = imgPreset?.label ?? imgProvider;

  // The settings exactly as a save would send them. The connection test sends
  // the same object, so what passed is what gets stored.
  const mainCandidate = {
    provider,
    model: model || undefined,
    imageModel: imageModel || undefined,
    baseUrl: baseUrl.trim(),
    apiKey: apiKey || undefined,
    apiSecret: apiSecret || undefined,
  };
  const imgCandidate = imageLoaded && imgProvider
    ? {
        provider: imgProvider,
        model: imgModel || undefined,
        baseUrl: imgBaseUrl.trim(),
        ...(imgKey.trim() ? { apiKey: imgKey.trim() } : {}),
        ...(imgSecret.trim() ? { apiSecret: imgSecret.trim() } : {}),
      }
    : null;
  const candidateSig = JSON.stringify([workspaceId, mainCandidate, imgCandidate]);
  const shownVerdict = verdict && verdict.sig === candidateSig ? verdict : null;
  const badField = shownVerdict?.state === "failed" ? fieldForCode(shownVerdict.code) : null;
  const testing = shownVerdict?.state === "checking";

  // The connection each catalog belongs to: provider, host and credential,
  // stored or typed. Not the model fields, which the catalog exists to fill.
  const connSig = JSON.stringify([workspaceId, provider, baseUrl.trim(), apiKey, apiSecret, sameProvider && !!config?.hasKey]);
  const shownCatalog = catalog && catalog.sig === connSig ? catalog : null;
  const imgConnSig = JSON.stringify([workspaceId, imgProvider, imgBaseUrl.trim(), imgKey, imgSecret, imgSameProvider && imgHasKey]);
  const shownImgCatalog = imgCatalog && imgCatalog.sig === imgConnSig ? imgCatalog : null;
  const mainHasKey = !!apiKey.trim() || (sameProvider && !!config?.hasKey);
  const imgHasCredential = !!imgKey.trim() || (imgSameProvider && imgHasKey);

  // What these settings leave unavailable, said where they are saved rather
  // than discovered as a failed generation. Only judged once the image
  // provider's record has loaded: before that, "no image provider" is a guess.
  const gapsKnown = imageLoaded;
  const imgCaps = (id: string) => (id ? presets.find((p) => p.id === id)?.capabilities ?? PERMISSIVE_CAPS : undefined);
  const gaps = gapsKnown ? aiCapabilityGaps(selPreset?.capabilities, imgCaps(imgProvider)) : [];
  const storedGaps = config ? aiCapabilityGaps(config.capabilities, imgCaps(imgStoredProvider)) : null;

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

  // The checks that need no round trip. The server makes each of them too, but
  // catching them here points at the field and costs no tokens.
  function preflight(): boolean {
    const url = baseUrl.trim();
    // Endpoint-routed providers are unusable without their URL; the server
    // rejects the save too (ai_base_url_required), but catching it here points
    // at the field without a round trip.
    if (requiresBaseUrl && !url) {
      toast.error(tr("errors.api_ai_base_url_required"));
      return false;
    }
    // A signing provider needs both halves of its credential. The secret is
    // only required when the key is being set: leaving both untouched keeps the
    // stored pair.
    if (requiresSecret && (apiKey.trim() || !(sameProvider && config?.hasKey)) && !apiSecret.trim()) {
      toast.error(tr("errors.api_ai_secret_required"));
      return false;
    }
    // A provider change must bring the new provider's key (the server rejects
    // it as ai_key_required_for_provider_change); say so before the round trip.
    if (!sameProvider && config?.hasKey && !apiKey.trim()) {
      toast.error(tr("errors.api_ai_key_required_for_provider_change"));
      return false;
    }
    // The image provider is a separate vendor with a separate key. The server
    // rejects a keyless one too, but its generic reason would not name which of
    // the two providers is short a key.
    if (imageLoaded && imgProvider && !imgKey.trim() && !(imgSameProvider && imgHasKey)) {
      toast.error(tr("editor.image_provider_key_required"));
      return false;
    }
    if (imageLoaded && imgProvider && !!imgPreset?.needsSecret &&
        (imgKey.trim() || !(imgSameProvider && imgHasKey)) && !imgSecret.trim()) {
      toast.error(tr("errors.api_ai_secret_required"));
      return false;
    }
    if (imageLoaded && imgProvider && !!imgPreset?.needsBaseUrl && !imgBaseUrl.trim()) {
      toast.error(tr("editor.image_provider_base_url_required"));
      return false;
    }
    return true;
  }

  // Tests the settings as typed, main provider then image provider, and saves
  // nothing. Resolves true only when everything that can be judged passed.
  async function runTests(): Promise<boolean> {
    if (!workspaceId) return false;
    const ws = workspaceId;
    const sig = candidateSig;
    const main = mainCandidate;
    const img = imgCandidate;
    setVerdict({ sig, state: "checking" });
    try {
      await oc.testAiConfig(ws, main);
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { code?: string } | null) : null;
      const coded = e instanceof ApiError ? apiCodeMessage(e.body) : null;
      setVerdict({ sig, state: "failed", code: body?.code, detail: coded ?? tr("dashboard.the_provider_did_not_answer") });
      return false;
    }
    if (img) {
      setImgCheck("checking");
      setImgCheckDetail("");
      try {
        const r = await oc.testAiImageConfig(ws, img);
        setImgCheck(r.verified ? "ok" : "unverified");
      } catch (e) {
        const coded = e instanceof ApiError ? apiCodeMessage(e.body) : null;
        setImgCheck("failed");
        setImgCheckDetail(coded ?? tr("editor.the_image_provider_did_not_answer"));
        setVerdict({ sig, state: "failed", code: "image", detail: tr("editor.image_provider_test_failed") });
        return false;
      }
    }
    setVerdict({ sig, state: "ok" });
    return true;
  }

  /** Fetch the main provider's catalog for the settings as typed: chat models
   *  for the model field and, when the form shows one, image models for the
   *  image model field. Free on every provider, so it can run the moment the
   *  key is in. */
  async function fetchModels() {
    if (!workspaceId || catalog?.state === "loading") return;
    const ws = workspaceId;
    const sig = connSig;
    const empty = { sig, models: [] as AiModelInfo[], imageModels: [] as AiModelInfo[] };
    if (!mainHasKey) {
      setCatalog({ ...empty, state: "failed", detail: tr("editor.fetch_models_needs_key") });
      return;
    }
    if (requiresBaseUrl && !baseUrl.trim()) {
      setCatalog({ ...empty, state: "failed", detail: tr("errors.api_ai_base_url_required") });
      return;
    }
    setCatalog({ ...empty, state: "loading" });
    const candidate = { provider, baseUrl: baseUrl.trim(), apiKey: apiKey || undefined, apiSecret: apiSecret || undefined };
    try {
      const wantsImages = mainCanImage && !imgProvider;
      const [text, images] = await Promise.all([
        oc.listAiModels(ws, candidate, "text"),
        wantsImages ? oc.listAiModels(ws, candidate, "image") : Promise.resolve(null),
      ]);
      setCatalog({ sig, state: text.supported ? "ok" : "none", models: text.models, imageModels: images?.models ?? [] });
    } catch (e) {
      const coded = e instanceof ApiError ? apiCodeMessage(e.body) : null;
      setCatalog({ ...empty, state: "failed", detail: coded ?? tr("dashboard.the_provider_did_not_answer") });
    }
  }

  /** The same for the dedicated image provider, whose catalog is image
   *  models only. */
  async function fetchImageModels() {
    if (!workspaceId || !imgProvider || imgCatalog?.state === "loading") return;
    const ws = workspaceId;
    const sig = imgConnSig;
    const empty = { sig, models: [] as AiModelInfo[], imageModels: [] as AiModelInfo[] };
    if (!imgHasCredential) {
      setImgCatalog({ ...empty, state: "failed", detail: tr("editor.fetch_models_needs_key") });
      return;
    }
    if (!!imgPreset?.needsBaseUrl && !imgBaseUrl.trim()) {
      setImgCatalog({ ...empty, state: "failed", detail: tr("editor.image_provider_base_url_required") });
      return;
    }
    setImgCatalog({ ...empty, state: "loading" });
    try {
      const r = await oc.listAiImageModels(ws, {
        provider: imgProvider,
        baseUrl: imgBaseUrl.trim(),
        ...(imgKey.trim() ? { apiKey: imgKey.trim() } : {}),
        ...(imgSecret.trim() ? { apiSecret: imgSecret.trim() } : {}),
      });
      setImgCatalog({ sig, state: r.supported ? "ok" : "none", models: r.models, imageModels: r.models });
    } catch (e) {
      const coded = e instanceof ApiError ? apiCodeMessage(e.body) : null;
      setImgCatalog({ ...empty, state: "failed", detail: coded ?? tr("editor.the_image_provider_did_not_answer") });
    }
  }

  async function testConnection() {
    if (!workspaceId || saving || testing) return;
    if (!preflight()) return;
    await runTests();
  }

  /** Save, after the settings pass a connection test. `untested` is the
   *  explicit "Save anyway" for an endpoint the server cannot reach right now
   *  (a local model that is off, a VPN-only host). */
  async function save(untested = false) {
    if (!workspaceId || saving || testing) return;
    if (!preflight()) return;
    // Say what these settings leave out, once, when the save would introduce
    // it. Skipped on "Save anyway": that follows a save already confirmed.
    const added = untested ? [] : newAiGaps(gaps, storedGaps);
    if (added.length) {
      const ok = await confirmAction({
        title: tr("editor.ai_gaps_title"),
        message: [...added.map((g) => gapLine(g)), tr("editor.ai_gaps_confirm")].join("\n"),
        confirmText: tr("editor.save_provider"),
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      // Tested first (#46): a failing test saves nothing, so settings that do
      // not work can never replace settings that do.
      if (!untested && !(await runTests())) return;
      // baseUrl uses PATCH semantics server-side: a rendered field sends its
      // exact value, so emptying a visible field is an explicit clear, and the
      // server drops a stored URL on a provider change.
      const c = await oc.setAiConfig(workspaceId, mainCandidate);
      setApiKey("");
      setApiSecret("");
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
      // Skipped when there is nothing to say: with no image provider selected
      // and none stored, this was a DELETE for a row that never existed, on
      // every save. Clearing a stored one still goes through, because then the
      // empty provider is a real instruction.
      if (imageLoaded && (imgProvider || imgStoredProvider)) {
        const img = await oc.setAiImageConfig(workspaceId, imgCandidate ?? { provider: "", baseUrl: "" });
        setImgStoredProvider(img?.provider ?? "");
        setImgStoredModel(img?.model ?? "");
        setImgStoredBaseUrl(img?.baseUrl ?? "");
        setImgHasKey(!!img?.hasKey);
        setImgHasSecret(!!img?.hasSecret);
        setImgKey("");
        setImgSecret("");
        setReplacingImgKey(false);
        // A tested save already has its verdict, about exactly these values.
        // An untested one gets checked now: the moment a key is entered is when
        // a typo is cheapest to find and the person still has it to hand.
        if (img?.hasKey && untested) void checkImageProvider();
      }
      // "Not saved" is no longer true once an untested save lands, and it must
      // not sit beside settings that are now stored.
      if (untested) setVerdict(null);
      toast.success(untested ? tr("editor.ai_provider_saved_untested") : tr("editor.ai_provider_saved"));
      onSaved(c, !untested);
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
  // A field the failed test points at. Red border only: the reason itself is
  // spelled out beside the Save button, so color is never the only signal.
  const invalid = (f: "key" | "model" | "baseUrl") => (badField === f ? " border-red-400 focus:border-red-500 focus:ring-red-100" : "");
  const labelCls = wide
    ? "flex min-w-0 flex-col gap-1.5 text-sm font-medium text-neutral-700"
    : "flex min-w-0 flex-col gap-1 text-[11px] font-medium text-neutral-500";

  async function checkImageProvider() {
    if (!workspaceId) return;
    // The workspace this verdict is about. A check is a live third-party call,
    // and landing one workspace's answer on another's form is how a working
    // provider gets reported as broken.
    const ws = workspaceId;
    setImgCheck("checking");
    setImgCheckDetail("");
    try {
      const r = await oc.testAiImageConfig(ws);
      if (imgFor === ws) setImgCheck(r.verified ? "ok" : "unverified");
    } catch (e) {
      if (imgFor !== ws) return;
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
      setImgSecret("");
      setImgHasKey(false);
      setImgHasSecret(false);
      setReplacingImgKey(false);
      setImgCheck("idle");
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
              // A secret belongs to one vendor; never let it follow a switch.
              setApiSecret("");
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
            aria-invalid={badField === "baseUrl" || undefined}
            className={fieldCls + invalid("baseUrl")}
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
            <span>{(requiresSecret ? tr("editor.access_key") : tr("editor.api_key"))}</span>
            <span className={`${fieldCls}${invalid("key")} flex items-center justify-between gap-2`}>
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
            {(requiresSecret ? tr("editor.access_key") : tr("editor.api_key"))}
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              // "Leave blank to keep" is only true for the provider the key
              // belongs to; on a switched provider a key is required. A
              // signing provider calls its first credential the access key.
              placeholder={sameProvider && config?.hasKey ? tr("editor.api_key_leave_blank_to_keep") : (requiresSecret ? tr("editor.access_key") : tr("editor.api_key"))}
              autoFocus={replacingKey}
              aria-invalid={badField === "key" || undefined}
              className={fieldCls + invalid("key")}
            />
          </label>
        )}

        {/* A signing provider's second credential, after the access key it
            belongs with. */}
        {requiresSecret && (
          <label className={labelCls}>
            {tr("editor.secret_key")}
            <input
              type="password"
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              placeholder={
                sameProvider && config?.hasSecret && !apiKey.trim()
                  ? tr("editor.api_key_leave_blank_to_keep")
                  : tr("editor.secret_key")
              }
              className={fieldCls}
            />
          </label>
        )}

        {/* The model fields come AFTER the connection details, in the order the
            form is filled: once the host and key are in, the provider's own
            catalog can be fetched and offered here. A <div> with an explicit
            label, not a wrapping <label>: the fetch button inside a label would
            take the field's name. Free text stays allowed for a name the
            catalog does not carry. */}
        <div className={labelCls}>
          <span className="flex items-center justify-between gap-2">
            <label htmlFor={modelInputId}>{tr("editor.model_optional")}</label>
            <button
              type="button"
              onClick={() => void fetchModels()}
              disabled={!workspaceId || shownCatalog?.state === "loading"}
              className="shrink-0 text-xs font-medium text-brand-ink hover:underline disabled:opacity-40"
            >
              {shownCatalog?.state === "loading" ? tr("editor.fetching_models") : tr("editor.fetch_models")}
            </button>
          </span>
          <ModelSuggestInput
            id={modelInputId}
            value={model}
            onChange={setModel}
            models={shownCatalog?.models ?? []}
            placeholder={modelHint || tr("editor.model_optional")}
            invalid={badField === "model"}
            className={fieldCls + invalid("model")}
          />
          {catalogNote(shownCatalog, shownCatalog?.models ?? []) && (
            <span role="status" className={`text-[11px] font-normal ${shownCatalog?.state === "failed" ? "text-red-700" : "text-neutral-500"}`}>
              {catalogNote(shownCatalog, shownCatalog?.models ?? [])}
            </span>
          )}
        </div>

        {/* Hidden once a dedicated image provider is chosen: that provider's
            own model field takes over, and two image-model boxes on one form
            is a guessing game about which one is in effect. */}
        {mainCanImage && !imgProvider && (
          <div className={labelCls}>
            <label htmlFor={imageModelInputId}>{tr("editor.image_model_optional")}</label>
            <ModelSuggestInput
              id={imageModelInputId}
              value={imageModel}
              onChange={setImageModel}
              models={shownCatalog?.imageModels ?? []}
              placeholder={selPreset?.defaultImageModel || tr("editor.image_model_optional")}
              className={fieldCls}
            />
          </div>
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
          {/* The same shape as the main provider's status: a dot, the state in
              words, and the check beside it. This provider is billed separately
              and fails separately, so it needs its own answer to "is this
              working?" rather than being covered by the section above. */}
          <div className="mb-2.5 flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5">
            <div className="flex flex-col gap-0.5">
              <span aria-hidden className={wide ? "text-sm font-medium text-neutral-700" : "text-[11px] font-medium text-neutral-500"}>
                {tr("editor.image_provider")}
              </span>
              <span className="text-[11px] text-neutral-500">
                {mainCanImage
                  ? tr("editor.image_provider_hint")
                  : tr("editor.image_provider_needed_hint", { provider: selPreset?.label ?? provider })}
              </span>
            </div>
            {/* Only once a key is stored, and not while one is being replaced:
                the check reports on the SAVED key, which is not the key in the
                box during a replacement. */}
            {imgShowsStoredKey && (
              <div className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                <span className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      imgCheck === "ok"
                        ? "bg-emerald-500"
                        : imgCheck === "failed"
                          ? "bg-red-500"
                          : imgCheck === "unverified"
                            ? "bg-neutral-300"
                            : "bg-amber-400"
                    }`}
                  />
                  <span aria-live="polite" className="text-xs text-neutral-700">
                    {imgCheck === "ok"
                      ? tr("dashboard.ai_working_provider", { provider: imgLabel })
                      : imgCheck === "failed"
                        ? tr("dashboard.ai_provider_not_working", { provider: imgLabel })
                        : imgCheck === "unverified"
                          ? tr("editor.image_provider_could_not_verify")
                          : tr("dashboard.ai_key_saved_provider", { provider: imgLabel })}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void checkImageProvider()}
                  disabled={imgCheck === "checking"}
                  className="rounded-full border border-neutral-200 px-2.5 py-0.5 text-[11px] text-neutral-600 transition hover:border-neutral-300 disabled:opacity-40"
                >
                  {imgCheck === "checking" ? tr("dashboard.testing") : tr("dashboard.test_connection")}
                </button>
              </div>
            )}
          </div>

          {/* The reason, in the provider's own words, where the main provider
              puts its own. */}
          {imgCheck === "failed" && imgCheckDetail && (
            <p role="status" className="mb-2.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {imgCheckDetail}
            </p>
          )}
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
                  setImgSecret(""); // a secret belongs to one vendor
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
                    <span>{(imgPreset?.needsSecret ? tr("editor.access_key") : tr("editor.api_key"))}</span>
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
                  </div>
                ) : (
                  <label className={labelCls}>
                    {(imgPreset?.needsSecret ? tr("editor.access_key") : tr("editor.api_key"))}
                    <input
                      type="password"
                      value={imgKey}
                      onChange={(e) => setImgKey(e.target.value)}
                      placeholder={imgSameProvider && imgHasKey ? tr("editor.api_key_leave_blank_to_keep") : (imgPreset?.needsSecret ? tr("editor.access_key") : tr("editor.api_key"))}
                      autoFocus={replacingImgKey}
                      className={fieldCls}
                    />
                  </label>
                )}

                {!!imgPreset?.needsSecret && (
                  <label className={labelCls}>
                    {tr("editor.secret_key")}
                    <input
                      type="password"
                      value={imgSecret}
                      onChange={(e) => setImgSecret(e.target.value)}
                      placeholder={
                        imgSameProvider && imgHasSecret && !imgKey.trim()
                          ? tr("editor.api_key_leave_blank_to_keep")
                          : tr("editor.secret_key")
                      }
                      className={fieldCls}
                    />
                  </label>
                )}
                <div className={labelCls}>
                  <span className="flex items-center justify-between gap-2">
                    <label htmlFor={imgModelInputId}>{tr("editor.image_model_optional")}</label>
                    <button
                      type="button"
                      onClick={() => void fetchImageModels()}
                      disabled={!workspaceId || shownImgCatalog?.state === "loading"}
                      className="shrink-0 text-xs font-medium text-brand-ink hover:underline disabled:opacity-40"
                    >
                      {shownImgCatalog?.state === "loading" ? tr("editor.fetching_models") : tr("editor.fetch_models")}
                    </button>
                  </span>
                  <ModelSuggestInput
                    id={imgModelInputId}
                    value={imgModel}
                    onChange={setImgModel}
                    models={shownImgCatalog?.models ?? []}
                    placeholder={imgPreset?.defaultImageModel || tr("editor.image_model_optional")}
                    className={fieldCls}
                  />
                  {catalogNote(shownImgCatalog, shownImgCatalog?.models ?? []) && (
                    <span role="status" className={`text-[11px] font-normal ${shownImgCatalog?.state === "failed" ? "text-red-700" : "text-neutral-500"}`}>
                      {catalogNote(shownImgCatalog, shownImgCatalog?.models ?? [])}
                    </span>
                  )}
                </div>
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

      {/* What the save is about to do, in words: features these settings
          leave out, and the connection test's answer. Both sit directly above
          the buttons, where the decision is made. */}
      {gaps.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <p className="font-medium">{tr("editor.ai_gaps_notice")}</p>
          <ul className="mt-1 list-disc ps-4">
            {gaps.map((g) => <li key={g}>{gapLine(g)}</li>)}
          </ul>
        </div>
      )}
      {shownVerdict?.state === "ok" && (
        <p role="status" className="flex items-center gap-2 text-xs text-emerald-700">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
          {tr("editor.connection_works", { provider: selPreset?.label ?? provider })}
        </p>
      )}
      {shownVerdict?.state === "failed" && (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <p><span className="font-medium">{tr("editor.connection_test_failed")}</span> {shownVerdict.detail}</p>
          {/* The escape hatch for a host the server cannot reach right now. It
              stays a quiet link: the default path is to fix the settings. */}
          <button
            type="button"
            onClick={() => void save(true)}
            disabled={saving}
            className="self-start text-xs font-medium text-red-700 underline hover:text-red-800 disabled:opacity-40"
          >
            {tr("editor.save_anyway")}
          </button>
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
            onClick={() => void testConnection()}
            disabled={!workspaceId || saving || testing}
            className="rounded-xl border border-neutral-200 px-4 py-2.5 text-sm font-medium text-neutral-700 transition hover:border-neutral-300 disabled:opacity-40"
          >
            {testing && !saving ? tr("editor.testing_connection") : tr("editor.test_connection")}
          </button>
          <button
            onClick={() => void save()}
            disabled={!workspaceId || saving || testing}
            className="rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:bg-neutral-200 disabled:text-neutral-400"
          >
            {testing ? tr("editor.testing_connection") : saving ? tr("editor.saving") : tr("editor.save_provider")}
          </button>
        </div>
      ) : (
        // Stacked, the primary action comes FIRST and fills the panel; Cancel
        // is the quiet way back underneath it. items-stretch matters: centring
        // would leave the block button sized to its text.
        <div className="mt-0.5 flex flex-col items-stretch gap-2">
          <Button block onClick={() => void save()} disabled={!workspaceId || saving || testing}>
            {testing ? tr("editor.testing_connection") : saving ? tr("editor.saving") : tr("editor.save_provider")}
          </Button>
          <Button block variant="secondary" onClick={() => void testConnection()} disabled={!workspaceId || saving || testing}>
            {testing && !saving ? tr("editor.testing_connection") : tr("editor.test_connection")}
          </Button>
          {onCancel && (
            <button onClick={onCancel} className="text-xs text-neutral-500 hover:underline">{tr("editor.cancel")}</button>
          )}
        </div>
      )}
    </div>
  );
}
