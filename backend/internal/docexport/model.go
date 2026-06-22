// Package docexport renders a doc design (file.meta.doc.blocks) to DOCX or PDF,
// porting the doc-31 export builders. The block model mirrors @hc/docs; the
// builders are pure (bytes in, bytes out).
package docexport

// Run is one inline text run with marks.
type Run struct {
	Text      string
	Bold      bool
	Italic    bool
	Underline bool
	Strike    bool
	Code      bool
	Color     string // hex like "#112233" or ""
	Link      string
}

// ListItem is one list entry.
type ListItem struct {
	Text    []Run
	Checked bool
	Depth   int
}

// Block is a normalized doc block (the union flattened).
type Block struct {
	Type      string // paragraph|heading|list|quote|code|divider|image|chartEmbed|table|callout|embed
	Level     int    // heading level 1..3
	Text      []Run
	Style     string     // list style: bullet|numbered|checklist
	Items     []ListItem // list
	Code      string     // code block
	HeaderRow bool       // table
	Rows      [][][]Run  // table rows -> cells -> runs
	Alt       string     // image
	URL       string     // image/embed
	Icon      string     // callout
}

func asArr(v any) []any          { a, _ := v.([]any); return a }
func asObj(v any) map[string]any { m, _ := v.(map[string]any); return m }
func asStr(v any) string         { s, _ := v.(string); return s }

// ResolveBlocks reads meta.doc.blocks in persisted order (blockOrder wins; any
// blocks not listed are appended), matching the Node resolveBlocks.
func ResolveBlocks(file map[string]any) []Block {
	doc := asObj(asObj(file["meta"])["doc"])
	rawBlocks := asArr(doc["blocks"])
	parsed := make([]Block, 0, len(rawBlocks))
	byID := map[string]Block{}
	idOf := make([]string, 0, len(rawBlocks))
	for _, rb := range rawBlocks {
		m := asObj(rb)
		b := parseBlock(m)
		parsed = append(parsed, b)
		id := asStr(m["id"])
		byID[id] = b
		idOf = append(idOf, id)
	}
	order := asArr(doc["blockOrder"])
	if len(order) == 0 {
		return parsed
	}
	seen := map[string]bool{}
	out := make([]Block, 0, len(parsed))
	for _, o := range order {
		id := asStr(o)
		if b, ok := byID[id]; ok {
			out = append(out, b)
			seen[id] = true
		}
	}
	for i, id := range idOf {
		if !seen[id] {
			out = append(out, parsed[i])
		}
	}
	return out
}

func parseBlock(m map[string]any) Block {
	b := Block{Type: asStr(m["type"])}
	switch b.Type {
	case "heading":
		b.Level = intOr(m["level"], 1)
		b.Text = parseRich(m["text"])
	case "paragraph", "quote", "callout":
		b.Text = parseRich(m["text"])
		b.Icon = asStr(m["icon"])
	case "list":
		b.Style = asStr(m["style"])
		for _, it := range asArr(m["items"]) {
			im := asObj(it)
			checked, _ := im["checked"].(bool)
			b.Items = append(b.Items, ListItem{Text: parseRich(im["text"]), Checked: checked, Depth: intOr(im["depth"], 0)})
		}
	case "code":
		b.Code = asStr(m["code"])
	case "image":
		b.Alt = asStr(m["alt"])
		b.URL = asStr(m["url"])
	case "embed":
		b.URL = asStr(m["url"])
	case "table":
		b.HeaderRow, _ = m["headerRow"].(bool)
		for _, r := range asArr(m["rows"]) {
			rm := asObj(r)
			var cells [][]Run
			for _, c := range asArr(rm["cells"]) {
				cells = append(cells, parseRich(c))
			}
			b.Rows = append(b.Rows, cells)
		}
	}
	return b
}

// parseRich parses a RichText { runs: [{text, marks, link}] } into []Run.
func parseRich(v any) []Run {
	rt := asObj(v)
	var out []Run
	for _, rr := range asArr(rt["runs"]) {
		rm := asObj(rr)
		run := Run{Text: asStr(rm["text"]), Link: asStr(rm["link"])}
		for _, mk := range asArr(rm["marks"]) {
			switch s := mk.(type) {
			case string:
				switch s {
				case "bold":
					run.Bold = true
				case "italic":
					run.Italic = true
				case "underline":
					run.Underline = true
				case "strike":
					run.Strike = true
				case "code":
					run.Code = true
				}
			case map[string]any:
				if col := asStr(s["color"]); col != "" {
					run.Color = col
				}
			}
		}
		out = append(out, run)
	}
	return out
}

func intOr(v any, def int) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	}
	return def
}

func plain(runs []Run) string {
	s := ""
	for _, r := range runs {
		s += r.Text
	}
	return s
}
