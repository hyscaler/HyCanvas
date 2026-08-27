// The workspace's AI settings, where an admin would look for them.
//
// Connecting a provider is a workspace decision - admin-gated, shared by every
// member, billed to whoever owns the key - but it was reachable only from
// inside a design, in the assistant's own setup form. This puts it alongside
// the other workspace administration surfaces (members, API keys), and brings
// the usage meter with it: on a bring-your-own-key product, people are
// spending their own money and had no way to see how much.
//
// The form itself is the shared component, so the two doors cannot drift.

import { useCallback, useEffect, useState } from "react";
import { Sparkles, Activity } from "lucide-react";
import type { AiConfigView, AiProviderPreset } from "@hc/sdk";
import { ApiError } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { apiCodeMessage } from "@/lib/errors";
import { AiProviderSettings } from "@/components/ai/AiProviderSettings";
import { WorkspaceAiPolicy } from "./WorkspaceAiPolicy";
import { tr } from "@/lib/i18n";

export function WorkspaceAiPanel({ workspaceId, canEdit }: { workspaceId: string | null; canEdit: boolean }) {
  const [config, setConfig] = useState<AiConfigView | null>(null);
  const [presets, setPresets] = useState<AiProviderPreset[]>([]);
  const [usage, setUsage] = useState<number | null>(null);
  // Whether the stored config has been proven to WORK, as opposed to merely
  // existing. A saved key said "Connected" even when it was a typo, because
  // nothing had ever asked the provider.
  const [health, setHealth] = useState<{ ok: boolean; detail?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const [loading, setLoading] = useState(true);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const loadUsage = useCallback(() => {
    if (!workspaceId) return;
    void oc.getAiUsage(workspaceId).then(
      (u) => setUsage(u.tokensThisMonth),
      () => setUsage(null), // metering is best-effort; absence is not an error
    );
  }, [workspaceId]);

  const runTest = useCallback(async () => {
    if (!workspaceId) return;
    setTesting(true);
    try {
      await oc.testAiConfig(workspaceId);
      setHealth({ ok: true });
    } catch (e) {
      // The server classifies the reason; show that rather than "failed".
      const coded = e instanceof ApiError ? apiCodeMessage(e.body) : null;
      setHealth({ ok: false, detail: coded ?? tr("dashboard.the_provider_did_not_answer") });
    } finally {
      setTesting(false);
      loadUsage(); // the check itself spends a few tokens
    }
  }, [workspaceId, loadUsage]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void (async () => {
      const [cfg, list] = await Promise.all([
        oc.getAiConfig(workspaceId).catch(() => null),
        oc.aiProviders().catch(() => [] as AiProviderPreset[]),
      ]);
      if (cancelled) return;
      setConfig(cfg);
      setPresets(list ?? []);
      setLoadedFor(workspaceId);
      setHealth(null);
      setLoading(false);
    })();
    loadUsage();
    return () => { cancelled = true; };
  }, [workspaceId, loadUsage]);

  if (workspaceId && loadedFor && loadedFor !== workspaceId && !loading) {
    setLoading(true);
    setConfig(null);
  }

  if (!workspaceId) return null;

  const connected = !!config?.hasKey;
  const providerLabel = presets.find((p) => p.id === config?.provider)?.label ?? config?.provider ?? "";

  return (
    <section className="mt-8">
      {/* Status sits on the heading row, at the end: it is a summary of this
          section, so it belongs level with the section's name rather than
          stacked under the description as a third line of prose. */}
      <div className="mb-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div>
          <h2 className="mb-1 flex items-center gap-1.5 text-sm font-bold uppercase tracking-wide text-neutral-400">
            <Sparkles size={15} /> {tr("dashboard.ai")}
          </h2>
          <p className="max-w-xl text-xs text-neutral-500">{tr("dashboard.ai_workspace_hint")}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="flex items-center gap-2">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                !connected ? "bg-neutral-300" : health?.ok ? "bg-emerald-500" : health && !health.ok ? "bg-red-500" : "bg-amber-400"
              }`}
            />
            <span className="text-neutral-700">
              {loading
                ? tr("dashboard.loading")
                : !connected
                  ? tr("dashboard.no_ai_provider_connected")
                  : health?.ok
                    ? tr("dashboard.ai_working_provider", { provider: providerLabel })
                    : health && !health.ok
                      ? tr("dashboard.ai_provider_not_working", { provider: providerLabel })
                      : tr("dashboard.ai_key_saved_provider", { provider: providerLabel })}
            </span>
          </span>
          {connected && canEdit && (
            <button
              onClick={() => void runTest()}
              disabled={testing}
              className="rounded-full border border-neutral-200 px-2.5 py-0.5 text-[11px] text-neutral-600 transition hover:border-neutral-300 disabled:opacity-40"
            >
              {testing ? tr("dashboard.testing") : tr("dashboard.test_connection")}
            </button>
          )}
          {/* An estimate, and labelled as one: the server meters roughly four
              characters per token over what it sent and received, so it will
              not match the provider's own billing, and it is further off for
              scripts where a character is closer to a token. The period is
              real: usage is keyed by calendar month (UTC) and starts again at
              the turn of each one. */}
          {usage !== null && (
            <span className="flex items-center gap-1 text-xs text-neutral-500" title={tr("dashboard.tokens_estimate_hint")}>
              <Activity size={12} />
              {tr("dashboard.n_tokens_this_month", { count: usage, formatted: usage.toLocaleString() })}
            </span>
          )}
        </div>
      </div>

      {health && !health.ok && health.detail && (
        <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {health.detail}
        </p>
      )}

      {!loading && (
        <div>
          <AiProviderSettings
            workspaceId={workspaceId}
            config={config}
            presets={presets}
            canEdit={canEdit}
            layout="wide"
            // Verify immediately on save: the moment a key is entered is when
            // a typo is cheapest to find and the user still has the value to
            // hand.
            onSaved={(c) => { setConfig(c); loadUsage(); void runTest(); }}
            onReset={() => { setConfig(null); setHealth(null); loadUsage(); }}
          />
        </div>
      )}

      {/* Governance sits with the provider it governs, and only for the
          admins who can change either. */}
      {!loading && canEdit && <WorkspaceAiPolicy workspaceId={workspaceId} presets={presets} />}
    </section>
  );
}
