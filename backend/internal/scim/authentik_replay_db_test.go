package scim

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"github.com/google/uuid"
)

// The request sequence Authentik's SCIM client sends, with its payload shapes,
// taken from authentik/providers/scim/clients/users.py and groups.py (AC-3).
// Authentik is the identity provider this was built against; the shapes matter
// because its client changes behaviour on status codes and advertised features.

// authentikUser is the default "authentik default SCIM Mapping: User" output
// plus the externalId the client adds (user.uid), with unset optionals sent as
// null, as its exclude_unset dump does for explicitly-None fields.
func authentikUser(username, uid, email string, active bool) map[string]any {
	return map[string]any{
		"schemas":     []string{schemaUser},
		"userName":    username,
		"name":        map[string]any{"formatted": "Ada Lovelace", "givenName": "Ada", "familyName": "Lovelace"},
		"displayName": "Ada Lovelace",
		"photos":      nil,
		"locale":      nil,
		"active":      active,
		"emails":      []map[string]any{{"value": email, "type": "other", "primary": true}},
		"externalId":  uid,
	}
}

// unchangedForAuthentik mirrors Authentik's diff(): it merges its next payload
// into our last response and re-sends only if that changes anything. A response
// that drops or rewrites what it sent means a PUT for every user on every sync.
func unchangedForAuthentik(t *testing.T, response, payload map[string]any) {
	t.Helper()
	norm := func(v any) any {
		b, _ := json.Marshal(v)
		var out any
		_ = json.Unmarshal(b, &out)
		return out
	}
	for k, v := range payload {
		if !reflect.DeepEqual(norm(response[k]), norm(v)) {
			t.Errorf("response %s = %v, Authentik sent %v: it would re-send this user every sync", k, response[k], v)
		}
	}
}

func TestAuthentikReplay_DB(t *testing.T) {
	cfg := &Config{Token: goodToken, Groups: map[string][]Grant{}, Modes: map[string]Mode{}}
	hs := newHarness(t, cfg)
	n := uuid.NewString()[:8]

	// The client reads the provider config first and branches on it.
	code, spc := hs.do("GET", "/ServiceProviderConfig", nil)
	if code != 200 || spc["patch"].(map[string]any)["supported"] != true || spc["filter"].(map[string]any)["supported"] != true {
		t.Fatalf("ServiceProviderConfig: %d %v", code, spc)
	}

	// Create.
	payload := authentikUser("ada-"+n, "uid-"+n, "ada-"+n+"@example.com", true)
	code, created := hs.do("POST", "/Users", payload)
	if code != http.StatusCreated {
		t.Fatalf("create: %d %v", code, created)
	}
	id := created["id"].(string)
	unchangedForAuthentik(t, created, payload)

	// Lost connection object: create again, 409, then the userName lookup it
	// does to adopt the existing resource.
	if code, _ := hs.do("POST", "/Users", payload); code != http.StatusConflict {
		t.Fatalf("re-create: %d, want 409", code)
	}
	code, list := hs.do("GET", filterPath("/Users", `userName eq "ada-`+n+`"`), nil)
	if res, _ := list["Resources"].([]any); code != 200 || len(res) != 1 || res[0].(map[string]any)["id"] != id {
		t.Fatalf("adopt lookup: %d %v", code, list)
	}

	// Deactivate: a full PUT with active false.
	off := authentikUser("ada-"+n, "uid-"+n, "ada-"+n+"@example.com", false)
	code, put := hs.do("PUT", "/Users/"+id, off)
	if code != 200 || put["active"] != false {
		t.Fatalf("deactivate PUT: %d %v", code, put)
	}
	unchangedForAuthentik(t, put, off)

	// Group create without members: with PATCH supported the client deletes the
	// member list from the create payload and adds members by PATCH.
	cfg.Groups["ak-staff-"+n] = []Grant{{Workspace: "unused-" + n, Role: RoleMember}}
	code, g := hs.do("POST", "/Groups", map[string]any{"schemas": []string{schemaGroup}, "displayName": "ak-staff-" + n, "externalId": "pk-" + n})
	if code != http.StatusCreated {
		t.Fatalf("group create: %d %v", code, g)
	}
	gid := g["id"].(string)

	code, _ = hs.do("PATCH", "/Groups/"+gid, map[string]any{"schemas": []string{schemaPatch}, "Operations": []map[string]any{
		{"op": "add", "path": "members", "value": []map[string]any{{"value": id}}},
	}})
	if code != 200 {
		t.Fatalf("member add: %d", code)
	}

	// Attribute update: path-less replace of the group minus id, WITHOUT a
	// members key. Reading the missing key as "no members" would empty the group.
	code, upd := hs.do("PATCH", "/Groups/"+gid, map[string]any{"schemas": []string{schemaPatch}, "Operations": []map[string]any{
		{"op": "replace", "value": map[string]any{"schemas": []string{schemaGroup}, "displayName": "ak-staff-" + n, "externalId": "pk-" + n}},
	}})
	if ms, _ := upd["members"].([]any); code != 200 || len(ms) != 1 {
		t.Fatalf("path-less replace emptied the group: %d %v", code, upd)
	}

	code, _ = hs.do("PATCH", "/Groups/"+gid, map[string]any{"schemas": []string{schemaPatch}, "Operations": []map[string]any{
		{"op": "remove", "path": `members[value eq "` + id + `"]`},
	}})
	if code != 200 {
		t.Fatalf("member remove: %d", code)
	}
	if _, got := hs.do("GET", "/Groups/"+gid, nil); len(got["members"].([]any)) != 0 {
		t.Fatalf("member not removed: %v", got["members"])
	}

	if code, _ := hs.do("DELETE", "/Groups/"+gid, nil); code != http.StatusNoContent {
		t.Fatalf("group delete: %d, want 204", code)
	}
	if code, _ := hs.do("DELETE", "/Users/"+id, nil); code != http.StatusNoContent {
		t.Fatalf("user delete: %d, want 204", code)
	}
}
