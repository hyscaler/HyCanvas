// Font embedding for PDF export (doc 28 FR-22).
//
// Until now the PDF encoder mapped every text run onto one of the base-14
// standard fonts, so a deck set in a custom typeface came out in Helvetica. For
// a raster export that was invisible; for the tagged export it was a silent
// change to the user's design. This embeds the real font instead.
//
// The bytes are already here. An uploaded font is stored in the design itself
// as a data URL (`DesignFile.fonts[].url`, written by `addDocFont`) precisely so
// it travels with the file, which means the server can read it without any new
// upload endpoint, storage, or network call. A font we cannot embed degrades to
// the base-14 mapping rather than failing the export.
//
// Fonts are embedded as composite (Type0/Identity-H) fonts with a CIDFontType2
// descendant, not as simple WinAnsi fonts. That is what lets a deck in Greek,
// Cyrillic, or any other script export correctly: a simple font is limited to a
// 256-code encoding. Because Identity-H writes raw glyph ids into the content
// stream, every embedded font also carries a ToUnicode CMap, without which the
// glyphs would be unreadable to a screen reader and uncopyable to a human. For
// an accessibility feature that CMap is not optional; it is the entire point.

package render

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"strings"

	"golang.org/x/image/font/sfnt"
	"golang.org/x/image/math/fixed"
)

// embeddedFont is one design font the encoder can draw with.
type embeddedFont struct {
	key    string // PDF resource name within a page, e.g. "E0"
	family string // the design's family name, matched against a run's fontFamily
	psName string // the BaseFont name written into the PDF
	data   []byte // raw sfnt bytes, embedded verbatim as FontFile2
	sf     *sfnt.Font
	buf    sfnt.Buffer
	upem   float64
	// used records every glyph the document actually draws, so the width array
	// and the ToUnicode CMap describe exactly what is on the page.
	used map[uint16]rune
}

// glyphID looks a rune up without recording anything. Lookup must stay free of
// side effects: `covers` asks about runes the encoder may then decide NOT to
// draw with this font, and marking those glyphs used would embed a font nothing
// on the page actually renders.
func (e *embeddedFont) glyphID(r rune) (uint16, bool) {
	gi, err := e.sf.GlyphIndex(&e.buf, r)
	if err != nil || gi == 0 {
		return 0, false // 0 is .notdef
	}
	return uint16(gi), true
}

// glyph resolves a rune and records it, so the width array and the ToUnicode
// CMap describe exactly the glyphs the document draws. Only call it once the
// encoder has committed to drawing the run with this font.
func (e *embeddedFont) glyph(r rune) (uint16, bool) {
	g, ok := e.glyphID(r)
	if !ok {
		return 0, false
	}
	e.used[g] = r
	return g, true
}

// width1000 is a rune's advance in PDF glyph space (1000 units to the em),
// which is the space /W and text placement are expressed in.
func (e *embeddedFont) width1000(r rune) float64 {
	gi, err := e.sf.GlyphIndex(&e.buf, r)
	if err != nil || gi == 0 {
		return 0
	}
	// ppem == unitsPerEm makes sfnt report advances in raw font units.
	adv, err := e.sf.GlyphAdvance(&e.buf, gi, fixed.I(int(e.upem)), 0)
	if err != nil {
		return 0
	}
	return float64(adv) / 64.0 * 1000.0 / e.upem
}

// covers reports whether the font can draw every rune in the text. A run that
// needs even one missing glyph falls back wholesale, so a line never renders
// half in the real typeface and half in Helvetica.
func (e *embeddedFont) covers(text string) bool {
	for _, r := range text {
		if r == '\n' || r == '\r' {
			continue
		}
		if _, ok := e.glyphID(r); !ok {
			return false
		}
	}
	return true
}

// hexGlyphs encodes text as Identity-H expects it: two bytes per glyph id.
func (e *embeddedFont) hexGlyphs(text string) string {
	var sb strings.Builder
	for _, r := range text {
		if r == '\n' || r == '\r' {
			continue
		}
		g, ok := e.glyph(r)
		if !ok {
			continue
		}
		fmt.Fprintf(&sb, "%04X", g)
	}
	return sb.String()
}

// textWidth is the advance of a whole run, in points.
func (e *embeddedFont) textWidth(text string, size, letterSpacing float64) float64 {
	w := 0.0
	for _, r := range text {
		if r == '\n' || r == '\r' {
			continue
		}
		w += e.width1000(r)/1000.0*size + letterSpacing
	}
	return w
}

// --- sfnt table plumbing ----------------------------------------------------

