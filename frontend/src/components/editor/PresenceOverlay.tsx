// Remote presence rendered over the canvas: each peer's cursor as
// a colored pointer with a name label (page coords -> screen via the shared
// CanvasApi), and their current selection as colored outlines around the node
// world-AABBs (the same world-AABB/toScreen the gizmo and guides use). A peer's
// cursor is hidden when null (pointer left their canvas). Pointer-events are off
// so this never intercepts editing interactions.
//
// Whiteboard ephemeral presence: one-shot emoji reactions float up and
// fade near the sender's cursor (FR-9), and live cursor-chat bubbles hang below
// each peer's cursor (FR-10). To stay responsive with 100+ participants, only a
// capped number of remote cursors render and the rest collapse into a
// "+M others" badge (FR-15).

import { useEffect, useRef, useState } from "react";
import { worldAABB } from "@hc/editor";
import { useEditor } from "@/store/editor";
import { usePresence } from "@/store/presence";
import { serverNow } from "@/lib/realtime";
import type { CanvasApi } from "@/lib/useEditorCanvas";
import { presenceFallback } from "@/lib/theme.generated";

// A reaction animates for this long; past it we stop rendering, so a latched or
// roster-snapshot reaction never replays stale on a late joiner.
const REACTION_TTL_MS = 2500;

// A laser beam fades over this long after the last position update, so a paused
// or roster-carried beam disappears on its own (FR-17). Each new position
// remounts the dot and restarts the CSS fade, like reactions.
const LASER_TTL_MS = 1200;

// At most this many remote cursors render at once; the overflow collapses into a
// single "+M others" badge so large rooms stay responsive.
const MAX_CURSORS = 8;

