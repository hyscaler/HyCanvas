// A dismissible banner shown when the signed-in user's email is not yet
// verified. It offers a one-click "resend" that re-sends the
// verification link through the backend. Self-contained so it can sit at the
// top of the dashboard without threading state through it.

import { useState } from "react";
import { MailWarning, X } from "lucide-react";
import { oc } from "@/lib/sdk";
import { useAuth } from "@/store/auth";
import { useToast } from "@/components/ui/Toast";

export function VerifyEmailBanner() {
  const user = useAuth((s) => s.user);
  const toast = useToast();
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!user || user.emailVerified || dismissed) return null;

  async function resend() {
    if (!user) return;
    setBusy(true);
    try {
      await oc.requestEmailVerification(user.email);
      toast.success("Verification email sent. Check your inbox.");
    } catch {
      toast.error("Couldn't send the email. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-6 flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <MailWarning size={18} className="shrink-0 text-amber-600" />
      <span className="flex-1">
        Verify your email <span className="font-semibold">{user.email}</span> to secure your account.
      </span>
      <button
        onClick={() => void resend()}
        disabled={busy}
        className="font-semibold text-amber-800 underline-offset-2 hover:underline disabled:opacity-50"
      >
        {busy ? "Sending…" : "Resend email"}
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="text-amber-500 hover:text-amber-700"
        aria-label="Dismiss"
      >
        <X size={16} />
      </button>
    </div>
  );
}
