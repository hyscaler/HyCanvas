// Step 4: optional SMTP, prefilled from the server-held answers. Skipping is
// fine: without SMTP the server keeps account emails (verification, resets)
// in an in-app dev outbox outside production, and sends nothing in production.

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/router";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { WizardShell, ErrorBanner, SuccessBanner, useSecretGate } from "./WizardShell";
import { getAnswers, setupPost, updateAnswers, type SMTPAnswers } from "./wizard";
import { tr } from "@/lib/i18n";
import { userMessage } from "@/lib/errors";

const smtpDefaults = (): SMTPAnswers => ({
  enabled: false,
  host: "",
  port: "587",
  username: "",
  password: "",
  from: "",
  fromName: tr("installation.hycanvas_2"),
});

export function Step4Email() {
  const router = useRouter();
  const ready = useSecretGate();
  const [smtp, setSMTPState] = useState<SMTPAnswers>(smtpDefaults());
  const [tested, setTested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    void getAnswers()
      .then((a) => {
        if (a.smtp.enabled || a.smtp.host) setSMTPState({ ...smtpDefaults(), ...a.smtp });
      })
      .catch(() => {});
  }, [ready]);

  function setSMTP(patch: Partial<SMTPAnswers>) {
    setSMTPState((prev) => ({ ...prev, ...patch }));
    setTested(false);
    setError(null);
  }

  async function test() {
    setBusy(true);
    setError(null);
    try {
      await setupPost("smtp/test", {
        host: smtp.host,
        port: smtp.port,
        username: smtp.username,
        password: smtp.password,
      });
      setTested(true);
    } catch (err) {
      setError(userMessage(err, tr("installation.smtp_check_failed")));
    } finally {
      setBusy(false);
    }
  }

  const canContinue = !smtp.enabled || tested;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await updateAnswers({ smtp });
      await router.push("/installation/step-5");
    } catch (err) {
      setError(userMessage(err, tr("installation.couldnt_save_please_try_again")));
      setBusy(false);
    }
  }

  return (
    <WizardShell
      step={4}
      title={tr("installation.transactional_email")}
      subtitle={tr("installation.used_for_email_verification_password_resets")}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
          <input
            type="checkbox"
            checked={smtp.enabled}
            onChange={(e) => setSMTP({ enabled: e.target.checked })}
            className="h-4 w-4 rounded border-neutral-300 accent-[var(--color-brand-600)]"
          />
          {tr("installation.send_email_via_smtp")}
        </label>

        {smtp.enabled && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Input label={tr("installation.smtp_host")} required placeholder={tr("installation.smtp_example_com")} value={smtp.host} onChange={(e) => setSMTP({ host: e.target.value })} autoFocus />
              </div>
              <Input label={tr("installation.port")} inputMode="numeric" placeholder="587" value={smtp.port} onChange={(e) => setSMTP({ port: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label={tr("installation.username")} value={smtp.username} onChange={(e) => setSMTP({ username: e.target.value })} autoComplete="off" />
              <Input label={tr("installation.password")} type="password" value={smtp.password} onChange={(e) => setSMTP({ password: e.target.value })} autoComplete="off" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label={tr("installation.from_address")} type="email" placeholder={tr("installation.noreply_example_com")} value={smtp.from} onChange={(e) => setSMTP({ from: e.target.value })} />
              <Input label={tr("installation.from_name")} placeholder={tr("installation.hycanvas_2")} value={smtp.fromName} onChange={(e) => setSMTP({ fromName: e.target.value })} />
            </div>
            <p className="text-xs text-neutral-400">{tr("installation.smtp_tls_port_hint")}</p>
          </>
        )}

        {error && <ErrorBanner>{error}</ErrorBanner>}
        {smtp.enabled && tested && <SuccessBanner>{tr("installation.smtp_server_reachable_and_credentials_accept")}</SuccessBanner>}

        <div className="flex items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={() => void router.push("/installation/step-3")}>
            {tr("installation.back")}
          </Button>
          <div className="flex gap-2">
            {smtp.enabled && (
              <Button type="button" variant="secondary" onClick={() => void test()} disabled={busy}>
                {busy ? tr("installation.working") : tr("installation.test_smtp")}
              </Button>
            )}
            <Button type="submit" disabled={!canContinue || busy}>
              {smtp.enabled ? tr("installation.continue") : tr("installation.skip_for_now")}
            </Button>
          </div>
        </div>
      </form>
    </WizardShell>
  );
}
