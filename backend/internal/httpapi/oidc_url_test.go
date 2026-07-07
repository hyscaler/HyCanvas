package httpapi

import "testing"

func TestFrontendURLResolution(t *testing.T) {
	t.Setenv("FRONTEND_URL", "")
	t.Setenv("APP_URL", "")
	if got := frontendURL(); got != "http://localhost:3000" {
		t.Errorf("default = %q", got)
	}
	// Production single binary: only APP_URL is set and must win over the
	// dev default, or SSO redirects strand users on localhost:3000.
	t.Setenv("APP_URL", "https://hycanvas.art/")
	if got := frontendURL(); got != "https://hycanvas.art" {
		t.Errorf("APP_URL fallback = %q", got)
	}
	// Dev: the browser lives on the Next dev server, so an explicit
	// FRONTEND_URL takes precedence.
	t.Setenv("FRONTEND_URL", "http://localhost:3000/")
	if got := frontendURL(); got != "http://localhost:3000" {
		t.Errorf("FRONTEND_URL precedence = %q", got)
	}
}
