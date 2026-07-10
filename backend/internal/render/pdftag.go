// Accessibility tagging for PDF export (doc 28 FR-22, FR-29).
//
// An untagged PDF is a bag of glyphs and paths: a screen reader gets no
// structure, no descriptions, and no order it can trust. A tagged PDF carries a
// structure tree beside the page content, so assistive technology reads the
// slide as authored rather than as drawn.
//
// Two orders exist and they are deliberately different. Content is drawn in
// z-order, because that is what the page must look like. The structure tree is
// built in reading order, because that is what the page must mean. The bridge
// between them is the marked-content id (MCID): each drawn item is wrapped in
// `/Role <</MCID n>> BDC ... EMC`, and the structure tree references those ids
// in whatever order the author chose.
//
// The reading-order and alt-text rules mirror `packages/schema/src/a11y.ts`
// exactly, including its guiding rule: these fields can never hide content. An
// absent reading order falls back to z-order, a partial one is completed with
// the remaining nodes in z-order, and a stale id is ignored rather than fatal.

package render

import "strings"

// pdfTag is one entry in the structure tree: a marked-content id, the standard
// structure type it carries, and an optional description.
type pdfTag struct {
	mcid int
	role string // a standard structure type: P, Figure, Sect
	alt  string // /Alt, the description exposed to assistive technology
}

// Standard structure types we emit. Because every role here is already a
// standard type, the structure tree needs no /RoleMap.
const (
	tagParagraph = "P"
	tagFigure    = "Figure"
	tagSection   = "Sect"
	tagDocument  = "Document"
)

// nodeAltText mirrors `nodeAltText` in a11y.ts: the generic `altText` wins, and
// the older image-only `alt` stays supported so files written before schema v12
// keep the descriptions they already have.
func nodeAltText(node map[string]any) string {
	if s := strings.TrimSpace(asStr(node["altText"])); s != "" {
		return s
	}
	if asStr(node["type"]) == "image" {
		return strings.TrimSpace(asStr(node["alt"]))
	}
	return ""
}

// isDecorative mirrors `isDecorative` in a11y.ts. A decorative node is
// presentational: it becomes a PDF artifact, outside the structure tree, so a
// screen reader steps over it instead of announcing it.
func isDecorative(node map[string]any) bool { return asBool(node["decorative"]) }

// tagRole decides how a node enters the structure tree.
//
//   - text and sticky carry words, so they are paragraphs.
//   - an image always enters the tree, described or not. Tagging an undescribed
//     image as an artifact would silently hide it from a screen reader; leaving
//     it a /Figure with no /Alt keeps it visible to the reader and to any
//     PDF/UA checker, which is the honest outcome and matches what our own
//     accessibility checker already flags.
//   - other geometry (shape, path, line, ink, connector) is presentational
//     unless the author described it. Nothing is lost by artifacting a bare
//     rectangle, and everything is lost by making a reader hear about it.
//
// The empty string means "emit as an artifact".
func tagRole(node map[string]any) string {
	if isDecorative(node) {
		return ""
	}
	switch asStr(node["type"]) {
	case "text", "sticky":
		return tagParagraph
	case "image":
		return tagFigure
	default:
		if nodeAltText(node) != "" {
			return tagFigure
		}
		return ""
	}
}

// resolveReadingOrder mirrors `resolveReadingOrder` in a11y.ts: the ids in
// `page.readingOrder` that still exist come first, then every remaining node in
// z-order. A missing list means pure z-order. Nothing is ever omitted.
func resolveReadingOrder(page map[string]any) []any {
	children := asArr(page["children"])
	order := asArr(page["readingOrder"])
	if len(order) == 0 {
		return children
	}
	byID := make(map[string]any, len(children))
	for _, ch := range children {
		byID[asStr(asObj(ch)["id"])] = ch
	}
	ordered := make([]any, 0, len(children))
	taken := make(map[string]bool, len(children))
	for _, raw := range order {
		id := asStr(raw)
		if n, ok := byID[id]; ok && !taken[id] {
			ordered = append(ordered, n)
			taken[id] = true
		}
	}
	for _, ch := range children { // never hide a node
		if !taken[asStr(asObj(ch)["id"])] {
			ordered = append(ordered, ch)
		}
	}
	return ordered
}
