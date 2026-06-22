// Mini-app scope enforcement. The host grants each app a set
// of capabilities; an action outside the granted scopes is denied and surfaced
// (never a silent failure). Built-in and third-party apps use the same check.

import type { AppScope, MiniApp } from "./types";

export type AppAction = "insert-node" | "edit-own-nodes" | "read-selection" | "network";

const ACTION_SCOPE: Record<AppAction, AppScope> = {
  "insert-node": "insert-node",
  "edit-own-nodes": "edit-own-nodes",
  "read-selection": "read-selection",
  network: "network",
};

export interface ScopeDecision {
  allowed: boolean;
  reason?: string;
}

export function hasScope(app: Pick<MiniApp, "scopes">, scope: AppScope): boolean {
  return app.scopes.includes(scope);
}

/** Decide whether an app may perform an action (FR-8). */
export function checkAppAction(app: Pick<MiniApp, "scopes">, action: AppAction): ScopeDecision {
  const needed = ACTION_SCOPE[action];
  if (hasScope(app, needed)) return { allowed: true };
  return { allowed: false, reason: `app lacks required scope "${needed}" for action "${action}"` };
}

/** Throw when an app attempts an out-of-scope action (host-side guard). */
export function assertAppAction(app: Pick<MiniApp, "scopes">, action: AppAction): void {
  const d = checkAppAction(app, action);
  if (!d.allowed) throw new Error(d.reason);
}

/**
 * Whether an app may edit a given node: it must hold "edit-own-nodes" and the
 * node must be one the app inserted (tracked by the host via `ownedNodeIds`).
 */
export function canEditNode(app: Pick<MiniApp, "scopes">, ownedNodeIds: ReadonlySet<string>, nodeId: string): boolean {
  return hasScope(app, "edit-own-nodes") && ownedNodeIds.has(nodeId);
}
