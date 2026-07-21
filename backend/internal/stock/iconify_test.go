package stock

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// iconifyServer stands in for api.iconify.design: /search returns ordered ids
// across two sets, /collections carries their licenses (one CC-BY, one MIT),
// and each /{prefix}.json returns the requested icon bodies.
func iconifyServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/search":
			// mdi first (MIT-ish per collections below), then a CC-BY set.
			_, _ = w.Write([]byte(`{"icons":["mdi:home","mdi:heart","openmoji:cat"]}`))
		case r.URL.Path == "/collections":
			_, _ = w.Write([]byte(`{
				"mdi": {"license": {"title": "Apache 2.0", "spdx": "Apache-2.0", "url": "https://example.com/mdi"}},
				"openmoji": {"license": {"title": "CC BY-SA 4.0", "spdx": "CC-BY-SA-4.0", "url": "https://example.com/openmoji"}}
			}`))
		case r.URL.Path == "/mdi.json":
			icons := r.URL.Query().Get("icons")
			if !strings.Contains(icons, "home") || !strings.Contains(icons, "heart") {
				t.Errorf("mdi bulk missing icons: %q", icons)
			}
			_, _ = w.Write([]byte(`{"prefix":"mdi","width":24,"height":24,"icons":{
				"home":{"body":"<path fill=\"currentColor\" d=\"M10 20v-6h4v6z\"/>"},
				"heart":{"body":"<path fill=\"currentColor\" d=\"m12 21l-1-1z\"/>"}
			}}`))
		case r.URL.Path == "/openmoji.json":
			_, _ = w.Write([]byte(`{"prefix":"openmoji","width":72,"height":72,"icons":{
				"cat":{"body":"<circle cx=\"36\" cy=\"36\" r=\"30\"/>"}
			}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func TestIconifySearchAssemblesInlineSVGAndLicense(t *testing.T) {
	srv := iconifyServer(t)
	defer srv.Close()
	ic := newIconify()
	ic.baseURL = srv.URL

	assets := ic.search(context.Background(), Query{Kind: "icon", Text: "home", Limit: 60})
	if len(assets) != 3 {
		t.Fatalf("want 3 assets, got %d", len(assets))
	}

	// Relevance order preserved (search order), each carries inline SVG.
	if assets[0]["id"] != "iconify-mdi-home" {
		t.Errorf("first asset id = %v, want iconify-mdi-home", assets[0]["id"])
	}
	svg, _ := assets[0]["svg"].(string)
	if !strings.HasPrefix(svg, "<svg") || !strings.Contains(svg, `viewBox="0 0 24 24"`) || !strings.Contains(svg, "M10 20v-6h4v6z") {
		t.Errorf("assembled svg wrong: %q", svg)
	}
	if assets[0]["format"] != "svg" || assets[0]["kind"] != "icon" {
		t.Errorf("format/kind wrong: %v / %v", assets[0]["format"], assets[0]["kind"])
	}

	// License per set: mdi Apache (no attribution), openmoji CC-BY-SA (attribution).
	mdiLic := assets[0]["license"].(map[string]any)
	if mdiLic["type"] != "Apache-2.0" || mdiLic["attributionRequired"] != false {
		t.Errorf("mdi license wrong: %+v", mdiLic)
	}
	var catLic map[string]any
	for _, a := range assets {
		if a["id"] == "iconify-openmoji-cat" {
			catLic = a["license"].(map[string]any)
			// openmoji is 72x72 -> viewBox must reflect the set dimensions.
			if s, _ := a["svg"].(string); !strings.Contains(s, `viewBox="0 0 72 72"`) {
				t.Errorf("openmoji viewBox wrong: %q", s)
			}
		}
	}
	if catLic == nil || catLic["type"] != "CC-BY-SA-4.0" || catLic["attributionRequired"] != true {
		t.Errorf("openmoji license wrong: %+v", catLic)
	}
}

func TestIconifyDisabledAndEmpty(t *testing.T) {
	// Disabled provider returns nil (seed fallback).
	ic := newIconify()
	ic.enabled = false
	if got := ic.search(context.Background(), Query{Kind: "icon", Text: "home"}); got != nil {
		t.Errorf("disabled search should be nil, got %d", len(got))
	}

	// A server that returns no icons -> nil (seed fallback), never a panic.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/search" {
			_, _ = w.Write([]byte(`{"icons":[]}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	ic2 := newIconify()
	ic2.baseURL = srv.URL
	if got := ic2.search(context.Background(), Query{Kind: "icon", Text: "zzz", Limit: 10}); got != nil {
		t.Errorf("empty search should be nil, got %d", len(got))
	}
}

func TestIconifyHandlesKind(t *testing.T) {
	ic := newIconify()
	if !ic.handles("icon") || ic.handles("photo") {
		t.Errorf("handles wrong: icon=%v photo=%v", ic.handles("icon"), ic.handles("photo"))
	}
	// A disabled provider reports handles=false so callers treat it as absent
	// and serve the bundled catalog (on every page, not just the first).
	ic.enabled = false
	if ic.handles("icon") {
		t.Error("disabled provider must report handles(icon)=false")
	}
}

// TestLiveForRespectsEnabled: a disabled provider must be indistinguishable from
// no provider, so searchAllMerged falls back to the bundled catalog on every
// page (the documented air-gapped STOCK_*_PROVIDER=off config), not just page 1.
func TestLiveForRespectsEnabled(t *testing.T) {
	off := newIconify()
	off.enabled = false
	disabled := &Service{live: []liveProvider{&openverse{enabled: false}, off}}
	if disabled.liveFor("photo") != nil || disabled.liveFor("icon") != nil {
		t.Fatal("disabled providers must be treated as absent (liveFor == nil)")
	}
	on := newIconify()
	on.enabled = true
	enabled := &Service{live: []liveProvider{&openverse{enabled: true}, on}}
	if enabled.liveFor("photo") == nil || enabled.liveFor("icon") == nil {
		t.Fatal("enabled providers must be found by liveFor")
	}
}

// TestIconifyBailsWithoutLicenses: when /search and /{prefix}.json succeed but
// /collections is unavailable, search returns nil (so the caller serves the
// bundled seed) rather than emitting icons with unverified attribution, and it
// backs off instead of re-fetching /collections on every search.
func TestIconifyBailsWithoutLicenses(t *testing.T) {
	var collectionsHits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/search":
			_, _ = w.Write([]byte(`{"icons":["mdi:home"]}`))
		case "/collections":
			atomic.AddInt32(&collectionsHits, 1)
			w.WriteHeader(http.StatusInternalServerError)
		case "/mdi.json":
			_, _ = w.Write([]byte(`{"prefix":"mdi","width":24,"height":24,"icons":{"home":{"body":"<path fill=\"currentColor\" d=\"M1 1h2v2z\"/>"}}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	ic := newIconify()
	ic.baseURL = srv.URL
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if got := ic.search(ctx, Query{Kind: "icon", Text: "home", Limit: 10}); got != nil {
			t.Fatalf("search %d must bail (nil) without licenses, got %d assets", i, len(got))
		}
	}
	if n := atomic.LoadInt32(&collectionsHits); n != 1 {
		t.Fatalf("/collections should be fetched once then backed off, was hit %d times", n)
	}
}

// The registry must route icon text-search to Iconify and photo to Openverse,
// and fall back to the seed for faceted queries.
func TestServiceRoutesByKind(t *testing.T) {
	svc := NewService(nil)
	if svc.liveFor("icon") == nil {
		t.Error("no live provider for icon")
	}
	if svc.liveFor("photo") == nil {
		t.Error("no live provider for photo")
	}
	if svc.liveFor("audio") != nil {
		t.Error("audio should have no live provider")
	}
}
