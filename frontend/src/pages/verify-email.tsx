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
        <title>Verify email · HyCanvas</title>
      </Head>
      <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-6">
        <CanvasFloor />
        <div className="relative z-10 w-full max-w-sm rounded-2xl bg-white p-8 text-center shadow-2xl ring-1 ring-black/5">
          <Logo size={32} className="mx-auto mb-6" />
          {state === "verifying" && (
            <>
              <Loader2 size={36} className="mx-auto animate-spin text-brand-500" />
              <p className="mt-4 text-sm text-neutral-500">Verifying your email…</p>
            </>
          )}
          {state === "ok" && (
            <>
              <CheckCircle2 size={40} className="mx-auto text-emerald-500" />
              <h1 className="mt-4 text-lg font-bold text-neutral-900">Email verified</h1>
              <p className="mt-1.5 text-sm text-neutral-500">Your email is confirmed. You&apos;re all set.</p>
              <Button block size="lg" className="mt-6" onClick={() => void router.push("/dashboard")}>
                Go to dashboard
              </Button>
            </>
          )}
          {state === "error" && (
            <>
              <AlertCircle size={40} className="mx-auto text-red-500" />
              <h1 className="mt-4 text-lg font-bold text-neutral-900">Link expired or invalid</h1>
              <p className="mt-1.5 text-sm text-neutral-500">
                This verification link is no longer valid. You can request a new one from your dashboard.
              </p>
              <Link href="/dashboard" className="mt-6 inline-block text-sm font-semibold text-brand-700 hover:underline">
                Back to dashboard
              </Link>
            </>
          )}
        </div>
      </main>
    </>
  );
}
