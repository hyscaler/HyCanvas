package render

import "strings"

// Base-14 PDF font selection and glyph-advance metrics (doc 11). The design
// export embeds no font files; it maps each text run's family/style to one of the
// standard 14 fonts and uses that font's real AFM character widths (per 1000-unit
// em) so text advance, run placement, and width are accurate rather than a rough
// guess. ASCII range 32..126 is covered; other code points fall back to the
// font's average width.

// pdfFontRef is a chosen base-14 font: a PDF resource key (/F1.. ), its BaseFont
// name (for the font dictionary), and a pointer to its width table.
type pdfFontRef struct {
	key      string // resource name, e.g. "F2"
	baseFont string // e.g. "Helvetica-Bold"
	widths   *[95]int
	mono     bool
}

// Width tables for codes 32..126 (index = code-32), in 1000-unit em space.
var helveticaWidths = [95]int{
	278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
	556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
	1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
	667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
	333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
	556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
}

var helveticaBoldWidths = [95]int{
	278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
	556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
	975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
	667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
	333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
	611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
}

var timesRomanWidths = [95]int{
	250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
	500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
	921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
	556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
	333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
	500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
}

var timesBoldWidths = [95]int{
	250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278,
	500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500,
	930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778,
	611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500,
	333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500,
	556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520,
}

// courierWidths: Courier is monospaced; every glyph is 600.
var courierWidths = func() [95]int {
	var w [95]int
	for i := range w {
		w[i] = 600
	}
	return w
}()

// The font resources registered into every exported PDF, in object order. The
// resource key index here (F1..) must match assemblePDF's font dictionary.
var pdfFontTable = []pdfFontRef{
	{key: "F1", baseFont: "Helvetica", widths: &helveticaWidths},
	{key: "F2", baseFont: "Helvetica-Bold", widths: &helveticaBoldWidths},
	{key: "F3", baseFont: "Helvetica-Oblique", widths: &helveticaWidths},
	{key: "F4", baseFont: "Helvetica-BoldOblique", widths: &helveticaBoldWidths},
	{key: "F5", baseFont: "Times-Roman", widths: &timesRomanWidths},
	{key: "F6", baseFont: "Times-Bold", widths: &timesBoldWidths},
	{key: "F7", baseFont: "Times-Italic", widths: &timesRomanWidths},
	{key: "F8", baseFont: "Times-BoldItalic", widths: &timesBoldWidths},
	{key: "F9", baseFont: "Courier", widths: &courierWidths, mono: true},
	{key: "F10", baseFont: "Courier-Bold", widths: &courierWidths, mono: true},
}

// selectFont maps a run's family + style to a base-14 font. fontFamily steers the
// family (serif/mono/sans); the style string and weight pick bold/italic.
func selectFont(family, style string, bold, italic bool) pdfFontRef {
	f := strings.ToLower(family)
	s := strings.ToLower(style)
	if strings.Contains(s, "bold") {
		bold = true
	}
	if strings.Contains(s, "italic") || strings.Contains(s, "oblique") {
		italic = true
	}
	serif := strings.Contains(f, "times") || strings.Contains(f, "serif") || strings.Contains(f, "georgia") || strings.Contains(f, "garamond")
	mono := strings.Contains(f, "courier") || strings.Contains(f, "mono") || strings.Contains(f, "consolas")
	switch {
	case mono:
		if bold {
			return pdfFontTable[9]
		}
		return pdfFontTable[8]
	case serif:
		switch {
		case bold && italic:
			return pdfFontTable[7]
		case bold:
			return pdfFontTable[5]
		case italic:
			return pdfFontTable[6]
		default:
			return pdfFontTable[4]
		}
	default: // sans (Helvetica)
		switch {
		case bold && italic:
			return pdfFontTable[3]
		case bold:
			return pdfFontTable[1]
		case italic:
			return pdfFontTable[2]
		default:
			return pdfFontTable[0]
		}
	}
}

// textAdvance returns the rendered width of text at the given point size using
// the font's real metrics (plus per-glyph letter spacing in points).
func textAdvance(f pdfFontRef, text string, size, letterSpacing float64) float64 {
	total := 0.0
	for _, r := range text {
		w := 0
		if r >= 32 && r <= 126 {
			w = f.widths[r-32]
		} else {
			w = 500 // average fallback for non-ASCII / control
			if f.mono {
				w = 600
			}
		}
		total += (float64(w)/1000.0)*size + letterSpacing
	}
	return total
}
