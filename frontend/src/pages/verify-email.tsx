// Email-verification landing. Reads ?token from the link, calls
// the verify endpoint, and reports success or failure. Client-rendered: the
// token only exists in the URL on the user's device.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import Link from "next/link";
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { oc } from "@/lib/sdk";
import { CanvasFloor } from "@/components/ui/CanvasFloor";
import { Logo } from "@/components/ui/Logo";
import { Button } from "@/components/ui/Button";
import { tr } from "@/lib/i18n";

type State = "verifying" | "ok" | "error";

export default function VerifyEmailPage() {
  const router = useRouter();
  const [state, setState] = useState<State>("verifying");
  const ran = useRef(false);

  useEffect(() => {
    if (!router.isReady || ran.current) return;
    ran.current = true;
    const token = typeof router.query.token === "string" ? router.query.token : "";
    // Resolve asynchronously (even for the missing-token case) so we never call
    // setState synchronously inside the effect body.
    (token ? oc.verifyEmail(token) : Promise.reject(new Error("missing token")))
      .then(() => setState("ok"))
      .catch(() => setState("error"));
  }, [router.isReady, router.query.token]);

  return (
    <>
      <Head>
        <title>{tr("page.verify_email_hycanvas")}</title>
      </Head>
      <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-6">
        <CanvasFloor />
        <div className="relative z-10 w-full max-w-sm rounded-2xl bg-surface p-8 text-center shadow-2xl ring-1 ring-black/5">
          <Logo size={32} className="mx-auto mb-6" />
          {state === "verifying" && (
            <>
              <Loader2 size={36} className="mx-auto animate-spin text-brand-500" />
              <p className="mt-4 text-sm text-neutral-500">{tr("page.verifying_your_email")}</p>
            </>
          )}
          {state === "ok" && (
            <>
              <CheckCircle2 size={40} className="mx-auto text-emerald-500" />
              <h1 className="mt-4 text-lg font-bold text-neutral-900">{tr("page.email_verified")}</h1>
              <p className="mt-1.5 text-sm text-neutral-500">{tr("page.email_confirmed")}</p>
              <Button block size="lg" className="mt-6" onClick={() => void router.push("/dashboard")}>
                {tr("page.go_to_dashboard")}
              </Button>
            </>
          )}
          {state === "error" && (
            <>
              <AlertCircle size={40} className="mx-auto text-red-500" />
              <h1 className="mt-4 text-lg font-bold text-neutral-900">{tr("page.link_expired_or_invalid")}</h1>
              <p className="mt-1.5 text-sm text-neutral-500">
                {tr("page.this_verification_link_is_no_longer_valid_yo")}
              </p>
              <Link href="/dashboard" className="mt-6 inline-block text-sm font-semibold text-brand-ink hover:underline">
                {tr("page.back_to_dashboard")}
              </Link>
            </>
          )}
        </div>
      </main>
    </>
  );
}
