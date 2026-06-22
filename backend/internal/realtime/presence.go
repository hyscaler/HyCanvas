// Package realtime ports the NestJS realtime collaboration gateway (doc 16) as
// a Go WebSocket relay. Per the architecture decision, the server is an
// opaque-blob relay: it broadcasts y-protocols sync frames between the members
// of a design room and persists update frames to the update log, but it does NOT
// maintain a server-side Y.Doc - CRDT merge stays in the browser (the frontend's
// readSyncMessage answers a peer's sync step 1 with step 2, so peers sync each
// other through the relay). Viewer read-only is enforced at the connection
// boundary (a viewer's sync frames are dropped). Presence and collaborative
// locks are server-authoritative, pure logic (this file + locks.go).
package realtime

import "hash/fnv"

// Role is a participant's permission in a room.
type Role string

const (
	RoleEditor Role = "editor"
	RoleViewer Role = "viewer"
)

const maxChatLen = 200

var allowedReactions = map[string]bool{"👍": true, "❤️": true, "😂": true, "🎉": true, "👀": true, "✅": true}

// presencePalette is the stable per-user color palette (AC-1).
var presencePalette = []string{
	"#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
	"#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#a855f7",
}

// colorForUser returns a stable palette color for a user id (FNV-1a hash).
func colorForUser(userID string) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(userID))
	return presencePalette[int(h.Sum32())%len(presencePalette)]
}

// PeerIdentity is the server-assigned identity of a connection (never client-set).
type PeerIdentity struct {
	ClientID string `json:"clientId"`
	UserID   string `json:"userId"`
	Name     string `json:"name"`
	Color    string `json:"color"`
	Role     Role   `json:"role"`
}

// PresenceState is the ephemeral, client-supplied presence (never persisted).
type PresenceState map[string]any

// sanitizePresence coerces an untrusted presence payload to the allowed shape.
func sanitizePresence(raw map[string]any) PresenceState {
	out := PresenceState{}
	if raw == nil {
		return out
	}
	if v, ok := raw["cursor"]; ok {
		if v == nil {
			out["cursor"] = nil
		} else if c, ok := v.(map[string]any); ok {
			if x, okx := numeric(c["x"]); okx {
				if y, oky := numeric(c["y"]); oky {
					out["cursor"] = map[string]any{"x": x, "y": y}
				}
			}
		}
	}
	if sel, ok := raw["selection"].([]any); ok {
		ids := []string{}
		for _, s := range sel {
			if str, ok := s.(string); ok {
				ids = append(ids, str)
			}
		}
		out["selection"] = ids
	}
	if v, ok := raw["viewport"].(map[string]any); ok {
		z, okz := numeric(v["zoom"])
		px, okx := numeric(v["panX"])
		py, oky := numeric(v["panY"])
		if okz && okx && oky {
			out["viewport"] = map[string]any{"zoom": z, "panX": px, "panY": py}
		}
	}
	if v, ok := raw["following"]; ok {
		if v == nil {
			out["following"] = nil
		} else if str, ok := v.(string); ok {
			out["following"] = str
		}
	}
	if v, ok := raw["reaction"]; ok {
		if v == nil {
			out["reaction"] = nil
		} else if r, ok := v.(map[string]any); ok {
			emoji, _ := r["emoji"].(string)
			at, okAt := numeric(r["at"])
			if okAt && allowedReactions[emoji] {
				out["reaction"] = map[string]any{"emoji": emoji, "at": at}
			}
		}
	}
	if v, ok := raw["chat"]; ok {
		if v == nil {
			out["chat"] = nil
		} else if str, ok := v.(string); ok {
			if len(str) > maxChatLen {
				str = str[:maxChatLen]
			}
			out["chat"] = str
		}
	}
	return out
}

func numeric(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok
}

// Peer is a participant as broadcast: identity + latest presence.
type Peer struct {
	PeerIdentity
	State PresenceState `json:"state"`
}

func augmentPresence(id PeerIdentity, state PresenceState) Peer {
	return Peer{PeerIdentity: id, State: state}
}

// member is one connection's identity + latest presence.
type member struct {
	identity PeerIdentity
	state    PresenceState
}

// Room is the in-memory participant registry for one design (pure, socket-free).
type Room struct {
	DesignID string
	members  map[string]*member
}

func newRoom(designID string) *Room {
	return &Room{DesignID: designID, members: map[string]*member{}}
}

func (r *Room) join(id PeerIdentity) {
	r.members[id.ClientID] = &member{identity: id, state: PresenceState{}}
}

func (r *Room) leave(clientID string) bool {
	if _, ok := r.members[clientID]; !ok {
		return false
	}
	delete(r.members, clientID)
	return true
}

func (r *Room) setRole(clientID string, role Role) bool {
	m, ok := r.members[clientID]
	if !ok || m.identity.Role == role {
		return false
	}
	m.identity.Role = role
	return true
}

func (r *Room) has(clientID string) bool { _, ok := r.members[clientID]; return ok }
func (r *Room) size() int                { return len(r.members) }

func (r *Room) updatePresence(clientID string, raw map[string]any) *Peer {
	m, ok := r.members[clientID]
	if !ok {
		return nil
	}
	m.state = sanitizePresence(raw)
	p := augmentPresence(m.identity, m.state)
	return &p
}

func (r *Room) roster() []Peer {
	out := make([]Peer, 0, len(r.members))
	for _, m := range r.members {
		out = append(out, augmentPresence(m.identity, m.state))
	}
	return out
}

func (r *Room) identity(clientID string) (PeerIdentity, bool) {
	m, ok := r.members[clientID]
	if !ok {
		return PeerIdentity{}, false
	}
	return m.identity, true
}
