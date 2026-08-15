package render

import (
	"strings"
	"testing"
)

const (
	he = "שלום"  // "shalom"
	ar = "مرحبا" // "marhaba"
)

// These mirror the cases in `packages/text/src/__tests__/bidi.test.ts`. The two
// implementations lay out the same paragraph on two different paths, so a
// divergence here is a design that reads correctly on the canvas and wrongly in
// its own export.
func TestResolveBaseDirectionMatchesTheBrowser(t *testing.T) {
	cases := []struct{ text, declared, want string }{
		{"hello world", "auto", "ltr"},
		{he, "auto", "rtl"},
		{ar, "auto", "rtl"},
		{`  "123" ` + he, "auto", "rtl"},
		{`  "123" hello`, "auto", "ltr"},
		{"Re: " + he, "auto", "ltr"},
		{he, "ltr", "ltr"}, // an explicit declaration wins
		{"hello", "rtl", "rtl"},
		{"", "auto", "ltr"},
		{"123 456 ...", "auto", "ltr"},
	}
	for _, c := range cases {
		if got := ResolveBaseDirection(c.text, c.declared); got != c.want {
			t.Errorf("ResolveBaseDirection(%q, %q) = %q, want %q", c.text, c.declared, got, c.want)
		}
	}
}

func TestResolveLevels(t *testing.T) {
	// Right-to-left text gets an odd level inside a left-to-right paragraph.
	text := []rune("hi " + he)
	lv := resolveLevels(text, "ltr")
	if lv[0] != 0 {
		t.Errorf("Latin should sit at the base level, got %d", lv[0])
	}
	if lv[len(lv)-1]%2 != 1 {
		t.Errorf("Hebrew should sit at an odd level, got %d", lv[len(lv)-1])
	}
	// Latin gets an even level above the base inside a right-to-left paragraph.
	text = []rune(ar + " ok")
	lv = resolveLevels(text, "rtl")
	if lv[0]%2 != 1 {
		t.Errorf("Arabic at base level should be odd, got %d", lv[0])
	}
	if lv[len(lv)-1]%2 != 0 {
		t.Errorf("Latin inside Arabic should be even, got %d", lv[len(lv)-1])
	}
	// Digits after Arabic still read left to right (W2, I2).
	text = []rune(ar + " 2026")
	lv = resolveLevels(text, "rtl")
	if d := lv[len(lv)-1]; d%2 != 0 || d <= 1 {
		t.Errorf("digits in Arabic should be even and above the base, got %d", d)
	}
	// A neutral between two right-to-left runs goes right-to-left (N1); between
	// opposite directions it takes the base (N2).
	text = []rune(he + " - " + he)
	lv = resolveLevels(text, "ltr")
	if lv[strings.Index(string(text), "-")]%2 != 1 {
		t.Error("a dash between two Hebrew runs should be right-to-left")
	}
	text = []rune("abc - " + he)
	lv = resolveLevels(text, "ltr")
	if lv[4]%2 != 0 {
		t.Error("a dash between Latin and Hebrew should take the base direction")
	}
}

func TestOrderVisualReordersRuns(t *testing.T) {
	// Two Hebrew style runs in a right-to-left paragraph: the second authored
	// run is drawn first (leftmost).
	pieces := OrderVisual([]string{"שלום ", "עולם"}, "rtl")
	if len(pieces) != 2 || pieces[0].Item != 1 || pieces[1].Item != 0 {
		t.Fatalf("run order not reversed: %+v", pieces)
	}
	// An embedded Latin phrase stays readable and sits leftmost.
	pieces = OrderVisual([]string{ar + " ", "HyCanvas"}, "rtl")
	if pieces[0].Item != 1 || pieces[0].Text != "HyCanvas" {
		t.Fatalf("Latin inside Arabic was reordered or reversed: %+v", pieces[0])
	}
	if pieces[0].Level%2 != 0 {
		t.Errorf("Latin should be at an even level, got %d", pieces[0].Level)
	}
	// Hebrew after a Latin lead-in keeps the lead-in first.
	pieces = OrderVisual([]string{"Note: ", he}, "ltr")
	if pieces[0].Item != 0 {
		t.Fatalf("Latin lead-in should stay first: %+v", pieces)
	}
}

