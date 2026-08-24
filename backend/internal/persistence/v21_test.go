package persistence

// The v21 write boundary (Placeholder capacity hints, F28 T11).
//
// A schema bump must raise currentSchemaVersion and this Go mirror in the
// SAME change. The capacities are optional numbers on Placeholder that only
// layout-grounded generation reads; persistence treats them as opaque keys.

import (
	"testing"
)

func layoutWithCapacities() map[string]any {
	return map[string]any{
		"id": "layout-x", "masterId": "master-default", "name": "Capped",
		"placeholders": []any{map[string]any{
			"id": "ph-title", "role": "title",
			"rect":     map[string]any{"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.15},
			"maxChars": 60.0, "minChars": 30.0,
		}, map[string]any{
			"id": "ph-content", "role": "content",
			"rect":     map[string]any{"x": 0.1, "y": 0.3, "width": 0.8, "height": 0.6},
			"maxChars": 400.0, "minChars": 200.0, "minItems": 2.0, "maxItems": 6.0,
		}},
	}
}

func designAtV21WithLayout() DesignFile {
	return DesignFile{
		"id": "d", "schemaVersion": float64(21),
		"layouts": []any{layoutWithCapacities()},
		"pages":   []any{map[string]any{"id": "p", "children": []any{}}},
	}
}

func TestWriteBoundaryAcceptsV21(t *testing.T) {
	if err := validateForWrite(designAtV21WithLayout()); err != nil {
		t.Fatalf("a current-version document was rejected: %v", err)
	}
}

func TestWriteBoundaryStillAcceptsEveryOlderVersionAtV21(t *testing.T) {
	// Raising the ceiling must not raise the floor: every older document has to
	// keep saving, capacities present or not.
	for v := 1.0; v <= 21; v++ {
		if err := validateForWrite(designAtVersion(v, maskedImage())); err != nil {
			t.Fatalf("v%.0f rejected: %v", v, err)
		}
	}
}

func TestCapacitiesAreOpaqueToTheBackend(t *testing.T) {
	// persistence treats a DesignFile as map[string]any, so the new fields need
	// no Go-side type. This pins that: capacities round-trip untouched.
	d := designAtV21WithLayout()
	if err := validateForWrite(d); err != nil {
		t.Fatalf("validate: %v", err)
	}
	layouts := d["layouts"].([]any)
	ph := layouts[0].(map[string]any)["placeholders"].([]any)[1].(map[string]any)
	if ph["maxChars"] != 400.0 || ph["minItems"] != 2.0 {
		t.Fatalf("capacities mutated by the write boundary: %+v", ph)
	}
}
