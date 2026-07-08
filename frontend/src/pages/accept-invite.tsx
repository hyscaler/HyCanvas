// Invitations surface (/accept-invite). Two modes:
//   - With ?token=... (the email link): one-click accept of that specific invite
//     (clicking the emailed link is consent), then redirect into the workspace.
//   - Without a token (reached from the dashboard bell notification, or direct
//     nav): list the signed-in user's pending invitations with Accept / Decline.
// The caller must be signed in with the invited email; the backend enforces the
// email match and single-use semantics. The chrome is the shared canvas-floor
// stage (CanvasFloor) since this is a first-impression, shareable moment.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import { CheckCircle2, AlertCircle, Loader2, LogIn, Clock, Sparkles, MailOpen, ArrowRight } from "lucide-react";
import type { WorkspaceInvitation, WorkspaceRole } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { useAuth } from "@/store/auth";
import { useToast } from "@/components/ui/Toast";
import { Logo } from "@/components/ui/Logo";
import { Button } from "@/components/ui/Button";
import { CanvasFloor } from "@/components/ui/CanvasFloor";

const ROLE_LABEL: Record<WorkspaceRole, string> = { viewer: "Viewer", member: "Member", admin: "Admin", owner: "Owner" };
const ROLE_BADGE: Record<WorkspaceRole, string> = {
  owner: "bg-amber-50 text-amber-700 ring-amber-200",
  admin: "bg-brand-50 text-brand-ink ring-brand-200",
  member: "bg-neutral-100 text-neutral-700 ring-neutral-200",
  viewer: "bg-slate-100 text-slate-600 ring-slate-200",
};

// The canvas floor behind a glassy card: the paper artboard on the ink
// workspace, same stage as the marketing site and the sign-in showcase.
function Scene({ children }: { children: ReactNode }) {
  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-4 py-10">
      <CanvasFloor />
      <div className="relative z-10 w-full max-w-md">{children}</div>
    </main>
  );
}

// Glassy card with a gradient top accent + centered logo.
function Card({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-3xl bg-surface shadow-2xl shadow-brand-900/10 ring-1 ring-black/5">
      <div className="oc-gradient h-1.5 w-full" />
      <div className="px-7 py-8">
        <div className="mb-6 flex justify-center">
          <Logo size={34} />
        </div>
        {children}
      </div>
    </div>
  );
}

function HeroIcon({ children, tone = "brand" }: { children: ReactNode; tone?: "brand" | "green" | "red" }) {
  const cls =
    tone === "green"
      ? "bg-emerald-50 text-emerald-600 ring-emerald-100"
      : tone === "red"
        ? "bg-red-50 text-red-600 ring-red-100"
        : "bg-brand-50 text-brand-ink ring-brand-100";
  return <div className={`mx-auto grid h-12 w-12 place-items-center rounded-2xl ring-1 ring-inset ${cls}`}>{children}</div>;
}

