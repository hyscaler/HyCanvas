package persistence

// The v24 write boundary (Interaction.actionV2, F28 completion C16). The kind
// is a plain string; persistence treats the whole field as opaque keys.

import (
	"testing"
)

func designAtV24WithInteraction() DesignFile {
	return DesignFile{
		"id": "d", "schemaVersion": float64(24),
		"pages": []any{map[string]any{
			"id": "p1",
			"children": []any{map[string]any{
				"id": "n1", "type": "shape", "shape": "rect",
				"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
				"size":      map[string]any{"width": 10.0, "height": 10.0},
				"fills":     []any{},
				"interaction": map[string]any{
					"trigger": "click",
					"action":  map[string]any{"kind": "none"},
					"actionV2": map[string]any{
						"kind": "an-action-this-binary-does-not-know", "targetNodeId": "vid-1",
					},
				},
			}},
		}},
	}
}

// The paired EXACT pins are the cross-language drift alarm: a future bump
// must update this line, the TS twin (interactions.test.ts), and both
// currentSchemaVersion mirrors in the SAME change (CLAUDE.md bump protocol).
func TestV24PinsTheVersionPair(t *testing.T) {
	if currentSchemaVersion != 24 {
		t.Fatalf("currentSchemaVersion = %d: update this pin and the TS twin as part of the bump", currentSchemaVersion)
	}
}

func TestWriteBoundaryAcceptsV24(t *testing.T) {
	if err := validateForWrite(designAtV24WithInteraction()); err != nil {
		t.Fatalf("a current-version document was rejected: %v", err)
	}
}

func TestWriteBoundaryStillAcceptsEveryOlderVersionAtV24(t *testing.T) {
	for v := 1.0; v <= 24; v++ {
		if err := validateForWrite(designAtVersion(v, maskedImage())); err != nil {
			t.Fatalf("v%.0f rejected: %v", v, err)
		}
	}
}

func TestActionV2IsOpaqueToTheBackend(t *testing.T) {
	d := designAtV24WithInteraction()
	if err := validateForWrite(d); err != nil {
		t.Fatalf("validate: %v", err)
	}
	node := d["pages"].([]any)[0].(map[string]any)["children"].([]any)[0].(map[string]any)
	v2 := node["interaction"].(map[string]any)["actionV2"].(map[string]any)
	if v2["kind"] != "an-action-this-binary-does-not-know" {
		t.Fatalf("actionV2 mutated by the write boundary: %+v", v2)
	}
}
