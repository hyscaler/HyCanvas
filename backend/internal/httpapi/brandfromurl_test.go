package httpapi

// Brand kit draft from a domain (F28 T21): the deterministic page scan over
// fixture HTML. The SSRF gate itself is covered by the extract-url tests
// (shared fetchVetted/vetHop path).

import (
	"net/url"
	"strings"
	"testing"
)

func mustURL(t *testing.T, s string) *url.URL {
	t.Helper()
	u, err := url.Parse(s)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

const brandFixture = `<!doctype html>
<html><head>
<title>Acme Robotics - Build faster</title>
<meta name="description" content="Industrial robots for small teams.">
<meta name="theme-color" content="#e63946">
<meta property="og:image" content="/social/card.png">
<link rel="apple-touch-icon" href="/icons/apple-180.png">
<link rel="icon" href="favicon.ico">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Work+Sans">
<style>
  :root { --brand: #e63946; --accent: #1d3557; }
  h1 { color: #e63946; font-family: "Space Grotesk", sans-serif; }
  p  { color: #1d3557; font-family: Work Sans, sans-serif; }
  a  { color: #1d3557; }
  .card { background: #ffffff; border: 1px solid #000; }
</style>
</head><body>
<img src="/img/acme-logo.svg" alt="Acme Robotics logo">
<div style="color:#457b9d; font-family: var(--font-body)">hello</div>
</body></html>`

func TestScanBrandHTML(t *testing.T) {
	base := mustURL(t, "https://acme.example/products/")
	scan := scanBrandHTML([]byte(brandFixture), base)

	if scan.Title != "Acme Robotics - Build faster" {
		t.Fatalf("title = %q", scan.Title)
	}
	if scan.ThemeColor != "#e63946" {
		t.Fatalf("theme color = %q", scan.ThemeColor)
	}
	// Palette: theme-color first, then observed hexes by frequency; the pure
	// white/black chrome never makes the list.
	if len(scan.Colors) < 3 {
		t.Fatalf("colors = %v", scan.Colors)
	}
	if scan.Colors[0] != "#e63946" {
		t.Fatalf("theme color must lead: %v", scan.Colors)
	}
	if scan.Colors[1] != "#1d3557" { // 3 occurrences beat 1
		t.Fatalf("frequency order wrong: %v", scan.Colors)
	}
	for _, c := range scan.Colors {
		if c == "#ffffff" || c == "#000000" {
			t.Fatalf("near-extreme chrome color leaked into the palette: %v", scan.Colors)
		}
	}
	// Logos: the logo-hinted <img> outranks icons; relative refs resolve
	// against the page origin; the social card is still a candidate.
	if len(scan.LogoURLs) < 3 {
		t.Fatalf("logos = %v", scan.LogoURLs)
	}
	if scan.LogoURLs[0] != "https://acme.example/img/acme-logo.svg" {
		t.Fatalf("logo priority wrong: %v", scan.LogoURLs)
	}
	joined := strings.Join(scan.LogoURLs, " ")
	if !strings.Contains(joined, "https://acme.example/icons/apple-180.png") ||
		!strings.Contains(joined, "https://acme.example/products/favicon.ico") ||
		!strings.Contains(joined, "https://acme.example/social/card.png") {
		t.Fatalf("logo resolution wrong: %v", scan.LogoURLs)
	}
	// Fonts: webfont link families lead (deduped against CSS declarations);
	// generic families and var() declarations never appear.
	if len(scan.Fonts) != 2 || scan.Fonts[0] != "Space Grotesk" || scan.Fonts[1] != "Work Sans" {
		t.Fatalf("fonts = %v", scan.Fonts)
	}
}

func TestScanBrandHTMLDegenerateInputs(t *testing.T) {
	base := mustURL(t, "https://x.example/")
	// Not HTML at all: no signals, no panic.
	scan := scanBrandHTML([]byte("just some text"), base)
	if len(scan.Colors) != 0 || len(scan.LogoURLs) != 0 || len(scan.Fonts) != 0 {
		t.Fatalf("plain text produced signals: %+v", scan)
	}
	// Three-digit hexes expand; javascript: logo refs are refused.
	scan = scanBrandHTML([]byte(`<html><head><style>a{color:#1d3;}</style></head><body><img src="javascript:alert(1)" class="logo"></body></html>`), base)
	if len(scan.Colors) != 1 || scan.Colors[0] != "#11dd33" {
		t.Fatalf("short hex expansion wrong: %v", scan.Colors)
	}
	if len(scan.LogoURLs) != 0 {
		t.Fatalf("non-http logo ref accepted: %v", scan.LogoURLs)
	}
}
