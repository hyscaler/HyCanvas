package docexport

import (
	"bytes"
	"fmt"
	"strings"
)

// PDF page geometry (A4, points).
const (
	pageW  = 595.28
	pageH  = 841.89
	margin = 56.0
)

// fontKey -> base-14 font name. Inline marks are degraded to a block-level font
// in the PDF (bold headings, oblique quotes, mono code); per-run color/marks
// within wrapped text are not individually styled (a documented simplification).
var pdfFonts = map[string]string{
	"H":  "Helvetica",
	"HB": "Helvetica-Bold",
	"HO": "Helvetica-Oblique",
	"C":  "Courier",
}

type line struct {
	text  string
	font  string // key into pdfFonts
	size  float64
	color [3]float64
	x     float64
	rule  bool // horizontal divider (text ignored)
}

func widthFactor(font string) float64 {
	if font == "C" {
		return 0.6 // Courier is monospaced
	}
	return 0.5 // Helvetica family average
}

// wrap splits text into lines that fit maxWidth at the given font/size.
func wrap(text, font string, size, maxWidth float64) []string {
	words := strings.Fields(text)
	if len(words) == 0 {
		return []string{""}
	}
	cw := widthFactor(font) * size
	var out []string
	cur := ""
	for _, wd := range words {
		try := wd
		if cur != "" {
			try = cur + " " + wd
		}
		if float64(len([]rune(try)))*cw > maxWidth && cur != "" {
			out = append(out, cur)
			cur = wd
		} else {
			cur = try
		}
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}

var (
	colorBody  = [3]float64{0.07, 0.07, 0.07}
	colorMuted = [3]float64{0.47, 0.47, 0.47}
	colorQuote = [3]float64{0.27, 0.27, 0.27}
	colorBlue  = [3]float64{0.15, 0.39, 0.93}
)

// blocksToLines flattens the blocks into laid-out text lines.
func blocksToLines(blocks []Block, title string) []line {
	usable := pageW - margin*2
	var lines []line
	emit := func(text, font string, size float64, color [3]float64, indent float64) {
		for _, w := range wrap(text, font, size, usable-indent) {
			lines = append(lines, line{text: w, font: font, size: size, color: color, x: margin + indent})
		}
	}

	emit(title, "HB", 24, colorBody, 0)
	for _, b := range blocks {
		switch b.Type {
		case "heading":
			sz := map[int]float64{1: 20, 2: 16, 3: 13}[b.Level]
			if sz == 0 {
				sz = 13
			}
			emit(plain(b.Text), "HB", sz, colorBody, 0)
		case "paragraph":
			emit(plain(b.Text), "H", 11, colorBody, 0)
		case "list":
			for i, it := range b.Items {
				prefix := "• "
				switch b.Style {
				case "numbered":
					prefix = fmt.Sprintf("%d. ", i+1)
				case "checklist":
					if it.Checked {
						prefix = "[x] "
					} else {
						prefix = "[ ] "
					}
				}
				emit(prefix+plain(it.Text), "H", 11, colorBody, 14+float64(it.Depth)*16)
			}
		case "quote":
			emit(plain(b.Text), "HO", 11, colorQuote, 14)
		case "code":
			for _, cl := range strings.Split(b.Code, "\n") {
				emit(cl, "C", 10, colorBody, 0)
			}
		case "divider":
			lines = append(lines, line{rule: true, x: margin})
		case "image":
			label := b.Alt
			if label == "" {
				label = b.URL
			}
			emit("[Image: "+label+"]", "HO", 10, colorMuted, 0)
		case "chartEmbed":
			emit("[Chart]", "HO", 10, colorMuted, 0)
		case "callout":
			icon := b.Icon
			if icon == "" {
				icon = "i"
			}
			emit(icon+" "+plain(b.Text), "H", 11, colorBlue, 8)
		case "embed":
			emit(b.URL, "H", 11, colorBlue, 0)
		case "table":
			for ri, row := range b.Rows {
				cells := make([]string, len(row))
				for ci, c := range row {
					cells[ci] = plain(c)
				}
				font := "H"
				if b.HeaderRow && ri == 0 {
					font = "HB"
				}
				emit(strings.Join(cells, "  |  "), font, 10, colorBody, 0)
			}
		}
	}
	return lines
}

// BuildPDF lays the blocks out as a multi-page A4 text PDF using the base-14
// fonts (no embedding). Returns the PDF bytes.
func BuildPDF(blocks []Block, title string) ([]byte, error) {
	lines := blocksToLines(blocks, title)

	// Paginate: build one content stream per page.
	var pages []string
	var cur bytes.Buffer
	y := pageH - margin
	flush := func() {
		if cur.Len() > 0 {
			pages = append(pages, cur.String())
			cur.Reset()
		}
	}
	for _, ln := range lines {
		leading := ln.size * 1.4
		if ln.rule {
			leading = 12
		}
		if y-leading < margin {
			flush()
			y = pageH - margin
		}
		y -= leading
		if ln.rule {
			fmt.Fprintf(&cur, "0.8 0.8 0.8 RG 0.75 w %.2f %.2f m %.2f %.2f l S\n", margin, y+6, pageW-margin, y+6)
			continue
		}
		fmt.Fprintf(&cur, "BT /%s %.2f Tf %.3f %.3f %.3f rg 1 0 0 1 %.2f %.2f Tm (%s) Tj ET\n",
			ln.font, ln.size, ln.color[0], ln.color[1], ln.color[2], ln.x, y, escapePDFText(ln.text))
	}
	flush()
	if len(pages) == 0 {
		pages = []string{""}
	}

	return assemblePDF(pages), nil
}

func escapePDFText(s string) string {
	// Keep it to printable ASCII + space; replace the rest so the content stream
	// stays valid without font CMaps (base-14 WinAnsi). Non-ASCII degrades to '?'.
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case '(':
			b.WriteString(`\(`)
		case ')':
			b.WriteString(`\)`)
		default:
			if r >= 32 && r < 127 {
				b.WriteRune(r)
			} else {
				b.WriteByte('?')
			}
		}
	}
	return b.String()
}

