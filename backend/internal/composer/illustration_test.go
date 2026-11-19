package composer

import (
	"context"
	"strings"
	"testing"
)

// The composer reads its drawings from a registry (the editor loads them on
// demand, #77); the server bundle registers the whole set at startup, so a
// page the outline gives an illustration still gets the drawing here.
func TestCompose_DrawsIllustrations(t *testing.T) {
	outline := map[string]any{
		"title": "Lift-off",
		"pages": []any{map[string]any{
			"title":     "We launch in spring",
			"archetype": "cover",
			"subhead":   "A plan for the first season",
			"image":     map[string]any{"subject": "a rocket", "treatment": "illustration", "illustration": "rocket"},
		}},
	}
	got, err := Compose(context.Background(), Input{Outline: outline, Width: 1080, Height: 1350, DesignType: "post"})
	if err != nil {
		t.Fatalf("compose: %v", err)
	}
	if !strings.Contains(string(got), `"illustration":"CampaignLaunch"`) {
		t.Fatalf("the server composition drew no illustration for the rocket cover:\n%.600s", got)
	}
}