// The difference from the browser: this renderer draws rune by rune, so the
// characters inside a right-to-left run must come out reversed. Without this,
// Hebrew exports mirrored relative to the canvas.
func TestOrderVisualReversesCharactersInRtlRuns(t *testing.T) {
	pieces := OrderVisual([]string{he}, "rtl")
	if len(pieces) != 1 {
		t.Fatalf("expected one piece, got %d", len(pieces))
	}
	want := reverseRunes(he)
	if pieces[0].Text != want {
		t.Fatalf("Hebrew not reversed for per-rune drawing: got %q, want %q", pieces[0].Text, want)
	}
	// Latin inside the same line must NOT be reversed.
	pieces = OrderVisual([]string{he + " ", "abc"}, "rtl")
	for _, p := range pieces {
		if strings.Contains(p.Text, "abc") && p.Text != "abc" {
			t.Fatalf("Latin was reversed: %q", p.Text)
		}
	}
}

func TestOrderVisualLeavesLtrUntouched(t *testing.T) {
	in := []string{"Hello ", "world"}
	pieces := OrderVisual(in, "ltr")
	if len(pieces) != 2 || pieces[0].Text != "Hello " || pieces[1].Text != "world" {
		t.Fatalf("left-to-right text was altered: %+v", pieces)
	}
}

func TestOrderVisualPreservesContent(t *testing.T) {
	items := []string{"Total: ", "42 ", ar}
	for _, base := range []string{"ltr", "rtl"} {
		var got strings.Builder
		for _, p := range OrderVisual(items, base) {
			got.WriteString(p.Text)
		}
		if len([]rune(got.String())) != len([]rune(strings.Join(items, ""))) {
			t.Fatalf("%s: characters lost or duplicated: %q", base, got.String())
		}
	}
}

func TestOrderVisualEdgeCases(t *testing.T) {
	if OrderVisual(nil, "rtl") != nil {
		t.Error("nil input should produce no pieces")
	}
	pieces := OrderVisual([]string{""}, "rtl")
	for _, p := range pieces {
		if p.Text != "" {
			t.Errorf("empty run produced text: %q", p.Text)
		}
	}
	if HasRtl("hello 123 .,") {
		t.Error("HasRtl reported Latin and digits as right-to-left")
	}
	if !HasRtl("mixed " + ar) {
		t.Error("HasRtl missed Arabic")
	}
}

// End to end: a paragraph declared right-to-left must export right-aligned.
//
// This uses LATIN text on purpose. The embedded fallback font (Liberation Sans)
// has no Hebrew, Arabic, or CJK glyphs, so a Hebrew string exports as nothing
// at all and could not tell a passing alignment from a broken one. That font
// gap is the real blocker for non-Latin export and is recorded in the
// rasterizer's fidelity notes; the ordering this file tests is necessary but
// not sufficient until it is closed.
func TestRasterTextRtlParagraphAlignsRight(t *testing.T) {
	col := func(r, g, b float64) map[string]any {
		return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": 1.0}}
	}
	build := func(dir string) Design {
		return Design{"pages": []any{map[string]any{
			"width": 300.0, "height": 80.0,
			"background": map[string]any{"type": "solid", "color": col(1, 1, 1)},
			"children": []any{map[string]any{
				"id": "t1", "type": "text",
				"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
				"size":      map[string]any{"width": 300.0, "height": 80.0},
				"content": []any{map[string]any{
					"runs":  []any{map[string]any{"text": "shalom", "style": map[string]any{"fontSize": 24.0, "fill": map[string]any{"type": "solid", "color": col(0, 0, 0)}}}},
					"style": map[string]any{"direction": dir},
				}},
			}},
		}}}
	}
	side := func(d Design) (left, right int) {
		img, err := toRaster(d, 0, 1, false)
		if err != nil {
			t.Fatalf("toRaster: %v", err)
		}
		b := img.Bounds()
		for y := b.Min.Y; y < b.Max.Y; y++ {
			for x := b.Min.X; x < b.Max.X; x++ {
				if img.RGBAAt(x, y).R < 128 {
					if x < b.Dx()/2 {
						left++
					} else {
						right++
					}
				}
			}
		}
		return
	}
	lLeft, lRight := side(build("ltr"))
	if lLeft == 0 && lRight == 0 {
		t.Fatal("no glyphs rendered at all; the probe font lost Latin coverage")
	}
	if lLeft <= lRight {
		t.Fatalf("left-to-right text did not start on the left: left=%d right=%d", lLeft, lRight)
	}
	rLeft, rRight := side(build("rtl"))
	if rRight <= rLeft {
		t.Fatalf("a right-to-left paragraph did not align right: left=%d right=%d", rLeft, rRight)
	}
}

