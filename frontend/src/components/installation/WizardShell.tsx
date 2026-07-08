// Branded shell for the first-run installation wizard: the canvas floor
// behind a wide card, with an always-visible step progress header so the
// operator knows where they are (steps with done/current states + a bar).

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/router";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { CanvasFloor } from "@/components/ui/CanvasFloor";
import { Logo } from "@/components/ui/Logo";
import { getSecret, setupStatus } from "./wizard";

// useSecretGate sends steps 2..5 back to the welcome step when no verified
// access secret is held, which is the case on any fresh page load or direct
// deep link: the wizard always restarts at step 1. Returns readiness so the
// caller can hold off on data fetching while redirecting.
export function useSecretGate(): boolean {
  const router = useRouter();
  const ready = getSecret() !== null;
  useEffect(() => {
    if (!ready) void router.replace("/installation/step-1/");
  }, [ready, router]);
  return ready;
}

export const STEPS = [
  { n: 1, label: "Welcome" },
  { n: 2, label: "Database" },
  { n: 3, label: "Storage" },
  { n: 4, label: "Email" },
  { n: 5, label: "Install" },
  { n: 6, label: "Admin" },
];

export function WizardShell({
  step,
  title,
  subtitle,
  children,
  stage = "setup",
}: {
  step: number;
  title: string;
  subtitle?: string;
  children: ReactNode;
  // stage guards direct navigation: "setup" pages bounce to the app once the
  // server is configured; the "configured" page (admin creation, which runs
  // after the handover) bounces back to step 1 while the server is still in
  // setup mode; "none" skips the check (the install step mid-flight, when the
  // setup server intentionally disappears).
  stage?: "setup" | "configured" | "none";
}) {
  const router = useRouter();

  useEffect(() => {
    if (stage === "none") return;
    let cancelled = false;
    void setupStatus().then((st) => {
      if (cancelled) return;
      if (stage === "setup" && !st) void router.replace("/");
      if (stage === "configured" && st) void router.replace("/installation/step-1/");
    });
    return () => {
      cancelled = true;
    };
  }, [stage, router]);

  const progress = ((step - 1) / (STEPS.length - 1)) * 100;

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden p-6">
      <CanvasFloor />
      <div className="oc-fade-up relative z-10 w-full max-w-xl rounded-2xl bg-surface p-8 shadow-2xl ring-1 ring-black/5">
        <div className="mb-6 flex items-center justify-between">
          <Logo size={28} />
          <span className="text-xs font-medium text-neutral-400">
            Step {step} of {STEPS.length}
          </span>
        </div>

        {/* Progress header */}
        <div aria-hidden className="mb-2 flex items-center justify-between">
          {STEPS.map((s) => (
            <div key={s.n} className="flex flex-col items-center gap-1">
              <span
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-full text-xs font-semibold ring-1 transition",
                  s.n < step && "oc-gradient text-white ring-transparent",
                  s.n === step && "bg-brand-50 text-brand-ink ring-brand-300",
                  s.n > step && "bg-surface text-neutral-400 ring-neutral-200",
                )}
              >
                {s.n < step ? <Check size={13} /> : s.n}
              </span>
              <span
                className={cn(
                  "text-[10px] font-medium",
                  s.n === step ? "text-brand-ink" : "text-neutral-400",
                )}
              >
                {s.label}
              </span>
            </div>
          ))}
        </div>
        <div
          className="mb-7 h-1 w-full overflow-hidden rounded-full bg-neutral-100"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
          aria-label="Setup progress"
        >
          <div className="oc-gradient h-full rounded-full transition-all" style={{ width: `${progress}%` }} />
        </div>

        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm text-neutral-500">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

// ErrorBanner is the wizard's shared inline error idiom (matches AuthForm).
export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
      {children}
    </div>
  );
}

// SuccessBanner confirms a passed connection test.
export function SuccessBanner({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-xl bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
      {children}
    </div>
  );
}
