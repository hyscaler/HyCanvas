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

const PHASES = [
  { id: "validating", label: "Validating the database connection" },
  { id: "writing", label: "Writing the configuration (.env)" },
  { id: "migrating", label: "Creating database tables" },
  { id: "starting", label: "Starting HyCanvas" },
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
          setState({ kind: "error", detail: st.error ?? "Install failed." });
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
      setState({ kind: "error", detail: err instanceof Error ? err.message : "Install failed." });
    }
  }

  const running = state.kind === "running" || state.kind === "waiting";
  const currentPhase = state.kind === "running" ? state.phase : state.kind === "waiting" ? "starting" : "";
  const phaseIndex = PHASES.findIndex((p) => p.id === currentPhase);

  return (
    <WizardShell
      step={5}
      title={running ? "Installing…" : "Review and install"}
      subtitle={
        running
          ? "Hold tight; this takes a few seconds."
          : "Everything checks out. Installing writes the configuration, prepares the database, and starts the server."
      }
      stage={state.kind === "review" ? "setup" : "none"}
    >
      {state.kind === "review" && (
        <div className="flex flex-col gap-4">
          {answers ? (
            <dl className="divide-y divide-neutral-100 rounded-xl border border-neutral-200 text-sm">
              <Row k="Public URL" v={answers.appUrl || "(current origin)"} />
              {answers.proxied ? (
                <Row k="Listens on" v={`${answers.bindHost || "127.0.0.1"}:${answers.port || "8005"} (behind your proxy)`} />
              ) : (
                <Row k="Port" v={answers.port || "8005"} />
              )}
              <Row
                k="Database"
                v={
                  answers.db.url
                    ? answers.db.url.replace(/:\/\/([^:]+):[^@]*@/, "://$1:••••@")
                    : `${answers.db.user}@${answers.db.host}:${answers.db.port || "5432"}/${answers.db.name}`
                }
              />
              <Row
                k="Storage"
                v={answers.storage.driver === "s3" ? `S3: ${answers.storage.s3.bucket} @ ${answers.storage.s3.endpoint}` : `Local disk: ${answers.storage.localPath}`}
              />
              <Row k="Email" v={answers.smtp.enabled ? `SMTP via ${answers.smtp.host}` : "Not configured"} />
              <Row k="Secrets" v="JWT and encryption keys are generated automatically" />
            </dl>
          ) : (
            <div className="grid place-items-center rounded-xl border border-neutral-200 py-10">
              <BrandLoader size={72} />
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <Button type="button" variant="ghost" onClick={() => void router.push("/installation/step-4")}>
              Back
            </Button>
            <Button type="button" size="lg" onClick={() => void install()} disabled={!answers}>
              Install HyCanvas
            </Button>
          </div>
        </div>
      )}

      {running && (
        <ul className="flex flex-col gap-3">
          {PHASES.map((p, i) => {
            const done = phaseIndex > i || state.kind === "waiting";
            const active = !done && phaseIndex === i;
            return (
              <li key={p.id} className="flex items-center gap-3 text-sm">
                <span
                  className={cn(
                    "grid h-6 w-6 place-items-center rounded-full",
                    done && "oc-gradient text-white",
                    active && "bg-brand-50 text-brand-700",
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
              Back to database
            </Button>
            <Button type="button" onClick={() => void install()}>
              Try again
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
      <dd className="break-all text-right text-neutral-900">{v}</dd>
    </div>
  );
}
