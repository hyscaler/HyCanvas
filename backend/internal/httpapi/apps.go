package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
)

// builtInApps is the listing of built-in mini-apps (doc 13 FR-9), mirroring the
// former SEED_APPS. The Apps panel uses it plus the client-side scope logic to
// gate launching into the editor's insert actions; the sandboxed runtime is
// deferred, so this is the listing only.
var builtInApps = []map[string]any{
	{"id": "qr", "name": "QR code", "icon": "qr-code", "builtIn": true, "scopes": []string{"insert-node", "edit-own-nodes"}, "entry": "builtin:qr"},
	{"id": "charts", "name": "Charts", "icon": "bar-chart", "builtIn": true, "scopes": []string{"insert-node", "edit-own-nodes"}, "entry": "builtin:charts"},
	{"id": "tables", "name": "Tables", "icon": "table", "builtIn": true, "scopes": []string{"insert-node", "edit-own-nodes"}, "entry": "builtin:tables"},
	{"id": "shapes", "name": "Shapes", "icon": "shapes", "builtIn": true, "scopes": []string{"insert-node"}, "entry": "builtin:shapes"},
}

// mountApps attaches GET /api/v1/apps (the mini-app listing).
func mountApps(api chi.Router, acct *accounts.Service) {
	api.With(requireAuth(acct)).Get("/apps", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, builtInApps)
	})
}
