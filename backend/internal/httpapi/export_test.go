package httpapi

import (
	"strings"
	"testing"

	"hycanvas/backend/internal/persistence"
)

// The deck-to-video inline file never reaches the write boundary, so the
// export handler applies the same gate itself: an absurd page size would have
// the rasterizer allocate until the process dies, and a deep tree would
// overflow the stack (fatal, unrecoverable).
func TestBoundedPageSizes(t *testing.T) {
	ok := map[string]any{"pages": []any{map[string]any{"width": 1920.0, "height": 1080.0}}}
	if err := boundedPageSizes(ok); err != nil {
		t.Fatalf("a normal deck page was rejected: %v", err)
	}
	huge := map[string]any{"pages": []any{map[string]any{"width": 60000.0, "height": 60000.0}}}
	if err := boundedPageSizes(huge); err == nil {
		t.Error("a 60000px page was accepted")
	}
	stage := map[string]any{
		"pages": []any{map[string]any{"width": 100.0, "height": 100.0}},
		"meta":  map[string]any{"video": map[string]any{"stage": map[string]any{"width": 99999.0, "height": 10.0}}},
	}
	if err := boundedPageSizes(stage); err == nil {
		t.Error("a 99999px video stage was accepted")
	}
}

// The inline file must clear the same structural bar as a persisted one.
func TestValidateFileRejectsPathologicalInlineFile(t *testing.T) {
	deep := map[string]any{"id": "d", "pages": []any{}}
	node := map[string]any{"id": "n0", "type": "frame"}
	root := node
	for i := 1; i < 200; i++ {
		child := map[string]any{"id": "n" + strings.Repeat("x", i), "type": "frame"}
		node["children"] = []any{child}
		node = child
	}
	deep["pages"] = []any{map[string]any{"id": "p1", "children": []any{root}}}
	if err := persistence.ValidateFile(deep); err == nil {
		t.Error("a 200-deep node tree was accepted")
	}
}
