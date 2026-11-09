package scim

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// groupFixture is a team workspace with a hand-made owner, and a config whose
// group names are unique to this test (the tests share one database).
type groupFixture struct {
	*harness
	cfg    *Config
	n      string
	wsID   string
	slug   string
	owner  string // HyCanvas id of the workspace's hand-made owner
	staff  string // group display names
	admins string
	owners string
}

func newGroupFixture(t *testing.T, mode Mode) *groupFixture {
	t.Helper()
	cfg := &Config{Token: goodToken, Groups: map[string][]Grant{}, Modes: map[string]Mode{}}
	f := &groupFixture{harness: newHarness(t, cfg), cfg: cfg, n: uuid.NewString()[:8]}
	ctx := context.Background()
	o, _, _, err := f.acct.Signup(ctx, "owner-"+f.n+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatal(err)
	}
	f.owner = o.ID
	ws, err := f.acct.CreateWorkspace(ctx, o.ID, "Team "+f.n, "TEAM")
	if err != nil {
		t.Fatal(err)
	}
	f.wsID, f.slug = ws.ID, ws.Slug
	f.staff, f.admins, f.owners = "staff-"+f.n, "admins-"+f.n, "owners-"+f.n
	cfg.Groups[f.staff] = []Grant{{Workspace: f.slug, Role: RoleMember}}
	cfg.Groups[f.admins] = []Grant{{Workspace: f.slug, Role: RoleAdmin}}
	cfg.Groups[f.owners] = []Grant{{Workspace: f.slug, Role: RoleOwner}}
	if mode == ModeAuthoritative {
		cfg.Modes[f.slug] = ModeAuthoritative
	}
	return f
}

// provision creates a SCIM user and returns its SCIM id and HyCanvas id.
func (f *groupFixture) provision(name string) (string, string) {
	f.t.Helper()
	code, body := f.do("POST", "/Users", userBody(name+"-"+f.n, "sub-"+name+"-"+f.n, name+"-"+f.n+"@example.com", true))
	if code != http.StatusCreated {
		f.t.Fatalf("provision %s: %d %v", name, code, body)
	}
	id := body["id"].(string)
	return id, f.hcUser(id)
}

func (f *groupFixture) group(name string, members ...string) string {
	f.t.Helper()
	ms := []map[string]any{}
	for _, m := range members {
		ms = append(ms, map[string]any{"value": m})
	}
	code, body := f.do("POST", "/Groups", map[string]any{"schemas": []string{schemaGroup}, "displayName": name, "externalId": uuid.NewString(), "members": ms})
	if code != http.StatusCreated {
		f.t.Fatalf("create group %s: %d %v", name, code, body)
	}
	return body["id"].(string)
}

func (f *groupFixture) patch(groupID string, ops ...map[string]any) {
	f.t.Helper()
	if code, body := f.do("PATCH", "/Groups/"+groupID, map[string]any{"schemas": []string{schemaPatch}, "Operations": ops}); code != http.StatusOK && code != http.StatusNoContent {
		f.t.Fatalf("patch group: %d %v", code, body)
	}
}

func addOp(ids ...string) map[string]any {
	ms := []map[string]any{}
	for _, id := range ids {
		ms = append(ms, map[string]any{"value": id})
	}
	return map[string]any{"op": "add", "path": "members", "value": ms}
}

func removeOp(id string) map[string]any {
	return map[string]any{"op": "remove", "path": `members[value eq "` + id + `"]`}
}

// membership is "<ROLE>/<STATUS>/<managed>" or "" when there is none.
func (f *groupFixture) membership(userID string) string {
	f.t.Helper()
	var role, status string
	var managed bool
	err := f.tx.QueryRow(context.Background(),
		`SELECT role::text, status::text, "managed_by_scim" FROM "workspace_members" WHERE "workspace_id" = $1 AND "user_id" = $2`,
		f.wsID, userID).Scan(&role, &status, &managed)
	if err != nil {
		return ""
	}
	m := "hand"
	if managed {
		m = "scim"
	}
	return role + "/" + status + "/" + m
}

func (f *groupFixture) handMember(name, role string) string {
	f.t.Helper()
	u, _, _, err := f.acct.Signup(context.Background(), name+"-"+f.n+"@example.com", "a-strong-password", name)
	if err != nil {
		f.t.Fatal(err)
	}
	if _, err := f.tx.Exec(context.Background(),
		`INSERT INTO "workspace_members" (id, "workspace_id", "user_id", role, status, "joined_at", "updated_at") VALUES ($1, $2, $3, $4, 'ACTIVE', now(), now())`,
		uuid.NewString(), f.wsID, u.ID, role); err != nil {
		f.t.Fatal(err)
	}
	return u.ID
}