export function PresenceOverlay({ api }: { api: CanvasApi }) {
  const peers = usePresence((s) => s.peers);
  const locks = usePresence((s) => s.locks);
  const selfClientId = usePresence((s) => s.self?.clientId ?? null);
  const self = usePresence((s) => s.self);
  const selfLaser = usePresence((s) => s.selfLaser);
  // Re-render on viewport/document changes so cursors and outlines track pan,
  // zoom, and edits exactly like the gizmo overlay does.
  const viewport = useEditor((s) => s.viewport);
  const viewportSize = useEditor((s) => s.viewportSize);
  useEditor((s) => s.rev);
  // Per-owner laser-ink trail buffers (ephemeral; never persisted). Accumulated in
  // an effect (refs must not be touched during render) and mirrored to state so the
  // fading comet trail (FR-17) renders. Page-coord samples; projected at draw time.
  const laserTrailsRef = useRef<Map<string, { x: number; y: number; at: number }[]>>(new Map());
  const [laserTrails, setLaserTrails] = useState<{ key: string; color: string; samples: { x: number; y: number; at: number }[] }[]>([]);

  // Accumulate each owner's recent laser samples into a bounded ring buffer and
  // mirror it to state for rendering. Runs after commit (refs are off-limits in
  // render); fires whenever a laser position changes. The per-`at` guard makes
  // appends idempotent.
  useEffect(() => {
    const t = serverNow();
    const live = [
      { key: "self", color: self?.color ?? presenceFallback, laser: selfLaser },
      ...Object.values(peers).map((p) => ({ key: p.clientId, color: p.color, laser: p.state.laser ?? null })),
    ].filter((l) => l.laser && t - l.laser.at < LASER_TTL_MS) as { key: string; color: string; laser: { x: number; y: number; at: number } }[];
    const trails = laserTrailsRef.current;
    const liveKeys = new Set(live.map((l) => l.key));
    for (const [k] of trails) if (!liveKeys.has(k)) trails.delete(k);
    for (const { key, laser } of live) {
      const buf = trails.get(key) ?? [];
      if (buf.length === 0 || buf[buf.length - 1].at !== laser.at) buf.push({ x: laser.x, y: laser.y, at: laser.at });
      trails.set(key, buf.filter((s) => t - s.at < LASER_TTL_MS).slice(-24));
    }
    const next = live.map((l) => ({ key: l.key, color: l.color, samples: trails.get(l.key) ?? [] }));
    // Skip the state write (and its render pass) when nobody is lasering and the
    // trail was already empty - presence frames arrive constantly otherwise.
    setLaserTrails((prev) => (prev.length === 0 && next.length === 0 ? prev : next));
  }, [selfLaser, peers, self]);

  const doc = useEditor.getState().doc;
  const list = Object.values(peers);
  // Collaborative locks held by OTHER participants: a tinted badge
  // at the node's top-left corner with the holder's name (title on hover).
  const otherLocks = Object.entries(locks).filter(([, h]) => h.clientId !== selfClientId);
  if (!list.length && !otherLocks.length && !selfLaser) return null;

  // Laser beams (FR-17): the local user's own (echoed) plus every peer's, each a
  // glowing dot in the owner's color, age-gated so a paused/stale beam fades out.
  const now = serverNow();
  const lasers = [
    { key: "self", color: self?.color ?? presenceFallback, laser: selfLaser },
    ...list.map((peer) => ({ key: peer.clientId, color: peer.color, laser: peer.state.laser ?? null })),
  ].filter((l) => l.laser && now - l.laser.at < LASER_TTL_MS);


  // Interest management + spatial culling (FR-28): with hundreds of cursors we
  // can't render them all, so prefer the ones whose cursor falls inside the
  // visible viewport (the relevant, nearby collaborators) and cull the rest.
  // Peers with no cursor, or cursors far off-screen, sort last and overflow into
  // the "+M others" badge. The cap then bounds the rendered DOM regardless.
  const zoom = viewport.zoom || 1;
  const margin = 80 / zoom; // keep cursors just past the edge visible
  const viewRect = {
    x0: viewport.panX - margin,
    y0: viewport.panY - margin,
    x1: viewport.panX + viewportSize.width / zoom + margin,
    y1: viewport.panY + viewportSize.height / zoom + margin,
  };
  const inView = (peer: (typeof list)[number]): boolean => {
    const c = peer.state.cursor;
    return !!c && c.x >= viewRect.x0 && c.x <= viewRect.x1 && c.y >= viewRect.y0 && c.y <= viewRect.y1;
  };
  // Stable order: in-view peers first (then by clientId so the set is steady
  // frame to frame), so the capped slice tracks who is actually near the user.
  const ordered = [...list].sort((a, b) => {
    const ai = inView(a) ? 0 : 1;
    const bi = inView(b) ? 0 : 1;
    return ai !== bi ? ai - bi : a.clientId < b.clientId ? -1 : 1;
  });
  const shownCursors = ordered.slice(0, MAX_CURSORS).filter(inView);
  const shownSet = new Set(shownCursors.map((p) => p.clientId));
  const hiddenCount = list.length - shownCursors.length;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {/* Float-up + fade keyframes for one-shot reactions. The
          animation ends at opacity 0 so a stale (un-remounted) element stays
          invisible until a new reaction (new `at`) remounts and replays it. */}
      <style>{`
        @keyframes oc-reaction-float {
          0% { opacity: 0; transform: translate(-50%, 0) scale(0.7); }
          15% { opacity: 1; transform: translate(-50%, -8px) scale(1.1); }
          100% { opacity: 0; transform: translate(-50%, -56px) scale(1); }
        }
        @keyframes oc-laser-fade {
          0% { opacity: 0.95; }
          70% { opacity: 0.95; }
          100% { opacity: 0; }
        }
      `}</style>

      {/* Laser-ink comet trail (FR-17): the recent path behind each laser, one
          line segment per consecutive sample, keyed by its `at` so each mounts
          once and CSS-fades from then (older segments are dimmer). The dot below
          rides on top. */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
        {laserTrails.flatMap(({ key, color, samples }) =>
          samples.slice(1).map((s, i) => {
            const a = api.toScreen(samples[i]); // samples[i] is the point before s
            const b = api.toScreen(s);
            return (
              <line
                key={`laserink:${key}:${s.at}`}
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={color} strokeWidth={3} strokeLinecap="round"
                style={{ animation: "oc-laser-fade 1.2s ease-out forwards" }}
              />
            );
          }),
        )}
      </svg>

      {/* Laser beams: a glowing dot at each owner's pointer, keyed by owner + the
          beam's `at` so each new position remounts and restarts the fade (no JS
          timer); a paused beam fades out via the CSS animation. Ephemeral, never
          persisted. */}
      {lasers.map(({ key, color, laser }) => {
        const p = api.toScreen(laser!);
        return (
          <div
            key={`laser:${key}:${laser!.at}`}
            className="absolute h-3.5 w-3.5 rounded-full"
            style={{
              left: p.x,
              top: p.y,
              transform: "translate(-50%, -50%)",
              background: color,
              boxShadow: `0 0 6px 2px ${color}, 0 0 14px 5px ${color}66`,
              animation: "oc-laser-fade 1.2s ease-out forwards",
            }}
          />
        );
      })}

      {/* Selection outlines (one rect per selected node per peer). */}
      <svg className="absolute inset-0 h-full w-full overflow-visible">
        {list.flatMap((peer) =>
          (peer.state.selection ?? []).map((nodeId) => {
            const b = worldAABB(doc, nodeId);
            if (!b) return null;
            const tl = api.toScreen({ x: b.x, y: b.y });
            const br = api.toScreen({ x: b.x + b.width, y: b.y + b.height });
            return (
              <rect
                key={`${peer.clientId}:${nodeId}`}
                x={Math.min(tl.x, br.x)}
                y={Math.min(tl.y, br.y)}
                width={Math.abs(br.x - tl.x)}
                height={Math.abs(br.y - tl.y)}
                fill="none"
                stroke={peer.color}
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            );
          }),
        )}
      </svg>

      {/* Collaborative-lock badges: a padlock tinted with the holder's color at
          the top-left of each node locked by another user. */}
      {otherLocks.map(([nodeId, holder]) => {
        const b = worldAABB(doc, nodeId);
        if (!b) return null;
        const tl = api.toScreen({ x: b.x, y: b.y });
        return (
          <div
            key={`lock:${nodeId}`}
            className="absolute grid h-5 w-5 place-items-center rounded-full text-white shadow-sm ring-2 ring-white"
            style={{ left: tl.x, top: tl.y, transform: "translate(-50%, -50%)", background: holder.color }}
            title={`Locked by ${holder.name}`}
          >
            <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <rect x={3} y={11} width={18} height={11} rx={2} />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
        );
      })}

      {/* Emoji reactions: a one-shot float-up near the sender's
          cursor. Keyed by clientId + reaction `at` so a new ping remounts the
          element and replays the CSS animation without any JS timer. Limited to
          the shown (in-view) peers so a packed room doesn't flood the DOM. */}
      {list.filter((peer) => shownSet.has(peer.clientId)).map((peer) => {
        const r = peer.state.reaction;
        const c = peer.state.cursor;
        // Age-gate: only show a reaction within its animation window, so a
        // latched or roster-carried ping doesn't replay stale on a late joiner.
        if (!r || !c || serverNow() - r.at >= REACTION_TTL_MS) return null;
        const p = api.toScreen(c);
        return (
          <div
            key={`reaction:${peer.clientId}:${r.at}`}
            className="absolute select-none text-2xl leading-none"
            style={{
              left: p.x,
              top: p.y - 12,
              animation: "oc-reaction-float 2.5s ease-out forwards",
            }}
          >
            {r.emoji}
          </div>
        );
      })}

      {/* Cursor chat bubbles: a small rounded bubble anchored just
          below/right of the peer's cursor, accented with the peer color. Limited
          to shown (in-view) peers for the same scale reason as reactions. */}
      {list.filter((peer) => shownSet.has(peer.clientId)).map((peer) => {
        const chat = peer.state.chat;
        const c = peer.state.cursor;
        if (!chat || !chat.trim() || !c) return null;
        const p = api.toScreen(c);
        return (
          <div
            key={`chat:${peer.clientId}`}
            className="absolute max-w-[220px] break-words rounded-xl border bg-white px-2.5 py-1 text-xs text-neutral-800 shadow-sm"
            style={{ left: p.x + 14, top: p.y + 16, borderColor: peer.color }}
          >
            {chat}
          </div>
        );
      })}

      {/* Cursors + name labels (capped at MAX_CURSORS). */}
      {shownCursors.map((peer) => {
        const c = peer.state.cursor;
        if (!c) return null; // pointer left their canvas -> hide
        const p = api.toScreen(c);
        return (
          <div key={peer.clientId} className="absolute" style={{ left: p.x, top: p.y, transform: "translate(-2px, -2px)" }}>
            <svg width={18} height={18} viewBox="0 0 18 18" style={{ display: "block" }}>
              <path
                d="M2 2 L2 14 L6 10 L9 16 L11 15 L8 9 L14 9 Z"
                fill={peer.color}
                stroke="#fff"
                strokeWidth={1}
                strokeLinejoin="round"
              />
            </svg>
            <span
              className="absolute left-4 top-3 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium text-white shadow-sm"
              style={{ background: peer.color }}
            >
              {peer.name}
            </span>
          </div>
        );
      })}

      {/* Aggregation badge for the overflow of remote cursors. */}
      {hiddenCount > 0 && (
        <div className="absolute right-3 top-3 rounded-full bg-neutral-900/80 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm">
          +{hiddenCount} others
        </div>
      )}
    </div>
  );
}
