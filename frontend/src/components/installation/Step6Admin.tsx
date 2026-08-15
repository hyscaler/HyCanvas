// Step 6: the first account. Runs after the handover to the normal server,
// so it uses the ordinary signup flow (session cookie included) and lands on
// the dashboard.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/router";
import { ApiError } from "@hc/sdk";
import { useAuth } from "@/store/auth";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { WizardShell, ErrorBanner } from "./WizardShell";
import { tr } from "@/lib/i18n";

export function Step6Admin() {
  const router = useRouter();
  const signup = useAuth((s) => s.signup);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signup(email, password, name || undefined);
      await router.push("/dashboard");
    } catch (err) {
      let msg = tr("installation.couldnt_create_the_account_please_try_again");
      if (err instanceof ApiError) {
        if (err.status === 409) msg = tr("installation.an_account_with_this_email_already_exists_si");
        else {
          const body = err.body as { message?: string } | undefined;
          msg = body?.message ?? `Request failed (${err.status}).`;
        }
      }
      setError(msg);
      setBusy(false);
    }
  }

  return (
    <WizardShell
      step={6}
      title={tr("installation.create_your_account")}
      subtitle="HyCanvas is running. Create the first account; it gets its own workspace and you land straight in the dashboard."
      stage="configured"
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Input label={tr("installation.name")} placeholder={tr("installation.your_name")} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus />
        <Input
          label={tr("installation.email")}
          type="email"
          required
          placeholder={tr("installation.you_example_com")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
        <Input
          label={tr("installation.password")}
          type="password"
          required
          minLength={8}
          placeholder={tr("installation.at_least_8_characters")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <Button type="submit" size="lg" block disabled={busy}>
          {busy ? tr("installation.creating") : tr("installation.create_account_and_finish")}
        </Button>
      </form>
    </WizardShell>
  );
}
