package persistence

// The v22 write boundary (PageTransition.easing + Page.transitionOut, F28
// completion C02+C03).
//
// A schema bump must raise currentSchemaVersion and this Go mirror in the
// SAME change. Both new fields are optional and opaque to persistence; the
// easing is deliberately a plain string, so an easing name this binary has
// never heard of must still save.

import (
	"testing"
)

func designAtV22WithTransitions() DesignFile {
	return DesignFile{
		"id": "d", "schemaVersion": float64(22),
		"pages": []any{map[string]any{
			"id":       "p1",
			"children": []any{},
			"transition": map[string]any{
				"type": "slide", "direction": "left", "durationMs": 400.0,
				"easing": "a-future-easing-this-binary-does-not-know",
			},
			"transitionOut": map[string]any{
				"type": "fade", "durationMs": 300.0, "easing": "linear",
			},
		}},
	}
}

// The paired EXACT pins are the cross-language drift alarm: a future bump
// must update this line, the TS twin (transitions.test.ts), and both
// currentSchemaVersion mirrors in the SAME change (CLAUDE.md bump protocol).
func TestV22PinsTheVersionPair(t *testing.T) {
	if currentSchemaVersion != 22 {
		t.Fatalf("currentSchemaVersion = %d: update this pin and the TS twin as part of the bump", currentSchemaVersion)
	}
}

func TestWriteBoundaryAcceptsV22(t *testing.T) {
	if err := validateForWrite(designAtV22WithTransitions()); err != nil {
		t.Fatalf("a current-version document was rejected: %v", err)
	}
}

func TestWriteBoundaryStillAcceptsEveryOlderVersionAtV22(t *testing.T) {
	// Raising the ceiling must not raise the floor: every older document has to
	// keep saving, transition fields present or not.
	for v := 1.0; v <= 22; v++ {
		if err := validateForWrite(designAtVersion(v, maskedImage())); err != nil {
			t.Fatalf("v%.0f rejected: %v", v, err)
		}
	}
}

func TestTransitionFieldsAreOpaqueToTheBackend(t *testing.T) {
	// persistence treats a DesignFile as map[string]any, so the new fields need
	// no Go-side type. This pins that they round-trip untouched.
	d := designAtV22WithTransitions()
	if err := validateForWrite(d); err != nil {
		t.Fatalf("validate: %v", err)
	}
	page := d["pages"].([]any)[0].(map[string]any)
	tr := page["transition"].(map[string]any)
	out := page["transitionOut"].(map[string]any)
	if tr["easing"] != "a-future-easing-this-binary-does-not-know" || out["type"] != "fade" {
		t.Fatalf("transition fields mutated by the write boundary: %+v", page)
	}
}
