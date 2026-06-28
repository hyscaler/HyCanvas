package realtime

import "testing"

// The presence palette is generated from frontend/src/theme.config.mjs. Its
// ORDER is meaningful: colorForUser assigns by hash index, so reordering or
// removing entries reassigns existing users' colors. This pins the order; if it
// fails after a theme change you reordered (not appended), so confirm that is
// intended before updating this test.
func TestPresencePaletteStable(t *testing.T) {
	want := []string{
		"#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
		"#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#a855f7",
	}
	if len(presencePalette) != len(want) {
		t.Fatalf("presence palette length = %d, want %d", len(presencePalette), len(want))
	}
	for i, c := range want {
		if presencePalette[i] != c {
			t.Errorf("presencePalette[%d] = %s, want %s (reordering reassigns users' colors)", i, presencePalette[i], c)
		}
	}
}

// colorForUser must be deterministic and always return a palette color.
func TestColorForUserStable(t *testing.T) {
	if a, b := colorForUser("user-123"), colorForUser("user-123"); a != b {
		t.Fatalf("colorForUser not deterministic: %s vs %s", a, b)
	}
	got := colorForUser("user-123")
	for _, c := range presencePalette {
		if c == got {
			return
		}
	}
	t.Fatalf("colorForUser returned %s not in palette", got)
}