// sfntTable returns a raw table from an sfnt container, or nil.
func sfntTable(data []byte, tag string) []byte {
	if len(data) < 12 || len(tag) != 4 {
		return nil
	}
	n := int(binary.BigEndian.Uint16(data[4:6]))
	for i := 0; i < n; i++ {
		rec := 12 + 16*i
		if rec+16 > len(data) {
			return nil
		}
		if string(data[rec:rec+4]) == tag {
			off := int(binary.BigEndian.Uint32(data[rec+8 : rec+12]))
			length := int(binary.BigEndian.Uint32(data[rec+12 : rec+16]))
			if off < 0 || length < 0 || off+length > len(data) {
				return nil
			}
			return data[off : off+length]
		}
	}
	return nil
}

// embeddingAllowed reads the OS/2 fsType bits. Bit 1 means the foundry licensed
// the font with embedding restricted, and we honor that: the design still
// exports, in a standard face, rather than shipping a font the user may not have
// the right to redistribute inside a document.
func embeddingAllowed(data []byte) bool {
	os2 := sfntTable(data, "OS/2")
	if len(os2) < 10 {
		return true // no OS/2 table says nothing; do not invent a restriction
	}
	fsType := binary.BigEndian.Uint16(os2[8:10])
	const restricted = 0x0002
	return fsType&restricted == 0
}

// hasTrueTypeOutlines reports whether the font carries glyf outlines. An
// OpenType/CFF font ("OTTO") needs FontFile3 and a CIDFontType0 descendant, so
// it is not embeddable by this path and falls back to base-14.
func hasTrueTypeOutlines(data []byte) bool {
	if len(data) < 4 {
		return false
	}
	if string(data[0:4]) == "OTTO" {
		return false
	}
	return sfntTable(data, "glyf") != nil
}

// --- reading fonts out of the design ---------------------------------------

// dataURLBytes decodes a `data:...;base64,...` URL. A font referenced by http(s)
// (a Google or CDN face) returns false: the renderer never reaches the network,
// so such a font falls back to base-14 rather than making export depend on an
// outbound connection an air-gapped self-hoster may not have.
func dataURLBytes(url string) ([]byte, bool) {
	if !strings.HasPrefix(url, "data:") {
		return nil, false
	}
	i := strings.Index(url, ",")
	if i < 0 {
		return nil, false
	}
	meta, payload := url[5:i], url[i+1:]
	if !strings.Contains(meta, "base64") {
		return nil, false
	}
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil || len(raw) == 0 {
		return nil, false
	}
	return raw, true
}

// parseDesignFonts collects every font in `DesignFile.fonts` that we can
// legitimately embed. Anything else is skipped in silence and handled by the
// base-14 fallback: a font that cannot be embedded must never fail an export.
func parseDesignFonts(file Design) []*embeddedFont {
	var out []*embeddedFont
	for _, raw := range asArr(file["fonts"]) {
		ref := asObj(raw)
		family := strings.TrimSpace(asStr(ref["family"]))
		if family == "" {
			continue
		}
		data, ok := dataURLBytes(asStr(ref["url"]))
		if !ok || !hasTrueTypeOutlines(data) || !embeddingAllowed(data) {
			continue
		}
		sf, err := sfnt.Parse(data)
		if err != nil {
			continue
		}
		upem := float64(sf.UnitsPerEm())
		if upem <= 0 {
			continue
		}
		e := &embeddedFont{
			key:    fmt.Sprintf("E%d", len(out)),
			family: family,
			psName: postScriptName(family),
			data:   data,
			sf:     sf,
			upem:   upem,
			used:   map[uint16]rune{},
		}
		out = append(out, e)
	}
	return out
}

// postScriptName sanitizes a family into a name a PDF BaseFont accepts (no
// spaces or delimiters).
func postScriptName(family string) string {
	var sb strings.Builder
	for _, r := range family {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			sb.WriteRune(r)
		case r == '-' || r == '_':
			sb.WriteRune('-')
		}
	}
	if sb.Len() == 0 {
		return "EmbeddedFont"
	}
	return sb.String()
}

// findEmbedded picks the design font a run's family names, if any.
func findEmbedded(fonts []*embeddedFont, family string) *embeddedFont {
	family = strings.TrimSpace(strings.ToLower(family))
	if family == "" {
		return nil
	}
	for _, e := range fonts {
		if strings.ToLower(e.family) == family {
			return e
		}
	}
	return nil
}

// --- PDF objects ------------------------------------------------------------

