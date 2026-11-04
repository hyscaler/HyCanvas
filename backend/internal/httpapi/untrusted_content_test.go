package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// A user-uploaded SVG served from the app origin runs its script with the
// viewer's session unless the response is sandboxed. Pin the policy so a later
// edit cannot quietly re-enable script or drop nosniff.
func TestUntrustedContentHeadersSandboxTheResponse(t *testing.T) {
	rec := httptest.NewRecorder()
	setUntrustedContentHeaders(rec)

	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, want nosniff", got)
	}
	csp := rec.Header().Get("Content-Security-Policy")
	directives := map[string]string{}
	for _, d := range strings.Split(csp, ";") {
		f := strings.Fields(d)
		if len(f) == 0 {
			continue
		}
		directives[f[0]] = strings.Join(f[1:], " ")
	}
	sandbox, ok := directives["sandbox"]
	if !ok {
		t.Fatalf("CSP %q has no sandbox directive", csp)
	}
	if strings.Contains(sandbox, "allow-scripts") || strings.Contains(sandbox, "allow-same-origin") {
		t.Fatalf("sandbox %q must not allow scripts or the app origin", sandbox)
	}
	if directives["default-src"] != "'none'" {
		t.Fatalf("default-src = %q, want 'none'", directives["default-src"])
	}
	if _, ok := directives["script-src"]; ok {
		t.Fatalf("CSP %q must not grant script-src", csp)
	}
}
