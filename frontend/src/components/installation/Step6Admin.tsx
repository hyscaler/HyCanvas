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
      let msg = "Couldn't create the account. Please try again.";
      if (err instanceof ApiError) {
        if (err.status === 409) msg = "An account with this email already exists. Sign in instead.";
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
      title="Create your account"
      subtitle="HyCanvas is running. Create the first account; it gets its own workspace and you land straight in the dashboard."
      stage="configured"
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Input label="Name" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus />
        <Input
          label="Email"
          type="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
        <Input
          label="Password"
          type="password"
          required
          minLength={8}
          placeholder="At least 8 characters"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <Button type="submit" size="lg" block disabled={busy}>
          {busy ? "Creating…" : "Create account and finish"}
        </Button>
      </form>
    </WizardShell>
  );
}
