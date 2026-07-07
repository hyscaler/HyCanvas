// Step 2: PostgreSQL connection. Prefills from the server-held answers, and
// the connection must test successfully before the wizard moves on. Reached
// only through step 1 in the same SPA session (useSecretGate).

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/router";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { WizardShell, ErrorBanner, SuccessBanner, useSecretGate } from "./WizardShell";
import { getAnswers, setupPost, updateAnswers, type DBAnswers } from "./wizard";

const DB_DEFAULTS: DBAnswers = { url: "", host: "localhost", port: "5432", user: "", password: "", name: "hycanvas" };

export function Step2Database() {
  const router = useRouter();
  const ready = useSecretGate();
  const [db, setDbState] = useState<DBAnswers>(DB_DEFAULTS);
  const [mode, setMode] = useState<"fields" | "url">("fields");
  const [tested, setTested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    void getAnswers()
      .then((a) => {
        if (a.db.url || a.db.host) {
          setDbState({ ...DB_DEFAULTS, ...a.db });
          if (a.db.url) setMode("url");
        }
      })
      .catch(() => {});
  }, [ready]);

  // Any edit invalidates a previous successful test.
  function setDB(patch: Partial<DBAnswers>) {
    setDbState((prev) => ({ ...prev, ...patch }));
    setTested(false);
    setError(null);
  }

  const payload =
    mode === "url"
      ? { url: db.url }
      : { host: db.host, port: db.port, user: db.user, password: db.password, name: db.name };

  async function test() {
    setBusy(true);
    setError(null);
    try {
      await setupPost("db/test", payload);
      setTested(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed.");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      // The server's DSN builder prefers a non-empty url, so clear it when
      // discrete fields are the chosen mode.
      await updateAnswers({ db: mode === "url" ? { ...db } : { ...db, url: "" } });
      await router.push("/installation/step-3");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save. Please try again.");
      setBusy(false);
    }
  }

  return (
    <WizardShell
      step={2}
      title="Connect PostgreSQL"
      subtitle="HyCanvas stores designs and accounts in Postgres. The database must exist; tables are created automatically."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {mode === "fields" ? (
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
          onClick={() => {
            setMode((m) => (m === "fields" ? "url" : "fields"));
            setTested(false);
            setError(null);
          }}
          className="self-start text-sm font-medium text-brand-700 hover:underline"
        >
          {mode === "fields" ? "Paste a connection URL instead" : "Enter host and credentials instead"}
        </button>

        {error && <ErrorBanner>{error}</ErrorBanner>}
        {tested && <SuccessBanner>Connection succeeded.</SuccessBanner>}

        <div className="flex items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={() => void router.push("/installation/step-1")}>
            Back
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => void test()} disabled={busy}>
              {busy ? "Working…" : "Test connection"}
            </Button>
            <Button type="submit" disabled={!tested || busy}>
              Continue
            </Button>
          </div>
        </div>
      </form>
    </WizardShell>
  );
}
