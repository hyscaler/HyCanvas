package render

import (
	"encoding/base64"
	"encoding/binary"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/image/font/gofont/goregular"
)

// A design whose uploaded font is carried the way the editor really carries one:
// a base64 data URL in DesignFile.fonts (see `addDocFont`).
func fontDataURL(ttf []byte) string {
	return "data:font/ttf;base64," + base64.StdEncoding.EncodeToString(ttf)
}

func textNode(id, body, family string, y float64) map[string]any {
	return map[string]any{"id": id, "type": "text",
		"transform": map[string]any{"x": 20.0, "y": y, "scaleX": 1.0, "scaleY": 1.0},
		"size":      map[string]any{"width": 500.0, "height": 40.0},
		"content": []any{map[string]any{"runs": []any{
			map[string]any{"text": body, "style": map[string]any{"fontSize": 24.0, "fontFamily": family}}}}}}
}

func designWithFont(ttf []byte, family string, nodes ...any) Design {
	return Design(map[string]any{
		"pages": []any{map[string]any{"id": "p1", "name": "Fonts", "width": 600.0, "height": 300.0,
			"children": nodes}},
		"fonts": []any{map[string]any{"id": "f1", "family": family, "source": "upload", "url": fontDataURL(ttf)}},
	})
}

func renderOne(t *testing.T, file Design) string {
	t.Helper()
	out, err := ToPDF(file, 0)
	if err != nil {
		t.Fatalf("ToPDF: %v", err)
	}
	return string(out)
}

// The design's own font is embedded as a composite font, with everything a
// reader needs to draw it and a screen reader needs to read it.
func TestDesignFontIsEmbedded(t *testing.T) {
	pdf := renderOne(t, designWithFont(goregular.TTF, "Go Regular",
		textNode("t1", "Hello", "Go Regular", 40)))

	for _, want := range []string{
		"/Subtype /Type0",
		"/Encoding /Identity-H",
		"/Subtype /CIDFontType2",
		"/CIDToGIDMap /Identity",
		"/FontFile2",
		"/ToUnicode",
		"/BaseFont /GoRegular",
	} {
		if !strings.Contains(pdf, want) {
			t.Errorf("embedded font is missing %q", want)
		}
	}
	// Length1 must state the real (uncompressed) size of the sfnt, or a reader
	// cannot reconstruct the font.
	if !strings.Contains(pdf, "/Length1 "+strconv.Itoa(len(goregular.TTF))) {
		t.Errorf("FontFile2 should declare /Length1 %d", len(goregular.TTF))
	}
}

// Identity-H addresses glyphs by id, so a run in an embedded font is written as
// hex glyph ids, while a run that falls back keeps literal text.
func TestEmbeddedRunsUseGlyphIdsAndFallbackKeepsLiterals(t *testing.T) {
	pdf := renderOne(t, designWithFont(goregular.TTF, "Go Regular",
		textNode("t1", "Embedded", "Go Regular", 40),
		textNode("t2", "Fallback", "Helvetica", 100)))

	shows := regexp.MustCompile(`/(\w+) [\d.]+ Tf\n(?:[^\n]*\n)*?((?:<[0-9A-F]+>)|\([^)]*\)) Tj`).FindAllStringSubmatch(pdf, -1)
	if len(shows) != 2 {
		t.Fatalf("expected 2 text runs, got %d", len(shows))
	}
	if !strings.HasPrefix(shows[0][1], "E") || !strings.HasPrefix(shows[0][2], "<") {
		t.Errorf("the embedded run should draw glyph ids with an /E font, got /%s %s", shows[0][1], shows[0][2])
	}
	if !strings.HasPrefix(shows[1][1], "F") || !strings.HasPrefix(shows[1][2], "(") {
		t.Errorf("the fallback run should keep literal text in a base-14 font, got /%s %s", shows[1][1], shows[1][2])
	}
}

// A ToUnicode CMap is what makes the glyph ids readable again. Without it the
// tagged PDF would be a picture of text: a screen reader would announce
// nothing, and a copy-paste would produce mojibake.
func TestToUnicodeMapsEveryDrawnGlyph(t *testing.T) {
	pdf := renderOne(t, designWithFont(goregular.TTF, "Go Regular",
		textNode("t1", "AB", "Go Regular", 40)))

	if !strings.Contains(pdf, "/CMapName /Adobe-Identity-UCS def") {
		t.Fatal("no ToUnicode CMap emitted")
	}
	// Each drawn glyph maps back to its character: <gid> <unicode>.
	entries := regexp.MustCompile(`<([0-9A-F]{4})> <([0-9A-F]{4})>`).FindAllStringSubmatch(pdf, -1)
	got := map[string]bool{}
	for _, e := range entries {
		got[e[2]] = true
	}
	for _, r := range []string{"0041", "0042"} { // 'A', 'B'
		if !got[r] {
			t.Errorf("ToUnicode is missing a mapping back to U+%s", r)
		}
	}
}

// Non-Latin text is the reason for a composite font: a simple WinAnsi font
// cannot address these code points at all.
func TestNonLatinTextIsEmbeddable(t *testing.T) {
	pdf := renderOne(t, designWithFont(goregular.TTF, "Go Regular",
		textNode("t1", "Ελληνικά", "Go Regular", 40)))
	if !strings.Contains(pdf, "/Encoding /Identity-H") {
		t.Fatal("Greek text should be drawn through the embedded composite font")
	}
	// U+0395 (Greek capital epsilon) must round-trip through ToUnicode.
	if !strings.Contains(pdf, "> <0395>") {
		t.Error("ToUnicode should map the Greek text back to its code points")
	}
}

