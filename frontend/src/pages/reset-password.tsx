// Password-reset landing. Reads ?token from the reset link and
// presents a new-password form. On success the backend revokes existing
// sessions, so the user is sent to /login to sign in fresh.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { ApiError } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { Logo } from "@/components/ui/Logo";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    // The token lives only in the URL; read it at submit time.
    const token = typeof router.query.token === "string" ? router.query.token : "";
    if (!token) {
      setError("This reset link is invalid or has expired.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await oc.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError("This reset link is invalid or has expired. Request a new one.");
      } else {
        setError("Something went wrong. Please try again.");
      }
      setBusy(false);
    }
  }

  return (
    <>
      <Head>
        <title>Reset password · HyCanvas</title>
      </Head>
      <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-6">
        <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
          <Logo size={32} className="mb-6" />
          {done ? (
            <div className="text-center">
              <CheckCircle2 size={40} className="mx-auto text-emerald-500" />
              <h1 className="mt-4 text-lg font-bold text-neutral-900">Password updated</h1>
              <p className="mt-1.5 text-sm text-neutral-500">
                You can now sign in with your new password.
              </p>
              <Button block size="lg" className="mt-6" onClick={() => void router.push("/login")}>
                Sign in
              </Button>
            </div>
          ) : (
            <>
              <h1 className="text-lg font-bold text-neutral-900">Choose a new password</h1>
              <p className="mt-1.5 text-sm text-neutral-500">Enter a new password for your account.</p>
              <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
                <Input
                  label="New password"
                  type="password"
                  required
                  minLength={8}
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  autoFocus
                />
                <Input
                  label="Confirm password"
                  type="password"
                  required
                  minLength={8}
                  placeholder="Re-enter your password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                />
                {error && (
                  <div role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
                    {error}
                  </div>
                )}
                <Button type="submit" size="lg" block disabled={busy}>
                  {busy ? "Please wait…" : "Update password"}
                </Button>
              </form>
              <p className="mt-6 text-center text-sm text-neutral-500">
                <Link href="/login" className="font-semibold text-brand-700 hover:underline">
                  Back to sign in
                </Link>
              </p>
            </>
          )}
        </div>
      </main>
    </>
  );
}
