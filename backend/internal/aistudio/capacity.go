package aistudio

import (
	"fmt"
	"math"
)

// The capacity clause the outline prompt carries: how many characters one
// line of each slot holds at full size on the deck's page, from the same
// constants the composer sets type with. Mirrors capacity.ts; the composer
// package's test checks this copy against the bundle's for every page size.

// designTypeSizes mirrors generateSizes on the API and designTypeSizes in
// capacity.ts.
var designTypeSizes = map[string][2]int{
	"deck": {1920, 1080}, "doc": {1240, 1754}, "poster": {1080, 1350}, "social": {1080, 1080}, "social-set": {1080, 1080},
}

type slotCapacity struct{ title, point, columnPoint, coverSubhead, statLabel int }

func slotCapacityFor(width, height int) slotCapacity {
	w := float64(width)
	h := float64(height)
	short := math.Min(w, h)
	unit := math.Max(4, math.Round(short*0.012))
	margin := unit * 6
	gutter := unit * 2
	col := (w - 2*margin - 11*gutter) / 12
	full := w - 2*margin
	six := 6*col + 5*gutter
	titlePx := h * 0.07
	pointPx := h * 0.034
	subPx := h * 0.034
	labelPx := h * 0.036
	return slotCapacity{
		title:        int(math.Floor(full / (titlePx * 0.55))),
		point:        int(math.Floor((full - 1.6*pointPx) / (pointPx * 0.5))),
		columnPoint:  int(math.Floor((six - 6*unit - 1.6*pointPx) / (pointPx * 0.5))),
		coverSubhead: int(math.Floor(six / (subPx * 0.5))),
		statLabel:    int(math.Floor((six - 6*unit) / (labelPx * 0.55))),
	}
}

// CapacityClause renders the sentence for a design type at its default page.
func CapacityClause(designType string) string {
	size, ok := designTypeSizes[designType]
	if !ok {
		size = designTypeSizes["deck"]
	}
	return capacityClauseAt(designType, size[0], size[1])
}

func capacityClauseAt(designType string, width, height int) string {
	c := slotCapacityFor(width, height)
	what := "post"
	switch designType {
	case "deck":
		what = "deck"
	case "doc":
		what = "document"
	case "poster":
		what = "poster"
	}
	return fmt.Sprintf("This %s composes at %d by %d. At full size one line holds about %d characters of a title, %d of a bullet, %d of a column point, %d of a cover subhead and %d of a stat label; a title reads best on one or two lines and a bullet on one or two. Write to that width rather than well under it: a point far shorter than its line reads as thin, not concise.", what, width, height, c.title, c.point, c.columnPoint, c.coverSubhead, c.statLabel)
}