func TestGroupGrantsMappedRole_DB(t *testing.T) {
	f := newGroupFixture(t, ModeAdditive)
	a, aID := f.provision("a")

	staff := f.group(f.staff, a)
	if got := f.membership(aID); got != "MEMBER/ACTIVE/scim" {
		t.Fatalf("after staff create: %q", got)
	}
	admins := f.group(f.admins)
	f.patch(admins, addOp(a))
	if got := f.membership(aID); got != "ADMIN/ACTIVE/scim" {
		t.Fatalf("highest role should win: %q", got)
	}
	f.patch(admins, removeOp(a))
	if got := f.membership(aID); got != "MEMBER/ACTIVE/scim" {
		t.Fatalf("after leaving admins: %q", got)
	}
	f.patch(staff, removeOp(a))
	if got := f.membership(aID); got != "" {
		t.Fatalf("after leaving every mapped group: %q, want no membership", got)
	}

	code, list := f.do("GET", filterPath("/Groups", `displayName eq "`+f.staff+`"`), nil)
	if res, _ := list["Resources"].([]any); code != 200 || len(res) != 1 || res[0].(map[string]any)["id"] != staff {
		t.Fatalf("group filter: %d %v", code, list)
	}
}

// AC-6, additive half: a membership SCIM did not create is never changed.
func TestAdditiveLeavesHandMembershipsAlone_DB(t *testing.T) {
	f := newGroupFixture(t, ModeAdditive)
	guest := f.handMember("guest", "VIEWER")
	a, aID := f.provision("a")
	// The provisioned person also has a hand-made membership.
	if _, err := f.tx.Exec(context.Background(),
		`INSERT INTO "workspace_members" (id, "workspace_id", "user_id", role, status, "joined_at", "updated_at") VALUES ($1, $2, $3, 'VIEWER', 'ACTIVE', now(), now())`,
		uuid.NewString(), f.wsID, aID); err != nil {
		t.Fatal(err)
	}
	staff := f.group(f.staff, a)
	if got := f.membership(aID); got != "VIEWER/ACTIVE/hand" {
		t.Fatalf("additive changed a hand-made membership: %q", got)
	}
	f.patch(staff, removeOp(a))
	if got := f.membership(aID); got != "VIEWER/ACTIVE/hand" {
		t.Fatalf("additive removed a hand-made membership: %q", got)
	}
	if got := f.membership(guest); got != "VIEWER/ACTIVE/hand" {
		t.Fatalf("additive touched a guest: %q", got)
	}
}

// AC-6, authoritative half, and AC-7: the provider is the source of truth, but
// the last owner is never removed and the request still succeeds.
func TestAuthoritative_DB(t *testing.T) {
	f := newGroupFixture(t, ModeAuthoritative)
	guest := f.handMember("guest", "VIEWER")
	a, aID := f.provision("a")

	f.group(f.staff, a)
	if got := f.membership(aID); got != "MEMBER/ACTIVE/scim" {
		t.Fatalf("desired member: %q", got)
	}
	if got := f.membership(guest); got != "VIEWER/ACTIVE/hand" {
		t.Fatalf("unrelated sync changed an untouched guest: %q", got)
	}
	if got := f.membership(f.owner); got != "OWNER/ACTIVE/hand" {
		t.Fatalf("the last owner was removed: %q", got)
	}

	// Another owner does not make an unrelated request sweep the creator.
	f.group(f.owners, a)
	if got := f.membership(aID); got != "OWNER/ACTIVE/scim" {
		t.Fatalf("mapped owner: %q", got)
	}
	f.patch(f.groupID(f.staff), removeOp(a)) // only A is touched
	if got := f.membership(f.owner); got != "OWNER/ACTIVE/hand" {
		t.Fatalf("unrelated sync changed the creator: %q", got)
	}
	// An explicitly touched member is still removed when their final grant goes.
	f.patch(f.groupID(f.owners), removeOp(a))
	if got := f.membership(aID); got != "" {
		t.Fatalf("touched member kept an obsolete grant: %q", got)
	}
}

func (f *groupFixture) groupID(name string) string {
	f.t.Helper()
	var id string
	if err := f.tx.QueryRow(context.Background(), `SELECT id FROM "scim_groups" WHERE "display_name" = $1`, name).Scan(&id); err != nil {
		f.t.Fatal(err)
	}
	return id
}

