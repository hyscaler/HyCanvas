package convert

import "testing"

func frame(id string, x, y, w, h float64, children ...map[string]any) map[string]any {
	kids := make([]any, len(children))
	for i, c := range children {
		kids[i] = c
	}
	return map[string]any{
		"id": id, "type": "frame", "name": id,
		"transform": map[string]any{"x": x, "y": y, "scaleX": 1.0, "scaleY": 1.0},
		"size":      map[string]any{"width": w, "height": h},
		"children":  kids,
	}
}

func rect(id string, x, y, w, h float64) map[string]any {
	return map[string]any{
		"id": id, "type": "shape",
		"transform": map[string]any{"x": x, "y": y, "scaleX": 1.0, "scaleY": 1.0},
		"size":      map[string]any{"width": w, "height": h},
	}
}

func TestWhiteboardToDeck_Frames(t *testing.T) {
	design := map[string]any{
		"title": "Board",
		"meta":  map[string]any{"kind": "whiteboard", "whiteboard": map[string]any{"infinite": true}, "keep": 1.0},
		"pages": []any{map[string]any{"id": "pg", "children": []any{
			frame("f1", 0, 0, 400, 300, rect("a", 10, 10, 50, 50)),
			frame("f2", 500, 0, 400, 300, rect("b", 520, 10, 50, 50)),
		}}},
	}
	deck, slides := WhiteboardToDeck(design)
	if slides != 2 {
		t.Fatalf("expected 2 slides, got %d", slides)
	}
	// Deck dropped the whiteboard surface kind but kept other meta.
	meta := asObj(deck["meta"])
	if _, ok := meta["kind"]; ok {
		t.Fatal("deck meta should drop kind")
	}
	if _, ok := meta["whiteboard"]; ok {
		t.Fatal("deck meta should drop whiteboard")
	}
	if meta["keep"] != 1.0 {
		t.Fatalf("deck meta should keep other keys: %+v", meta)
	}
	// Slides are uniform 1920x1080 with white background.
	p0 := asObj(asArr(deck["pages"])[0])
	if num(p0, "width") != 1920 || num(p0, "height") != 1080 {
		t.Fatalf("slide size: %vx%v", p0["width"], p0["height"])
	}
	if asObj(p0["background"]) == nil {
		t.Fatal("slide should have a background")
	}
	// Child ids are regenerated (not the source "a").
	child := asObj(asArr(p0["children"])[0])
	if id, _ := child["id"].(string); id == "a" {
		t.Fatal("child id should be regenerated")
	}
}

func TestWhiteboardToDeck_Frameless(t *testing.T) {
	design := map[string]any{
		"title": "Loose",
		"pages": []any{map[string]any{"id": "pg", "children": []any{
			rect("a", 0, 0, 100, 100),
			rect("b", 200, 50, 100, 100),
		}}},
	}
	deck, slides := WhiteboardToDeck(design)
	if slides != 1 {
		t.Fatalf("frameless board should yield 1 slide, got %d", slides)
	}
	if title, _ := deck["title"].(string); title != "Loose (deck)" {
		t.Fatalf("deck title: %q", title)
	}
	p0 := asObj(asArr(deck["pages"])[0])
	if len(asArr(p0["children"])) != 2 {
		t.Fatalf("expected both loose nodes on the slide, got %d", len(asArr(p0["children"])))
	}
}
