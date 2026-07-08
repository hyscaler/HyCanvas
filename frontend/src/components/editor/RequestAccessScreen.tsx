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

const MODES: { value: AccessMode; label: string }[] = [
  { value: "view", label: "Can view" },
  { value: "comment", label: "Can comment" },
  { value: "edit", label: "Can edit" },
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
      toast.success("Access request sent.");
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        toast.error("You already have this level of access.");
      } else {
        toast.error("Could not send the request.");
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
            <h1 className="text-lg font-bold text-neutral-900">Request sent</h1>
            <p className="mt-1.5 text-sm text-neutral-500">
              The owner has been notified. You will get a notification when they respond.
            </p>
            <Button variant="secondary" className="mt-6" onClick={onBack}>Back to dashboard</Button>
          </>
        ) : (
          <>
            <h1 className="text-lg font-bold text-neutral-900">You need access</h1>
            <p className="mt-1.5 text-sm text-neutral-500">
              You do not have permission to open this design. Request access from its owner.
            </p>
            <div className="mt-5 flex flex-col gap-2 text-left">
              <label className="text-xs font-medium text-neutral-600">
                Access level
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as AccessMode)}
                  className="mt-1 h-10 w-full rounded-xl border border-neutral-200 bg-surface px-3 text-sm text-neutral-800 outline-none focus:border-brand-500"
                >
                  {MODES.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Add a message (optional)"
                rows={2}
                className="resize-none rounded-xl border border-neutral-200 bg-surface px-3 py-2 text-sm text-neutral-800 outline-none focus:border-brand-500"
              />
            </div>
            <div className="mt-5 flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={onBack}>Cancel</Button>
              <Button className="flex-1" disabled={busy} onClick={() => void request()}>
                {busy ? "Sending…" : "Request access"}
              </Button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
