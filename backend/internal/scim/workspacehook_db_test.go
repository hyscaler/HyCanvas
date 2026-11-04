package scim

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// A provisioned account's personal workspace gets the same set-up as any new
// workspace (the starter brand kit), once, and only after the request commits.
func TestProvisionedWorkspaceRunsTheWorkspaceHook_DB(t *testing.T) {
	hs := newHarness(t, nil)
	type call struct{ ws, owner string }
	var calls []call
	srv := NewServer(&Config{Token: goodToken}, hs.tx, testJWT, nil, slog.New(slog.NewTextHandler(io.Discard, nil))).
		WithWorkspaceHook(func(_ context.Context, ws, owner string) { calls = append(calls, call{ws, owner}) })
	hs.h = srv.Handler()

	n := uuid.NewString()[:8]
	code, body := hs.do("POST", "/Users", userBody("hook-"+n, "sub-hook-"+n, "hook-"+n+"@example.com", true))
	if code != http.StatusCreated {
		t.Fatalf("create: %d %v", code, body)
	}
	owner := hs.hcUser(body["id"].(string))
	var personal string
	if err := hs.tx.QueryRow(context.Background(), `SELECT id FROM "workspaces" WHERE "owner_id" = $1 AND kind = 'PERSONAL'`, owner).Scan(&personal); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || calls[0] != (call{personal, owner}) {
		t.Fatalf("hook calls %v, want one for the personal workspace %s of %s", calls, personal, owner)
	}
	// An update creates no workspace.
	hs.do("PUT", "/Users/"+body["id"].(string), userBody("hook-"+n, "sub-hook-"+n, "hook-"+n+"@example.com", true))
	if len(calls) != 1 {
		t.Fatalf("an update ran the workspace hook: %v", calls)
	}
}
