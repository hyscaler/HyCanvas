package httpapi

import (
	"net/http"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/realtime"
	"hycanvas/backend/internal/sharing"
)

// mountRealtime attaches the collaboration WebSocket endpoint at /realtime
// (root, not under /api/v1, matching the NestJS gateway upgrade path). The
// connection authenticates via the hc_access cookie and authorizes against the
// design's resolved gateway role (editor/viewer).
func mountRealtime(r chi.Router, hub *realtime.Hub, acct *accounts.Service, sh *sharing.Service, persist *persistence.Service, secure bool) {
	r.Get("/realtime", realtimeHandler(hub, acct, sh, persist, secure))
}

func realtimeHandler(hub *realtime.Hub, acct *accounts.Service, sh *sharing.Service, persist *persistence.Service, secure bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		designID := r.URL.Query().Get("design")
		if designID == "" {
			http.Error(w, "missing design", http.StatusBadRequest)
			return
		}
		// Authenticate via the access cookie (the gateway is cookie-only, like Node).
		c, err := r.Cookie(accessCookie)
		if err != nil || c.Value == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		userID, _, err := acct.VerifyAccess(r.Context(), c.Value)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		// Authorize: the design must resolve to a workspace the caller can see, and
		// the gateway role (editor/viewer) gates document mutation.
		if _, err := persist.GetWorkspaceID(r.Context(), designID); err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		role, err := sh.ResolveGatewayRole(r.Context(), designID, userID, nil)
		if err != nil {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		user, err := acct.GetUserByID(r.Context(), userID)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}

		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: !secure})
		if err != nil {
			return // Accept already wrote the response
		}
		defer ws.CloseNow()

		id := realtime.PeerIdentity{
			ClientID: uuid.NewString(),
			UserID:   userID,
			Name:     user.Name,
			Color:    "", // assigned by the hub palette
			Role:     realtime.Role(role),
		}
		// ?branch= joins an in-CRDT branch session (FR-10): its own room (sync,
		// presence, and locks fully isolated from main) journaling to the branch's
		// lineage. The branch must belong to this design; permissions are the
		// design's own (already resolved above).
		roomKey := designID
		if branch := r.URL.Query().Get("branch"); branch != "" {
			if !persist.BranchBelongsToDesign(r.Context(), designID, branch) {
				_ = ws.Close(websocket.StatusPolicyViolation, "unknown branch")
				return
			}
			roomKey = realtime.RoomKey(designID, branch)
		}
		hub.Serve(r.Context(), ws, id, roomKey)
	}
}
