package persistence

// The v25 write boundary: photo-grid track sizes (#40). `colWidths` and
// `rowHeights` are optional weight arrays on a grid node; persistence treats
// them as opaque, so the interesting property is that they survive a round trip
// rather than that their values mean anything here.

import (
	"testing"
)

func gridWithTracks() map[string]any {
	return map[string]any{
		"id": "g1", "type": "grid",
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 400.0, "height": 400.0},
		"rows":      2.0, "cols": 2.0, "gap": 8.0,
		"cells": []any{
			map[string]any{"row": 0.0, "col": 0.0, "rowSpan": 1.0, "colSpan": 1.0},
			map[string]any{"row": 0.0, "col": 1.0, "rowSpan": 1.0, "colSpan": 1.0},
		},
		"children":   []any{},
		"colWidths":  []any{2.0, 1.0},
		"rowHeights": []any{1.0, 1.0},
	}
}

// The paired EXACT pins are the cross-language drift alarm: a future bump
// must update this line, the TS twin (gridTracks.test.ts), and both
// currentSchemaVersion mirrors in the SAME change (CLAUDE.md bump protocol).
func TestV25PinsTheVersionPair(t *testing.T) {
	if currentSchemaVersion != 25 {
		t.Fatalf("currentSchemaVersion = %d: update this pin and the TS twin as part of the bump", currentSchemaVersion)
	}
}

func TestWriteBoundaryAcceptsV25(t *testing.T) {
	if err := validateForWrite(designAtVersion(25, gridWithTracks())); err != nil {
		t.Fatalf("a current-version document was rejected: %v", err)
	}
}

// Every older version must still be writable: a self-hoster upgrading a binary
// keeps designs made by every version before it.
func TestWriteBoundaryStillAcceptsEveryOlderVersionAtV25(t *testing.T) {
	for v := 1.0; v <= 25; v++ {
		if err := validateForWrite(designAtVersion(v, maskedImage())); err != nil {
			t.Fatalf("v%.0f rejected: %v", v, err)
		}
	}
}

// A grid WITHOUT track sizes is the shape every existing design has, and it
// must keep validating untouched: omitting the keys means equal tracks.
func TestWriteBoundaryAcceptsAGridWithNoTrackSizes(t *testing.T) {
	g := gridWithTracks()
	delete(g, "colWidths")
	delete(g, "rowHeights")
	if err := validateForWrite(designAtVersion(25, g)); err != nil {
		t.Fatalf("a grid without track sizes was rejected: %v", err)
	}
}

// The backend never interprets the weights, so they must come back exactly as
// written. Losing them here would silently reset an author's proportions on the
// next save, which is the failure this guards.
func TestTrackSizesAreOpaqueToTheBackend(t *testing.T) {
	d := designAtVersion(25, gridWithTracks())
	if err := validateForWrite(d); err != nil {
		t.Fatalf("validate: %v", err)
	}
	node := d["pages"].([]any)[0].(map[string]any)["children"].([]any)[0].(map[string]any)
	cols, ok := node["colWidths"].([]any)
	if !ok || len(cols) != 2 || cols[0] != 2.0 || cols[1] != 1.0 {
		t.Fatalf("colWidths did not survive the write boundary: %#v", node["colWidths"])
	}
	rows, ok := node["rowHeights"].([]any)
	if !ok || len(rows) != 2 {
		t.Fatalf("rowHeights did not survive the write boundary: %#v", node["rowHeights"])
	}
}
