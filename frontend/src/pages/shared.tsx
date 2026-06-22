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

export default function SharedLinkPage() {
  const router = useRouter();
  const authStatus = useAuth((s) => s.status);
  const [state, setState] = useState<State>({ kind: "resolving" });
  const [password, setPassword] = useState("");
  const ran = useRef(false);

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
            //  - link_password_required (or unspecified): wrong/needed password
            //    -> show the password form.
            if (problemCode(e.body) === "link_signin_required") {
              setState({ kind: "signin" });
              return;
            }
            setState({ kind: "password", error: pwd ? "Incorrect password." : undefined });
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
    const token = typeof router.query.token === "string" ? router.query.token : "";
    void open(token);
  }, [router.isReady, router.query.token, authStatus, open]);

  function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    const token = typeof router.query.token === "string" ? router.query.token : "";
    setState({ kind: "resolving" });
    void open(token, password);
  }

  if (state.kind === "viewing") {
    return (
      <>
        <Head>
          <title>Shared design · HyCanvas</title>
        </Head>
        <div className="min-h-screen bg-neutral-100">
          <header className="flex items-center gap-3 border-b border-neutral-200 bg-white px-4 py-2.5">
            <Logo size={26} />
            <span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-700">
              {state.mode === "comment" ? "Comment access" : "View only"}
            </span>
            <Link href="/" className="ml-auto text-sm font-semibold text-brand-700 hover:underline">
              HyCanvas
            </Link>
          </header>
          <SharedViewer
            doc={state.file}
            token={typeof router.query.token === "string" ? router.query.token : undefined}
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
      <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-6">
        <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-8 text-center shadow-sm">
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
                href={`/login?next=${encodeURIComponent(
                  router.asPath || `/shared?token=${typeof router.query.token === "string" ? router.query.token : ""}`,
                )}`}
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
              <Link href="/" className="mt-6 inline-block text-sm font-semibold text-brand-700 hover:underline">
                Go to HyCanvas
              </Link>
            </>
          )}
        </div>
      </main>
    </>
  );
}
