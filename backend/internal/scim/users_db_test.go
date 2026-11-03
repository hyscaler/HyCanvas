package scim

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
)

const testJWT = "test-jwt-secret"

type harness struct {
	t            *testing.T
	tx           pgx.Tx
	h            http.Handler
	acct         *accounts.Service
	disconnected []string
	// deactivatedAtDisconnect records, for each disconnect, whether the account
	// was already deactivated when the server asked for the sockets to close.
	deactivatedAtDisconnect []bool
}

func newHarness(t *testing.T, cfg *Config) *harness {
	t.Helper()
	tx := testTx(t)
	hs := &harness{t: t, tx: tx, acct: accounts.NewService(tx, testJWT)}
	if cfg == nil {
		cfg = &Config{Token: goodToken, Groups: map[string][]Grant{}, Modes: map[string]Mode{}}
	}
	srv := NewServer(cfg, tx, testJWT, func(userID string) {
		hs.disconnected = append(hs.disconnected, userID)
		var off bool
		_ = tx.QueryRow(context.Background(), `SELECT "deactivated_at" IS NOT NULL FROM "users" WHERE id = $1`, userID).Scan(&off)
		hs.deactivatedAtDisconnect = append(hs.deactivatedAtDisconnect, off)
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	hs.h = srv.Handler()
	return hs
}

func (hs *harness) do(method, path string, body any) (int, map[string]any) {
	hs.t.Helper()
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, rdr)
	req.Header.Set("Authorization", "Bearer "+goodToken)
	req.Header.Set("Content-Type", contentTypeSCIM)
	rec := httptest.NewRecorder()
	hs.h.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// hcUser is the HyCanvas account a SCIM user resource is linked to.
func (hs *harness) hcUser(scimID string) string {
	hs.t.Helper()
	var id string
	if err := hs.tx.QueryRow(context.Background(), `SELECT "user_id" FROM "scim_users" WHERE id = $1`, scimID).Scan(&id); err != nil {
		hs.t.Fatalf("no link for %s: %v", scimID, err)
	}
	return id
}

func userBody(userName, externalID, email string, active bool) map[string]any {
	return map[string]any{
		"schemas":     []string{schemaUser},
		"userName":    userName,
		"externalId":  externalID,
		"displayName": "Alice Example",
		"name":        map[string]any{"formatted": "Alice Example", "givenName": "Alice", "familyName": "Example"},
		"emails":      []map[string]any{{"value": email, "type": "other", "primary": true}},
		"active":      active,
		"locale":      "en-US",
	}
}

func filterPath(base, filter string) string { return base + "?filter=" + url.QueryEscape(filter) }

func TestDisabledServerIs404(t *testing.T) {
	h := NewServer(nil, nil, testJWT, nil, slog.Default()).Handler()
	for _, p := range []string{"/Users", "/ServiceProviderConfig", "/"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, p, nil)
		req.Header.Set("Authorization", "Bearer "+goodToken)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s with SCIM off: %d, want 404", p, rec.Code)
		}
	}
}

func TestBearerAuth(t *testing.T) {
	h := NewServer(&Config{Token: goodToken}, nil, testJWT, nil, slog.Default()).Handler()
	try := func(set func(*http.Request)) int {
		req := httptest.NewRequest(http.MethodGet, "/ServiceProviderConfig", nil)
		set(req)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	if c := try(func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+goodToken) }); c != http.StatusOK {
		t.Fatalf("control: the right token got %d", c)
	}
	for name, set := range map[string]func(*http.Request){
		"none":    func(*http.Request) {},
		"wrong":   func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+goodToken+"x") },
		"api key": func(r *http.Request) { r.Header.Set("Authorization", "Bearer hyk_0123456789abcdef0123456789abcdef") },
		"basic":   func(r *http.Request) { r.Header.Set("Authorization", "Basic "+goodToken) },
		"cookie":  func(r *http.Request) { r.AddCookie(&http.Cookie{Name: "access_token", Value: goodToken}) },
		"prefix":  func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+goodToken[:31]) },
	} {
		if c := try(set); c != http.StatusUnauthorized {
			t.Errorf("%s: %d, want 401", name, c)
		}
	}
}

