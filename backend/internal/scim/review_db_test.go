package scim

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"hycanvas/backend/internal/accounts"
)

func TestRecycledEmailSSOBeforeSCIM_DB(t *testing.T) {
	for _, domain := range []string{"", "example.com"} {
		t.Run(domain, func(t *testing.T) {
			t.Setenv("OIDC_ALLOWED_EMAIL_DOMAINS", domain)
			h := newHarness(t, nil)
			n := uuid.NewString()
			email := n + "@example.com"
			code, u := h.do("POST", "/Users", userBody(n, "old-"+n, email, true))
			if code != 201 {
				t.Fatal(code, u)
			}
			id := u["id"].(string)
			uid := h.hcUser(id)
			if code, _ := h.do("DELETE", "/Users/"+id, nil); code != 204 {
				t.Fatal(code)
			}
			_, _, _, err := h.acct.LoginWithOidc(context.Background(), accounts.OidcProfile{Subject: "new-" + n, Email: email, EmailVerified: true}, "", "", true, true)
			if !errors.Is(err, accounts.ErrAccountDisabled) {
				t.Fatal(err)
			}
			var count int
			if err := h.tx.QueryRow(context.Background(), `SELECT count(*) FROM auth_identities WHERE provider_subject=$1`, "new-"+n).Scan(&count); err != nil || count != 0 {
				t.Fatal(count, err)
			}
			if code, body := h.do("POST", "/Users", userBody("new-"+n, "new-"+n, email, true)); code != 409 {
				t.Fatal(code, body)
			}
			var off bool
			if err := h.tx.QueryRow(context.Background(), `SELECT deactivated_at IS NOT NULL FROM users WHERE id=$1`, uid).Scan(&off); err != nil || !off {
				t.Fatal(off, err)
			}
		})
	}
}

func TestPasswordsNeverStoredOrReturned_DB(t *testing.T) {
	h := newHarness(t, nil)
	n := uuid.NewString()
	body := userBody(n, n, n+"@example.com", true)
	body["Password"] = "cleartext-secret"
	code, u := h.do("POST", "/Users", body)
	if code != 201 {
		t.Fatal(code, u)
	}
	id := u["id"].(string)
	check := func(v any) {
		t.Helper()
		b, _ := json.Marshal(v)
		if strings.Contains(string(b), "cleartext-secret") {
			t.Fatal("password leaked", string(b))
		}
	}
	check(u)
	for _, method := range []string{"PUT", "PATCH", "PATCH"} {
		var payload any = body
		if method == "PATCH" {
			payload = map[string]any{"Operations": []any{map[string]any{"op": "replace", "path": "pAsSwOrD", "value": "cleartext-secret"}, map[string]any{"op": "add", "value": map[string]any{"PASSWORD": "cleartext-secret", "locale": "en"}}}}
		}
		code, u = h.do(method, "/Users/"+id, payload)
		if code != 200 {
			t.Fatal(code, u)
		}
		check(u)
		var raw string
		if err := h.tx.QueryRow(context.Background(), `SELECT attributes::text FROM scim_users WHERE id=$1`, id).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		check(raw)
	}
	for _, path := range []string{"/Users/" + id, "/Users"} {
		code, u = h.do("GET", path, nil)
		if code != 200 {
			t.Fatal(code)
		}
		check(u)
	}
}

func TestExternalIDImmutableAndDetachedRelinkRequiresBinding_DB(t *testing.T) {
	h := newHarness(t, nil)
	n := uuid.NewString()
	body := userBody(n, n, n+"@example.com", true)
	code, u := h.do("POST", "/Users", body)
	if code != 201 {
		t.Fatal(code, u)
	}
	id := u["id"].(string)
	uid := h.hcUser(id)
	changed := userBody(n, "different-"+n, n+"@example.com", true)
	for _, method := range []string{"PUT", "PATCH"} {
		var b any = changed
		if method == "PATCH" {
			b = map[string]any{"Operations": []any{map[string]any{"op": "replace", "path": "externalId", "value": "different-" + n}}}
		}
		if code, u := h.do(method, "/Users/"+id, b); code != 400 || u["scimType"] != "mutability" {
			t.Fatal(code, u)
		}
	}
	if code, _ := h.do("DELETE", "/Users/"+id, nil); code != 204 {
		t.Fatal(code)
	}
	changed = userBody(n, n, "changed-"+n+"@example.com", true)
	if code, u := h.do("POST", "/Users", changed); code != 409 {
		t.Fatal(code, u)
	}
	body["displayName"] = "Unrequested replacement"
	if code, restored := h.do("POST", "/Users", body); code != 201 || restored["displayName"] != "Alice Example" {
		t.Fatal("relink changed profile", code, restored)
	}
	if code, _ := h.do("DELETE", "/Users/"+id, nil); code != 204 {
		t.Fatal(code)
	}
	if _, err := h.tx.Exec(context.Background(), `DELETE FROM auth_identities WHERE user_id=$1 AND provider='OIDC'`, uid); err != nil {
		t.Fatal(err)
	}
	if code, u := h.do("POST", "/Users", body); code != 409 {
		t.Fatal(code, u)
	}
}

