// Share-link landing. Reads ?token from the link, resolves
// access (prompting for a password when the link requires one), and then:
//  - edit link, signed-in user: opens the design in the editor (their recorded
//    grant keeps access). A signed-in user on any link is routed to the editor;
//    the editor surfaces the resolved view/comment banner and disables editing.
//  - view/comment link, anonymous visitor: opens a read-only render of the
//    latest snapshot, no account required.
// Expired/disabled/wrong-password links show a clear, friendly denial.
//
// Client-rendered: the token only exists in the URL on the visitor's device,
// which is also compatible with static export (a query param, not a dynamic
// route segment).

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Lock, AlertCircle, Loader2, LogIn } from "lucide-react";
import type { DesignFile } from "@hc/sdk";
import { ApiError } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { useAuth } from "@/store/auth";
import { CanvasFloor } from "@/components/ui/CanvasFloor";
import { Logo } from "@/components/ui/Logo";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { tr } from "@/lib/i18n";

const SharedViewer = dynamic(
  () => import("@/components/SharedViewer").then((m) => m.SharedViewer),
  { ssr: false, loading: () => <div className="p-6 text-neutral-500">{tr("page.loading")}</div> },
);

type State =
  | { kind: "resolving" }
  | { kind: "password"; error?: string }
  | { kind: "signin" }
  | { kind: "viewing"; file: DesignFile; mode: string }
  | { kind: "denied"; reason: string };

/** The stable error code the backend sets on a share-link 403 (problem+json
 *  extension member), so the two 403 reasons are distinguishable without parsing
 *  the human-readable message. */
