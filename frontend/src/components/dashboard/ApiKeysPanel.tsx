// Workspace API keys (F40 E01): mint, list, and revoke the keys that drive
// the public generation API. Admin-only (the parent gates on role); the raw
// key appears exactly once at mint in a copy box and is never retrievable
// again, matching the hash-only storage on the server.

import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, Plus, ShieldOff } from "lucide-react";
import type { ApiKeyView } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { userMessage } from "@/lib/errors";
import { tr } from "@/lib/i18n";

const ALL_SCOPES = ["generate", "read", "export"] as const;

function scopeLabel(scope: string): string {
  switch (scope) {
    case "generate": return tr("dashboard.scope_generate");
    case "read": return tr("dashboard.scope_read");
    case "export": return tr("dashboard.scope_export");
    default: return scope;
  }
}

export function ApiKeysPanel({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKeyView[] | null>(null);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<Set<string>>(new Set(["generate"]));
  const [minting, setMinting] = useState(false);
  // The one-time raw key, shown until dismissed (never persisted client-side).
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [armedRevoke, setArmedRevoke] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setKeys(await oc.apiKeys(workspaceId)); // setState after await: allowed
    } catch {
      setKeys([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await oc.apiKeys(workspaceId);
        if (!cancelled) setKeys(list);
      } catch {
        if (!cancelled) setKeys([]);
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

  async function mint() {
    const l = label.trim();
    if (!l || scopes.size === 0 || minting) return;
    setMinting(true);
    try {
      const { key } = await oc.createApiKey(workspaceId, { label: l, scopes: [...scopes] });
      setFreshKey(key);
      setLabel("");
      await reload();
    } catch (e) {
      toast.error(userMessage(e, tr("dashboard.could_not_create_the_api_key")));
    } finally {
      setMinting(false);
    }
  }

  async function revoke(k: ApiKeyView) {
    if (armedRevoke !== k.id) {
      setArmedRevoke(k.id);
      setTimeout(() => setArmedRevoke((cur) => (cur === k.id ? null : cur)), 3500);
      return;
    }
    setArmedRevoke(null);
    try {
      await oc.revokeApiKey(workspaceId, k.id);
      toast.success(tr("dashboard.api_key_revoked"));
      await reload();
    } catch (e) {
      toast.error(userMessage(e, tr("dashboard.could_not_revoke_the_api_key")));
    }
  }

  async function copyFresh() {
    if (!freshKey) return;
    try {
      await navigator.clipboard.writeText(freshKey);
      toast.success(tr("dashboard.api_key_copied"));
    } catch {
      toast.error(tr("dashboard.could_not_copy_select_and_copy_manually"));
    }
  }

  return (
    <section className="mt-8">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-neutral-400">
        <KeyRound size={15} /> {tr("dashboard.api_keys")}
      </h2>
      <p className="mb-3 max-w-xl text-xs text-neutral-500">{tr("dashboard.api_keys_hint")}</p>

      {/* Mint form */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50/60 p-3">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={tr("dashboard.key_label_placeholder")}
          aria-label={tr("dashboard.key_label")}
          maxLength={80}
          className="h-9 w-56"
        />
        <span className="flex items-center gap-3 text-xs text-neutral-600">
          {ALL_SCOPES.map((s) => (
            <label key={s} className="flex cursor-pointer items-center gap-1">
              <input
                type="checkbox"
                checked={scopes.has(s)}
                onChange={(e) => {
                  const next = new Set(scopes);
                  if (e.target.checked) next.add(s);
                  else next.delete(s);
                  setScopes(next);
                }}
              />
              {scopeLabel(s)}
            </label>
          ))}
        </span>
        <Button size="sm" className="ms-auto gap-1" onClick={() => void mint()} disabled={minting || !label.trim() || scopes.size === 0}>
          <Plus size={15} /> {minting ? tr("dashboard.creating_key") : tr("dashboard.create_api_key")}
        </Button>
      </div>

      {/* One-time raw key reveal */}
      {freshKey && (
        <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
          <p className="mb-2 text-xs font-semibold text-amber-800">{tr("dashboard.copy_this_key_now_it_wont_be_shown_again")}</p>
          <div className="flex items-center gap-1.5">
            <input
              readOnly
              value={freshKey}
              aria-label={tr("dashboard.api_key")}
              onFocus={(e) => e.currentTarget.select()}
              className="h-8 min-w-0 flex-1 truncate rounded-lg border border-amber-200 bg-surface px-2 font-mono text-xs text-neutral-700 outline-none"
            />
            <button aria-label={tr("dashboard.copy_api_key")} title={tr("dashboard.copy_api_key")} className="grid h-8 w-8 place-items-center rounded-lg text-amber-700 hover:bg-amber-100" onClick={() => void copyFresh()}>
              <Copy size={15} />
            </button>
            <Button size="sm" variant="secondary" onClick={() => setFreshKey(null)}>{tr("dashboard.done")}</Button>
          </div>
        </div>
      )}

      {/* Key list */}
      {keys !== null && keys.length === 0 && (
        <p className="mt-3 text-xs text-neutral-400">{tr("dashboard.no_api_keys_yet")}</p>
      )}
      {keys !== null && keys.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {keys.map((k) => (
            <li key={k.id} className={`flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-sm ${k.revoked ? "border-neutral-100 bg-neutral-50 opacity-60" : "border-neutral-200 bg-surface"}`}>
              <span className="min-w-0 truncate font-medium text-neutral-800">{k.label}</span>
              <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-500">{k.prefix}…</span>
              <span className="flex gap-1">
                {k.scopes.map((s) => (
                  <span key={s} className="rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-ink">{scopeLabel(s)}</span>
                ))}
              </span>
              <span className="text-[11px] text-neutral-400">
                {k.revoked
                  ? tr("dashboard.revoked")
                  : k.lastUsedAt
                    ? tr("dashboard.last_used_date", { date: new Date(k.lastUsedAt).toLocaleDateString() })
                    : tr("dashboard.never_used")}
              </span>
              {!k.revoked && (
                <button
                  onClick={() => void revoke(k)}
                  className={`ms-auto flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition ${armedRevoke === k.id ? "bg-red-50 text-red-600 ring-1 ring-red-300" : "text-neutral-400 hover:bg-neutral-100 hover:text-red-600"}`}
                >
                  <ShieldOff size={13} /> {armedRevoke === k.id ? tr("dashboard.click_again_to_revoke") : tr("dashboard.revoke")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
