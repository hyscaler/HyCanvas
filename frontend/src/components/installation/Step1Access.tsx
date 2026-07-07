// Step 1: wizard access secret (printed on the server's terminal / in
// `hycanvas service log`) plus the app basics. Nothing can be configured
// until the secret verifies.

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/router";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { WizardShell, ErrorBanner } from "./WizardShell";
import { loadAnswers, saveAnswers, setupStatus, verifySecret } from "./wizard";

export function Step1Access() {
  const router = useRouter();
  // Lazy init: sessionStorage and window exist client-side only; the static
  // prerender falls back to empty answers inside loadAnswers.
  const [answers, setAnswers] = useState(() => {
    const a = loadAnswers();
    if (typeof window !== "undefined" && !a.appUrl) a.appUrl = window.location.origin;
    return a;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void setupStatus().then((st) => {
      if (st) setAnswers((prev) => ({ ...prev, port: prev.port || st.defaults.port }));
    });
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await verifySecret(answers.secret.trim());
      const next = { ...answers, secret: answers.secret.trim() };
      saveAnswers(next);
      await router.push("/installation/step-2");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed. Please try again.");
      setBusy(false);
    }
  }

  return (
    <WizardShell
      step={1}
      title="Welcome to HyCanvas"
      subtitle="Let's set up your server. First, prove you're the operator: enter the wizard access secret shown where you started the server (terminal output or `hycanvas service log`)."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Input
          label="Wizard access secret"
          required
          autoFocus
          placeholder="Printed when the server started"
          value={answers.secret}
          onChange={(e) => setAnswers({ ...answers, secret: e.target.value })}
          autoComplete="off"
        />
        <Input
          label="Public URL"
          type="url"
          required
          placeholder="https://canvas.example.com"
          value={answers.appUrl}
          onChange={(e) => setAnswers({ ...answers, appUrl: e.target.value })}
        />
        <Input
          label="Port"
          inputMode="numeric"
          placeholder="8005"
          value={answers.port}
          onChange={(e) => setAnswers({ ...answers, port: e.target.value })}
        />
        <p className="text-xs text-neutral-400">
          The public URL is used in links the server generates (email verification, sharing). You can change both later in `.env`.
        </p>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <Button type="submit" size="lg" block disabled={busy || !answers.secret}>
          {busy ? "Checking…" : "Continue"}
        </Button>
      </form>
    </WizardShell>
  );
}