func TestUserLifecycle_DB(t *testing.T) {
	hs := newHarness(t, nil)
	ctx := context.Background()
	sub := "sub-" + uuid.NewString()
	userName := "alice-" + uuid.NewString()[:8]
	email := userName + "@example.com"

	code, created := hs.do("POST", "/Users", userBody(userName, sub, email, true))
	if code != http.StatusCreated {
		t.Fatalf("create: %d %v", code, created)
	}
	id, _ := created["id"].(string)
	if id == "" || created["active"] != true || created["userName"] != userName {
		t.Fatalf("create body: %v", created)
	}
	// What the provider sent and we do not model comes back, so its change
	// detection does not see a difference on every sync.
	if created["locale"] != "en-US" {
		t.Fatalf("unmodelled attribute not echoed: %v", created["locale"])
	}
	hcID := hs.hcUser(id)

	if code, got := hs.do("GET", "/Users/"+id, nil); code != 200 || got["id"] != id {
		t.Fatalf("get: %d %v", code, got)
	}

	// Authentik's lost-connection path: create again, get 409, look the user up.
	if code, body := hs.do("POST", "/Users", userBody(userName, sub, email, true)); code != http.StatusConflict || body["scimType"] != "uniqueness" {
		t.Fatalf("duplicate create: %d %v", code, body)
	}
	code, list := hs.do("GET", filterPath("/Users", `userName eq "`+userName+`"`), nil)
	if res, _ := list["Resources"].([]any); code != 200 || len(res) != 1 || res[0].(map[string]any)["id"] != id {
		t.Fatalf("filter after 409: %d %v", code, list)
	}

	// The person signs in through SSO and lands on the provisioned account.
	u, tokens, _, err := hs.acct.LoginWithOidc(ctx, accounts.OidcProfile{Subject: sub, Email: email, Name: "x"}, "d", "ip", true, false)
	if err != nil || u.ID != hcID {
		t.Fatalf("sso login: %v (user %v, want %s)", err, u, hcID)
	}

	// Authentik deactivates with a full PUT.
	code, put := hs.do("PUT", "/Users/"+id, userBody(userName, sub, email, false))
	if code != 200 || put["active"] != false {
		t.Fatalf("put active=false: %d %v", code, put)
	}
	if _, _, err := hs.acct.VerifyAccess(ctx, tokens.Access); err == nil {
		t.Fatal("a session from before deactivation still works")
	}
	if len(hs.disconnected) != 1 || hs.disconnected[0] != hcID || !hs.deactivatedAtDisconnect[0] {
		t.Fatalf("disconnect calls %v (deactivated at the time: %v), want one, after deactivation", hs.disconnected, hs.deactivatedAtDisconnect)
	}

	// Entra ID reactivates with a path-less PATCH and a string boolean.
	code, patched := hs.do("PATCH", "/Users/"+id, map[string]any{
		"schemas":    []string{schemaPatch},
		"Operations": []map[string]any{{"op": "Replace", "value": map[string]any{"active": "True"}}},
	})
	if code != 200 || patched["active"] != true {
		t.Fatalf("patch reactivate: %d %v", code, patched)
	}
	if _, _, _, err := hs.acct.LoginWithOidc(ctx, accounts.OidcProfile{Subject: sub, Email: email}, "d", "ip", true, false); err != nil {
		t.Fatalf("sso login after reactivation: %v", err)
	}

	// Okta deactivates with a pathed PATCH.
	code, _ = hs.do("PATCH", "/Users/"+id, map[string]any{
		"Operations": []map[string]any{{"op": "replace", "path": "active", "value": false}},
	})
	if code != 200 {
		t.Fatalf("patch deactivate: %d", code)
	}
	if _, _, _, err := hs.acct.LoginWithOidc(ctx, accounts.OidcProfile{Subject: sub, Email: email}, "d", "ip", true, false); err == nil {
		t.Fatal("sso login works after a PATCH deactivation")
	}

	// DELETE deactivates and detaches; the account and its data remain.
	if code, _ := hs.do("DELETE", "/Users/"+id, nil); code != http.StatusNoContent {
		t.Fatalf("delete: %d", code)
	}
	if code, _ := hs.do("GET", "/Users/"+id, nil); code != http.StatusNotFound {
		t.Fatalf("get after delete: %d, want 404", code)
	}
	if code, list := hs.do("GET", filterPath("/Users", `userName eq "`+userName+`"`), nil); code != 200 || list["totalResults"] != float64(0) {
		t.Fatalf("filter after delete: %d %v", code, list)
	}
	var stillThere int
	_ = hs.tx.QueryRow(ctx, `SELECT count(*) FROM "users" WHERE id = $1 AND "deactivated_at" IS NOT NULL`, hcID).Scan(&stillThere)
	if stillThere != 1 {
		t.Fatal("DELETE removed the account or left it active")
	}

	// The provider re-creates the person: same account, relinked and active.
	code, again := hs.do("POST", "/Users", userBody(userName, sub, email, true))
	if code != http.StatusCreated || again["active"] != true {
		t.Fatalf("re-create: %d %v", code, again)
	}
	if hs.hcUser(again["id"].(string)) != hcID {
		t.Fatal("re-create made a new account instead of relinking the old one")
	}
}

