// A one-way channel from the rest of the editor to the AI assistant panel.
//
// Several genuinely useful AI capabilities were reachable only by typing the
// right sentence into the chat and hoping the planner routed it - per-slide
// regeneration being the clearest example: a complete, layout-preserving,
// image-diffing tool with no button anywhere. A surface that wants to invoke
// one publishes a request here; the panel (which owns the workspace config,
// the plan executor and the undo turn) performs it.
//
// Deliberately not a store slice: this is a transient user intent, not
// document state, and it must never be persisted or undone.

/** A request from elsewhere in the editor for the assistant to do something.
 *  `prompt` requests fall back to the planner; `action` requests run a known
 *  tool directly, which is deterministic and cannot be misrouted. */
export type AiRequest =
  | { kind: "prompt"; text: string }
  | { kind: "action"; action: "regenerateSlide"; pageIndex: number; instruction: string };

type Listener = (req: AiRequest) => void;
const listeners = new Set<Listener>();

/** The most recent request made while nobody was listening (the AI panel
 *  mounts on first open, so a request can precede it). Delivered once the
 *  panel subscribes, and only while it is fresh: a request the user made and
 *  then wandered away from should not fire minutes later. */
let pending: { req: AiRequest; at: number } | null = null;
const pendingTtlMs = 30_000;

export function subscribeAiRequests(cb: Listener, now = 0): () => void {
  listeners.add(cb);
  if (pending && now - pending.at < pendingTtlMs) {
    const { req } = pending;
    pending = null;
    // Deliver after the caller finishes subscribing, so a handler that sets
    // state does not run inside the subscriber's own render pass.
    queueMicrotask(() => cb(req));
  }
  return () => listeners.delete(cb);
}

/** Ask the assistant to do something. Returns whether a listener took it. */
export function requestAi(req: AiRequest, now = 0): boolean {
  if (!listeners.size) {
    pending = { req, at: now };
    return false;
  }
  for (const cb of listeners) cb(req);
  return true;
}

/** Test seam: drop any queued request. */
export function clearPendingAiRequest(): void {
  pending = null;
}
