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
import { oc } from "@/lib/sdk";
import { AiProviderSettings } from "@/components/ai/AiProviderSettings";
import { tr } from "@/lib/i18n";

export function WorkspaceAiPanel({ workspaceId, canEdit }: { workspaceId: string | null; canEdit: boolean }) {
  const [config, setConfig] = useState<AiConfigView | null>(null);
  const [presets, setPresets] = useState<AiProviderPreset[]>([]);
  const [usage, setUsage] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const loadUsage = useCallback(() => {
    if (!workspaceId) return;
    void oc.getAiUsage(workspaceId).then(
      (u) => setUsage(u.tokensThisMonth),
      () => setUsage(null), // metering is best-effort; absence is not an error
    );
  }, [workspaceId]);

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
      <h2 className="mb-1 flex items-center gap-1.5 text-sm font-bold uppercase tracking-wide text-neutral-400">
        <Sparkles size={15} /> {tr("dashboard.ai")}
      </h2>
      <p className="mb-3 max-w-xl text-xs text-neutral-500">{tr("dashboard.ai_workspace_hint")}</p>

      {/* Status line, then the form directly on the page. The card that used
          to wrap this added a second border inside a page that already has
          plenty of structure, and made a full-width section look like a
          narrow widget. */}
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="flex items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${connected ? "bg-emerald-500" : "bg-neutral-300"}`} />
          <span className="text-neutral-700">
            {loading
              ? tr("dashboard.loading")
              : connected
                ? tr("dashboard.ai_connected_provider", { provider: providerLabel })
                : tr("dashboard.no_ai_provider_connected")}
          </span>
        </span>
        {usage !== null && (
          <span className="flex items-center gap-1 text-xs text-neutral-500" title={tr("dashboard.tokens_used_this_month")}>
            <Activity size={12} />
            {/* Thousands separators come from the user's locale, so a large
                number stays readable wherever they are. */}
            {tr("dashboard.n_tokens_this_month", { count: usage })}
          </span>
        )}
      </div>

      {!loading && (
        <div className="max-w-3xl">
          <AiProviderSettings
            workspaceId={workspaceId}
            config={config}
            presets={presets}
            canEdit={canEdit}
            layout="wide"
            onSaved={(c) => { setConfig(c); loadUsage(); }}
          />
        </div>
      )}
    </section>
  );
}
