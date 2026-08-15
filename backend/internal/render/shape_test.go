package render

import (
	"strings"
	"testing"
)

// Contextual forms for a real word: محمد (meem-hah-meem-dal).
// meem starts the word (initial), hah and the second meem sit inside (medial),
// dal is right-joining so it takes its final form and ends the join run.
func TestShapeArabicContextualForms(t *testing.T) {
	got := []rune(ShapeArabic("محمد", 0, 0))
	want := []rune{0xFEE3, 0xFEA4, 0xFEE4, 0xFEAA} // initial, medial, medial, final
	if len(got) != len(want) {
		t.Fatalf("length: got %d want %d (%U)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("pos %d: got %U want %U", i, got[i], want[i])
		}
	}
}

// A right-joining letter ends a join, and lam+alef inside a word ligates.
// سلام: seen takes its initial form, lam+alef fuse into the FINAL lam-alef
// ligature (seen joins into it), and meem is isolated because alef never
// joins forward. The first version of this test forgot the ligature and
// expected four glyphs; the shaper was right and the test was wrong.
func TestShapeArabicRightJoinerBreaksTheChain(t *testing.T) {
	got := []rune(ShapeArabic("سلام", 0, 0))
	want := []rune{0xFEB3, 0xFEFC, 0xFEE1} // seen initial, lam-alef final, meem isolated
	if len(got) != len(want) {
		t.Fatalf("got %U want %U", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %U want %U", got, want)
		}
	}
	// A right-joiner genuinely breaking a chain, without a ligature: دد.
	// Both dals: the first cannot join forward, so the second is isolated?
	// No - dal joins BACKWARD, so the second takes... nothing: its
	// predecessor dal does not join forward. Both isolated.
	got = []rune(ShapeArabic("دد", 0, 0))
	if got[0] != 0xFEA9 || got[1] != 0xFEA9 {
		t.Errorf("dal+dal: got %U, want both isolated %U", got, rune(0xFEA9))
	}
}

// The mandatory lam-alef ligature: لا fuses into one glyph.
func TestShapeArabicLamAlefLigature(t *testing.T) {
	if got := ShapeArabic("لا", 0, 0); got != string(rune(0xFEFB)) {
		t.Errorf("isolated lam-alef: got %U", []rune(got))
	}
	// After a joining letter the ligature takes its final form: بلا.
	got := []rune(ShapeArabic("بلا", 0, 0))
	want := []rune{0xFE91, 0xFEFC} // beh initial, lam-alef final
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("beh+lam+alef: got %U want %U", got, want)
	}
}

// Harakat are transparent: fathas between letters must not break the join,
// and must survive in the output.
func TestShapeArabicHarakatTransparent(t *testing.T) {
	// beh + fatha + noon: beh still joins noon through the mark.
	got := []rune(ShapeArabic("بَن", 0, 0))
	want := []rune{0xFE91, 0x064E, 0xFEE6} // beh initial, fatha kept, noon final
	if len(got) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Errorf("got %U want %U", got, want)
	}
}

// ZWNJ breaks a join; ZWJ forces one. Both are consumed.
func TestShapeArabicJoinControls(t *testing.T) {
	// beh + ZWNJ + noon: both sides refuse to join across the break.
	got := []rune(ShapeArabic("ب‌ن", 0, 0))
	want := []rune{0xFE8F, 0xFEE5} // beh isolated, noon isolated
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("ZWNJ: got %U want %U", got, want)
	}
	// beh + ZWJ at the end: beh takes its initial form as if joined forward.
	got = []rune(ShapeArabic("ب‍", 0, 0))
	if len(got) != 1 || got[0] != 0xFE91 {
		t.Errorf("ZWJ: got %U", got)
	}
}

// Cross-seam context: a word split across two style runs still joins at the
// boundary when the neighbor runes are passed in.
func TestShapeArabicCrossRunContext(t *testing.T) {
	// "مح" | "مد" as two pieces of one word.
	left := []rune(ShapeArabic("مح", 0, 'م'))
	right := []rune(ShapeArabic("مد", 'ح', 0))
	if left[1] != 0xFEA4 { // hah medial: joined on both sides
		t.Errorf("hah at seam: got %U want %U", left[1], rune(0xFEA4))
	}
	if right[0] != 0xFEE4 { // meem medial
		t.Errorf("meem at seam: got %U want %U", right[0], rune(0xFEE4))
	}
}

