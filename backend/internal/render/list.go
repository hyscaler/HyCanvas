// List markers for exported text.
//
// The canvas lays a list paragraph out with a marker in a gutter and a
// hanging indent for wrapped lines (@hc/text layoutText). The three exporters
// used to ignore style.list entirely, so a bulleted slide exported as flush
// paragraphs with no bullets, and generated decks worked around it by baking
// a literal bullet character into the text. This mirrors the canvas's list
// bookkeeping so the raster, PDF and SVG paths draw what the editor shows,
// and the composer can use real list styles.

package render

import "strconv"

// The gutter and the per-level indent, in ems of the paragraph's first run,
// exactly as the canvas sizes them.
const (
	listGutterEm = 1.6
	listLevelEm  = 1.2
)

// listCounters carries numbered-list ordinals across the paragraphs of one
// text node: one counter per level, deeper levels restart, and a paragraph
// that is not a list item resets numbering.
type listCounters struct{ n []int }

// listLayout is what one paragraph's list style adds to its geometry.
type listLayout struct {
	// marker is drawn in the gutter on the first line; empty when the
	// paragraph is not a list item.
	marker string
	// markerX is the marker's offset from the content edge.
	markerX float64
	// indent is every line's offset from the content edge: the marker offset
	// plus the gutter for a list item, the plain indentStart otherwise.
	indent float64
}

// paragraphStyleOf resolves the style the canvas would read: the paragraph's
// own style with its overrides on top.
func paragraphStyleOf(po map[string]any) map[string]any {
	st := asObj(po["style"])
	ov := asObj(po["overrides"])
	if len(ov) == 0 {
		return st
	}
	out := make(map[string]any, len(st)+len(ov))
	for k, v := range st {
		out[k] = v
	}
	for k, v := range ov {
		out[k] = v
	}
	return out
}

// listMarkerText mirrors the canvas's marker choice: an author's own marker,
// else an ordinal for numbered lists, a ballot box for checklists, a bullet.
func listMarkerText(typ, custom string, ordinal int) string {
	if custom != "" {
		return custom
	}
	switch typ {
	case "number":
		return strconv.Itoa(ordinal) + "."
	case "checklist":
		return "☐"
	}
	return "•"
}

// next advances the counters for one paragraph and returns its list geometry.
// em is the paragraph's first run's font size.
func (c *listCounters) next(pstyle map[string]any, em float64) listLayout {
	indentStart := asNum(pstyle["indentStart"])
	list := asObj(pstyle["list"])
	if list == nil {
		c.n = c.n[:0]
		return listLayout{indent: indentStart}
	}
	level := int(asNum(list["level"]))
	if level < 0 {
		level = 0
	}
	typ := asStr(list["type"])
	for len(c.n) <= level {
		c.n = append(c.n, 0)
	}
	if typ == "number" {
		c.n[level]++
		c.n = c.n[:level+1]
	}
	ord := c.n[level]
	if ord == 0 {
		ord = 1
	}
	markerX := indentStart + float64(level)*em*listLevelEm
	return listLayout{
		marker:  listMarkerText(typ, asStr(list["marker"]), ord),
		markerX: markerX,
		indent:  markerX + em*listGutterEm,
	}
}

// winAnsiMarker is the marker as the base-14 PDF path can show it. Those
// fonts are single-byte WinAnsi, and a UTF-8 bullet written into them reads
// back as three wrong glyphs. The bullet and the dashes have WinAnsi codes;
// anything else the encoding lacks becomes the bullet rather than garbage.
func winAnsiMarker(marker string) string {
	out := make([]byte, 0, len(marker))
	for _, r := range marker {
		switch {
		case r < 0x80:
			out = append(out, byte(r))
		case r == '\u2022':
			out = append(out, 0x95)
		case r == '\u2013':
			out = append(out, 0x96)
		case r == '\u2014':
			out = append(out, 0x97)
		default:
			out = append(out, 0x95)
		}
	}
	return string(out)
}
