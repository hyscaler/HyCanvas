package stock

import (
	"context"
	"os"
	"strings"
	"testing"
)

// TestIconifyLive hits the real api.iconify.design to prove the provider's
// response structs match production and it assembles genuine inline SVG with a
// per-set license. Opt-in (network): run with STOCK_LIVE_TEST=1.
func TestIconifyLive(t *testing.T) {
	if os.Getenv("STOCK_LIVE_TEST") != "1" {
		t.Skip("set STOCK_LIVE_TEST=1 to run the live Iconify integration test")
	}
	ic := newIconify()
	assets := ic.search(context.Background(), Query{Kind: "icon", Text: "home", Limit: 12})
	if len(assets) == 0 {
		t.Fatal("live Iconify search returned no assets")
	}
	a := assets[0]
	svg, _ := a["svg"].(string)
	if !strings.HasPrefix(svg, "<svg") || !strings.Contains(svg, "viewBox=") || !strings.Contains(strings.ToLower(svg), "path") && !strings.Contains(strings.ToLower(svg), "<") {
		t.Fatalf("first asset lacks inline svg: %.80q", svg)
	}
	if a["kind"] != "icon" || a["format"] != "svg" {
		t.Fatalf("kind/format wrong: %v/%v", a["kind"], a["format"])
	}
	lic, _ := a["license"].(map[string]any)
	if lic == nil || lic["type"] == "" {
		t.Fatalf("asset missing license: %+v", lic)
	}
	t.Logf("live: %d icons, first=%v license=%v", len(assets), a["id"], lic["type"])
}
