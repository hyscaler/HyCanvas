// Step 1: wizard access secret (printed on the server's terminal / in
// `hycanvas service log`) plus the app basics. Nothing can be configured
// until the secret verifies, and every fresh page load restarts here: the
// secret is held only in module memory and the answers only on the server.

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/router";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { WizardShell, ErrorBanner } from "./WizardShell";
import { getAnswers, setupStatus, updateAnswers, verifySecret } from "./wizard";

export function Step1Access() {
  const router = useRouter();
  const [secret, setSecret] = useState("");
  const [appUrl, setAppUrl] = useState(() =>
    typeof window !== "undefined" ? window.location.origin : "",
  );
  const [port, setPort] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void setupStatus().then((st) => {
      if (st) setPort((prev) => prev || st.defaults.port);
    });
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await verifySecret(secret.trim());
      // A mid-wizard refresh lands back here; keep any answers already on the
      // server, only overriding the basics with what this form now shows.
      const existing = await getAnswers();
      await updateAnswers({ appUrl: appUrl || existing.appUrl, port: port || existing.port });
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
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="off"
        />
        <Input
          label="Public URL"
          type="url"
          required
          placeholder="https://canvas.example.com"
          value={appUrl}
          onChange={(e) => setAppUrl(e.target.value)}
        />
        <Input
          label="Port"
          inputMode="numeric"
          placeholder="8005"
          value={port}
          onChange={(e) => setPort(e.target.value)}
        />
        <p className="text-xs text-neutral-400">
          The public URL is used in links the server generates (email verification, sharing). You can change both later in `.env`.
        </p>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <Button type="submit" size="lg" block disabled={busy || !secret}>
          {busy ? "Checking…" : "Continue"}
        </Button>
      </form>
    </WizardShell>
  );
}
