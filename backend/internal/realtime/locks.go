// Pure collaborative-lock arbitration (doc 16 slice C: FR-8). Server-
// authoritative, socket-free: any editor may claim one or more node ids; while a
// node is locked only the holding connection may mutate it. Distinct from the
// schema's structural `locked` flag. Locks release on unlock, disconnect, or a
// heartbeat sweep. Viewers may not lock.
package realtime

// LockHolder is who holds a lock (the slice broadcast to the room).
type LockHolder struct {
	ClientID string `json:"clientId"`
	UserID   string `json:"userId"`
	Name     string `json:"name"`
	Color    string `json:"color"`
}

// LockMap is the authoritative lock map: nodeId -> holder.
type LockMap map[string]LockHolder

func holderOf(id PeerIdentity) LockHolder {
	return LockHolder{ClientID: id.ClientID, UserID: id.UserID, Name: id.Name, Color: id.Color}
}

// lockTable holds the collaborative locks for one room.
type lockTable struct {
	locks map[string]LockHolder
}

func newLockTable() *lockTable { return &lockTable{locks: map[string]LockHolder{}} }

// lock grants a lock on each id to the requester (idempotent re-lock; ids held
// by another are refused; viewers refused entirely). Returns whether changed.
func (t *lockTable) lock(id PeerIdentity, ids []string) bool {
	if id.Role != RoleEditor {
		return false
	}
	holder := holderOf(id)
	changed := false
	for _, nodeID := range ids {
		cur, held := t.locks[nodeID]
		if held && cur.ClientID != id.ClientID {
			continue // held by another
		}
		if held && cur.ClientID == id.ClientID {
			continue // already ours
		}
		t.locks[nodeID] = holder
		changed = true
	}
	return changed
}

// unlock releases each id iff held by the requester. Returns whether changed.
func (t *lockTable) unlock(clientID string, ids []string) bool {
	changed := false
	for _, nodeID := range ids {
		if cur, held := t.locks[nodeID]; held && cur.ClientID == clientID {
			delete(t.locks, nodeID)
			changed = true
		}
	}
	return changed
}

// releaseAll releases every lock held by a client (on leave/disconnect/sweep).
func (t *lockTable) releaseAll(clientID string) bool {
	changed := false
	for nodeID, holder := range t.locks {
		if holder.ClientID == clientID {
			delete(t.locks, nodeID)
			changed = true
		}
	}
	return changed
}

// snapshot is a copy of the authoritative lock map for broadcasting.
func (t *lockTable) snapshot() LockMap {
	out := LockMap{}
	for k, v := range t.locks {
		out[k] = v
	}
	return out
}
