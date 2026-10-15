// The personal AI provider (#47): the signed-in user's own bring-your-own key,
// used in any workspace that has no provider of its own and allows personal
// keys. It is the same form as the workspace provider, with the same test
// before saving and the same capability warnings; web search stays a
// workspace setting.

import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import type { AiConfigView, AiProviderPreset } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { AiProviderSettings } from "@/components/ai/AiProviderSettings";
import { Spinner } from "@/components/ui/Spinner";
import { tr } from "@/lib/i18n";

type Loaded = { config: AiConfigView | null; presets: AiProviderPreset[]; tokens: number };

export function PersonalAiSettings() {
  const [state, setState] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  // Bumped after a save or a reset so the form remounts on the stored values.
  const [rev, setRev] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([oc.getMyAiConfig(), oc.aiProviders(), oc.getMyAiUsage().catch(() => ({ tokensThisMonth: 0 }))]).then(
      ([config, presets, usage]) => {
        if (!cancelled) setState({ config, presets, tokens: usage.tokensThisMonth });
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rev]);

  return (
    <section className="rounded-2xl border border-neutral-200 bg-surface p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-neutral-900">{tr("settings.ai_provider")}</h2>
      <p className="mt-1 text-sm text-neutral-500">{tr("settings.personal_ai_description")}</p>
      <div className="mt-4 flex items-start gap-2.5 rounded-xl bg-neutral-50 p-3 text-xs leading-relaxed text-neutral-600">
        <Info size={15} className="mt-0.5 shrink-0 text-brand-ink" />
        <p>{tr("settings.personal_ai_precedence")}</p>
      </div>
      <div className="mt-5">
        {failed ? (
          <p role="alert" className="text-sm text-red-600">{tr("settings.personal_ai_load_failed")}</p>
        ) : !state ? (
          <div className="grid place-items-center py-10 text-neutral-400"><Spinner /></div>
        ) : (
          <>
            <AiProviderSettings
              key={rev}
              personal
              workspaceId={null}
              config={state.config}
              presets={state.presets}
              canEdit
              layout="wide"
              onSaved={() => setRev((r) => r + 1)}
              onReset={() => setRev((r) => r + 1)}
            />
            {state.config && (
              <p className="mt-4 text-xs text-neutral-500">{tr("settings.personal_ai_usage", { count: state.tokens.toLocaleString() })}</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
