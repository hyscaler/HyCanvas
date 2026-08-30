// API-key authentication for the public generation API (F40 E02). A bearer
// token with the "hyk_" prefix authenticates as the key's minting user, but
// ONLY on an allowlisted route surface, only with the matching scope, only
// inside the key's workspace, and under a per-key rate budget. Everything
// else (account settings, members, billing-adjacent surfaces) stays
// session-only, so a leaked key's blast radius is the API surface it was
// minted for and nothing more.
package httpapi

import (
	"context"
	"net/http"
	"regexp"
	"sync"
	"time"

	"hycanvas/backend/internal/apikeys"
)

// Wired once by the router constructor (package-level rather than threading a
// new parameter through every requireAuth call site; requireAuth is mounted
// dozens of times and the key path is a strict superset check).
var (
	apiKeyAuth *apikeys.Service
	// design id -> workspace id, for the tenancy guard on design-scoped
	// routes (set from persistence.GetWorkspaceID).
	apiKeyDesignWS func(ctx context.Context, designID string) (string, error)
)

type apiKeyCtx struct{}

// apiKeyFrom returns the authenticated key's info when the request was
// API-key-authenticated, else nil (session auth).
func apiKeyFrom(ctx context.Context) *apikeys.KeyInfo {
	k, _ := ctx.Value(apiKeyCtx{}).(*apikeys.KeyInfo)
	return k
}

// apiKeyRoute is one allowlisted (method, path) surface an API key may call.
// designIdx, when >= 0, names the capture group holding a design id whose
// workspace must match the key's (the tenancy guard: a key is scoped to ONE
// workspace even when its minting user belongs to several).
type apiKeyRoute struct {
	method    string
	re        *regexp.Regexp
	scope     string // "" = any valid key (e.g. job polling)
	designIdx int
	// label names the surface in the audit trail; "" (job polling) is the
	// one read that is too chatty and too low-value to audit.
	label string
}

var apiKeyRoutes = []apiKeyRoute{
	{method: http.MethodPost, re: regexp.MustCompile(`^/api/v1/generate/presentation$`), scope: apikeys.ScopeGenerate, designIdx: -1, label: "http:generate_presentation"},
	{method: http.MethodGet, re: regexp.MustCompile(`^/api/v1/jobs/([^/]+)$`), scope: "", designIdx: -1, label: ""},
	{method: http.MethodGet, re: regexp.MustCompile(`^/api/v1/themes$`), scope: "", designIdx: -1, label: ""},
	{method: http.MethodGet, re: regexp.MustCompile(`^/api/v1/designs/([^/]+)$`), scope: apikeys.ScopeRead, designIdx: 1, label: "http:get_design"},
	{method: http.MethodGet, re: regexp.MustCompile(`^/api/v1/designs/([^/]+)/file$`), scope: apikeys.ScopeRead, designIdx: 1, label: "http:get_design_file"},
	{method: http.MethodGet, re: regexp.MustCompile(`^/api/v1/designs/([^/]+)/render\.pdf$`), scope: apikeys.ScopeExport, designIdx: 1, label: "http:render_pdf"},
	{method: http.MethodGet, re: regexp.MustCompile(`^/api/v1/designs/([^/]+)/render\.png$`), scope: apikeys.ScopeExport, designIdx: 1, label: "http:render_png"},
	{method: http.MethodPost, re: regexp.MustCompile(`^/api/v1/designs/([^/]+)/export/doc$`), scope: apikeys.ScopeExport, designIdx: 1, label: "http:export_doc"},
	{method: http.MethodGet, re: regexp.MustCompile(`^/api/v1/designs/([^/]+)/export/doc/([^/]+)/download$`), scope: apikeys.ScopeExport, designIdx: 1, label: "http:export_doc_download"},
	{method: http.MethodPost, re: regexp.MustCompile(`^/api/v1/designs/([^/]+)/links$`), scope: apikeys.ScopeExport, designIdx: 1, label: "http:create_share_link"},
}

