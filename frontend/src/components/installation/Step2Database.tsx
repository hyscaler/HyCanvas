// Step 2: PostgreSQL connection. Prefills from the server-held answers, and
// the connection must test successfully before the wizard moves on. Reached
// only through step 1 in the same SPA session (useSecretGate).

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/router";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { WizardShell, ErrorBanner, SuccessBanner, useSecretGate } from "./WizardShell";
import { getAnswers, setupPost, updateAnswers, type DBAnswers } from "./wizard";
import { tr } from "@/lib/i18n";
import { userMessage } from "@/lib/errors";

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
      setError(userMessage(err, tr("installation.connection_failed")));
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
      setError(userMessage(err, tr("installation.couldnt_save_please_try_again")));
      setBusy(false);
    }
  }

  return (
    <WizardShell
      step={2}
      title={tr("installation.connect_postgresql")}
      subtitle="HyCanvas stores designs and accounts in Postgres. The database must exist; tables are created automatically."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {mode === "fields" ? (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Input label={tr("installation.host")} required placeholder={tr("installation.localhost")} value={db.host} onChange={(e) => setDB({ host: e.target.value })} autoFocus />
              </div>
              <Input label={tr("installation.port")} inputMode="numeric" placeholder="5432" value={db.port} onChange={(e) => setDB({ port: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label={tr("installation.username")} required placeholder={tr("installation.postgres")} value={db.user} onChange={(e) => setDB({ user: e.target.value })} />
              <Input label={tr("installation.password")} type="password" value={db.password} onChange={(e) => setDB({ password: e.target.value })} autoComplete="off" />
            </div>
            <Input label={tr("installation.database_name")} required placeholder={tr("installation.hycanvas")} value={db.name} onChange={(e) => setDB({ name: e.target.value })} />
          </>
        ) : (
          <Input
            label={tr("installation.connection_url")}
            required
            placeholder={tr("installation.postgresql_user_password_host_5432_hycanvas")}
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
          className="self-start text-sm font-medium text-brand-ink hover:underline"
        >
          {mode === "fields" ? tr("installation.paste_a_connection_url_instead") : tr("installation.enter_host_and_credentials_instead")}
        </button>

        {error && <ErrorBanner>{error}</ErrorBanner>}
        {tested && <SuccessBanner>{tr("installation.connection_succeeded")}</SuccessBanner>}

        <div className="flex items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={() => void router.push("/installation/step-1")}>
            {tr("installation.back")}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => void test()} disabled={busy}>
              {busy ? tr("installation.working") : tr("installation.test_connection")}
            </Button>
            <Button type="submit" disabled={!tested || busy}>
              {tr("installation.continue")}
            </Button>
          </div>
        </div>
      </form>
    </WizardShell>
  );
}
