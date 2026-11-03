package scim

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestParseFilter(t *testing.T) {
	allowed := []string{"userName", "externalId", "emails.value"}
	for in, want := range map[string][2]string{
		`userName eq "alice"`:             {"userName", "alice"},
		`USERNAME EQ "Alice"`:             {"userName", "Alice"},
		`externalId eq "a b \"c\""`:       {"externalId", `a b "c"`},
		`emails.value eq "a@example.com"`: {"emails.value", "a@example.com"},
		`  userName   eq   "padded"  `:    {"userName", "padded"},
	} {
		attr, val, err := parseFilter(in, allowed)
		if err != nil || attr != want[0] || val != want[1] {
			t.Errorf("%s: got %q %q %v, want %q %q", in, attr, val, err, want[0], want[1])
		}
	}
	for _, bad := range []string{
		`userName co "a"`,
		`userName eq "a" and active eq true`,
		`displayName eq "a"`,
		`userName eq alice`,
		`userName eq "unterminated`,
		``,
	} {
		if _, _, err := parseFilter(bad, allowed); err == nil {
			t.Errorf("%q: accepted, want invalidFilter", bad)
		}
	}
}

func TestParsePatchShapes(t *testing.T) {
	// Authentik and Okta: lower-case op, a path, a members array.
	ops, err := parsePatch([]byte(`{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
		"Operations":[{"op":"add","path":"members","value":[{"value":"u1"}]},{"op":"remove","path":"members[value eq \"u2\"]"}]}`))
	if err != nil || len(ops) != 2 || ops[0].Op != "add" || ops[1].Op != "remove" || ops[1].Path != `members[value eq "u2"]` {
		t.Fatalf("authentik shape: %+v %v", ops, err)
	}
	// Entra ID: capitalised op, no path, the change as an object.
	ops, err = parsePatch([]byte(`{"Operations":[{"op":"Replace","value":{"active":false}}]}`))
	if err != nil || len(ops) != 1 || ops[0].Op != "replace" || ops[0].Path != "" || !strings.Contains(string(ops[0].Value), "active") {
		t.Fatalf("entra shape: %+v %v", ops, err)
	}
	for _, bad := range []string{`{"Operations":[{"op":"move","path":"x"}]}`, `{"Operations":[]}`, `not json`} {
		if _, err := parsePatch([]byte(bad)); err == nil {
			t.Errorf("%s: accepted", bad)
		}
	}
}

func TestPaging(t *testing.T) {
	for q, want := range map[string][2]int{
		"":                        {1, 100},
		"startIndex=5&count=10":   {5, 10},
		"startIndex=0&count=1000": {1, 100},
		"startIndex=-3&count=-1":  {1, 0},
		"startIndex=x&count=y":    {1, 100},
	} {
		v, _ := url.ParseQuery(q)
		start, count := paging(v)
		if start != want[0] || count != want[1] {
			t.Errorf("%q: got %d,%d want %d,%d", q, start, count, want[0], want[1])
		}
	}
}

func TestErrorBodyIsSCIM(t *testing.T) {
	rec := httptest.NewRecorder()
	writeError(rec, http.StatusConflict, "uniqueness", "taken")
	if rec.Code != 409 || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/scim+json") {
		t.Fatalf("status %d, content-type %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["status"] != "409" || body["scimType"] != "uniqueness" || body["schemas"].([]any)[0] != schemaError {
		t.Fatalf("body %v", body)
	}
}

// Authentik changes its behaviour on these flags, so they must match what is
// implemented: PATCH and filter yes, the rest no.
func TestServiceProviderConfigAdvertisesWhatIsImplemented(t *testing.T) {
	rec := httptest.NewRecorder()
	serviceProviderConfig(rec, httptest.NewRequest(http.MethodGet, "/ServiceProviderConfig", nil))
	var spc map[string]map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &spc)
	for feature, want := range map[string]bool{"patch": true, "filter": true, "bulk": false, "sort": false, "etag": false, "changePassword": false} {
		if got, _ := spc[feature]["supported"].(bool); got != want {
			t.Errorf("%s.supported = %v, want %v", feature, got, want)
		}
	}
}