// matchAPIKeyRoute returns the allowlist entry and the design id (or "").
func matchAPIKeyRoute(method, path string) (*apiKeyRoute, string, bool) {
	for i := range apiKeyRoutes {
		rt := &apiKeyRoutes[i]
		if rt.method != method {
			continue
		}
		m := rt.re.FindStringSubmatch(path)
		if m == nil {
			continue
		}
		design := ""
		if rt.designIdx > 0 && rt.designIdx < len(m) {
			design = m[rt.designIdx]
		}
		return rt, design, true
	}
	return nil, "", false
}

// --- per-key rate budget ----------------------------------------------------

// Token bucket per key id: generous for the read/export surface (the generate
// endpoint applies its own tighter budget on top). Same shape as the audience
// guard's limiter; kept separate because the keying and budgets differ.
const (
	apiKeyRatePerSec = 5.0
	apiKeyBurst      = 20.0
)

type apiKeyBucket struct {
	tokens float64
	last   time.Time
}

var (
	apiKeyMu      sync.Mutex
	apiKeyBuckets = map[string]*apiKeyBucket{}
)

func allowAPIKeyCall(keyID string, now time.Time, rate, burst float64) bool {
	apiKeyMu.Lock()
	defer apiKeyMu.Unlock()
	b := apiKeyBuckets[keyID]
	if b == nil {
		b = &apiKeyBucket{tokens: burst, last: now}
		apiKeyBuckets[keyID] = b
	}
	b.tokens += now.Sub(b.last).Seconds() * rate
	if b.tokens > burst {
		b.tokens = burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// authenticateAPIKey handles the hyk_ branch of requireAuth. It either writes
// the failure response (returning nil) or returns the request with the key's
// identity in context.
func authenticateAPIKey(w http.ResponseWriter, r *http.Request, token string) *http.Request {
	if apiKeyAuth == nil {
		problemWithCode(w, r, http.StatusUnauthorized, "Unauthorized", "API keys are not enabled on this server", "api_keys_disabled")
		return nil
	}
	info, err := apiKeyAuth.Verify(r.Context(), token)
	if err != nil {
		problemWithCode(w, r, http.StatusUnauthorized, "Unauthorized", "invalid or revoked API key", "invalid_api_key")
		return nil
	}
	rt, designID, ok := matchAPIKeyRoute(r.Method, r.URL.Path)
	if !ok {
		problemWithCode(w, r, http.StatusForbidden, "Forbidden", "this endpoint is not available to API keys", "api_key_route_not_allowed")
		return nil
	}
	if rt.scope != "" && !info.HasScope(rt.scope) {
		problemWithCode(w, r, http.StatusForbidden, "Forbidden", "this API key lacks the '"+rt.scope+"' scope", "api_key_scope_missing")
		return nil
	}
	if !allowAPIKeyCall(info.ID, time.Now(), apiKeyRatePerSec, apiKeyBurst) {
		w.Header().Set("Retry-After", "5")
		problemWithCode(w, r, http.StatusTooManyRequests, "Too Many Requests", "this API key is over its request budget; slow down and try again", "api_key_rate_limited")
		return nil
	}
	// Tenancy guard: a design-scoped call must target the key's OWN workspace.
	// The membership checks downstream run as the minting user, who may belong
	// to more workspaces than the key does.
	if designID != "" && apiKeyDesignWS != nil {
		ws, err := apiKeyDesignWS(r.Context(), designID)
		if err != nil || ws != info.WorkspaceID {
			// Same problem for missing and cross-tenant: not an existence oracle.
			problemWithCode(w, r, http.StatusNotFound, "Not Found", "design not found", "design_not_found")
			return nil
		}
	}
	// The audit trail (E08): one row per meaningful key action, written here
	// so every allowlisted route is covered without per-handler hooks. Job
	// polling (label "") is deliberately not audited.
	if rt.label != "" {
		apiKeyAuth.Audit(r.Context(), &info, rt.label, designID)
	}
	ctx := context.WithValue(r.Context(), userKey, &authedUser{ID: info.UserID})
	ctx = context.WithValue(ctx, apiKeyCtx{}, &info)
	return r.WithContext(ctx)
}
