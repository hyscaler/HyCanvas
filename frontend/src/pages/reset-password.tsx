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
import { CanvasFloor } from "@/components/ui/CanvasFloor";
import { Logo } from "@/components/ui/Logo";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { tr } from "@/lib/i18n";

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
      setError(tr("page.this_reset_link_is_invalid_or_has_expired"));
      return;
    }
    if (password !== confirm) {
      setError(tr("page.passwords_dont_match"));
      return;
    }
    setBusy(true);
    try {
      await oc.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError(tr("page.this_reset_link_is_invalid_or_has_expired_re"));
      } else {
        setError(tr("page.something_went_wrong_please_try_again"));
      }
      setBusy(false);
    }
  }

  return (
    <>
      <Head>
        <title>{tr("page.reset_password_hycanvas")}</title>
      </Head>
      <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-6">
        <CanvasFloor />
        <div className="relative z-10 w-full max-w-sm rounded-2xl bg-surface p-8 shadow-2xl ring-1 ring-black/5">
          <Logo size={32} className="mb-6" />
          {done ? (
            <div className="text-center">
              <CheckCircle2 size={40} className="mx-auto text-emerald-500" />
              <h1 className="mt-4 text-lg font-bold text-neutral-900">{tr("page.password_updated")}</h1>
              <p className="mt-1.5 text-sm text-neutral-500">
                {tr("page.you_can_now_sign_in_with_your_new_password")}
              </p>
              <Button block size="lg" className="mt-6" onClick={() => void router.push("/login")}>
                {tr("page.sign_in")}
              </Button>
            </div>
          ) : (
            <>
              <h1 className="text-lg font-bold text-neutral-900">{tr("page.choose_a_new_password")}</h1>
              <p className="mt-1.5 text-sm text-neutral-500">{tr("page.enter_a_new_password_for_your_account")}</p>
              <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
                <Input
                  label={tr("page.new_password")}
                  type="password"
                  required
                  minLength={8}
                  placeholder={tr("page.at_least_8_characters")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  autoFocus
                />
                <Input
                  label={tr("page.confirm_password")}
                  type="password"
                  required
                  minLength={8}
                  placeholder={tr("page.re_enter_your_password")}
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
                  {busy ? tr("page.please_wait") : tr("page.update_password")}
                </Button>
              </form>
              <p className="mt-6 text-center text-sm text-neutral-500">
                <Link href="/login" className="font-semibold text-brand-ink hover:underline">
                  {tr("page.back_to_sign_in")}
                </Link>
              </p>
            </>
          )}
        </div>
      </main>
    </>
  );
}