// assemblePDF writes a valid PDF: catalog, pages tree, the four base-14 fonts as
// a shared resource, and one page + content stream object per page, with a
// correct xref table.
func assemblePDF(pageStreams []string) []byte {
	var buf bytes.Buffer
	buf.WriteString("%PDF-1.4\n")
	offsets := []int{} // 1-indexed object offsets

	objects := []string{}
	addObj := func(body string) int {
		objects = append(objects, body)
		return len(objects) // object number (1-indexed)
	}

	// Numbering: 1=Catalog, 2=Pages (both filled in after pages exist), then the
	// four shared fonts, then a content + page object per page.
	catalogNum := addObj("") // 1
	pagesNum := addObj("")   // 2
	fontKeys := []string{"H", "HB", "HO", "C"}
	fontObjNums := map[string]int{}
	for _, k := range fontKeys {
		fontObjNums[k] = addObj(fmt.Sprintf("<< /Type /Font /Subtype /Type1 /BaseFont /%s /Encoding /WinAnsiEncoding >>", pdfFonts[k]))
	}

	// Resources dict referencing fonts.
	var res strings.Builder
	res.WriteString("<< /Font << ")
	for _, k := range fontKeys {
		res.WriteString(fmt.Sprintf("/%s %d 0 R ", k, fontObjNums[k]))
	}
	res.WriteString(">> >>")

	// Page + content objects.
	var pageObjNums []int
	for _, stream := range pageStreams {
		contentNum := addObj(fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(stream), stream))
		pageBody := fmt.Sprintf("<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %.2f %.2f] /Resources %s /Contents %d 0 R >>",
			pagesNum, pageW, pageH, res.String(), contentNum)
		pageObjNums = append(pageObjNums, addObj(pageBody))
	}

	// Fill catalog + pages tree.
	kids := make([]string, len(pageObjNums))
	for i, n := range pageObjNums {
		kids[i] = fmt.Sprintf("%d 0 R", n)
	}
	objects[catalogNum-1] = fmt.Sprintf("<< /Type /Catalog /Pages %d 0 R >>", pagesNum)
	objects[pagesNum-1] = fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), len(pageObjNums))

	// Serialize objects, recording byte offsets.
	for i, body := range objects {
		offsets = append(offsets, buf.Len())
		fmt.Fprintf(&buf, "%d 0 obj\n%s\nendobj\n", i+1, body)
	}

	// xref.
	xrefStart := buf.Len()
	fmt.Fprintf(&buf, "xref\n0 %d\n", len(objects)+1)
	buf.WriteString("0000000000 65535 f \n")
	for _, off := range offsets {
		fmt.Fprintf(&buf, "%010d 00000 n \n", off)
	}
	fmt.Fprintf(&buf, "trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF",
		len(objects)+1, catalogNum, xrefStart)
	return buf.Bytes()
}
