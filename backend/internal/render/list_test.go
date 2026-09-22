package render

import (
	"strings"
	"testing"
)

// Numbering follows the canvas: one counter per level, deeper levels restart,
// a paragraph that is not a list item resets, and the gutter and per-level
// indent are in ems of the first run.
func TestListCountersMirrorTheCanvas(t *testing.T) {
	item := func(typ string, level float64) map[string]any {
		return map[string]any{"list": map[string]any{"type": typ, "level": level}}
	}
	var c listCounters
	seq := []struct {
		style  map[string]any
		marker string
		indent float64
	}{
		{item("number", 0), "1.", 32},
		{item("number", 0), "2.", 32},
		{item("number", 1), "1.", 56},
		{item("number", 1), "2.", 56},
		{item("number", 0), "3.", 32},
		{item("bullet", 0), "•", 32},
		{item("checklist", 0), "☐", 32},
		{map[string]any{}, "", 0},
		{item("number", 0), "1.", 32},
		{map[string]any{"indentStart": 10.0, "list": map[string]any{"type": "bullet", "level": 0.0, "marker": "-"}}, "-", 42},
	}
	for i, st := range seq {
		got := c.next(st.style, 20)
		if got.marker != st.marker || got.indent != st.indent {
			t.Fatalf("step %d: marker %q indent %v, want %q %v", i, got.marker, got.indent, st.marker, st.indent)
		}
	}
}

func TestWinAnsiMarker(t *testing.T) {
	cases := map[string]string{"•": "\x95", "1.": "1.", "–": "\x96", "✓": "\x95", "-": "-"}
	for in, want := range cases {
		if got := winAnsiMarker(in); got != want {
			t.Fatalf("winAnsiMarker(%q) = %q, want %q", in, got, want)
		}
	}
}

// The raster path draws the marker in the gutter and starts the text after
// it: the same word set as a list item ends further right than set plain,
// and a clear gap separates the marker from the word.
func TestRasterListItemHasMarkerAndGutter(t *testing.T) {
	col := func(r, g, b float64) map[string]any {
		return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": 1.0}}
	}
	build := func(pstyle map[string]any) Design {
		return Design{"pages": []any{map[string]any{
			"width": 400.0, "height": 100.0,
			"background": map[string]any{"type": "solid", "color": col(1, 1, 1)},
			"children": []any{map[string]any{
				"id": "t1", "type": "text",
				"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
				"size":      map[string]any{"width": 400.0, "height": 100.0},
				"content": []any{map[string]any{
					"runs":  []any{map[string]any{"text": "hello", "style": map[string]any{"fontSize": 40.0, "fill": map[string]any{"type": "solid", "color": col(0, 0, 0)}}}},
					"style": pstyle,
				}},
			}},
		}}}
	}
	inkColumns := func(d Design) []bool {
		img, err := toRaster(d, 0, 1, false)
		if err != nil {
			t.Fatalf("toRaster: %v", err)
		}
		b := img.Bounds()
		cols := make([]bool, b.Dx())
		for y := b.Min.Y; y < b.Max.Y; y++ {
			for x := b.Min.X; x < b.Max.X; x++ {
				if img.RGBAAt(x, y).R < 128 {
					cols[x-b.Min.X] = true
				}
			}
		}
		return cols
	}
	extent := func(cols []bool) (first, last int) {
		first, last = -1, -1
		for x, ink := range cols {
			if ink {
				if first < 0 {
					first = x
				}
				last = x
			}
		}
		return
	}
	plain := inkColumns(build(map[string]any{}))
	pFirst, pLast := extent(plain)
	if pFirst < 0 {
		t.Fatal("no glyphs rendered at all; the probe font lost Latin coverage")
	}
	list := inkColumns(build(map[string]any{"list": map[string]any{"type": "number", "level": 0.0}}))
	lFirst, lLast := extent(list)
	// The word moved right by the gutter (1.6em = 64px) minus nothing: the
	// marker starts where the plain word did.
	if lLast < pLast+40 {
		t.Fatalf("list text did not start after the gutter: plain ends at %d, list ends at %d", pLast, lLast)
	}
	if lFirst > pFirst+4 {
		t.Fatalf("the marker should sit at the content edge, first ink at %d (plain %d)", lFirst, pFirst)
	}
	// A clear gap between the marker and the word, wider than any gap
	// between two letters at this size.
	gap, best := 0, 0
	for x := lFirst; x <= lLast; x++ {
		if list[x] {
			gap = 0
			continue
		}
		gap++
		if gap > best {
			best = gap
		}
	}
	if best < 10 {
		t.Fatalf("no gutter gap between marker and text (widest empty run %dpx)", best)
	}
}

// The PDF path sets the marker in the gutter, re-encoded for the base-14
// WinAnsi fonts, and moves the text's baseline start past it.
func TestPdfTextBodyPlacesMarkerAndIndent(t *testing.T) {
	node := map[string]any{
		"type": "text",
		"content": []any{
			map[string]any{
				"runs":  []any{map[string]any{"text": "hello", "style": map[string]any{"fontSize": 16.0}}},
				"style": map[string]any{"list": map[string]any{"type": "bullet", "level": 0.0}},
			},
			map[string]any{
				"runs": []any{map[string]any{"text": "plain", "style": map[string]any{"fontSize": 16.0}}},
			},
		},
	}
	c := &pdfCtx{used: map[*embeddedFont]bool{}, alpha: 1}
	c.textBody(node)
	out := c.buf.String()
	if !strings.Contains(out, "(\x95) Tj") {
		t.Fatalf("bullet marker not emitted as the WinAnsi bullet:\n%s", out)
	}
	if !strings.Contains(out, "1 0 0 -1 "+pn(25.6)+" ") {
		t.Fatalf("list text should start after a 1.6em gutter:\n%s", out)
	}
	if !strings.Contains(out, "1 0 0 -1 "+pn(0)+" ") {
		t.Fatalf("a plain paragraph should still start at the content edge:\n%s", out)
	}
	if strings.Count(out, " Tj") != 3 {
		t.Fatalf("expected marker + two runs = 3 text ops, got %d", strings.Count(out, " Tj"))
	}
}

// The SVG path emits the marker as its own text element in the gutter and
// starts the paragraph after it.
func TestSvgTextBodyPlacesMarkerAndIndent(t *testing.T) {
	node := map[string]any{
		"type": "text",
		"size": map[string]any{"width": 300.0, "height": 100.0},
		"content": []any{
			map[string]any{
				"runs":  []any{map[string]any{"text": "first", "style": map[string]any{"fontSize": 16.0}}},
				"style": map[string]any{"list": map[string]any{"type": "number", "level": 0.0}},
			},
			map[string]any{
				"runs":  []any{map[string]any{"text": "second", "style": map[string]any{"fontSize": 16.0}}},
				"style": map[string]any{"list": map[string]any{"type": "number", "level": 0.0}},
			},
		},
	}
	c := &svgCtx{alpha: 1}
	out := c.textBody(node)
	if !strings.Contains(out, ">1.</tspan>") || !strings.Contains(out, ">2.</tspan>") {
		t.Fatalf("numbered markers missing:\n%s", out)
	}
	if strings.Count(out, `<text x="`+num(25.6)+`"`) != 2 {
		t.Fatalf("both items should start after the gutter:\n%s", out)
	}
	if strings.Count(out, `<text x="`+num(0)+`"`) != 2 {
		t.Fatalf("both markers should sit at the content edge:\n%s", out)
	}
}
