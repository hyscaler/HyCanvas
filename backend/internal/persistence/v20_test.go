package persistence

// The v20 write boundary (ImageNode.alphaMask).
//
// A schema bump must raise CURRENT_SCHEMA_VERSION and this Go mirror in the
// SAME change. Miss the mirror and validate.go range-checks the newer file out
// with 422 and nothing persists, which is a data-loss bug that only shows up
// once a client has already been upgraded.

import (
	"errors"
	"testing"
)

func designAtVersion(v float64, node map[string]any) DesignFile {
	return DesignFile{
		"id": "d", "schemaVersion": v,
		"pages": []any{map[string]any{"id": "p", "children": []any{node}}},
	}
}

func maskedImage() map[string]any {
	return map[string]any{
		"id": "img", "type": "image",
		"source":    map[string]any{"assetId": "a1", "naturalWidth": 100.0, "naturalHeight": 80.0},
		"fit":       "cover",
		"alphaMask": map[string]any{"assetId": "m1", "width": 100.0, "height": 80.0},
	}
}

func TestWriteBoundaryAcceptsV20(t *testing.T) {
	if err := validateForWrite(designAtVersion(20, maskedImage())); err != nil {
		t.Fatalf("a current-version document was rejected: %v", err)
	}
}

func TestWriteBoundaryStillAcceptsOlderVersions(t *testing.T) {
	// Raising the ceiling must not raise the floor: every older document has to
	// keep saving.
	for v := 1.0; v <= 20; v++ {
		if err := validateForWrite(designAtVersion(v, maskedImage())); err != nil {
			t.Fatalf("v%.0f rejected: %v", v, err)
		}
	}
}

func TestWriteBoundaryRejectsAVersionFromTheFuture(t *testing.T) {
	// The check is what tells an operator their binary is behind, rather than
	// silently persisting a file it cannot render.
	if err := validateForWrite(designAtVersion(21, maskedImage())); !errors.Is(err, ErrInvalidFile) {
		t.Fatalf("v21 accepted by a v20 binary: %v", err)
	}
}

func TestTheMaskIsOpaqueToTheBackend(t *testing.T) {
	// persistence treats a DesignFile as map[string]any, so a new field needs no
	// Go-side type. This pins that: the mask round-trips untouched.
	d := designAtVersion(20, maskedImage())
	if err := validateForWrite(d); err != nil {
		t.Fatalf("validate: %v", err)
	}
	node := asObj(asArr(asObj(asArr(d["pages"])[0])["children"])[0])
	m := asObj(node["alphaMask"])
	if m == nil || m["assetId"] != "m1" {
		t.Fatalf("mask altered by validation: %+v", node["alphaMask"])
	}
}
