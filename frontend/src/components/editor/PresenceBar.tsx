// Top-bar presence UI: an avatar stack of connected
// peers (colored initials circles, max 5 + an overflow count) and a connection
// state badge. Clicking an avatar toggles FOLLOW mode for that peer; while
// following, a "Following <name>" pill with a stop button appears, and the
// useRealtime hook mirrors that peer's viewport until the user moves or Esc.

import { Check, Cloud, CloudOff, Eye, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePresence, type ConnectionState, type Peer } from "@/store/presence";

const MAX_AVATARS = 5;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function Badge({ state, readOnly, synced }: { state: ConnectionState; readOnly: boolean; synced: boolean }) {
  if (readOnly)
    return (
      <span className="flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600" title="You have view-only access">
        <Eye size={13} /> Read-only
      </span>
    );
  // Brief "Synced" reassurance right after reconnecting, so offline edits merging
  // back reads as success rather than silently flipping to "Live" (FR-14 UX).
  if (state === "connected" && synced)
    return (
      <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700" title="Synced: your offline changes merged in">
        <Check size={13} /> Synced
      </span>
    );
  // Offline/reconnecting reassure that edits are safe: the Y.Doc is mirrored to
  // IndexedDB, so changes persist on this device and sync on
  // reconnect. The title spells that out so "Offline" never reads as data loss.
  const savedLocally = "Your changes are saved on this device and will sync when you reconnect.";
  const map: Record<ConnectionState, { label: string; cls: string; icon: React.ReactNode; title: string }> = {
    connecting: { label: "Connecting", cls: "bg-amber-50 text-amber-700", icon: <Loader2 size={13} className="animate-spin" />, title: "Connecting to live collaboration" },
    connected: { label: "Live", cls: "bg-emerald-50 text-emerald-700", icon: <Cloud size={13} />, title: "Live: changes sync with collaborators in real time" },
    reconnecting: { label: "Reconnecting", cls: "bg-amber-50 text-amber-700", icon: <Loader2 size={13} className="animate-spin" />, title: `Reconnecting. ${savedLocally}` },
    offline: { label: "Offline", cls: "bg-neutral-100 text-neutral-500", icon: <CloudOff size={13} />, title: `Offline. ${savedLocally}` },
  };
  const m = map[state];
  return (
    <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${m.cls}`} title={m.title}>
      {m.icon} {m.label}
    </span>
  );
}

function Avatar({ peer, following, onClick }: { peer: Peer; following: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={`${peer.name}${following ? " (following)" : ""}: click to follow`}
      className={`relative grid h-7 w-7 -ml-1.5 first:ml-0 place-items-center rounded-full text-[11px] font-semibold text-white ring-2 transition ${following ? "ring-neutral-900" : "ring-white"}`}
      style={{ background: peer.color }}
    >
      {initials(peer.name)}
    </button>
  );
}

export function PresenceBar() {
  const connection = usePresence((s) => s.connection);
  const peers = usePresence((s) => s.peers);
  const self = usePresence((s) => s.self);
  const following = usePresence((s) => s.following);
  const toggleFollow = usePresence((s) => s.toggleFollow);
  const setFollowing = usePresence((s) => s.setFollowing);

  // Flash "Synced" for a moment when we come back online after a drop (not on the
  // first connect, which is just "Live"). Tracks the previous connection state.
  const [justSynced, setJustSynced] = useState(false);
  const prevConn = useRef(connection);
  useEffect(() => {
    const prev = prevConn.current;
    prevConn.current = connection;
    if (connection === "connected" && (prev === "offline" || prev === "reconnecting")) {
      setJustSynced(true);
      const t = setTimeout(() => setJustSynced(false), 2500);
      return () => clearTimeout(t);
    }
  }, [connection]);

  const list = Object.values(peers);
  const shown = list.slice(0, MAX_AVATARS);
  const overflow = list.length - shown.length;
  const readOnly = self?.role === "viewer";
  const followingPeer = following ? peers[following] : null;

  return (
    <div className="flex items-center gap-2">
      {followingPeer && (
        <span
          className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-white"
          style={{ background: followingPeer.color }}
        >
          Following {followingPeer.name}
          <button onClick={() => setFollowing(null)} className="ml-0.5 rounded-full hover:bg-black/15" aria-label="Stop following">
            <X size={13} />
          </button>
        </span>
      )}
      {list.length > 0 && (
        <div className="flex items-center">
          {shown.map((p) => (
            <Avatar key={p.clientId} peer={p} following={following === p.clientId} onClick={() => toggleFollow(p.clientId)} />
          ))}
          {overflow > 0 && (
            <span className="-ml-1.5 grid h-7 w-7 place-items-center rounded-full bg-neutral-200 text-[11px] font-semibold text-neutral-600 ring-2 ring-white">
              +{overflow}
            </span>
          )}
        </div>
      )}
      <Badge state={connection} readOnly={readOnly} synced={justSynced} />
    </div>
  );
}