// An existing account is adopted only on the SSO linking rules; otherwise the
// create is a conflict and the follow-up lookup finds nothing to take over.
func TestCreateAdoption_DB(t *testing.T) {
	hs := newHarness(t, nil)
	ctx := context.Background()
	t.Setenv("OIDC_ALLOWED_EMAIL_DOMAINS", "")

	pwEmail := "pw-" + uuid.NewString()[:8] + "@example.com"
	if _, _, _, err := hs.acct.Signup(ctx, pwEmail, "a-strong-password", "PW"); err != nil {
		t.Fatal(err)
	}
	if code, body := hs.do("POST", "/Users", userBody("pw-user", "sub-"+uuid.NewString(), pwEmail, true)); code != http.StatusConflict {
		t.Fatalf("unvouched adoption: %d %v, want 409", code, body)
	}
	if _, list := hs.do("GET", filterPath("/Users", `userName eq "pw-user"`), nil); list["totalResults"] != float64(0) {
		t.Fatalf("the refused account is visible to the provider: %v", list)
	}

	sub := "sub-" + uuid.NewString()
	ssoEmail := "jit-" + uuid.NewString()[:8] + "@example.com"
	jit, _, _, err := hs.acct.LoginWithOidc(ctx, accounts.OidcProfile{Subject: sub, Email: ssoEmail, EmailVerified: true, Name: "JIT"}, "d", "ip", true, true)
	if err != nil {
		t.Fatal(err)
	}
	code, body := hs.do("POST", "/Users", userBody("jit-user", sub, ssoEmail, true))
	if code != http.StatusCreated || hs.hcUser(body["id"].(string)) != jit.ID {
		t.Fatalf("same-subject adoption: %d %v", code, body)
	}
}

func TestUserUpdateConflictsAndFilters_DB(t *testing.T) {
	hs := newHarness(t, nil)
	n := uuid.NewString()[:8]
	_, a := hs.do("POST", "/Users", userBody("a-"+n, "sub-a-"+n, "a-"+n+"@example.com", true))
	_, _ = hs.do("POST", "/Users", userBody("b-"+n, "sub-b-"+n, "b-"+n+"@example.com", true))
	if code, body := hs.do("PUT", "/Users/"+a["id"].(string), userBody("a-"+n, "sub-a-"+n, "b-"+n+"@example.com", true)); code != http.StatusConflict {
		t.Fatalf("email collision on PUT: %d %v", code, body)
	}
	if code, body := hs.do("GET", filterPath("/Users", `name co "x"`), nil); code != http.StatusBadRequest || body["scimType"] != "invalidFilter" {
		t.Fatalf("unsupported filter: %d %v", code, body)
	}
	code, list := hs.do("GET", filterPath("/Users", `externalId eq "sub-b-`+n+`"`), nil)
	if res, _ := list["Resources"].([]any); code != 200 || len(res) != 1 {
		t.Fatalf("externalId filter: %d %v", code, list)
	}
	code, list = hs.do("GET", filterPath("/Users", `emails.value eq "A-`+n+`@EXAMPLE.COM"`), nil)
	if res, _ := list["Resources"].([]any); code != 200 || len(res) != 1 {
		t.Fatalf("email filter is case-insensitive: %d %v", code, list)
	}
	if code, _ := hs.do("GET", "/Users/"+uuid.NewString(), nil); code != http.StatusNotFound {
		t.Fatalf("unknown id: %d", code)
	}
	if code, _ := hs.do("GET", "/Users/not-a-uuid", nil); code != http.StatusNotFound {
		t.Fatalf("malformed id: %d", code)
	}
}
