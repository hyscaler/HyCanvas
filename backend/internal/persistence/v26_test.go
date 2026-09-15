package persistence

// The v26 write boundary: masonry collages (#39). `masonry` is an optional flag
// on a grid node; persistence treats it as opaque, so what matters here is that
// it survives a round trip and that a grid without it still validates.

import (
	"testing"
)

func gridWithMasonry() map[string]any {
	return map[string]any{
		"id": "g1", "type": "grid",
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 400.0, "height": 400.0},
		"rows":      2.0, "cols": 2.0, "gap": 8.0,
		"cells": []any{
			map[string]any{"row": 0.0, "col": 0.0, "rowSpan": 1.0, "colSpan": 1.0},
			map[string]any{"row": 0.0, "col": 1.0, "rowSpan": 1.0, "colSpan": 1.0},
		},
		"children": []any{},
		"masonry":  true,
	}
}

// The paired EXACT pins are the cross-language drift alarm: a future bump
// must update this line, the TS twin (masonry.test.ts), and both
// currentSchemaVersion mirrors in the SAME change (CLAUDE.md bump protocol).
func TestV26PinsTheVersionPair(t *testing.T) {
	if currentSchemaVersion != 26 {
		t.Fatalf("currentSchemaVersion = %d: update this pin and the TS twin as part of the bump", currentSchemaVersion)
	}
}

func TestWriteBoundaryAcceptsV26(t *testing.T) {
	if err := validateForWrite(designAtVersion(26, gridWithMasonry())); err != nil {
		t.Fatalf("a current-version document was rejected: %v", err)
	}
}

// Every older version must still be writable: a self-hoster upgrading a binary
// keeps designs made by every version before it.
func TestWriteBoundaryStillAcceptsEveryOlderVersionAtV26(t *testing.T) {
	for v := 1.0; v <= 26; v++ {
		if err := validateForWrite(designAtVersion(v, maskedImage())); err != nil {
			t.Fatalf("v%.0f rejected: %v", v, err)
		}
	}
}

// A grid WITHOUT the flag is the shape every existing design has, and it must
// keep validating untouched: omitting the key means the regular lattice.
func TestWriteBoundaryAcceptsAGridWithNoMasonryFlag(t *testing.T) {
	g := gridWithMasonry()
	delete(g, "masonry")
	if err := validateForWrite(designAtVersion(26, g)); err != nil {
		t.Fatalf("a grid without the masonry flag was rejected: %v", err)
	}
}

// The backend never interprets the flag, so it must come back exactly as
// written. Losing it here would silently drop an author's collage layout on the
// next save, which is the failure this guards.
func TestMasonryFlagIsOpaqueToTheBackend(t *testing.T) {
	d := designAtVersion(26, gridWithMasonry())
	if err := validateForWrite(d); err != nil {
		t.Fatalf("validate: %v", err)
	}
	node := d["pages"].([]any)[0].(map[string]any)["children"].([]any)[0].(map[string]any)
	if node["masonry"] != true {
		t.Fatalf("masonry did not survive the write boundary: %#v", node["masonry"])
	}
	// The lattice an older client lays out must survive alongside it.
	if node["rows"] != 2.0 || node["cols"] != 2.0 {
		t.Fatalf("the row/column lattice was altered: rows=%#v cols=%#v", node["rows"], node["cols"])
	}
	if cells, ok := node["cells"].([]any); !ok || len(cells) != 2 {
		t.Fatalf("cells did not survive the write boundary: %#v", node["cells"])
	}
}