// fontObjects emits the five objects an embedded font needs, starting at object
// number `first`: the Type0 font, its CIDFontType2 descendant, the font
// descriptor, the embedded file, and the ToUnicode CMap. It returns the bodies
// in order plus the page resource entry.
func (e *embeddedFont) fontObjects(first int) (bodies []string, resource string) {
	cidFont := first + 1
	descriptor := first + 2
	fontFile := first + 3
	toUnicode := first + 4

	bodies = append(bodies, fmt.Sprintf(
		"<< /Type /Font /Subtype /Type0 /BaseFont /%s /Encoding /Identity-H /DescendantFonts [%d 0 R] /ToUnicode %d 0 R >>",
		e.psName, cidFont, toUnicode))
	bodies = append(bodies, fmt.Sprintf(
		"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /%s /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor %d 0 R /DW 1000 /W [%s] /CIDToGIDMap /Identity >>",
		e.psName, descriptor, e.widthArray()))
	bodies = append(bodies, e.descriptorObject(fontFile))

	// The font is embedded whole. Length1 is the uncompressed size, which a
	// reader needs to reconstruct the sfnt.
	packed := flate(e.data)
	bodies = append(bodies, fmt.Sprintf(
		"<< /Length %d /Length1 %d /Filter /FlateDecode >>\nstream\n%s\nendstream",
		len(packed)+1, len(e.data), packed))
	bodies = append(bodies, e.toUnicodeObject())

	return bodies, fmt.Sprintf("/%s %d 0 R ", e.key, first)
}

// widthArray gives every drawn glyph its real advance, in the `cid [w]` form.
func (e *embeddedFont) widthArray() string {
	if len(e.used) == 0 {
		return ""
	}
	var sb strings.Builder
	for _, g := range e.sortedGlyphs() {
		w := e.width1000(e.used[g])
		fmt.Fprintf(&sb, "%d [%s] ", g, pn(w))
	}
	return strings.TrimSpace(sb.String())
}

func (e *embeddedFont) sortedGlyphs() []uint16 {
	out := make([]uint16, 0, len(e.used))
	for g := range e.used {
		out = append(out, g)
	}
	// Insertion sort: the set is small (the glyphs a deck actually draws) and
	// this keeps the output deterministic, which the tests depend on.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

func (e *embeddedFont) descriptorObject(fontFile int) string {
	var b sfnt.Buffer
	ppem := fixed.I(int(e.upem))
	m, err := e.sf.Metrics(&b, ppem, 0)
	toUnits := func(v fixed.Int26_6) float64 { return float64(v) / 64.0 * 1000.0 / e.upem }
	ascent, descent, capHeight := 750.0, -250.0, 700.0
	if err == nil {
		ascent = toUnits(m.Ascent)
		descent = -toUnits(m.Descent) // PDF wants descent negative
		if m.CapHeight > 0 {
			capHeight = toUnits(m.CapHeight)
		}
	}
	// Flag 4 marks the font symbolic, which is what a composite font with its
	// own encoding is; the /FontBBox is deliberately generous rather than
	// derived per glyph, which a reader tolerates.
	return fmt.Sprintf(
		"<< /Type /FontDescriptor /FontName /%s /Flags 4 /FontBBox [-1000 %s 2000 %s] /ItalicAngle 0 /Ascent %s /Descent %s /CapHeight %s /StemV 80 /FontFile2 %d 0 R >>",
		e.psName, pn(descent), pn(ascent), pn(ascent), pn(descent), pn(capHeight), fontFile)
}

// toUnicodeObject maps the glyph ids back to the characters they represent.
// Without it a screen reader announces nothing intelligible and a copy-paste
// yields mojibake, so the "accessible" export would be a lie.
func (e *embeddedFont) toUnicodeObject() string {
	glyphs := e.sortedGlyphs()
	var chars strings.Builder
	// beginbfchar takes at most 100 entries per block.
	for i := 0; i < len(glyphs); i += 100 {
		end := i + 100
		if end > len(glyphs) {
			end = len(glyphs)
		}
		fmt.Fprintf(&chars, "%d beginbfchar\n", end-i)
		for _, g := range glyphs[i:end] {
			fmt.Fprintf(&chars, "<%04X> <%s>\n", g, utf16BE(e.used[g]))
		}
		chars.WriteString("endbfchar\n")
	}
	cmap := "/CIDInit /ProcSet findresource begin\n" +
		"12 dict begin\nbegincmap\n" +
		"/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
		"/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n" +
		"1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
		chars.String() +
		"endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend"
	return fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(cmap)+1, cmap)
}

// utf16BE renders a rune as the big-endian UTF-16 hex a bfchar value needs,
// which is a surrogate pair for anything above the basic plane.
func utf16BE(r rune) string {
	if r > 0xFFFF {
		r -= 0x10000
		hi := 0xD800 + (r >> 10)
		lo := 0xDC00 + (r & 0x3FF)
		return fmt.Sprintf("%04X%04X", hi, lo)
	}
	return fmt.Sprintf("%04X", r)
}
