package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	"hycanvas/backend/internal/brand"
)

// The grounding mirrors the editor's derivations: the voice clause word for
// word, every swatch as hex, fonts by role, the first logo with its URL.
func TestBrandGroundingFromKitMirrorsTheEditor(t *testing.T) {
	kit := brand.BrandKit{
		Voice:    json.RawMessage(`{"tone":["warm"," direct ",""],"doSay":["we","together"],"dontSay":["synergy"]}`),
		Palettes: json.RawMessage(`[{"colors":[{"value":{"srgb":{"r":0.0549,"g":0.4784,"b":0.3725,"a":1}}},{"value":{"srgb":{"r":0.9569,"g":0.7255,"b":0.2588,"a":1}}}]},{"colors":[{"value":{"srgb":{"r":1,"g":1,"b":1,"a":1}}}]}]`),
		Fonts:    json.RawMessage(`[{"role":"Body text","fontFamily":"Nunito"},{"role":"Headline","fontFamily":"Fraunces"}]`),
		Logos:    json.RawMessage(`[{"id":"l1","label":"Primary","assetId":"asset-1","minSizePx":120,"variants":{"dark":"asset-1-dark"}},{"id":"l2","assetId":"asset-2"}]`),
	}
	g := brandGroundingFromKit(kit, func(id string) string { return "/api/v1/assets/" + id + "/content" }, func(id string) float64 {
		if id == "asset-1-dark" {
			return 4
		}
		return 3
	})
	if g.Clause != "Write in this brand voice. Tone: warm,  direct . Do: we; together. Don't: synergy." {
		t.Fatalf("clause = %q", g.Clause)
	}
	if len(g.Palette) != 3 || g.Palette[0] != "#0e7a5f" || g.Palette[1] != "#f4b942" || g.Palette[2] != "#ffffff" {
		t.Fatalf("palette = %v", g.Palette)
	}
	if g.Fonts == nil || g.Fonts.Heading != "Fraunces" || g.Fonts.Body != "Nunito" {
		t.Fatalf("fonts = %+v", g.Fonts)
	}
	if g.Logo == nil || g.Logo.AssetID != "asset-1" || g.Logo.URL != "/api/v1/assets/asset-1/content" || g.Logo.Aspect != 3 || g.Logo.MinSizePx != 120 {
		t.Fatalf("logo = %+v", g.Logo)
	}
	// The dark-ground version rides along with its own aspect, for the
	// composer's deep pages.
	if g.Logo.Dark == nil || g.Logo.Dark.AssetID != "asset-1-dark" || g.Logo.Dark.URL != "/api/v1/assets/asset-1-dark/content" || g.Logo.Dark.Aspect != 4 {
		t.Fatalf("dark logo = %+v", g.Logo.Dark)
	}
}

// A named kit wins over the default; an unknown id (another workspace's, or
// a typo) falls back to the default, and no default falls back to the first.
func TestPickBrandKitPrefersTheNamedKitWithinTheWorkspace(t *testing.T) {
	kits := []brand.BrandKit{{ID: "k1"}, {ID: "k2", IsDefault: true}, {ID: "k3"}}
	if got := pickBrandKit(kits, "").ID; got != "k2" {
		t.Fatalf("default: got %s", got)
	}
	if got := pickBrandKit(kits, " k3 ").ID; got != "k3" {
		t.Fatalf("named: got %s", got)
	}
	if got := pickBrandKit(kits, "elsewhere").ID; got != "k2" {
		t.Fatalf("unknown id: got %s", got)
	}
	if got := pickBrandKit([]brand.BrandKit{{ID: "a"}, {ID: "b"}}, "").ID; got != "a" {
		t.Fatalf("no default: got %s", got)
	}
}

// A kit with nothing in it grounds nothing, and malformed JSON never fails
// a generation.
func TestBrandGroundingFromKitToleratesEmptyAndBadKits(t *testing.T) {
	if g := brandGroundingFromKit(brand.BrandKit{}, func(string) string { return "" }, func(string) float64 { return 0 }); g.Clause != "" || g.Palette != nil || g.Fonts != nil || g.Logo != nil {
		t.Fatalf("empty kit grounded something: %+v", g)
	}
	bad := brand.BrandKit{Voice: json.RawMessage(`{"tone":"not a list"}`), Palettes: json.RawMessage(`nope`), Fonts: json.RawMessage(`[]`), Logos: json.RawMessage(`[{"assetId":""}]`)}
	if g := brandGroundingFromKit(bad, func(string) string { return "" }, func(string) float64 { return 0 }); g.Clause != "" || g.Palette != nil || g.Fonts != nil || g.Logo != nil {
		t.Fatalf("bad kit grounded something: %+v", g)
	}
	// A voice with only blank entries produces no clause.
	blank := brand.BrandKit{Voice: json.RawMessage(`{"tone":[" "],"doSay":[],"dontSay":[""]}`)}
	if g := brandGroundingFromKit(blank, func(string) string { return "" }, func(string) float64 { return 0 }); g.Clause != "" {
		t.Fatalf("blank voice produced %q", g.Clause)
	}
}

// The starter kit grounds a deck the way its spec intends: plum then magenta
// lead the palette, both faces are the brand face, the lockup is the logo
// with its paper version for deep pages, and the voice clause carries the
// tone and the do and don't lists.
func TestBrandGroundingFromTheStarterKit(t *testing.T) {
	starter, err := brand.BuildStarterKit(func(file string) string { return "id-" + file })
	if err != nil {
		t.Fatalf("BuildStarterKit: %v", err)
	}
	kit := brand.BrandKit{Palettes: starter.Palettes, Fonts: starter.Fonts, Logos: starter.Logos, Voice: starter.Voice}
	g := brandGroundingFromKit(kit, func(id string) string { return "/assets/" + id }, func(string) float64 { return 5 })
	if len(g.Palette) != 8 || g.Palette[0] != "#9b2c72" || g.Palette[1] != "#d6409a" {
		t.Fatalf("palette = %v", g.Palette)
	}
	if g.Fonts == nil || g.Fonts.Heading != "Plus Jakarta Sans" || g.Fonts.Body != "Plus Jakarta Sans" {
		t.Fatalf("fonts = %+v", g.Fonts)
	}
	if g.Logo == nil || g.Logo.AssetID != "id-hycanvas-logo-ink.png" || g.Logo.MinSizePx != 96 || g.Logo.Dark == nil || g.Logo.Dark.AssetID != "id-hycanvas-logo-paper.png" {
		t.Fatalf("logo = %+v", g.Logo)
	}
	for _, want := range []string{"Write in this brand voice. Tone: confident, plain-spoken, warm, specific.", " Do: lead with what the reader can make;", " Don't: compare HyCanvas with other design tools;"} {
		if !strings.Contains(g.Clause, want) {
			t.Fatalf("clause %q lacks %q", g.Clause, want)
		}
	}
}