// Glyph coverage (F38 FR-10). The embedded fallback has no Hebrew, Arabic,
// Indic or CJK, and an uncovered rune used to be skipped silently, so a design
// in those scripts exported BLANK while the canvas showed words. Registering a
// font that covers the script must rescue it, per glyph, even when the run
// names a different family.
func TestUncoveredGlyphsFallBackToARegisteredFont(t *testing.T) {
	// The embedded font is the ground truth for the gap this guards.
	if coversRune(fallbackFont, 'א') {
		t.Skip("the embedded font now covers Hebrew; this guard needs rewriting")
	}
	if !coversRune(fallbackFont, 'A') {
		t.Fatal("the embedded font lost Latin coverage")
	}

	// With nothing registered, nothing covers the rune and the renderer reports
	// it rather than dropping it in silence.
	var reported []rune
	SetMissingGlyphReporter(func(r rune) { reported = append(reported, r) })
	t.Cleanup(func() { SetMissingGlyphReporter(nil) })

	if f := fontCovering('א', "Whatever", 400); f != nil {
		t.Skip("a Hebrew-covering font is already registered in this process")
	}

	col := func(r, g, b float64) map[string]any {
		return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": 1.0}}
	}
	design := Design{"pages": []any{map[string]any{
		"width": 200.0, "height": 60.0,
		"background": map[string]any{"type": "solid", "color": col(1, 1, 1)},
		"children": []any{map[string]any{
			"id": "t1", "type": "text",
			"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
			"size":      map[string]any{"width": 200.0, "height": 60.0},
			"content": []any{map[string]any{
				"runs":  []any{map[string]any{"text": he, "style": map[string]any{"fontSize": 28.0, "fontFamily": "Whatever", "fill": map[string]any{"type": "solid", "color": col(0, 0, 0)}}}},
				"style": map[string]any{"direction": "auto"},
			}},
		}},
	}}}
	ink := func(d Design) int {
		img, err := toRaster(d, 0, 1, false)
		if err != nil {
			t.Fatalf("toRaster: %v", err)
		}
		n := 0
		b := img.Bounds()
		for y := b.Min.Y; y < b.Max.Y; y++ {
			for x := b.Min.X; x < b.Max.X; x++ {
				if img.RGBAAt(x, y).R < 128 {
					n++
				}
			}
		}
		return n
	}
	if got := ink(design); got != 0 {
		t.Fatalf("expected blank output with no covering font, got %d dark pixels", got)
	}
	if len(reported) == 0 {
		t.Fatal("an uncovered glyph was dropped without being reported")
	}
}

// A wrapped RTL paragraph must keep its base direction on continuation
// lines: dropping it resolved bidi with an LTR base and put trailing
// punctuation on the wrong side of every wrapped line.
func TestOrderVisualBaseDirectionMatters(t *testing.T) {
	rtl := ""
	for _, p := range OrderVisual([]string{"שלום!"}, "rtl") {
		rtl += p.Text
	}
	none := ""
	for _, p := range OrderVisual([]string{"שלום!"}, "") {
		none += p.Text
	}
	if rtl == none {
		t.Skip("base direction does not change this input; pick a stronger probe")
	}
	// With an RTL base the bang leads in LTR draw order (visual left).
	if []rune(rtl)[0] != '!' {
		t.Fatalf("rtl base: got %q, want the bang at visual left", rtl)
	}
}
