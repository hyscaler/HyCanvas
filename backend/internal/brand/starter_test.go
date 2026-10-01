package brand

import (
	"bytes"
	"encoding/json"
	"image"
	_ "image/png"
	"strings"
	"testing"
)

// The spec compiles into the shapes the brand panel writes: unit-range sRGB
// swatches in palettes, faces by role, logos with their asset ids and dark
// versions, and a voice with the three lists the outline prompt reads.
func TestStarterKitCompiles(t *testing.T) {
	kit, err := BuildStarterKit(func(file string) string { return "asset:" + file })
	if err != nil {
		t.Fatalf("BuildStarterKit: %v", err)
	}
	if kit.Name != "HyCanvas" {
		t.Fatalf("name = %q", kit.Name)
	}

	var palettes []struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Colors []struct {
			ID    string `json:"id"`
			Role  string `json:"role"`
			Name  string `json:"name"`
			Value struct {
				SRGB struct{ R, G, B, A float64 } `json:"srgb"`
			} `json:"value"`
		} `json:"colors"`
	}
	if err := json.Unmarshal(kit.Palettes, &palettes); err != nil {
		t.Fatalf("palettes: %v", err)
	}
	if len(palettes) < 1 || palettes[0].Name != "Brand" || len(palettes[0].Colors) != 6 {
		t.Fatalf("brand palette = %+v", palettes)
	}
	// Plum leads (the composer's primary), magenta second (its accent).
	first := palettes[0].Colors[0]
	if first.Role != "primary" || hexOfRGB(first.Value.SRGB.R, first.Value.SRGB.G, first.Value.SRGB.B) != "#9b2c72" {
		t.Fatalf("first swatch = %+v", first)
	}
	second := palettes[0].Colors[1]
	if second.Role != "accent" || hexOfRGB(second.Value.SRGB.R, second.Value.SRGB.G, second.Value.SRGB.B) != "#d6409a" {
		t.Fatalf("second swatch = %+v", second)
	}
	seen := map[string]bool{}
	for _, p := range palettes {
		for _, c := range p.Colors {
			if c.ID == "" || seen[c.ID] {
				t.Fatalf("swatch id %q missing or repeated", c.ID)
			}
			seen[c.ID] = true
			v := c.Value.SRGB
			if v.A != 1 || v.R < 0 || v.R > 1 || v.G < 0 || v.G > 1 || v.B < 0 || v.B > 1 {
				t.Fatalf("swatch %s out of range: %+v", c.ID, v)
			}
		}
	}

	var fonts []struct {
		ID         string `json:"id"`
		Role       string `json:"role"`
		FontFamily string `json:"fontFamily"`
	}
	if err := json.Unmarshal(kit.Fonts, &fonts); err != nil {
		t.Fatalf("fonts: %v", err)
	}
	if len(fonts) != 2 || fonts[0].Role != "heading" || fonts[1].Role != "body" || fonts[0].FontFamily != "Plus Jakarta Sans" || fonts[1].FontFamily != "Plus Jakarta Sans" {
		t.Fatalf("fonts = %+v", fonts)
	}

	var logos []struct {
		ID       string            `json:"id"`
		Label    string            `json:"label"`
		AssetID  string            `json:"assetId"`
		Variants map[string]string `json:"variants"`
		MinSize  float64           `json:"minSizePx"`
	}
	if err := json.Unmarshal(kit.Logos, &logos); err != nil {
		t.Fatalf("logos: %v", err)
	}
	if len(logos) != 4 {
		t.Fatalf("logos = %+v", logos)
	}
	// The lockup leads: it is the logo the composer places on every page.
	if logos[0].Label != "HyCanvas logo" || logos[0].AssetID != "asset:hycanvas-logo-ink.png" || logos[0].Variants["dark"] != "asset:hycanvas-logo-paper.png" || logos[0].MinSize != 96 {
		t.Fatalf("primary logo = %+v", logos[0])
	}
	if logos[1].Variants["dark"] != "asset:hycanvas-mark-paper.png" {
		t.Fatalf("mark = %+v", logos[1])
	}
	// The tile carries its own gradient and needs no dark version; so does
	// the colour lockup, which is for light grounds only.
	if logos[2].AssetID != "asset:hycanvas-tile.png" || len(logos[2].Variants) != 0 {
		t.Fatalf("tile = %+v", logos[2])
	}
	if logos[3].AssetID != "asset:hycanvas-logo-color.png" || len(logos[3].Variants) != 0 {
		t.Fatalf("colour lockup = %+v", logos[3])
	}

	var voice struct {
		Tone       []string `json:"tone"`
		DoSay      []string `json:"doSay"`
		DontSay    []string `json:"dontSay"`
		SampleCopy string   `json:"sampleCopy"`
	}
	if err := json.Unmarshal(kit.Voice, &voice); err != nil {
		t.Fatalf("voice: %v", err)
	}
	if len(voice.Tone) == 0 || len(voice.DoSay) == 0 || len(voice.DontSay) == 0 || !strings.HasPrefix(voice.SampleCopy, "Design anything, own everything.") {
		t.Fatalf("voice = %+v", voice)
	}
	for _, list := range [][]string{voice.Tone, voice.DoSay, voice.DontSay} {
		for _, s := range list {
			if strings.ContainsAny(s, "–—") {
				t.Fatalf("voice entry %q carries a long dash", s)
			}
		}
	}
}