// A run the font cannot fully cover falls back whole, so a line never renders
// half in the real typeface and half in Helvetica.
func TestRunFallsBackWhenTheFontLacksAGlyph(t *testing.T) {
	// Go Regular has no CJK glyphs.
	pdf := renderOne(t, designWithFont(goregular.TTF, "Go Regular",
		textNode("t1", "Hello 世界", "Go Regular", 40)))
	if strings.Contains(pdf, "/Encoding /Identity-H") {
		t.Error("a run with an uncoverable glyph should fall back to base-14, not embed")
	}
	// The CJK run is beyond WinAnsi, so the node RASTERIZES (mojibake would
	// be worse) and carries its text as the Figure tag's /Alt (UTF-16BE).
	if !strings.Contains(pdf, " Do\n") {
		t.Error("the run should still be drawn (as a raster layer)")
	}
	if !strings.Contains(pdf, "/Alt <FEFF") {
		t.Error("the rasterized text should keep its words as a Unicode /Alt")
	}
}

// A font whose OS/2 fsType restricts embedding is not embedded. The design still
// exports, in a standard face, rather than shipping a font the user may have no
// right to redistribute inside a document.
func TestRestrictedLicenseFontIsNotEmbedded(t *testing.T) {
	restricted := withFsType(t, goregular.TTF, 0x0002)
	pdf := renderOne(t, designWithFont(restricted, "Go Regular",
		textNode("t1", "Hello", "Go Regular", 40)))
	if strings.Contains(pdf, "/FontFile2") {
		t.Error("a font licensed against embedding must not be embedded")
	}
	if !strings.Contains(pdf, "(Hello) Tj") {
		t.Error("the text should still render through the base-14 fallback")
	}
}

// The permission check reads the real bit rather than assuming.
func TestEmbeddingAllowedReadsFsType(t *testing.T) {
	if !embeddingAllowed(goregular.TTF) {
		t.Error("Go Regular is freely embeddable")
	}
	if embeddingAllowed(withFsType(t, goregular.TTF, 0x0002)) {
		t.Error("fsType bit 1 (restricted) must block embedding")
	}
	// Editable-embedding (bit 3) is a permission, not a restriction.
	if !embeddingAllowed(withFsType(t, goregular.TTF, 0x0008)) {
		t.Error("an editable-embedding font is embeddable")
	}
}

// A font referenced by URL rather than embedded in the design (a Google face) is
// not fetched: export never reaches the network, so an air-gapped self-hoster
// gets the same PDF as everyone else.
func TestRemoteFontIsNotFetched(t *testing.T) {
	file := Design(map[string]any{
		"pages": []any{map[string]any{"id": "p1", "name": "P", "width": 300.0, "height": 100.0,
			"children": []any{textNode("t1", "Hello", "Inter", 40)}}},
		"fonts": []any{map[string]any{"id": "f1", "family": "Inter", "source": "google",
			"url": "https://fonts.gstatic.com/s/inter/v13/inter.ttf"}},
	})
	pdf := renderOne(t, file)
	if strings.Contains(pdf, "/FontFile2") {
		t.Error("a remote font must not be embedded; export makes no network call")
	}
	if !strings.Contains(pdf, "(Hello) Tj") {
		t.Error("the text should render through the base-14 fallback")
	}
}

// A design with no fonts at all produces exactly what this encoder always did.
func TestDesignWithoutFontsIsUnchanged(t *testing.T) {
	file := Design(map[string]any{
		"pages": []any{map[string]any{"id": "p1", "name": "P", "width": 300.0, "height": 100.0,
			"children": []any{textNode("t1", "Hello", "Helvetica", 40)}}},
	})
	pdf := renderOne(t, file)
	if strings.Contains(pdf, "/FontFile2") || strings.Contains(pdf, "/Type0") {
		t.Error("no design fonts means no embedded fonts")
	}
	if !strings.Contains(pdf, "(Hello) Tj") {
		t.Error("base-14 text should render as before")
	}
}

// A font parsed but never drawn with is not embedded: it would be dead weight in
// every exported file.
func TestUnusedFontIsNotEmbedded(t *testing.T) {
	pdf := renderOne(t, designWithFont(goregular.TTF, "Go Regular",
		textNode("t1", "Hello", "Helvetica", 40))) // never uses the design font
	if strings.Contains(pdf, "/FontFile2") {
		t.Error("an unused font should not be embedded")
	}
}

// withFsType returns a copy of the font with the OS/2 fsType field overwritten,
// so the licence check can be tested against a real table rather than a stub.
func withFsType(t *testing.T, ttf []byte, fsType uint16) []byte {
	t.Helper()
	out := make([]byte, len(ttf))
	copy(out, ttf)
	// Locate OS/2 in the copy, then patch its fsType (offset 8) in place.
	n := int(binary.BigEndian.Uint16(out[4:6]))
	for i := 0; i < n; i++ {
		rec := 12 + 16*i
		if string(out[rec:rec+4]) != "OS/2" {
			continue
		}
		off := int(binary.BigEndian.Uint32(out[rec+8 : rec+12]))
		binary.BigEndian.PutUint16(out[off+8:off+10], fsType)
		return out
	}
	t.Fatal("no OS/2 table to patch")
	return nil
}
