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

const SharedViewer = dynamic(
  () => import("@/components/SharedViewer").then((m) => m.SharedViewer),
  { ssr: false, loading: () => <div className="p-6 text-neutral-500">Loading…</div> },
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
          setState({ kind: "denied", reason: "This link is missing its token." });
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
              setState({ kind: "password", error: pwd ? "Incorrect password." : undefined });
              return;
            }
            setState({ kind: "denied", reason: "You do not have access to this link." });
            return;
          }
          if (e.status === 410) {
            setState({ kind: "denied", reason: "This link has expired." });
            return;
          }
          if (e.status === 404) {
            setState({ kind: "denied", reason: "This link is no longer available." });
            return;
          }
        }
        setState({ kind: "denied", reason: "This link could not be opened." });
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
    const designTitle = state.file.title?.trim() || "Shared design";
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
            <span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-700">View only</span>
            <div className="ml-auto flex items-center gap-3">
              {unlock && (
                <Link
                  href={`/login?next=${encodeURIComponent(`/shared/${encodeURIComponent(token)}/`)}`}
                  className="text-sm font-semibold text-brand-ink hover:underline"
                >
                  Sign in to {unlock}
                </Link>
              )}
              <Link href="/" className="text-sm font-semibold text-neutral-500 hover:text-neutral-800 hover:underline">
                HyCanvas
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
        <title>Shared design · HyCanvas</title>
      </Head>
      <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-6">
        <CanvasFloor />
        <div className="relative z-10 w-full max-w-sm rounded-2xl bg-surface p-8 text-center shadow-2xl ring-1 ring-black/5">
          <Logo size={32} className="mx-auto mb-6" />
          {state.kind === "resolving" && (
            <>
              <Loader2 size={36} className="mx-auto animate-spin text-brand-500" />
              <p className="mt-4 text-sm text-neutral-500">Opening shared design…</p>
            </>
          )}
          {state.kind === "password" && (
            <form onSubmit={submitPassword} className="text-left">
              <Lock size={28} className="mx-auto mb-3 text-brand-500" />
              <h1 className="mb-1 text-center text-lg font-bold text-neutral-900">Password required</h1>
              <p className="mb-4 text-center text-sm text-neutral-500">This link is password protected.</p>
              <Input
                type="password"
                autoFocus
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={state.error}
              />
              <Button block size="lg" type="submit" className="mt-4" disabled={!password}>
                Open design
              </Button>
            </form>
          )}
          {state.kind === "signin" && (
            <>
              <LogIn size={28} className="mx-auto mb-3 text-brand-500" />
              <h1 className="mb-1 text-lg font-bold text-neutral-900">Sign in to continue</h1>
              <p className="mb-5 text-sm text-neutral-500">
                The owner requires you to sign in to open this shared design.
              </p>
              <Link
                href={`/login?next=${encodeURIComponent(`/shared/${encodeURIComponent(tokenFromLocation(router.query.token))}/`)}`}
                className="block"
              >
                <Button block size="lg">
                  Sign in
                </Button>
              </Link>
            </>
          )}
          {state.kind === "denied" && (
            <>
              <AlertCircle size={40} className="mx-auto text-red-500" />
              <h1 className="mt-4 text-lg font-bold text-neutral-900">Can&apos;t open this link</h1>
              <p className="mt-1.5 text-sm text-neutral-500">{state.reason}</p>
              <Link
                href={authStatus === "authed" ? "/dashboard" : "/"}
                className="mt-6 inline-block text-sm font-semibold text-brand-ink hover:underline"
              >
                {authStatus === "authed" ? "Go to your dashboard" : "Go to HyCanvas"}
              </Link>
            </>
          )}
        </div>
      </main>
    </>
  );
}