func TestDeleteClearsGroupGrants_DB(t *testing.T) {
	f := newGroupFixture(t, ModeAdditive)
	a, uid := f.provision("a")
	f.group(f.owners, a)
	if code, b := f.do("DELETE", "/Users/"+a, nil); code != 204 {
		t.Fatal(code, b)
	}
	var count int
	if err := f.tx.QueryRow(context.Background(), `SELECT count(*) FROM scim_group_members WHERE user_id=$1`, uid).Scan(&count); err != nil || count != 0 {
		t.Fatal(count, err)
	}
	if err := f.acct.ReactivateUser(context.Background(), uid); err != nil {
		t.Fatal(err)
	}
	if err := f.reconcileForTest(uid); err != nil {
		t.Fatal(err)
	}
	if got := f.membership(uid); got != "" {
		t.Fatal("old role restored", got)
	}
}
func (f *groupFixture) reconcileForTest(uid string) error {
	s := &Server{cfg: f.cfg}
	return s.reconcile(&op{ctx: context.Background(), tx: f.tx}, uid)
}

type refreshSpy struct {
	calls []string
	check func(string)
}

func (s *refreshSpy) RefreshUser(_ context.Context, id, reason string) {
	s.calls = append(s.calls, id)
	if s.check != nil {
		s.check(id)
	}
}
func TestMembershipRefreshAfterCommitAndNotRollback_DB(t *testing.T) {
	f := newGroupFixture(t, ModeAdditive)
	a, uid := f.provision("a")
	staff := f.group(f.staff, a)
	spy := &refreshSpy{}
	srv := NewServer(f.cfg, f.tx, testJWT, nil, nil).WithAccessRefresher(spy)
	// Reuse the harness logger to avoid depending on output.
	srv.log = slog.New(slog.NewTextHandler(io.Discard, nil))
	f.h = srv.Handler()
	spy.check = func(id string) {
		if id != uid || f.membership(uid) != "VIEWER/ACTIVE/scim" {
			t.Fatal("refresh before role committed", id, f.membership(uid))
		}
	}
	f.cfg.Groups[f.staff] = []Grant{{Workspace: f.slug, Role: RoleViewer}}
	f.patch(staff, addOp(a))
	if len(spy.calls) != 1 {
		t.Fatal(spy.calls)
	}
	spy.check = func(id string) {
		if id != uid || f.membership(uid) != "" {
			t.Fatal("refresh before removal", id)
		}
	}
	f.patch(staff, removeOp(a))
	if len(spy.calls) != 2 {
		t.Fatal(spy.calls)
	}
	// A queued refresh from a failed transaction must never reach the hub.
	req := httptest.NewRequest("PATCH", "/Users", nil)
	rec := httptest.NewRecorder()
	srv.run(rec, req, func(o *op) (int, any, error) {
		o.refresh = append(o.refresh, uid)
		return 0, nil, badRequest("invalidValue", "rollback")
	})
	if rec.Code != 400 || len(spy.calls) != 2 {
		t.Fatal(rec.Code, spy.calls)
	}
}

// Two independent HTTP requests adding the same mapped membership must both
// succeed. Refresh callbacks query another connection, proving commit precedes
// the callback rather than merely observing the request's own transaction.
func TestConcurrentMembershipAddsAndCommittedRefresh_DB(t *testing.T) {
	f := newGroupFixture(t, ModeAdditive)
	a, uid := f.provision("a")
	group := f.group(f.staff)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := f.tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM scim_groups WHERE id=$1`, group)
		_, _ = pool.Exec(context.Background(), `DELETE FROM workspaces WHERE owner_id=ANY($1::uuid[])`, []string{uid, f.owner})
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=ANY($1::uuid[])`, []string{uid, f.owner})
	}()
	srv := NewServer(f.cfg, pool, testJWT, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	h := srv.Handler()
	payload, _ := json.Marshal(map[string]any{"Operations": []any{addOp(a)}})
	start := make(chan struct{})
	result := make(chan int, 2)
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			req := httptest.NewRequest("PATCH", "/Groups/"+group, bytes.NewReader(payload)).WithContext(ctx)
			req.Header.Set("Authorization", "Bearer "+goodToken)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			result <- rec.Code
		}()
	}
	close(start)
	for i := 0; i < 2; i++ {
		if code := <-result; code != 200 {
			t.Fatal("concurrent add", code)
		}
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, f.wsID, uid).Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	spy := &refreshSpy{check: func(id string) {
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, f.wsID, id).Scan(&count); err != nil || count != 0 {
			t.Fatal("refresh before commit", count, err)
		}
	}}
	srv.WithAccessRefresher(spy)
	payload, _ = json.Marshal(map[string]any{"Operations": []any{removeOp(a)}})
	req := httptest.NewRequest("PATCH", "/Groups/"+group, bytes.NewReader(payload)).WithContext(ctx)
	req.Header.Set("Authorization", "Bearer "+goodToken)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 || len(spy.calls) != 1 {
		t.Fatal(rec.Code, spy.calls)
	}
}
