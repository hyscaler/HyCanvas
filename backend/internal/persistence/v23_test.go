package persistence

// The v23 write boundary (animation depth channels, F28 completion
// C11/C12/C13/C15): Keyframe color/width/height, KeyframeTrack path/orient,
// AnimationClip spring, NodeAnimation trigger. All optional; persistence
// treats them as opaque keys.

import (
	"testing"
)

func designAtV23WithAnimation() DesignFile {
	return DesignFile{
		"id": "d", "schemaVersion": float64(23),
		"pages": []any{map[string]any{
			"id": "p1",
			"children": []any{map[string]any{
				"id": "n1", "type": "shape", "shape": "rect",
				"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
				"size":      map[string]any{"width": 100.0, "height": 100.0},
				"fills":     []any{},
				"animation": map[string]any{
					"entrance": map[string]any{"preset": "fade", "durationMs": 400.0, "delayMs": 0.0, "easing": "spring", "spring": map[string]any{"stiffness": 14.0, "damping": 0.5}},
					"custom": map[string]any{
						"durationMs": 2000.0, "orient": true,
						"path":      []any{map[string]any{"x": 0.0, "y": 0.0}, map[string]any{"x": 400.0, "y": 0.0}},
						"keyframes": []any{map[string]any{"t": 0.0, "width": 100.0, "color": map[string]any{"srgb": map[string]any{"r": 1.0, "g": 0.0, "b": 0.0, "a": 1.0}}}},
					},
					"trigger": map[string]any{"mediaNodeId": "vid-1", "atMs": 3000.0},
				},
			}},
		}},
	}
}

// The exact version pin lives with the LATEST bump (v24_test.go), so there is
// exactly one drift alarm per side at any time.

func TestWriteBoundaryAcceptsV23(t *testing.T) {
	if err := validateForWrite(designAtV23WithAnimation()); err != nil {
		t.Fatalf("a current-version document was rejected: %v", err)
	}
}

func TestWriteBoundaryStillAcceptsEveryOlderVersionAtV23(t *testing.T) {
	for v := 1.0; v <= 23; v++ {
		if err := validateForWrite(designAtVersion(v, maskedImage())); err != nil {
			t.Fatalf("v%.0f rejected: %v", v, err)
		}
	}
}

func TestAnimationChannelsAreOpaqueToTheBackend(t *testing.T) {
	d := designAtV23WithAnimation()
	if err := validateForWrite(d); err != nil {
		t.Fatalf("validate: %v", err)
	}
	node := d["pages"].([]any)[0].(map[string]any)["children"].([]any)[0].(map[string]any)
	anim := node["animation"].(map[string]any)
	if anim["trigger"].(map[string]any)["atMs"] != 3000.0 {
		t.Fatalf("animation fields mutated by the write boundary: %+v", anim)
	}
}
