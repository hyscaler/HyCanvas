// Sign-in / sign-up - a two-pane branded layout: a gradient brand
// panel and a clean form. Email + password ship now; social buttons are honest
// "coming soon" placeholders until the IdP integrations land. Free product: no
// plan picker, no card, no upsell (FR-1).

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import { Sparkles, Play, Presentation, Image as ImageIcon } from "lucide-react";
import { ApiError } from "@hc/sdk";
import { oc, authStartUrl } from "@/lib/sdk";
import { useAuth } from "@/store/auth";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Logo } from "@/components/ui/Logo";

// Capability chips that position the breadth of the product on the brand panel.
const CHIPS = ["Templates", "Photos & video", "AI Magic", "Docs", "Whiteboards", "Brand kit", "Print"];

// Centered branded shell for the transient auth states (magic-link redemption,
// two-step verification): the brand gradient + dotted grid + glows behind a
// clean white card, matching the sign-in showcase.
function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="oc-gradient relative grid min-h-screen place-items-center overflow-hidden p-6">
      <div aria-hidden className="oc-dotgrid pointer-events-none absolute inset-0 opacity-50" />
      <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-28 -left-16 h-96 w-96 rounded-full bg-sky-400/20 blur-3xl" />
      <div className="oc-fade-up relative z-10 w-full max-w-sm rounded-2xl bg-white p-8 shadow-2xl ring-1 ring-black/5">
        {children}
      </div>
    </div>
  );
}

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const toast = useToast();
  const login = useAuth((s) => s.login);
  const completeMfa = useAuth((s) => s.completeMfa);
  const signup = useAuth((s) => s.signup);
  const status = useAuth((s) => s.status);
  const bootstrap = useAuth((s) => s.bootstrap);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Login can switch to passwordless magic-link mode (only the email is asked).
  const [magic, setMagic] = useState(false);
  // Second-factor step: set once a password login returns an MFA challenge.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  // Set true once a magic-link redemption has failed, to flip out of the wait
  // screen and show the error on the normal form.
  const [magicFailed, setMagicFailed] = useState(false);
  const redeemedRef = useRef(false);
  // Social sign-in providers (empty unless configured server-side).
  const [providers, setProviders] = useState<{ id: string; label: string }[]>([]);

  const isSignup = mode === "signup";
  // Where to land after a successful sign-in. Honors a `?next=` return path so a
  // visitor sent here from a sign-in-required share link comes back to that link
  // (e.g. /shared?token=...). Only same-origin relative paths are allowed (must
  // start with a single "/", never "//"), to prevent an open-redirect; anything
  // else falls back to the dashboard.
  const afterAuthPath = (() => {
    const next = router.query.next;
    const raw = typeof next === "string" ? next : "";
    return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard";
  })();
  const magicToken =
    mode === "login" && typeof router.query.token === "string" ? router.query.token : "";
  // While a magic-link token is in the URL and we have not yet failed, show a
  // brief wait screen instead of the form (the redemption effect drives it).
  const redeeming = !!magicToken && !magicFailed;

  // A magic-link email points back to /login?token=...: redeem it on mount,
  // establish the session like a normal login, and head to the dashboard. Guard
  // against double-redemption (single-use token) on re-render / Strict Mode.
  useEffect(() => {
    if (!router.isReady || !magicToken || redeemedRef.current) return;
    redeemedRef.current = true;
    void (async () => {
      try {
        await oc.magicLink(magicToken);
        await bootstrap(); // hydrate the session from the new cookies
        await router.replace(afterAuthPath);
      } catch {
        setError("This sign-in link is no longer valid. Request a new one below.");
        setMagicFailed(true);
        // Drop the spent token from the URL so a refresh doesn't retry it.
        void router.replace("/login", undefined, { shallow: true });
      }
    })();
  }, [router, magicToken, bootstrap, afterAuthPath]);

  // Skip the form if there is already a valid session (cookie). Hold off while a
  // magic-link token is present so we don't race the redemption above.
  useEffect(() => {
    if (status === "loading" && !magicToken) void bootstrap();
  }, [status, bootstrap, magicToken]);
  useEffect(() => {
    if (status === "authed") void router.replace(afterAuthPath);
  }, [status, router, afterAuthPath]);

  // Which social providers are enabled (server-config-gated); buttons show only
  // when at least one is configured.
  useEffect(() => {
    let cancelled = false;
    void oc.authProviders().then((p) => { if (!cancelled) setProviders(p); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // A failed social sign-in bounces back as ?error=sso; surface it (derived, so a
  // later inline error from the form takes precedence).
  const ssoError = router.query.error === "sso" ? "Couldn't complete social sign-in. Please try again." : null;

  async function sendMagicLink() {
    if (!email) {
      setError("Enter your email first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await oc.requestMagicLink(email);
      // Non-enumerating: the API responds the same whether or not the account
      // exists, so the message is deliberately generic.
      toast.success("If that email has an account, a sign-in link is on its way.");
    } catch {
      toast.error("Couldn't send the link. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function forgotPassword() {
    if (!email) {
      setError("Enter your email, then tap “Forgot password?” again.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await oc.requestPasswordReset(email);
      toast.success("If that email has an account, a reset link is on its way.");
    } catch {
      toast.error("Couldn't send the email. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (magic) {
      await sendMagicLink();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (isSignup) {
        await signup(email, password, name || undefined);
      } else {
        const challenge = await login(email, password);
        if (challenge) {
          // Password was correct but the account needs a second factor: switch
          // to the code prompt rather than navigating.
          setMfaToken(challenge.mfaToken);
          setBusy(false);
          return;
        }
      }
      await router.push(afterAuthPath);
    } catch (err) {
      let msg = "Something went wrong. Please try again.";
      if (err instanceof ApiError) {
        if (err.status === 401) msg = "Invalid email or password.";
        else if (err.status === 409) msg = "An account with this email already exists.";
        else {
          const body = err.body as { message?: string } | undefined;
          msg = body?.message ?? `Request failed (${err.status}).`;
        }
      } else {
        // Not an HTTP error -> the request never reached the API (server down,
        // wrong URL, or a CORS block).
        msg = "Couldn't reach the server. Make sure the backend is running.";
      }
      setError(msg);
      setBusy(false);
    }
  }

  async function onSubmitMfa(e: FormEvent) {
    e.preventDefault();
    if (!mfaToken) return;
    setBusy(true);
    setError(null);
    try {
      await completeMfa(mfaToken, mfaCode);
      await router.push(afterAuthPath);
    } catch (err) {
      const msg =
        err instanceof ApiError && (err.status === 401 || err.status === 400)
          ? useRecovery
            ? "That recovery code isn't valid. Try another."
            : "That code isn't valid. Check your authenticator app and try again."
          : "Couldn't verify the code. Please try again.";
      setError(msg);
      setBusy(false);
    }
  }

  // Redeeming a magic-link token from the email: a brief full-screen wait while
  // the session is established, before any form is shown.
  if (redeeming) {
    return (
      <AuthShell>
        <div className="flex flex-col items-center text-center">
          <Logo size={32} />
          <div className="mt-6 h-7 w-7 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
          <p className="mt-4 text-sm text-neutral-500">Signing you in…</p>
        </div>
      </AuthShell>
    );
  }

  // Second-factor step: a focused code prompt shown after a correct password.
  if (mfaToken) {
    return (
      <AuthShell>
        <div className="mb-6">
          <Logo size={32} />
        </div>
        <h2 className="text-[1.7rem] font-bold tracking-tight text-neutral-900">Two-step verification</h2>
          <p className="mt-1.5 text-sm text-neutral-500">
            {useRecovery
              ? "Enter one of your saved recovery codes to sign in."
              : "Enter the 6-digit code from your authenticator app."}
          </p>
          <form onSubmit={onSubmitMfa} className="mt-7 flex flex-col gap-4">
            <Input
              label={useRecovery ? "Recovery code" : "Authentication code"}
              required
              autoFocus
              inputMode={useRecovery ? "text" : "numeric"}
              placeholder={useRecovery ? "xxxx-xxxx-xxxx" : "123456"}
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
              autoComplete="one-time-code"
            />
            {error && (
              <div role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
                {error}
              </div>
            )}
            <Button type="submit" size="lg" block disabled={busy || !mfaCode}>
              {busy ? "Verifying…" : "Verify and sign in"}
            </Button>
          </form>
          <button
            type="button"
            onClick={() => {
              setUseRecovery((v) => !v);
              setMfaCode("");
              setError(null);
            }}
            className="mt-3 w-full text-center text-sm font-medium text-brand-700 hover:underline"
          >
            {useRecovery ? "Use your authenticator app instead" : "Use a recovery code"}
          </button>
      </AuthShell>
    );
  }

  return (
    <div className="flex min-h-screen bg-white">
      {/* Brand showcase panel */}
      <div className="oc-gradient relative hidden w-1/2 flex-col justify-between overflow-hidden p-14 text-white lg:flex">
        {/* Atmosphere: dotted grid + soft color glows. */}
        <div aria-hidden className="oc-dotgrid pointer-events-none absolute inset-0 opacity-60" />
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-28 -left-16 h-96 w-96 rounded-full bg-sky-400/20 blur-3xl" />

        <Logo variant="light" size={36} className="relative z-10 text-xl" />

        {/* Floating collage: a glimpse of what you can make. */}
        <div aria-hidden className="relative z-10 mx-auto my-2 h-60 w-full max-w-md">
          {/* Presentation slide */}
          <div className="absolute left-1 top-3 w-48 rotate-[-7deg]">
            <div className="oc-float rounded-2xl bg-white p-3 text-neutral-800 shadow-2xl ring-1 ring-black/5">
              <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold text-brand-600"><Presentation size={12} /> Presentation</div>
              <div className="h-1.5 w-2/3 rounded bg-neutral-800" />
              <div className="mt-1.5 h-1.5 w-1/2 rounded bg-neutral-300" />
              <div className="mt-3 flex gap-1.5">
                <div className="h-10 flex-1 rounded bg-brand-100" />
                <div className="h-10 flex-1 rounded bg-sky-100" />
                <div className="h-10 flex-1 rounded bg-amber-100" />
              </div>
            </div>
          </div>
          {/* Social / photo post */}
          <div className="absolute right-2 top-0 w-40 rotate-[6deg]">
            <div className="oc-float overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5" style={{ animationDelay: "1.2s" }}>
              <div className="grid h-24 place-items-center bg-gradient-to-br from-pink-400 via-fuchsia-500 to-brand-500 text-white"><ImageIcon size={22} /></div>
              <div className="p-2.5"><div className="h-1.5 w-3/4 rounded bg-neutral-800" /><div className="mt-1.5 h-1.5 w-1/2 rounded bg-neutral-300" /></div>
            </div>
          </div>
          {/* Video */}
          <div className="absolute bottom-0 left-24 w-44 rotate-[3deg]">
            <div className="oc-float overflow-hidden rounded-2xl bg-neutral-900 text-white shadow-2xl ring-1 ring-white/10" style={{ animationDelay: "0.6s" }}>
              <div className="grid h-20 place-items-center bg-gradient-to-br from-indigo-500 to-sky-500">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-white/90 text-neutral-900"><Play size={14} className="ml-0.5" fill="currentColor" /></span>
              </div>
              <div className="flex items-center gap-1.5 p-2"><div className="h-1 flex-1 rounded bg-white/30" /><span className="text-[9px] text-white/60">0:12</span></div>
            </div>
          </div>
        </div>

        <div className="relative z-10">
          <span className="oc-fade-up inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold tracking-wide ring-1 ring-white/20" style={{ animationDelay: "0.05s" }}>
            <Sparkles size={13} /> 100% free · open source · no watermarks
          </span>
          <h1 className="oc-fade-up mt-5 max-w-md text-[2.7rem] font-extrabold leading-[1.05]" style={{ animationDelay: "0.12s" }}>
            Everything you need to design anything.
          </h1>
          <p className="oc-fade-up mt-3 max-w-sm text-white/80" style={{ animationDelay: "0.18s" }}>
            Templates, photos, video, docs, whiteboards, and AI - one free, open design platform. No tiers, no limits.
          </p>
          <div className="oc-fade-up mt-6 flex max-w-md flex-wrap gap-2" style={{ animationDelay: "0.24s" }}>
            {CHIPS.map((c) => (
              <span key={c} className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white/90 ring-1 ring-white/15">{c}</span>
            ))}
          </div>
        </div>

        <p className="relative z-10 text-sm text-white/60">Your designs, your data - open format, full export, forever.</p>
      </div>

      {/* Form pane */}
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-10 lg:hidden">
            <Logo size={32} />
          </div>

          <h2 className="text-[1.7rem] font-bold tracking-tight text-neutral-900">
            {isSignup ? "Create your free account" : "Welcome back"}
          </h2>
          <p className="mt-1.5 text-sm text-neutral-500">
            {isSignup ? "Start designing in seconds - no card required." : "Sign in to pick up where you left off."}
          </p>

          {providers.length > 0 && (
            <div className="mt-7 flex flex-col gap-2">
              {providers.map((p) => (
                <a
                  key={p.id}
                  href={authStartUrl(p.id)}
                  className="flex items-center justify-center gap-2 rounded-xl border border-neutral-300 bg-white px-4 py-2.5 text-sm font-semibold text-neutral-700 transition hover:border-neutral-400 hover:bg-neutral-50"
                >
                  Continue with {p.label}
                </a>
              ))}
              <div className="my-1 flex items-center gap-3 text-xs text-neutral-400">
                <span className="h-px flex-1 bg-neutral-200" /> or <span className="h-px flex-1 bg-neutral-200" />
              </div>
            </div>
          )}

          <form onSubmit={onSubmit} className={`flex flex-col gap-4 ${providers.length > 0 ? "" : "mt-7"}`}>
            {isSignup && (
              <Input label="Name" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus />
            )}
            <Input
              label="Email"
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              autoFocus={!isSignup}
            />
            {!magic && (
              <div className="flex flex-col gap-1.5">
                <Input
                  label="Password"
                  type="password"
                  required
                  minLength={8}
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={isSignup ? "new-password" : "current-password"}
                />
                {!isSignup && (
                  <button
                    type="button"
                    onClick={() => void forgotPassword()}
                    disabled={busy}
                    className="self-end text-xs font-medium text-brand-700 hover:underline disabled:opacity-50"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
            )}
            {(error ?? ssoError) && (
              <div role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
                {error ?? ssoError}
              </div>
            )}
            <Button type="submit" size="lg" block disabled={busy}>
              {busy
                ? "Please wait…"
                : magic
                  ? "Email me a sign-in link"
                  : isSignup
                    ? "Create account"
                    : "Sign in"}
            </Button>
          </form>

          {!isSignup && (
            <button
              type="button"
              onClick={() => {
                setMagic((m) => !m);
                setError(null);
              }}
              className="mt-3 w-full text-center text-sm font-medium text-brand-700 hover:underline"
            >
              {magic ? "Use a password instead" : "Sign in with a magic link"}
            </button>
          )}

          <p className="mt-6 text-center text-sm text-neutral-500">
            {isSignup ? (
              <>
                Already have an account?{" "}
                <Link href="/login" className="font-semibold text-brand-700 hover:underline">
                  Sign in
                </Link>
              </>
            ) : (
              <>
                New to HyCanvas?{" "}
                <Link href="/signup" className="font-semibold text-brand-700 hover:underline">
                  Create a free account
                </Link>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
