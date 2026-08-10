// Shown when the editor loads a design the caller cannot open (a 403): instead
// of a dead end, the caller can request access at a level with an optional
// message. The backend notifies the design's owners/admins, who approve or deny
// from the Share dialog; the caller is notified of the decision.

import { useState } from "react";
import { Lock } from "lucide-react";
import type { AccessMode } from "@hc/sdk";
import { ApiError } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { tr } from "@/lib/i18n";

const modes = (): { value: AccessMode; label: string }[] => [
  { value: "view", label: tr("editor.can_view") },
  { value: "comment", label: tr("editor.can_comment") },
  { value: "edit", label: tr("editor.can_edit") },
];

export function RequestAccessScreen({ designId, onBack }: { designId: string; onBack: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<AccessMode>("edit");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function request() {
    setBusy(true);
    try {
      await oc.requestAccess(designId, { mode, message: message.trim() || undefined });
      setSent(true);
      toast.success(tr("editor.access_request_sent"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        toast.error(tr("editor.you_already_have_this_level_of_access"));
      } else {
        toast.error(tr("editor.could_not_send_the_request"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-6">
      <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-surface p-8 text-center shadow-sm">
        <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-neutral-100 text-neutral-500">
          <Lock size={22} />
        </span>
        {sent ? (
          <>
            <h1 className="text-lg font-bold text-neutral-900">{tr("editor.request_sent")}</h1>
            <p className="mt-1.5 text-sm text-neutral-500">
              {tr("editor.the_owner_has_been_notified_you_will_get_a_n")}
            </p>
            <Button variant="secondary" className="mt-6" onClick={onBack}>{tr("editor.back_to_dashboard")}</Button>
          </>
        ) : (
          <>
            <h1 className="text-lg font-bold text-neutral-900">{tr("editor.you_need_access")}</h1>
            <p className="mt-1.5 text-sm text-neutral-500">
              {tr("editor.you_do_not_have_permission_to_open_this_desi")}
            </p>
            <div className="mt-5 flex flex-col gap-2 text-start">
              <label className="text-xs font-medium text-neutral-600">
                {tr("editor.access_level")}
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as AccessMode)}
                  className="mt-1 h-10 w-full rounded-xl border border-neutral-200 bg-surface px-3 text-sm text-neutral-800 outline-none focus:border-brand-500"
                >
                  {modes().map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={tr("editor.add_a_message_optional")}
                rows={2}
                className="resize-none rounded-xl border border-neutral-200 bg-surface px-3 py-2 text-sm text-neutral-800 outline-none focus:border-brand-500"
              />
            </div>
            <div className="mt-5 flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={onBack}>{tr("editor.cancel")}</Button>
              <Button className="flex-1" disabled={busy} onClick={() => void request()}>
                {busy ? tr("editor.sending") : tr("editor.request_access")}
              </Button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
