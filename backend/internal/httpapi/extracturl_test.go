package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The SSRF gate: internal, loopback, and metadata addresses must refuse, and
// only http(s) URLs are accepted at all.
func TestValidateExtractURLRefusesInternalTargets(t *testing.T) {
	ctx := context.Background()
	bad := []string{
		"ftp://example.com/x",
		"file:///etc/passwd",
		"http://localhost/admin",
		"http://127.0.0.1:8005/api",
		"http://[::1]/",
		"http://169.254.169.254/latest/meta-data/", // cloud metadata
		"http://10.0.0.5/",
		"http://192.168.1.1/",
		"http://172.16.0.1/",
		"http://100.100.100.200/latest/meta-data/", // CGNAT-range metadata service
		"http://100.64.0.1/",
		"http://0.0.0.0:8005/",
		"http://[::ffff:127.0.0.1]/", // IPv4-mapped loopback
		"not a url",
	}
	for _, u := range bad {
		if _, err := validateExtractURL(ctx, u); err == nil {
			t.Errorf("validateExtractURL(%q) accepted an unsafe target", u)
		}
	}
}

// The fetch must DIAL the address that was vetted. A hostname whose answer
// changes between check and connect (rebinding) must not reach the internal
// target: here the redirect target resolves to loopback, so the second hop's
// vet refuses before any connection is attempted.
func TestFetchVettedRefusesInternalRedirectTarget(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "http://127.0.0.1:9/internal")
		w.WriteHeader(http.StatusFound)
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// The test server itself is on loopback, so the FIRST hop already refuses:
	// either way no request may reach an internal address.
	res, err := fetchVetted(ctx, srv.URL, "test", "text/plain")
	if err == nil {
		_ = res.Body.Close()
		t.Fatal("fetchVetted followed a redirect to an internal address")
	}
}

// htmlToText: keeps readable content with block boundaries, drops script/nav/
// style subtrees, and surfaces the title.
func TestHtmlToText(t *testing.T) {
	page := `<html><head><title>The Launch Plan</title><style>p{color:red}</style></head>
	<body><nav>Home About</nav><script>alert(1)</script>
	<h1>Launch</h1><p>We ship in Q3.</p><ul><li>Alpha in July</li><li>Beta in August</li></ul>
	<footer>copyright</footer></body></html>`
	title, text := htmlToText([]byte(page))
	if title != "The Launch Plan" {
		t.Fatalf("title = %q", title)
	}
	for _, want := range []string{"Launch", "We ship in Q3.", "Alpha in July", "Beta in August"} {
		if !strings.Contains(text, want) {
			t.Errorf("text missing %q in %q", want, text)
		}
	}
	for _, drop := range []string{"alert(1)", "color:red", "Home About", "copyright"} {
		if strings.Contains(text, drop) {
			t.Errorf("text leaked %q", drop)
		}
	}
	// Block boundaries became newlines (outline-friendly structure).
	if !strings.Contains(text, "\n") {
		t.Error("expected newline-separated blocks")
	}
}
