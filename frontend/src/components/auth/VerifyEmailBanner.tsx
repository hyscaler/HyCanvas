// A dismissible banner shown when the signed-in user's email is not yet
// verified. It offers a one-click "resend" that re-sends the
// verification link through the backend. Self-contained so it can sit at the
// top of the dashboard without threading state through it.

import { useState } from "react";
import { MailWarning, X } from "lucide-react";
import { oc } from "@/lib/sdk";
import { useAuth } from "@/store/auth";
import { useToast } from "@/components/ui/Toast";
import { tr } from "@/lib/i18n";

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
      toast.success(tr("auth.verification_email_sent_check_your_inbox"));
    } catch {
      toast.error(tr("auth.couldnt_send_the_email_please_try_again"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-6 flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <MailWarning size={18} className="shrink-0 text-amber-700" />
      <span className="flex-1">
        {tr("auth.verify_your_email")} <span className="font-semibold">{user.email}</span> {tr("auth.to_secure_your_account")}
      </span>
      <button
        onClick={() => void resend()}
        disabled={busy}
        className="font-semibold text-amber-800 underline-offset-2 hover:underline disabled:opacity-50"
      >
        {busy ? tr("auth.sending") : tr("auth.resend_email")}
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="text-amber-500 hover:text-amber-700"
        aria-label={tr("auth.dismiss")}
      >
        <X size={16} />
      </button>
    </div>
  );
}
