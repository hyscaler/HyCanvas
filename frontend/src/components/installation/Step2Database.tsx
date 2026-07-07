// Step 2: PostgreSQL connection. The connection must test successfully
// before the wizard moves on, since everything else depends on it.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/router";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { WizardShell, ErrorBanner, SuccessBanner } from "./WizardShell";
import { loadAnswers, saveAnswers, setupPost, type SetupAnswers } from "./wizard";

export function Step2Database() {
  const router = useRouter();
  // Lazy init: sessionStorage exists client-side only; the static prerender
  // falls back to empty answers inside loadAnswers.
  const [answers, setAnswers] = useState(loadAnswers);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Any edit invalidates a previous successful test.
  function setDB(patch: Partial<SetupAnswers["db"]>) {
    setAnswers((prev) => ({ ...prev, db: { ...prev.db, ...patch, tested: false } }));
    setError(null);
  }

  const db = answers.db;
  const payload =
    db.mode === "url"
      ? { url: db.url }
      : { host: db.host, port: db.port, user: db.user, password: db.password, name: db.name };

  async function test() {
    setBusy(true);
    setError(null);
    try {
      await setupPost("db/test", payload, answers.secret);
      setAnswers((prev) => ({ ...prev, db: { ...prev.db, tested: true } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed.");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    saveAnswers(answers);
    await router.push("/installation/step-3");
  }

  return (
    <WizardShell
      step={2}
      title="Connect PostgreSQL"
      subtitle="HyCanvas stores designs and accounts in Postgres. The database must exist; tables are created automatically."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {db.mode === "fields" ? (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Input label="Host" required placeholder="localhost" value={db.host} onChange={(e) => setDB({ host: e.target.value })} autoFocus />
              </div>
              <Input label="Port" inputMode="numeric" placeholder="5432" value={db.port} onChange={(e) => setDB({ port: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Username" required placeholder="postgres" value={db.user} onChange={(e) => setDB({ user: e.target.value })} />
              <Input label="Password" type="password" value={db.password} onChange={(e) => setDB({ password: e.target.value })} autoComplete="off" />
            </div>
            <Input label="Database name" required placeholder="hycanvas" value={db.name} onChange={(e) => setDB({ name: e.target.value })} />
          </>
        ) : (
          <Input
            label="Connection URL"
            required
            placeholder="postgresql://user:password@host:5432/hycanvas"
            value={db.url}
            onChange={(e) => setDB({ url: e.target.value })}
            autoFocus
            autoComplete="off"
          />
        )}
        <button
          type="button"
          onClick={() => setDB({ mode: db.mode === "fields" ? "url" : "fields" })}
          className="self-start text-sm font-medium text-brand-700 hover:underline"
        >
          {db.mode === "fields" ? "Paste a connection URL instead" : "Enter host and credentials instead"}
        </button>

        {error && <ErrorBanner>{error}</ErrorBanner>}
        {db.tested && <SuccessBanner>Connection succeeded.</SuccessBanner>}

        <div className="flex items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={() => void router.push("/installation/step-1")}>
            Back
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => void test()} disabled={busy}>
              {busy ? "Testing…" : "Test connection"}
            </Button>
            <Button type="submit" disabled={!db.tested}>
              Continue
            </Button>
          </div>
        </div>
      </form>
    </WizardShell>
  );
}
