package render

import (
	"math"
	"strings"
	"testing"
)

func TestSelectFont(t *testing.T) {
	cases := []struct {
		family, style string
		bold, italic  bool
		want          string
	}{
		{"Arial", "Regular", false, false, "Helvetica"},
		{"Arial", "Regular", true, false, "Helvetica-Bold"},
		{"Helvetica", "Italic", false, false, "Helvetica-Oblique"},
		{"Helvetica", "Bold Italic", false, false, "Helvetica-BoldOblique"},
		{"Times New Roman", "Regular", false, false, "Times-Roman"},
		{"Georgia", "Regular", true, false, "Times-Bold"},
		{"Times", "Italic", false, false, "Times-Italic"},
		{"Courier New", "Regular", false, false, "Courier"},
		{"Menlo Mono", "Regular", true, false, "Courier-Bold"},
	}
	for _, c := range cases {
		got := selectFont(c.family, c.style, c.bold, c.italic)
		if got.baseFont != c.want {
			t.Errorf("selectFont(%q,%q,%v,%v) = %s, want %s", c.family, c.style, c.bold, c.italic, got.baseFont, c.want)
		}
	}
}

func TestTextAdvance(t *testing.T) {
	helv := pdfFontTable[0]
	// "AV" at 1000pt: A=667, V=667 in Helvetica => 1334pt advance.
	w := textAdvance(helv, "AV", 1000, 0)
	if math.Abs(w-1334) > 0.001 {
		t.Fatalf("Helvetica AV advance = %v, want 1334", w)
	}
	// Courier is monospaced: any 3 chars at 10pt = 3 * 0.6 * 10 = 18.
	cour := pdfFontTable[8]
	if got := textAdvance(cour, "x.y", 10, 0); math.Abs(got-18) > 0.001 {
		t.Fatalf("Courier advance = %v, want 18", got)
	}
	// Letter spacing adds per glyph.
	if got := textAdvance(cour, "ab", 10, 2); math.Abs(got-(12+4)) > 0.001 {
		t.Fatalf("Courier advance w/ spacing = %v, want 16", got)
	}
}

func TestPDFRegistersFontSet(t *testing.T) {
	pdf, err := ToPDF(sampleDesign(), 0)
	if err != nil {
		t.Fatalf("ToPDF: %v", err)
	}
	s := string(pdf)
	for _, bf := range []string{"/Helvetica", "/Helvetica-Bold", "/Times-Roman", "/Courier"} {
		if !strings.Contains(s, "/BaseFont "+bf) {
			t.Fatalf("pdf missing font %s", bf)
		}
	}
	// The page resource dict must reference all ten font keys.
	for _, k := range []string{"/F1 ", "/F5 ", "/F10 "} {
		if !strings.Contains(s, k) {
			t.Fatalf("pdf missing font resource key %s", k)
		}
	}
}
