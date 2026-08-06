// Room keys (doc 16 FR-10): a live room is keyed by design, or by
// design+branch for in-CRDT branch sessions. The composite key keeps a
// branch's sync/presence/locks fully isolated from main (a branch is its own
// document lineage), while helpers below let design-scoped operations (bans,
// role refresh, journaling) address every room of a design.
package realtime

import "strings"

// roomKeySep never appears in IDs (designs and branches use UUID/text ids the
// API mints; the unit separator is not URL- or JSON-hostile either).
const roomKeySep = "\x1f"

// RoomKey returns the hub room key for a design's main lineage (branchID "")
// or one of its branches.
func RoomKey(designID, branchID string) string {
	if branchID == "" {
		return designID
	}
	return designID + roomKeySep + branchID
}

// SplitRoomKey resolves a room key back to (designID, branchID); branchID is
// "" for a main-lineage room.
func SplitRoomKey(key string) (designID, branchID string) {
	if i := strings.IndexByte(key, roomKeySep[0]); i >= 0 {
		return key[:i], key[i+1:]
	}
	return key, ""
}
