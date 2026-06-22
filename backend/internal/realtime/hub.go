package realtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"sync"
)

// UpdateLog persists editor document updates to the durable journal
// (DesignUpdateLog). Optional; nil = updates are relayed but not journaled
// (snapshots remain the durability mechanism).
type UpdateLog interface {
	AppendUpdate(ctx context.Context, designID string, update []byte, authorID string) error
}

// conn is one live WebSocket connection in a room.
type conn struct {
	clientID string
	designID string
	send     chan []byte
}

// liveRoom is a room's presence registry + lock table + live connections.
type liveRoom struct {
	room  *Room
	locks *lockTable
	conns map[string]*conn
}

// Hub is the in-memory relay: design rooms with their live connections.
type Hub struct {
	mu        sync.Mutex
	rooms     map[string]*liveRoom
	updateLog UpdateLog
}

// NewHub builds a relay. updateLog may be nil.
func NewHub(updateLog UpdateLog) *Hub {
	return &Hub{rooms: map[string]*liveRoom{}, updateLog: updateLog}
}

func (h *Hub) roomFor(designID string) *liveRoom {
	lr, ok := h.rooms[designID]
	if !ok {
		lr = &liveRoom{room: newRoom(designID), locks: newLockTable(), conns: map[string]*conn{}}
		h.rooms[designID] = lr
	}
	return lr
}

// Join registers a connection: adds it to the room, sends welcome/roster/locks
// to it, and broadcasts the join to the rest. Returns the connection handle.
func (h *Hub) Join(id PeerIdentity, designID string, serverTimeMs int64) *conn {
	h.mu.Lock()
	defer h.mu.Unlock()
	if id.Color == "" {
		id.Color = colorForUser(id.UserID) // stable per-user palette color
	}
	lr := h.roomFor(designID)
	c := &conn{clientID: id.ClientID, designID: designID, send: make(chan []byte, 64)}
	lr.conns[id.ClientID] = c
	lr.room.join(id)

	c.send <- frame(map[string]any{"t": "welcome", "self": id, "serverTime": serverTimeMs})
	c.send <- frame(map[string]any{"t": "roster", "peers": lr.room.roster()})
	c.send <- frame(map[string]any{"t": "locks", "locks": lr.locks.snapshot()})
	joined := augmentPresence(id, PresenceState{})
	h.broadcastLocked(lr, frame(map[string]any{"t": "join", "peer": joined}), id.ClientID)
	return c
}

// Leave removes a connection, releases its locks, and broadcasts leave + locks.
func (h *Hub) Leave(c *conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	lr, ok := h.rooms[c.designID]
	if !ok {
		return
	}
	if _, present := lr.conns[c.clientID]; !present {
		return
	}
	delete(lr.conns, c.clientID)
	lr.room.leave(c.clientID)
	locksChanged := lr.locks.releaseAll(c.clientID)
	h.broadcastLocked(lr, frame(map[string]any{"t": "leave", "clientId": c.clientID}), "")
	if locksChanged {
		h.broadcastLocked(lr, frame(map[string]any{"t": "locks", "locks": lr.locks.snapshot()}), "")
	}
	close(c.send)
	if len(lr.conns) == 0 {
		delete(h.rooms, c.designID)
	}
}

// HandlePresence merges a presence update and broadcasts it to the room.
func (h *Hub) HandlePresence(c *conn, raw map[string]any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	lr, ok := h.rooms[c.designID]
	if !ok {
		return
	}
	peer := lr.room.updatePresence(c.clientID, raw)
	if peer == nil {
		return
	}
	h.broadcastLocked(lr, frame(map[string]any{"t": "presence", "peer": peer}), c.clientID)
}

// HandleSync relays a y-protocols sync frame. A viewer's frame is dropped
// (read-only enforcement); an editor's update frame is journaled (best-effort)
// and broadcast to the rest of the room.
func (h *Hub) HandleSync(ctx context.Context, c *conn, m string) {
	h.mu.Lock()
	lr, ok := h.rooms[c.designID]
	if !ok {
		h.mu.Unlock()
		return
	}
	id, present := lr.room.identity(c.clientID)
	if !present || id.Role != RoleEditor {
		h.mu.Unlock()
		return // viewers cannot mutate the document
	}
	h.broadcastLocked(lr, frame(map[string]any{"t": "sync", "m": m}), c.clientID)
	h.mu.Unlock()

	// Journal y-protocols UPDATE messages (type 2); sync step1/step2 handshakes
	// carry no durable mutation. Best-effort, outside the lock.
	if h.updateLog != nil {
		if raw, err := base64.StdEncoding.DecodeString(m); err == nil && len(raw) > 0 && raw[0] == 2 {
			_ = h.updateLog.AppendUpdate(ctx, c.designID, raw, id.UserID)
		}
	}
}

// HandleLock / HandleUnlock mutate the room's lock table and broadcast the
// authoritative map only when it changes.
func (h *Hub) HandleLock(c *conn, ids []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	lr, ok := h.rooms[c.designID]
	if !ok {
		return
	}
	id, present := lr.room.identity(c.clientID)
	if !present {
		return
	}
	if lr.locks.lock(id, ids) {
		h.broadcastLocked(lr, frame(map[string]any{"t": "locks", "locks": lr.locks.snapshot()}), "")
	}
}

func (h *Hub) HandleUnlock(c *conn, ids []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	lr, ok := h.rooms[c.designID]
	if !ok {
		return
	}
	if lr.locks.unlock(c.clientID, ids) {
		h.broadcastLocked(lr, frame(map[string]any{"t": "locks", "locks": lr.locks.snapshot()}), "")
	}
}

// NotifyCommentChanged broadcasts a comment-mutation signal to a design room
// (satisfies comments.Realtime). Clients refetch over REST.
func (h *Hub) NotifyCommentChanged(ctx context.Context, designID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	lr, ok := h.rooms[designID]
	if !ok {
		return
	}
	h.broadcastLocked(lr, frame(map[string]any{"t": "comment", "op": "changed", "designId": designID}), "")
}

// broadcastLocked sends a payload to every connection in the room except
// `exceptClientID` (use "" to send to all). Caller holds h.mu. Non-blocking: a
// full send buffer drops the frame for that slow client.
func (h *Hub) broadcastLocked(lr *liveRoom, payload []byte, exceptClientID string) {
	for cid, c := range lr.conns {
		if cid == exceptClientID {
			continue
		}
		select {
		case c.send <- payload:
		default:
		}
	}
}

func frame(v map[string]any) []byte {
	b, _ := json.Marshal(v)
	return b
}