// AC-7 in additive mode: removing the only owner from the owners group would
// leave the workspace ownerless, so that one change is skipped.
func TestLastOwnerGuardAdditive_DB(t *testing.T) {
	f := newGroupFixture(t, ModeAdditive)
	a, aID := f.provision("a")
	owners := f.group(f.owners, a)
	if _, err := f.tx.Exec(context.Background(), `DELETE FROM "workspace_members" WHERE "workspace_id" = $1 AND "user_id" = $2`, f.wsID, f.owner); err != nil {
		t.Fatal(err)
	}
	f.patch(owners, removeOp(a))
	if got := f.membership(aID); got != "OWNER/ACTIVE/scim" {
		t.Fatalf("the last owner was removed: %q", got)
	}
}

// FR-9: deactivation suspends; reconcile leaves a deactivated person alone, and
// reactivation then applies what changed meanwhile.
func TestDeactivatedMemberIsNotReconciled_DB(t *testing.T) {
	f := newGroupFixture(t, ModeAdditive)
	a, aID := f.provision("a")
	staff := f.group(f.staff, a)
	if code, _ := f.do("PATCH", "/Users/"+a, map[string]any{"Operations": []map[string]any{{"op": "replace", "path": "active", "value": false}}}); code != 200 {
		t.Fatal("deactivate failed")
	}
	if got := f.membership(aID); got != "MEMBER/SUSPENDED/scim" {
		t.Fatalf("after deactivation: %q", got)
	}
	f.patch(staff, removeOp(a))
	if got := f.membership(aID); got != "MEMBER/SUSPENDED/scim" {
		t.Fatalf("reconcile touched a deactivated person: %q", got)
	}
	if code, _ := f.do("PATCH", "/Users/"+a, map[string]any{"Operations": []map[string]any{{"op": "replace", "path": "active", "value": true}}}); code != 200 {
		t.Fatal("reactivate failed")
	}
	if got := f.membership(aID); got != "" {
		t.Fatalf("after reactivation the group they left should no longer grant access: %q", got)
	}
}

// AC-9: group DELETE is always 204, and a mapped group's grants go with it.
func TestGroupDelete_DB(t *testing.T) {
	f := newGroupFixture(t, ModeAdditive)
	a, aID := f.provision("a")
	staff := f.group(f.staff, a)
	unmapped := f.group("unmapped-" + f.n)
	if code, _ := f.do("DELETE", "/Groups/"+staff, nil); code != http.StatusNoContent {
		t.Fatalf("delete mapped group: %d", code)
	}
	if got := f.membership(aID); got != "" {
		t.Fatalf("a deleted group still grants: %q", got)
	}
	if code, _ := f.do("DELETE", "/Groups/"+unmapped, nil); code != http.StatusNoContent {
		t.Fatalf("delete unmapped group: %d", code)
	}
	if code, _ := f.do("GET", "/Groups/"+staff, nil); code != http.StatusNotFound {
		t.Fatalf("get deleted group: %d", code)
	}
}

func TestGroupMembersEdgeCases_DB(t *testing.T) {
	f := newGroupFixture(t, ModeAdditive)
	a, aID := f.provision("a")
	b, bID := f.provision("b")
	// Unknown and malformed member ids are ignored, not a 400 (FR-23).
	staff := f.group(f.staff, a, uuid.NewString(), "not-a-uuid")
	// A duplicate displayName is a uniqueness conflict, so Authentik looks it up.
	if code, body := f.do("POST", "/Groups", map[string]any{"displayName": f.staff}); code != http.StatusConflict || body["scimType"] != "uniqueness" {
		t.Fatalf("duplicate group: %d %v", code, body)
	}
	// PUT replaces the member list.
	code, put := f.do("PUT", "/Groups/"+staff, map[string]any{"displayName": f.staff, "members": []map[string]any{{"value": b}}})
	if code != 200 {
		t.Fatalf("put: %d %v", code, put)
	}
	if f.membership(aID) != "" || f.membership(bID) != "MEMBER/ACTIVE/scim" {
		t.Fatalf("after PUT: a=%q b=%q", f.membership(aID), f.membership(bID))
	}
	if ms, _ := put["members"].([]any); len(ms) != 1 || ms[0].(map[string]any)["value"] != b {
		t.Fatalf("PUT response members: %v", put["members"])
	}
	// Renaming a group to an unmapped name withdraws what it granted.
	f.patch(staff, map[string]any{"op": "replace", "path": "displayName", "value": "renamed-" + f.n})
	if got := f.membership(bID); got != "" {
		t.Fatalf("renamed group still grants: %q", got)
	}
}
