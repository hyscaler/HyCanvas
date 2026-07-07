// Step 4: optional SMTP. Skipping is fine: without SMTP the server keeps
// account emails (verification, resets) in an in-app dev outbox outside
// production, and sends nothing in production.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/router";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { WizardShell, ErrorBanner, SuccessBanner } from "./WizardShell";
import { loadAnswers, saveAnswers, setupPost, type SetupAnswers } from "./wizard";

export function Step4Email() {
  const router = useRouter();
  // Lazy init: sessionStorage exists client-side only; the static prerender
  // falls back to empty answers inside loadAnswers.
  const [answers, setAnswers] = useState(loadAnswers);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const smtp = answers.smtp;

  function setSMTP(patch: Partial<SetupAnswers["smtp"]>) {
    setAnswers((prev) => ({ ...prev, smtp: { ...prev.smtp, ...patch, tested: false } }));
    setError(null);
  }

  async function test() {
    setBusy(true);
    setError(null);
    try {
      await setupPost(
        "smtp/test",
        { host: smtp.host, port: smtp.port, username: smtp.username, password: smtp.password },
        answers.secret,
      );
      setAnswers((prev) => ({ ...prev, smtp: { ...prev.smtp, tested: true } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "SMTP check failed.");
    } finally {
      setBusy(false);
    }
  }

  const canContinue = !smtp.enabled || smtp.tested;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    saveAnswers(answers);
    await router.push("/installation/step-5");
  }

  return (
    <WizardShell
      step={4}
      title="Transactional email"
      subtitle="Used for email verification, password resets, magic links, and invites. Optional: without SMTP the server sends no email in production."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
          <input
            type="checkbox"
            checked={smtp.enabled}
            onChange={(e) => setSMTP({ enabled: e.target.checked })}
            className="h-4 w-4 rounded border-neutral-300 accent-[var(--color-brand-600)]"
          />
          Send email via SMTP
        </label>

        {smtp.enabled && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Input label="SMTP host" required placeholder="smtp.example.com" value={smtp.host} onChange={(e) => setSMTP({ host: e.target.value })} autoFocus />
              </div>
              <Input label="Port" inputMode="numeric" placeholder="587" value={smtp.port} onChange={(e) => setSMTP({ port: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Username" value={smtp.username} onChange={(e) => setSMTP({ username: e.target.value })} autoComplete="off" />
              <Input label="Password" type="password" value={smtp.password} onChange={(e) => setSMTP({ password: e.target.value })} autoComplete="off" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="From address" type="email" placeholder="noreply@example.com" value={smtp.from} onChange={(e) => setSMTP({ from: e.target.value })} />
              <Input label="From name" placeholder="HyCanvas" value={smtp.fromName} onChange={(e) => setSMTP({ fromName: e.target.value })} />
            </div>
            <p className="text-xs text-neutral-400">Port 465 uses implicit TLS; other ports upgrade with STARTTLS when the server offers it.</p>
          </>
        )}

        {error && <ErrorBanner>{error}</ErrorBanner>}
        {smtp.enabled && smtp.tested && <SuccessBanner>SMTP server reachable and credentials accepted.</SuccessBanner>}

        <div className="flex items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={() => void router.push("/installation/step-3")}>
            Back
          </Button>
          <div className="flex gap-2">
            {smtp.enabled && (
              <Button type="button" variant="secondary" onClick={() => void test()} disabled={busy}>
                {busy ? "Testing…" : "Test SMTP"}
              </Button>
            )}
            <Button type="submit" disabled={!canContinue}>
              {smtp.enabled ? "Continue" : "Skip for now"}
            </Button>
          </div>
        </div>
      </form>
    </WizardShell>
  );
}
