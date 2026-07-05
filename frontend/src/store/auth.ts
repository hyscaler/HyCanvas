// Auth + active-workspace state for the web app. Hydrated from the
// httpOnly session via GET /me; on a 401 the SDK transparently refreshes once
// (de-duped across concurrent callers) and retries, so a reload with only a
// refresh cookie still resolves. The active workspace is persisted per device
// in localStorage and scopes the dashboard/editor.

import { create } from "zustand";
import { ApiError, type User, type WorkspaceWithRole } from "@hc/sdk";
import { oc } from "@/lib/sdk";

type Status = "loading" | "authed" | "anon";

const ACTIVE_KEY = "oc.activeWorkspaceId";

interface AuthState {
  status: Status;
  user: User | null;
  workspaces: WorkspaceWithRole[];
  activeWorkspaceId: string | null;
  error: string | null;
  bootstrap: () => Promise<void>;
  // Resolves to a challenge token when the account requires a second factor;
  // the caller then prompts for a code and calls completeMfa to finish.
  login: (email: string, password: string) => Promise<{ mfaToken: string } | void>;
  completeMfa: (mfaToken: string, code: string) => Promise<void>;
  signup: (email: string, password: string, name?: string) => Promise<void>;
  logout: () => Promise<void>;
  // Permanently delete the account (FR-17), then drop to the anon state. The
  // server clears the auth cookies; we clear local state and the active id.
  deleteAccount: (input: { password: string; code?: string }) => Promise<void>;
  setActiveWorkspace: (id: string) => void;
  refreshWorkspaces: () => Promise<void>;
  // Replace the cached user after a profile change (no full re-bootstrap).
  setUser: (user: User) => void;
}

function readActive(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACTIVE_KEY);
}

function writeActive(id: string | null) {
  if (typeof window === "undefined") return;
  if (id) window.localStorage.setItem(ACTIVE_KEY, id);
  else window.localStorage.removeItem(ACTIVE_KEY);
}

async function loadSession(): Promise<{ user: User; workspaces: WorkspaceWithRole[] }> {
  const user = await oc.me();
  const workspaces = await oc.listWorkspaces();
  return { user, workspaces };
}

// Shared in-flight bootstrap; module-level because the zustand store is a
// singleton and bootstrap state is not renderable.
let hydrating: Promise<void> | null = null;

function pickActive(workspaces: WorkspaceWithRole[]): string | null {
  const saved = readActive();
  if (saved && workspaces.some((w) => w.id === saved)) return saved;
  // Default to the personal workspace, else the first.
  const personal = workspaces.find((w) => w.kind === "personal");
  return personal?.id ?? workspaces[0]?.id ?? null;
}

export const useAuth = create<AuthState>((set, get) => ({
  status: "loading",
  user: null,
  workspaces: [],
  activeWorkspaceId: null,
  error: null,

  async bootstrap() {
    // Several screens (plus React StrictMode's double-mounted effects) call
    // this concurrently on load; share one in-flight hydration so the session
    // endpoints are hit once.
    if (!hydrating) {
      hydrating = (async () => {
        try {
          const { user, workspaces } = await loadSession();
          set({ status: "authed", user, workspaces, activeWorkspaceId: pickActive(workspaces), error: null });
        } catch {
          // Any 401 already went through the SDK's single de-duped refresh and
          // retry; failing after that means there is no session. A second
          // manual refresh here would just race the rotation with the same
          // cookie again, the multi-tab storm that used to kill sessions.
          set({ status: "anon", user: null, workspaces: [], activeWorkspaceId: null });
        } finally {
          hydrating = null;
        }
      })();
    }
    return hydrating;
  },

  async login(email, password) {
    set({ error: null });
    const res = await oc.login({ email, password });
    // MFA-gated accounts get a challenge instead of a session: hand the token
    // back so the form can prompt for a code, then call completeMfa.
    if ("mfaRequired" in res && res.mfaRequired) return { mfaToken: res.mfaToken };
    const { user, workspaces } = await loadSession();
    set({ status: "authed", user, workspaces, activeWorkspaceId: pickActive(workspaces) });
  },

  async completeMfa(mfaToken, code) {
    set({ error: null });
    await oc.verifyMfa(mfaToken, code);
    const { user, workspaces } = await loadSession();
    set({ status: "authed", user, workspaces, activeWorkspaceId: pickActive(workspaces) });
  },

  async signup(email, password, name) {
    set({ error: null });
    await oc.signup({ email, password, name });
    const { user, workspaces } = await loadSession();
    set({ status: "authed", user, workspaces, activeWorkspaceId: pickActive(workspaces) });
  },

  async logout() {
    try {
      await oc.logout();
    } catch (e) {
      // The access token may have expired; refresh once so the server can
      // actually revoke the session, then retry. Best-effort: local state is
      // cleared regardless in the finally block.
      if (e instanceof ApiError && e.status === 401) {
        try {
          const { ok } = await oc.refresh();
          if (ok) await oc.logout();
        } catch {
          /* give up on server revoke; clear locally below */
        }
      }
    } finally {
      writeActive(null);
      set({ status: "anon", user: null, workspaces: [], activeWorkspaceId: null });
    }
  },

  async deleteAccount(input) {
    set({ error: null });
    await oc.deleteAccount(input);
    writeActive(null);
    set({ status: "anon", user: null, workspaces: [], activeWorkspaceId: null });
  },

  setActiveWorkspace(id) {
    writeActive(id);
    set({ activeWorkspaceId: id });
  },

  setUser(user) {
    set({ user });
  },

  async refreshWorkspaces() {
    const workspaces = await oc.listWorkspaces();
    // If the active workspace was removed (deleted or left), fall back to a
    // valid one rather than keeping a dangling id.
    const cur = get().activeWorkspaceId;
    const next = cur && workspaces.some((w) => w.id === cur) ? cur : pickActive(workspaces);
    writeActive(next);
    set({ workspaces, activeWorkspaceId: next });
  },
}));
