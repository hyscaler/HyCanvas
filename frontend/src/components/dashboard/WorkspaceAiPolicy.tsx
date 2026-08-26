// Workspace AI governance: which providers may be used, and a monthly token
// ceiling.
//
// The backend has enforced all of this from the start (every call checks the
// policy before spending a token) and there was no interface for any of it, so
// the controls existed and nobody could reach them. Admin-only, matching the
// server, and folded into the AI section rather than given a page of its own.

import { useEffect, useState } from "react";
import { ChevronDown, ShieldCheck } from "lucide-react";
import type { AiPolicy, AiProviderPreset } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { useToast } from "@/components/ui/Toast";
import { tr } from "@/lib/i18n";

export function WorkspaceAiPolicy({ workspaceId, presets }: { workspaceId: string | null; presets: AiProviderPreset[] }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [policy, setPolicy] = useState<AiPolicy | null>(null);
  const [cap, setCap] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void oc.getAiPolicy(workspaceId).then(
      (p) => {
        if (cancelled) return;
        setPolicy(p ?? {});
        setCap(p?.monthlyTokenCap ? String(p.monthlyTokenCap) : "");
      },
      () => { if (!cancelled) setPolicy({}); },
    );
    return () => { cancelled = true; };
  }, [workspaceId]);

  if (!workspaceId || !policy) return null;

  const blocked = policy.blockedProviders ?? [];
  const restricted = blocked.length > 0 || !!policy.monthlyTokenCap;

  async function save(next: AiPolicy) {
    if (!workspaceId || saving) return;
    setSaving(true);
    const previous = policy;
    setPolicy(next); // optimistic: the controls should not lag a round trip
    try {
      const saved = await oc.setAiPolicy(workspaceId, next);
      setPolicy(saved ?? next);
    } catch {
      setPolicy(previous); // put the switch back where the user found it
      toast.error(tr("dashboard.could_not_save_the_ai_policy"));
    } finally {
      setSaving(false);
    }
  }

  const toggleBlocked = (id: string) => {
    const nextBlocked = blocked.includes(id) ? blocked.filter((p) => p !== id) : [...blocked, id];
    void save({ ...policy, blockedProviders: nextBlocked });
  };

  const commitCap = () => {
    const n = Math.max(0, Math.floor(Number(cap.replace(/[^0-9]/g, "")) || 0));
    if ((policy?.monthlyTokenCap ?? 0) === n) return;
    void save({ ...policy, monthlyTokenCap: n || undefined });
  };

  return (
    <div className="mt-6 border-t border-neutral-200 pt-4">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-sm font-medium text-neutral-700 hover:text-neutral-900"
      >
        <ShieldCheck size={15} className="text-neutral-400" />
        {tr("dashboard.usage_limits")}
        {restricted && !open && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
            {tr("dashboard.limits_active")}
          </span>
        )}
        <ChevronDown size={14} className={`text-neutral-400 transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="mt-3 flex flex-col gap-4">
          <p className="max-w-2xl text-xs text-neutral-500">{tr("dashboard.usage_limits_hint")}</p>

          <label className="flex max-w-xs flex-col gap-1.5 text-sm font-medium text-neutral-700">
            {tr("dashboard.monthly_token_cap")}
            <input
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              onBlur={commitCap}
              inputMode="numeric"
              placeholder={tr("dashboard.no_cap")}
              className="h-11 rounded-xl border border-neutral-200 bg-surface px-3.5 text-sm tabular-nums outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
            <span className="text-[11px] font-normal text-neutral-500">{tr("dashboard.leave_blank_for_no_cap")}</span>
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-700">{tr("dashboard.blocked_providers")}</span>
            <span className="text-[11px] text-neutral-500">{tr("dashboard.blocked_providers_hint")}</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {presets.map((p) => {
                const off = blocked.includes(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => toggleBlocked(p.id)}
                    aria-pressed={off}
                    className={`rounded-full border px-3 py-1 text-xs transition ${
                      off
                        ? "border-amber-300 bg-amber-50 text-amber-800 line-through"
                        : "border-neutral-200 bg-surface text-neutral-600 hover:border-neutral-300"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
