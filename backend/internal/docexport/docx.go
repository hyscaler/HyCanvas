package docexport

import (
	"archive/zip"
	"bytes"
	"fmt"
	"strings"
)

// BuildDOCX renders the blocks to a minimal but valid Office Open XML (.docx)
// document. Inline marks (bold/italic/underline/strike/code/color) are preserved
// on runs; headings use sized bold runs (no external styles.xml needed); images/
// charts degrade to a labelled placeholder. Links render as their visible text.
func BuildDOCX(blocks []Block, title string) ([]byte, error) {
	var body strings.Builder
	body.WriteString(para(pPr(""), []string{run(Run{Text: title, Bold: true}, 48)}))
	for _, b := range blocks {
		body.WriteString(blockDOCX(b))
	}

	doc := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
		`<w:body>` + body.String() +
		`<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>` +
		`</w:body></w:document>`

	const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
		`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
		`<Default Extension="xml" ContentType="application/xml"/>` +
		`<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
		`</Types>`
	const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
		`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
		`</Relationships>`

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range []struct{ name, data string }{
		{"[Content_Types].xml", contentTypes},
		{"_rels/.rels", rels},
		{"word/document.xml", doc},
	} {
		w, err := zw.Create(f.name)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write([]byte(f.data)); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func blockDOCX(b Block) string {
	switch b.Type {
	case "heading":
		sz := map[int]int{1: 36, 2: 30, 3: 26}[b.Level]
		if sz == 0 {
			sz = 26
		}
		return para(pPr(""), runsXML(boldAll(b.Text), sz))
	case "paragraph":
		return para(pPr(""), runsXML(b.Text, 22))
	case "list":
		var sb strings.Builder
		for i, it := range b.Items {
			prefix := "• "
			switch b.Style {
			case "numbered":
				prefix = fmt.Sprintf("%d. ", i+1)
			case "checklist":
				if it.Checked {
					prefix = "☑ "
				} else {
					prefix = "☐ "
				}
			}
			ind := 360 + it.Depth*360
			runs := append([]string{run(Run{Text: prefix}, 22)}, runsXML(it.Text, 22)...)
			sb.WriteString(para(fmt.Sprintf(`<w:ind w:left="%d"/>`, ind), runs))
		}
		return sb.String()
	case "quote":
		return para(`<w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="999999"/></w:pBdr>`, runsXML(b.Text, 22))
	case "code":
		var sb strings.Builder
		for _, line := range strings.Split(b.Code, "\n") {
			if line == "" {
				line = " "
			}
			sb.WriteString(para(`<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>`, []string{run(Run{Text: line, Code: true}, 20)}))
		}
		return sb.String()
	case "divider":
		return para(`<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr>`, nil)
	case "image":
		label := b.Alt
		if label == "" {
			label = b.URL
		}
		return para(pPr(""), []string{run(Run{Text: "[Image: " + label + "]", Italic: true, Color: "#777777"}, 20)})
	case "chartEmbed":
		return para(pPr(""), []string{run(Run{Text: "[Chart]", Italic: true, Color: "#777777"}, 20)})
	case "callout":
		icon := b.Icon
		if icon == "" {
			icon = "ℹ"
		}
		runs := append([]string{run(Run{Text: icon + " "}, 22)}, runsXML(b.Text, 22)...)
		return para(`<w:shd w:val="clear" w:color="auto" w:fill="EEF4FF"/>`, runs)
	case "embed":
		return para(pPr(""), []string{run(Run{Text: b.URL, Underline: true, Color: "#2563EB"}, 22)})
	case "table":
		return tableDOCX(b)
	}
	return ""
}

func tableDOCX(b Block) string {
	var sb strings.Builder
	sb.WriteString(`<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>`)
	for _, side := range []string{"top", "left", "bottom", "right", "insideH", "insideV"} {
		sb.WriteString(fmt.Sprintf(`<w:%s w:val="single" w:sz="4" w:space="0" w:color="D4D4D4"/>`, side))
	}
	sb.WriteString(`</w:tblBorders></w:tblPr>`)
	for ri, row := range b.Rows {
		sb.WriteString(`<w:tr>`)
		for _, cell := range row {
			runs := cell
			if b.HeaderRow && ri == 0 {
				runs = boldAll(cell)
			}
			sb.WriteString(`<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>` + para(pPr(""), runsXML(runs, 20)) + `</w:tc>`)
		}
		sb.WriteString(`</w:tr>`)
	}
	sb.WriteString(`</w:tbl>`)
	// A trailing empty paragraph (Word requires a block after a table).
	sb.WriteString(para(pPr(""), nil))
	return sb.String()
}

func boldAll(runs []Run) []Run {
	out := make([]Run, len(runs))
	for i, r := range runs {
		r.Bold = true
		out[i] = r
	}
	return out
}

func runsXML(runs []Run, sz int) []string {
	if len(runs) == 0 {
		return []string{run(Run{Text: ""}, sz)}
	}
	out := make([]string, 0, len(runs))
	for _, r := range runs {
		out = append(out, run(r, sz))
	}
	return out
}

func pPr(inner string) string { return inner }

func para(pprInner string, runs []string) string {
	var sb strings.Builder
	sb.WriteString(`<w:p>`)
	if pprInner != "" {
		sb.WriteString(`<w:pPr>` + pprInner + `</w:pPr>`)
	}
	for _, r := range runs {
		sb.WriteString(r)
	}
	sb.WriteString(`</w:p>`)
	return sb.String()
}

func run(r Run, sz int) string {
	var rpr strings.Builder
	rpr.WriteString(`<w:rPr>`)
	if r.Bold {
		rpr.WriteString(`<w:b/>`)
	}
	if r.Italic {
		rpr.WriteString(`<w:i/>`)
	}
	if r.Underline {
		rpr.WriteString(`<w:u w:val="single"/>`)
	}
	if r.Strike {
		rpr.WriteString(`<w:strike/>`)
	}
	if r.Code {
		rpr.WriteString(`<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>`)
	}
	if r.Color != "" {
		rpr.WriteString(`<w:color w:val="` + strings.TrimPrefix(r.Color, "#") + `"/>`)
	}
	if sz > 0 {
		rpr.WriteString(fmt.Sprintf(`<w:sz w:val="%d"/><w:szCs w:val="%d"/>`, sz, sz))
	}
	rpr.WriteString(`</w:rPr>`)
	return `<w:r>` + rpr.String() + `<w:t xml:space="preserve">` + xmlEscape(r.Text) + `</w:t></w:r>`
}

func xmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	return s
}
