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
// Generous, because delivery is GATED on the panel becoming ready rather than
// on the clock: a user who arrives from the dashboard with a brief and has no
// provider yet must paste a key first, which easily outlasts a few seconds.
// The request still cannot fire out of nowhere - it lands the moment the chat
// becomes available, which is exactly when the user asked for it.
const pendingTtlMs = 10 * 60_000;

export function subscribeAiRequests(cb: Listener, now = Date.now()): () => void {
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
export function requestAi(req: AiRequest, now = Date.now()): boolean {
  if (!listeners.size) {
    pending = { req, at: now };
    return false;
  }
  for (const cb of listeners) cb(req);
  return true;
}

/** The queued request, WITHOUT consuming it, so a surface that cannot serve it
 *  yet (the provider-setup form) can still tell the user it is waiting rather
 *  than leaving them wondering where their brief went. */
export function peekPendingAiRequest(now = Date.now()): AiRequest | null {
  if (!pending || now - pending.at >= pendingTtlMs) return null;
  return pending.req;
}

/** Test seam: drop any queued request. */
export function clearPendingAiRequest(): void {
  pending = null;
  stagedSources = null;
}

// Grounding sources handed over with a request. They cannot ride the URL (a
// single document dwarfs any sane query string), and navigation from the
// dashboard to the editor is client-side, so the module survives it. A full
// reload legitimately drops them, exactly as it drops the brief.
let stagedSources: { sources: AiSourceLike[]; at: number } | null = null;
type AiSourceLike = { name: string; text: string };

export function stageAiSources(sources: AiSourceLike[], now = Date.now()): void {
  stagedSources = sources.length ? { sources, at: now } : null;
}

/** Take the staged sources, if any are still fresh. Consumed once: a later
 *  unrelated generation must not silently inherit someone's attachments. */
export function takeStagedAiSources(now = Date.now()): AiSourceLike[] {
  if (!stagedSources || now - stagedSources.at >= pendingTtlMs) {
    stagedSources = null;
    return [];
  }
  const { sources } = stagedSources;
  stagedSources = null;
  return sources;
}