// Every artwork file the spec names is embedded, decodes as PNG, and has the
// orientation its use expects: a wide lockup, a near-square mark, a square
// tile. The kit stores rasters because the Go exporter draws PNG, not SVG.
func TestStarterArtworkIsEmbeddedAndDecodes(t *testing.T) {
	files, err := StarterFiles()
	if err != nil {
		t.Fatalf("StarterFiles: %v", err)
	}
	if len(files) != 6 {
		t.Fatalf("files = %+v", files)
	}
	names := map[string]bool{}
	for _, f := range files {
		if names[f.Filename] {
			t.Fatalf("library filename %q repeated", f.Filename)
		}
		names[f.Filename] = true
		data, err := StarterArtwork(f.Path)
		if err != nil {
			t.Fatalf("%s: %v", f.Path, err)
		}
		cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil || format != "png" {
			t.Fatalf("%s: decode %q %v", f.Path, format, err)
		}
		aspect := float64(cfg.Width) / float64(cfg.Height)
		switch {
		case strings.HasPrefix(f.Path, "hycanvas-logo-"):
			// The ink, paper and colour lockups share one geometry.
			if aspect < 4 || aspect > 6 || cfg.Width < 1600 {
				t.Fatalf("%s: %dx%d is not a lockup", f.Path, cfg.Width, cfg.Height)
			}
		case strings.HasPrefix(f.Path, "hycanvas-mark-"):
			if aspect < 0.9 || aspect > 1.2 || cfg.Height < 900 {
				t.Fatalf("%s: %dx%d is not the mark", f.Path, cfg.Width, cfg.Height)
			}
		case f.Path == "hycanvas-tile.png":
			if cfg.Width != cfg.Height || cfg.Width < 900 {
				t.Fatalf("%s: %dx%d is not the tile", f.Path, cfg.Width, cfg.Height)
			}
		default:
			t.Fatalf("unexpected artwork %s", f.Path)
		}
	}
	// The light and dark versions carry distinct library names.
	if !names["HyCanvas logo.png"] || !names["HyCanvas logo on dark.png"] {
		t.Fatalf("library names = %v", names)
	}
}

// Without an asset store the kit still compiles, without logos.
func TestStarterKitWithoutAssets(t *testing.T) {
	kit, err := BuildStarterKit(func(string) string { return "" })
	if err != nil {
		t.Fatalf("BuildStarterKit: %v", err)
	}
	if string(kit.Logos) != "[]" {
		t.Fatalf("logos = %s", kit.Logos)
	}
}

func TestStarterKitEnabled(t *testing.T) {
	for val, want := range map[string]bool{"": true, "hycanvas": true, "HyCanvas": true, "off": false, "none": false, "false": false, "0": false, " OFF ": false} {
		t.Setenv("BRAND_STARTER_KIT", val)
		if got := StarterKitEnabled(); got != want {
			t.Fatalf("BRAND_STARTER_KIT=%q: enabled = %v, want %v", val, got, want)
		}
	}
}

func TestParseHex(t *testing.T) {
	r, g, b, err := parseHex("#9B2C72")
	if err != nil || hexOfRGB(r, g, b) != "#9b2c72" {
		t.Fatalf("parseHex: %v %v", hexOfRGB(r, g, b), err)
	}
	if _, _, _, err := parseHex("#12345"); err == nil {
		t.Fatal("five digits should fail")
	}
	if _, _, _, err := parseHex("#GGGGGG"); err == nil {
		t.Fatal("non-hex should fail")
	}
	if r, g, b, err := parseHex("#fff"); err != nil || hexOfRGB(r, g, b) != "#ffffff" {
		t.Fatalf("short form: %v %v", hexOfRGB(r, g, b), err)
	}
}

// hexOfRGB formats unit-range channels as the grounding does.
func hexOfRGB(r, g, b float64) string {
	ch := func(v float64) int {
		if v < 0 {
			v = 0
		}
		if v > 1 {
			v = 1
		}
		return int(v*255 + 0.5)
	}
	const digits = "0123456789abcdef"
	out := []byte{'#'}
	for _, v := range []int{ch(r), ch(g), ch(b)} {
		out = append(out, digits[v>>4], digits[v&15])
	}
	return string(out)
}

// A kit counts as the workspace's own when it has any content or a name the
// owner gave it; an empty kit under the default name is a placeholder.
func TestKitIsOwn(t *testing.T) {
	empty := BrandKitRow{Name: "Untitled brand kit", Palettes: json.RawMessage("[]"), Fonts: json.RawMessage("[]"), Logos: json.RawMessage("[]"), Collections: json.RawMessage("[]")}
	if kitIsOwn(empty) {
		t.Fatal("an empty untitled kit is a placeholder")
	}
	blankVoice := empty
	blankVoice.Voice = json.RawMessage(`{"tone":[""," "],"doSay":[],"dontSay":[],"sampleCopy":" "}`)
	if kitIsOwn(blankVoice) {
		t.Fatal("a blank voice is no content")
	}
	cases := map[string]BrandKitRow{
		"named":      {Name: "Acme", Palettes: json.RawMessage("[]")},
		"palette":    {Name: "Untitled brand kit", Palettes: json.RawMessage(`[{"id":"p","colors":[]}]`)},
		"font":       {Name: "Untitled brand kit", Fonts: json.RawMessage(`[{"role":"body","fontFamily":"Inter"}]`)},
		"logo":       {Name: "Untitled brand kit", Logos: json.RawMessage(`[{"assetId":"a"}]`)},
		"collection": {Name: "Untitled brand kit", Collections: json.RawMessage(`[{"id":"c"}]`)},
		"voice":      {Name: "Untitled brand kit", Voice: json.RawMessage(`{"tone":["warm"]}`)},
		"sample":     {Name: "Untitled brand kit", Voice: json.RawMessage(`{"sampleCopy":"Hello"}`)},
	}
	for name, k := range cases {
		if !kitIsOwn(k) {
			t.Fatalf("%s: should count as the workspace's own", name)
		}
	}
}