function RoleChip({ role }: { role: WorkspaceRole }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${ROLE_BADGE[role]}`}>
      {ROLE_LABEL[role]}
    </span>
  );
}

export default function AcceptInvitePage() {
  const router = useRouter();
  const toast = useToast();
  const status = useAuth((s) => s.status);
  const bootstrap = useAuth((s) => s.bootstrap);
  const refreshWorkspaces = useAuth((s) => s.refreshWorkspaces);
  const setActiveWorkspace = useAuth((s) => s.setActiveWorkspace);

  const token = typeof router.query.token === "string" ? router.query.token : "";

  type TokenResult = "idle" | "ok" | "error";
  const [tokenResult, setTokenResult] = useState<TokenResult>("idle");
  const tokenRan = useRef(false);

  const [invites, setInvites] = useState<WorkspaceInvitation[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Public page: trigger the session bootstrap ourselves (no RequireAuth wrapper).
  useEffect(() => {
    if (status === "loading") void bootstrap();
  }, [status, bootstrap]);

  // Token path: accept exactly once when signed in.
  useEffect(() => {
    if (!token || status !== "authed" || tokenRan.current) return;
    tokenRan.current = true;
    oc
      .acceptInvitation(token)
      .then(async (m) => {
        await refreshWorkspaces();
        if (m?.workspaceId) setActiveWorkspace(m.workspaceId);
        setTokenResult("ok");
        setTimeout(() => void router.replace("/dashboard"), 1400);
      })
      .catch(() => setTokenResult("error"));
  }, [token, status, router, refreshWorkspaces, setActiveWorkspace]);

  // List path: load the user's pending invitations when signed in and no token.
  useEffect(() => {
    if (token || status !== "authed") return;
    let cancelled = false;
    void (async () => {
      const list = await oc.myInvitations().catch(() => [] as WorkspaceInvitation[]);
      if (!cancelled) setInvites(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [token, status]);

  const respond = useCallback(
    async (inv: WorkspaceInvitation, accept: boolean) => {
      setBusyId(inv.id);
      try {
        const m = await oc.respondToInvitation(inv.id, accept);
        setInvites((prev) => (prev ?? []).filter((x) => x.id !== inv.id));
        if (accept) {
          await refreshWorkspaces();
          const wsId = (m as { workspaceId?: string } | undefined)?.workspaceId ?? inv.workspaceId;
          setActiveWorkspace(wsId);
          toast.success(`You joined ${inv.workspaceName || "the workspace"}.`);
          void router.push("/dashboard");
        } else {
          toast.success("Invitation declined.");
        }
      } catch {
        toast.error(accept ? "Could not accept the invitation." : "Could not decline the invitation.");
      } finally {
        setBusyId(null);
      }
    },
    [refreshWorkspaces, setActiveWorkspace, toast, router],
  );

  // --- render ---------------------------------------------------------------

  if (status === "loading") {
    return (
      <Scene>
        <Card>
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <Loader2 className="animate-spin text-brand-500" size={28} />
            <p className="text-sm text-neutral-500">Just a moment…</p>
          </div>
        </Card>
      </Scene>
    );
  }

  if (status === "anon") {
    return (
      <Scene>
        <Card>
          <div className="flex flex-col items-center gap-4 text-center">
            <HeroIcon>
              <LogIn size={26} />
            </HeroIcon>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-neutral-900">Sign in to continue</h1>
              <p className="mx-auto mt-2 max-w-xs text-sm text-neutral-500">
                Use the email your invitation was sent to, then come right back to join.
              </p>
            </div>
            <Link href={`/login?next=${encodeURIComponent(router.asPath)}`}>
              <Button size="lg">
                <LogIn size={18} /> Sign in
              </Button>
            </Link>
          </div>
        </Card>
      </Scene>
    );
  }

  // Token (email-link) one-click flow.
  if (token) {
    return (
      <Scene>
        <Card>
          {tokenResult === "ok" ? (
            <div className="flex flex-col items-center gap-4 py-2 text-center">
              <HeroIcon tone="green">
                <CheckCircle2 size={24} />
              </HeroIcon>
              <div>
                <h1 className="text-xl font-bold tracking-tight text-neutral-900">You&apos;re in</h1>
                <p className="mt-2 text-sm text-neutral-500">Taking you to the workspace…</p>
              </div>
              <Loader2 className="animate-spin text-neutral-300" size={18} />
            </div>
          ) : tokenResult === "error" ? (
            <div className="flex flex-col items-center gap-4 text-center">
              <HeroIcon tone="red">
                <AlertCircle size={26} />
              </HeroIcon>
              <div>
                <h1 className="text-xl font-bold tracking-tight text-neutral-900">This invitation can&apos;t be used</h1>
                <p className="mx-auto mt-2 max-w-xs text-sm text-neutral-500">
                  It may have expired, already been used, or been sent to a different email address.
                </p>
              </div>
              <Link href="/accept-invite">
                <Button variant="secondary">See your invitations</Button>
              </Link>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <HeroIcon>
                <Sparkles size={26} />
              </HeroIcon>
              <p className="mt-1 text-sm font-medium text-neutral-600">Accepting your invitation…</p>
              <Loader2 className="animate-spin text-neutral-300" size={20} />
            </div>
          )}
        </Card>
      </Scene>
    );
  }

  // In-app list flow.
  return (
    <Scene>
      <Card>
        {invites === null ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <Loader2 className="animate-spin text-brand-500" size={28} />
            <p className="text-sm text-neutral-500">Loading your invitations…</p>
          </div>
        ) : invites.length === 0 ? (
          <div className="flex flex-col items-center gap-4 py-2 text-center">
            <HeroIcon>
              <MailOpen size={26} />
            </HeroIcon>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-neutral-900">You&apos;re all caught up</h1>
              <p className="mt-2 text-sm text-neutral-500">No pending invitations right now.</p>
            </div>
            <Link href="/dashboard">
              <Button variant="secondary">
                Go to dashboard <ArrowRight size={16} />
              </Button>
            </Link>
          </div>
        ) : (
          <>
            <div className="mb-6 text-center">
              <h1 className="text-xl font-bold tracking-tight text-neutral-900">You&apos;ve been invited</h1>
              <p className="mt-1.5 text-sm text-neutral-500">
                Review your {invites.length === 1 ? "invitation" : "invitations"} below.
              </p>
            </div>
            <ul className="divide-y divide-neutral-100">
              {invites.map((inv) => (
                <li key={inv.id} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex items-center gap-3">
                    <span className="oc-gradient grid h-11 w-11 shrink-0 place-items-center rounded-xl text-base font-bold text-white">
                      {(inv.workspaceName || "?").charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="truncate text-sm font-semibold text-neutral-900">{inv.workspaceName || "A workspace"}</p>
                        <span className="shrink-0">
                          <RoleChip role={inv.role} />
                        </span>
                      </div>
                      <p className="mt-1 inline-flex items-center gap-1 text-xs text-neutral-500">
                        <Clock size={11} /> expires {new Date(inv.expiresAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Button variant="ghost" block disabled={busyId === inv.id} onClick={() => void respond(inv, false)}>
                      Decline
                    </Button>
                    <Button block disabled={busyId === inv.id} onClick={() => void respond(inv, true)}>
                      {busyId === inv.id ? <Loader2 size={16} className="animate-spin" /> : null} Accept
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-6 border-t border-neutral-100 pt-4 text-center text-xs text-neutral-400">
              You can leave a workspace anytime from its Members panel.
            </p>
          </>
        )}
      </Card>
    </Scene>
  );
}
