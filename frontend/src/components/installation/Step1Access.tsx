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
import { tr } from "@/lib/i18n";
import { userMessage } from "@/lib/errors";

export function Step1Access() {
  const router = useRouter();
  const [secret, setSecret] = useState("");
  const [appUrl, setAppUrl] = useState(() =>
    typeof window !== "undefined" ? window.location.origin : "",
  );
  const [port, setPort] = useState("");
  const [proxied, setProxied] = useState(false);
  const [bindHost, setBindHost] = useState("127.0.0.1");
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
      await updateAnswers({
        appUrl: appUrl || existing.appUrl,
        port: port || existing.port,
        proxied,
        bindHost: proxied ? bindHost : "",
      });
      await router.push("/installation/step-2");
    } catch (err) {
      setError(userMessage(err, tr("installation.verification_failed_please_try_again")));
      setBusy(false);
    }
  }

  return (
    <WizardShell
      step={1}
      title={tr("installation.welcome_to_hycanvas")}
      subtitle="Let's set up your server. First, prove you're the operator: enter the wizard access secret shown where you started the server (terminal output or `hycanvas service log`)."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Input
          label={tr("installation.wizard_access_secret")}
          required
          autoFocus
          placeholder={tr("installation.printed_when_the_server_started")}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="off"
        />
        <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
          <input
            type="checkbox"
            checked={proxied}
            onChange={(e) => {
              setProxied(e.target.checked);
              if (e.target.checked && typeof window !== "undefined" && appUrl === window.location.origin) {
                setAppUrl("");
              }
            }}
            className="h-4 w-4 rounded border-neutral-300 accent-[var(--color-brand-600)]"
          />
          {tr("installation.running_hycanvas_behind_a_proxy")}
        </label>
        <Input
          label={proxied ? tr("installation.external_url_the_domain_your_proxy_serves") : tr("installation.public_url")}
          type="url"
          required
          placeholder={proxied ? "https://hycanvas.art" : "https://canvas.example.com"}
          value={appUrl}
          onChange={(e) => setAppUrl(e.target.value)}
        />
        {proxied ? (
          <div className="grid grid-cols-2 gap-3">
            <Input
              label={tr("installation.internal_host_proxy_forwards_here")}
              placeholder="127.0.0.1"
              value={bindHost}
              onChange={(e) => setBindHost(e.target.value)}
            />
            <Input
              label={tr("installation.internal_port")}
              inputMode="numeric"
              placeholder="8005"
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
          </div>
        ) : (
          <Input
            label={tr("installation.port")}
            inputMode="numeric"
            placeholder="8005"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        )}
        <p className="text-xs text-neutral-400">
          {proxied
            ? `Point your proxy at http://${bindHost || "127.0.0.1"}:${port || "8005"} and forward the Host header. The external URL is used in links the server generates (email verification, sharing).`
            : "The public URL is used in links the server generates (email verification, sharing). You can change both later in `.env`."}
        </p>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <Button type="submit" size="lg" block disabled={busy || !secret}>
          {busy ? tr("installation.checking") : tr("installation.continue")}
        </Button>
      </form>
    </WizardShell>
  );
}
