// Step 5: review + install. Shows the server-held answers, triggers the
// server-side install (which uses those answers), renders its live phases
// (validate -> write config -> migrate -> start), then waits for the real
// server to come up and moves to the admin step.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { BrandLoader } from "@/components/ui/BrandLoader";
import { Button } from "@/components/ui/Button";
import { WizardShell, ErrorBanner, useSecretGate } from "./WizardShell";
import { getAnswers, healthOk, setupPost, setupStatus, type SetupAnswers } from "./wizard";
import { tr } from "@/lib/i18n";
import { userMessage } from "@/lib/errors";

const phases = () => [
  { id: "validating", label: tr("installation.validating_the_database_connection") },
  { id: "writing", label: tr("installation.writing_the_configuration_env") },
  { id: "migrating", label: tr("installation.creating_database_tables") },
  { id: "starting", label: tr("installation.starting_hycanvas") },
];

type InstallState =
  | { kind: "review" }
  | { kind: "running"; phase: string }
  | { kind: "waiting" } // setup server gone; polling the real server
  | { kind: "error"; detail: string };

export function Step5Install() {
  const router = useRouter();
  const ready = useSecretGate();
  const [answers, setAnswers] = useState<SetupAnswers | null>(null);
  const [state, setState] = useState<InstallState>({ kind: "review" });
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    if (!ready) return;
    void getAnswers()
      .then(setAnswers)
      .catch(() => {});
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [ready]);

  function advance() {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    // If the operator changed the port, the running origin is wrong now; a
    // full navigation to the configured URL carries them over.
    const target = "/installation/step-6/";
    const appUrl = answers?.appUrl ?? "";
    if (typeof window !== "undefined" && appUrl && !window.location.origin.startsWith(appUrl)) {
      window.location.href = appUrl.replace(/\/$/, "") + target;
      return;
    }
    void router.push(target);
  }

  function watchInstall() {
    pollRef.current = window.setInterval(() => {
      void (async () => {
        const st = await setupStatus();
        if (!st) {
          // The setup server is gone: the handover happened. Wait for the
          // normal server to answer health checks.
          setState({ kind: "waiting" });
          if (await healthOk()) advance();
          return;
        }
        if (st.phase === "error") {
          if (pollRef.current !== null) window.clearInterval(pollRef.current);
          setState({ kind: "error", detail: st.error ?? tr("installation.install_failed") });
          return;
        }
        setState({ kind: "running", phase: st.phase });
      })();
    }, 800);
  }

  async function install() {
    setState({ kind: "running", phase: "validating" });
    try {
      await setupPost("complete", {});
      watchInstall();
    } catch (err) {
      setState({ kind: "error", detail: userMessage(err, tr("installation.install_failed")) });
    }
  }

  const running = state.kind === "running" || state.kind === "waiting";
  const currentPhase = state.kind === "running" ? state.phase : state.kind === "waiting" ? "starting" : "";
  const phaseIndex = phases().findIndex((p) => p.id === currentPhase);

  return (
    <WizardShell
      step={5}
      title={running ? tr("installation.installing") : tr("installation.review_and_install")}
      subtitle={
        running
          ? "Hold tight; this takes a few seconds."
          : tr("installation.everything_checks_out_installing_writes_the")
      }
      stage={state.kind === "review" ? "setup" : "none"}
    >
      {state.kind === "review" && (
        <div className="flex flex-col gap-4">
          {answers ? (
            <dl className="divide-y divide-neutral-100 rounded-xl border border-neutral-200 text-sm">
              <Row k={tr("installation.public_url")} v={answers.appUrl || "(current origin)"} />
              {answers.proxied ? (
                <Row k={tr("installation.listens_on")} v={`${answers.bindHost || "127.0.0.1"}:${answers.port || "8005"} (behind your proxy)`} />
              ) : (
                <Row k={tr("installation.port")} v={answers.port || "8005"} />
              )}
              <Row
                k={tr("installation.database")}
                v={
                  answers.db.url
                    ? answers.db.url.replace(/:\/\/([^:]+):[^@]*@/, "://$1:••••@")
                    : `${answers.db.user}@${answers.db.host}:${answers.db.port || "5432"}/${answers.db.name}`
                }
              />
              <Row
                k={tr("installation.storage")}
                v={answers.storage.driver === "s3" ? `S3: ${answers.storage.s3.bucket} @ ${answers.storage.s3.endpoint}` : `Local disk: ${answers.storage.localPath}`}
              />
              <Row k={tr("installation.email")} v={answers.smtp.enabled ? `SMTP via ${answers.smtp.host}` : tr("installation.not_configured")} />
              <Row k={tr("installation.secrets")} v={tr("installation.jwt_and_encryption_keys_are_generated_automa")} />
            </dl>
          ) : (
            <div className="grid place-items-center rounded-xl border border-neutral-200 py-10">
              <BrandLoader size={72} />
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <Button type="button" variant="ghost" onClick={() => void router.push("/installation/step-4")}>
              {tr("installation.back")}
            </Button>
            <Button type="button" size="lg" onClick={() => void install()} disabled={!answers}>
              {tr("installation.install_hycanvas")}
            </Button>
          </div>
        </div>
      )}

      {running && (
        <ul className="flex flex-col gap-3">
          {phases().map((p, i) => {
            const done = phaseIndex > i || state.kind === "waiting";
            const active = !done && phaseIndex === i;
            return (
              <li key={p.id} className="flex items-center gap-3 text-sm">
                <span
                  className={cn(
                    "grid h-6 w-6 place-items-center rounded-full",
                    done && "oc-gradient text-white",
                    active && "bg-brand-50 text-brand-ink",
                    !done && !active && "bg-neutral-100 text-neutral-400",
                  )}
                >
                  {done ? <Check size={12} /> : active ? <Loader2 size={12} className="animate-spin" /> : i + 1}
                </span>
                <span className={cn(done || active ? "text-neutral-800" : "text-neutral-400")}>{p.label}</span>
              </li>
            );
          })}
        </ul>
      )}

      {state.kind === "error" && (
        <div className="flex flex-col gap-4">
          <ErrorBanner>{state.detail}</ErrorBanner>
          <div className="flex items-center justify-between gap-3">
            <Button type="button" variant="ghost" onClick={() => void router.push("/installation/step-2")}>
              {tr("installation.back_to_database")}
            </Button>
            <Button type="button" onClick={() => void install()}>
              {tr("installation.try_again")}
            </Button>
          </div>
        </div>
      )}
    </WizardShell>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-6 px-4 py-2.5">
      <dt className="shrink-0 font-medium text-neutral-500">{k}</dt>
      <dd className="break-all text-end text-neutral-900">{v}</dd>
    </div>
  );
}