// Non-Arabic text passes through untouched.
func TestShapeArabicPassthrough(t *testing.T) {
	for _, s := range []string{"hello", "שלום", "123 abc", ""} {
		if got := ShapeArabic(s, 0, 0); got != s {
			t.Errorf("%q changed to %q", s, got)
		}
	}
}

// End to end through the bidi pipeline: OrderVisual must emit presentation
// forms, not base-block letters, for an Arabic run.
func TestOrderVisualShapesArabic(t *testing.T) {
	pieces := OrderVisual([]string{"محمد"}, "rtl")
	joined := ""
	for _, p := range pieces {
		joined += p.Text
	}
	for _, r := range joined {
		if r >= 0x0621 && r <= 0x064A {
			t.Fatalf("unshaped base letter %U survived: %q", r, joined)
		}
	}
	// Reversed display order: final dal comes FIRST when drawing LTR.
	if []rune(joined)[0] != 0xFEAA {
		t.Errorf("display order: first rune %U, want final dal %U", []rune(joined)[0], rune(0xFEAA))
	}
	// Hebrew and Latin are untouched by the shaper.
	pieces = OrderVisual([]string{"שלום"}, "rtl")
	if !strings.Contains(pieces[0].Text, "ם") {
		t.Error("Hebrew was altered by shaping")
	}
}

// A blind rune reversal detaches combining marks from their base: the mark,
// drawn at the pen position, lands on the visually previous glyph. Reversal
// must keep base+marks clusters intact (بَن: the fatha stays with the beh).
func TestOrderVisualKeepsMarksOnTheirBase(t *testing.T) {
	pieces := OrderVisual([]string{"بَن"}, "rtl") // beh fatha noon
	joined := ""
	for _, p := range pieces {
		joined += p.Text
	}
	got := []rune(joined)
	want := []rune{0xFEE6, 0xFE91, 0x064E} // noon final, beh initial, fatha AFTER its base
	if len(got) != len(want) {
		t.Fatalf("got %d runes %U, want %U", len(got), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("display order %U, want %U (mark detached from its base)", got, want)
		}
	}
}

// A haraka at a style-run seam is transparent to joining: splitting بَ|ن into
// two runs (color change mid-word) must still join the beh to the noon.
func TestOrderVisualJoinsAcrossSeamHaraka(t *testing.T) {
	pieces := OrderVisual([]string{"بَ", "ن"}, "rtl") // بَ | ن
	joined := ""
	for _, p := range pieces {
		joined += p.Text
	}
	var hasNoonFinal, hasBehInitial bool
	for _, r := range joined {
		if r == 0xFEE6 {
			hasNoonFinal = true
		}
		if r == 0xFE91 {
			hasBehInitial = true
		}
		if r == 0xFEE5 {
			t.Fatalf("noon took its ISOLATED form: the seam fatha broke the join (%U)", []rune(joined))
		}
	}
	if !hasNoonFinal || !hasBehInitial {
		t.Fatalf("expected noon FINAL + beh INITIAL across the seam, got %U", []rune(joined))
	}
}

// Presentation forms decompose back to base letters for fonts whose cmap
// covers the base Arabic block but not Forms-B.
func TestUnshapeFallback(t *testing.T) {
	if got := UnshapeFallback(0xFEE6); len(got) != 1 || got[0] != 0x0646 {
		t.Fatalf("noon final should unshape to noon, got %U", got)
	}
	if got := UnshapeFallback(0xFEFB); len(got) != 2 || got[0] != 0x0644 || got[1] != 0x0627 {
		t.Fatalf("lam-alef ligature should unshape to lam+alef, got %U", got)
	}
	if got := UnshapeFallback('a'); got != nil {
		t.Fatalf("latin letters are not shaped forms, got %U", got)
	}
}