function problemCode(body: unknown): string | undefined {
  if (body && typeof body === "object" && "code" in body) {
    const c = (body as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}

/** Phone remote control (F28 C21): pairing-code entry + big controls. Every
 *  press posts to the audience relay; only the presenter holding the matching
 *  code reacts. Fully anonymous-capable, same trust boundary as reactions. */
function RemoteControlScreen({ token, password, title }: { token: string; password?: string; title: string }) {
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const send = async (action: "next" | "prev" | "blank") => {
    if (code.trim().length < 4 || sending) return;
    setSending(true);
    try {
      await oc.audienceRemote(token, { code: code.trim().toUpperCase(), action, password });
    } catch {
      /* over-budget or offline: the next press retries */
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-900 p-6 text-white">
      <div className="text-sm text-white/60">{title}</div>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        placeholder={tr("page.pairing_code")}
        aria-label={tr("page.pairing_code")}
        maxLength={8}
        className="w-48 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-center text-2xl font-bold tracking-widest text-white outline-none placeholder:text-white/30"
      />
      <div className="grid w-full max-w-sm grid-cols-2 gap-3">
        <button onClick={() => void send("prev")} disabled={code.trim().length < 4} className="rounded-2xl bg-white/10 py-10 text-lg font-semibold active:bg-white/20 disabled:opacity-30">{tr("page.previous")}</button>
        <button onClick={() => void send("next")} disabled={code.trim().length < 4} className="rounded-2xl bg-brand-600 py-10 text-lg font-semibold active:bg-brand-700 disabled:opacity-30">{tr("page.next")}</button>
      </div>
      <button onClick={() => void send("blank")} disabled={code.trim().length < 4} className="w-full max-w-sm rounded-2xl bg-white/10 py-4 text-sm font-semibold active:bg-white/20 disabled:opacity-30">{tr("page.blank_screen")}</button>
      <div className="text-center text-xs text-white/40">{tr("page.enter_the_code_shown_on_the_presenters_screen")}</div>
    </div>
  );
}

/** The link token, path-style (/shared/<token>, the canonical form the Go
 *  server rewrites) or legacy query (?token=). */
function tokenFromLocation(query: unknown): string {
  if (typeof query === "string" && query) return query;
  if (typeof window === "undefined") return "";
  const m = /^\/shared\/([^/?#]+)\/?$/.exec(window.location.pathname);
  return m ? decodeURIComponent(m[1]) : "";
}

export default function SharedLinkPage() {
  const router = useRouter();
  const authStatus = useAuth((s) => s.status);
  const bootstrap = useAuth((s) => s.bootstrap);
  const [state, setState] = useState<State>({ kind: "resolving" });
  const [password, setPassword] = useState("");
  const ran = useRef(false);

  // Resolve the session ourselves: nothing else on this public page triggers
  // the auth bootstrap, and the open() effect below waits for it, so without
  // this an anonymous visitor would sit on the spinner forever.
  useEffect(() => {
    if (authStatus === "loading") void bootstrap();
  }, [authStatus, bootstrap]);

  const open = useCallback(
    async (token: string, pwd?: string) => {
      try {
        if (!token) {
          setState({ kind: "denied", reason: tr("page.this_link_is_missing_its_token") });
          return;
        }
        // First resolve access. A signed-in visitor is routed to the editor so
        // they get the live (collaborative) surface; an anonymous visitor gets a
        // read-only render of the snapshot.
        if (authStatus === "authed") {
          const resolved = await oc.resolveShareLink(token, pwd);
          await router.replace(`/editor?id=${encodeURIComponent(resolved.designId)}`);
          return;
        }
        const { file, mode } = await oc.resolveShareLinkFile(token, pwd);
        setState({ kind: "viewing", file, mode });
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.status === 403) {
            // Two distinct 403 reasons, told apart by the problem+json `code`:
            //  - link_signin_required: an anonymous visitor on a sign-in-only
            //    link -> show a "Sign in to continue" CTA back to this link.
            //  - link_password_required: wrong/needed password -> password form.
            // Any other 403 is a real denial, not a missing password, so we must
            // not strand the visitor on a password form they can't satisfy.
            const code = problemCode(e.body);
            if (code === "link_signin_required") {
              setState({ kind: "signin" });
              return;
            }
            if (code === "link_password_required") {
              setState({ kind: "password", error: pwd ? tr("page.incorrect_password") : undefined });
              return;
            }
            setState({ kind: "denied", reason: tr("page.you_do_not_have_access_to_this_link") });
            return;
          }
          if (e.status === 410) {
            setState({ kind: "denied", reason: tr("page.this_link_has_expired") });
            return;
          }
          if (e.status === 404) {
            setState({ kind: "denied", reason: tr("page.this_link_is_no_longer_available") });
            return;
          }
        }
        setState({ kind: "denied", reason: tr("page.this_link_could_not_be_opened") });
      }
    },
    [authStatus, router],
  );

  useEffect(() => {
    // Wait for both the route and the auth bootstrap before resolving, so a
    // signed-in visitor is routed to the editor rather than the anonymous path.
    if (!router.isReady || authStatus === "loading" || ran.current) return;
    ran.current = true;
    const token = tokenFromLocation(router.query.token);
    // Canonicalize a legacy ?token= URL to the path form (cosmetic; outside the
    // Next router, which has no /shared/[token] route in the static export).
    if (token && typeof window !== "undefined" && typeof router.query.token === "string") {
      window.history.replaceState(window.history.state, "", `/shared/${encodeURIComponent(token)}/`);
    }
    void open(token);
  }, [router.isReady, router.query.token, authStatus, open]);

  function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    const token = tokenFromLocation(router.query.token);
    setState({ kind: "resolving" });
    void open(token, password);
  }

  if (state.kind === "viewing") {
    const designTitle = state.file.title?.trim() || tr("page.shared_design");
    // Phone remote (F28 C21): ?remote=1 turns this share link into a remote
    // control - big prev/next/blank buttons posting through the rate-limited
    // audience relay; the PRESENTER verifies the pairing code, so a wrong
    // code does nothing.
    const remoteMode = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("remote") === "1";
    if (remoteMode) {
      const token = tokenFromLocation(router.query.token);
      return (
        <>
          <Head>
            <title>{designTitle} · HyCanvas</title>
          </Head>
          <RemoteControlScreen token={token} password={password || undefined} title={designTitle} />
        </>
      );
    }
    // An anonymous visitor only ever gets a read-only render here, even on a
    // comment/edit link (commenting/editing need an account). Show "View only"
    // honestly and offer a sign-in CTA that unlocks what the link grants.
    const unlock = state.mode === "edit" ? "edit" : state.mode === "comment" ? "comment" : null;
    const token = tokenFromLocation(router.query.token);
    return (
      <>
        <Head>
          <title>{designTitle} · HyCanvas</title>
        </Head>
        {/* A column flex screen so the deck player can fill the space under the
            header (a scroll-stack render for a single page still scrolls). */}
        <div className="flex min-h-screen flex-col bg-neutral-100">
          <header className="flex shrink-0 items-center gap-3 border-b border-neutral-200 bg-surface px-4 py-2.5">
            <Logo size={26} />
            <span className="min-w-0 truncate text-sm font-semibold text-neutral-800">{designTitle}</span>
            <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-ink">{tr("page.view_only")}</span>
            <div className="ms-auto flex items-center gap-3">
              {unlock && (
                <Link
                  href={`/login?next=${encodeURIComponent(`/shared/${encodeURIComponent(token)}/`)}`}
                  className="text-sm font-semibold text-brand-ink hover:underline"
                >
                  Sign in to {unlock}
                </Link>
              )}
              <Link href="/" className="text-sm font-semibold text-neutral-500 hover:text-neutral-800 hover:underline">
                {tr("page.hycanvas_2")}
              </Link>
            </div>
          </header>
          <SharedViewer
            doc={state.file}
            token={token || undefined}
            password={password || undefined}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <Head>
        <title>{tr("page.shared_design_hycanvas")}</title>
      </Head>
      <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-6">
        <CanvasFloor />
        <div className="relative z-10 w-full max-w-sm rounded-2xl bg-surface p-8 text-center shadow-2xl ring-1 ring-black/5">
          <Logo size={32} className="mx-auto mb-6" />
          {state.kind === "resolving" && (
            <>
              <Loader2 size={36} className="mx-auto animate-spin text-brand-500" />
              <p className="mt-4 text-sm text-neutral-500">{tr("page.opening_shared_design")}</p>
            </>
          )}
          {state.kind === "password" && (
            <form onSubmit={submitPassword} className="text-start">
              <Lock size={28} className="mx-auto mb-3 text-brand-500" />
              <h1 className="mb-1 text-center text-lg font-bold text-neutral-900">{tr("page.password_required")}</h1>
              <p className="mb-4 text-center text-sm text-neutral-500">{tr("page.this_link_is_password_protected")}</p>
              <Input
                type="password"
                autoFocus
                placeholder={tr("page.password")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={state.error}
              />
              <Button block size="lg" type="submit" className="mt-4" disabled={!password}>
                {tr("page.open_design")}
              </Button>
            </form>
          )}
          {state.kind === "signin" && (
            <>
              <LogIn size={28} className="mx-auto mb-3 text-brand-500" />
              <h1 className="mb-1 text-lg font-bold text-neutral-900">{tr("page.sign_in_to_continue")}</h1>
              <p className="mb-5 text-sm text-neutral-500">
                {tr("page.the_owner_requires_you_to_sign_in_to_open_th")}
              </p>
              <Link
                href={`/login?next=${encodeURIComponent(`/shared/${encodeURIComponent(tokenFromLocation(router.query.token))}/`)}`}
                className="block"
              >
                <Button block size="lg">
                  {tr("page.sign_in")}
                </Button>
              </Link>
            </>
          )}
          {state.kind === "denied" && (
            <>
              <AlertCircle size={40} className="mx-auto text-red-500" />
              <h1 className="mt-4 text-lg font-bold text-neutral-900">{tr("page.cant_open_this_link")}</h1>
              <p className="mt-1.5 text-sm text-neutral-500">{state.reason}</p>
              <Link
                href={authStatus === "authed" ? "/dashboard" : "/"}
                className="mt-6 inline-block text-sm font-semibold text-brand-ink hover:underline"
              >
                {authStatus === "authed" ? tr("page.go_to_your_dashboard") : tr("page.go_to_hycanvas")}
              </Link>
            </>
          )}
        </div>
      </main>
    </>
  );
}
