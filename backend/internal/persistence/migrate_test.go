package persistence

import "testing"

func TestMigrateAdditiveBumps(t *testing.T) {
	// A v7 file with no transformable nodes migrates to current by version bumps.
	f := DesignFile{"schemaVersion": float64(7), "id": "d", "pages": []any{
		map[string]any{"id": "p", "children": []any{}},
	}}
	out := migrateFile(f)
	if schemaVersionOf(out) != currentSchemaVersion {
		t.Fatalf("expected v%d, got %d", currentSchemaVersion, schemaVersionOf(out))
	}
}

func TestMigrateV1Text(t *testing.T) {
	f := DesignFile{"schemaVersion": float64(1), "id": "d", "pages": []any{
		map[string]any{"id": "p", "children": []any{
			map[string]any{
				"id": "t", "type": "text", "align": "center", "autoFit": "grow",
				"size":    map[string]any{"width": 100.0, "height": 40.0},
				"content": []any{map[string]any{"text": "Hi", "fontSize": 20.0, "color": map[string]any{"space": "srgb", "r": 1.0, "g": 0.0, "b": 0.0, "a": 1.0}}},
			},
		}},
	}}
	out := migrateFile(f)
	if schemaVersionOf(out) != currentSchemaVersion {
		t.Fatalf("version = %d", schemaVersionOf(out))
	}
	node := asObj(asArr(asObj(asArr(out["pages"])[0])["children"])[0])
	box := asObj(node["box"])
	if box["mode"] != "autoHeight" {
		t.Fatalf("autoFit=grow should map to box.mode=autoHeight: %+v", box)
	}
	if node["align"] != nil {
		t.Fatal("v1 align field should be dropped")
	}
	paras := asArr(node["content"])
	run := asObj(asArr(asObj(paras[0])["runs"])[0])
	style := asObj(run["style"])
	if style["fontSize"] != 20.0 || run["text"] != "Hi" {
		t.Fatalf("run not migrated: %+v", run)
	}
	// The fill color was converted to the v4 srgb shape by the v3->v4 step.
	fill := asObj(style["fill"])
	if asObj(fill["color"])["srgb"] == nil {
		t.Fatalf("color should be v4 srgb shape: %+v", fill)
	}
}

func TestMigrateV3Colors(t *testing.T) {
	// A v3 file with an old solid fill (space:srgb color) -> v4 unified shape.
	f := DesignFile{"schemaVersion": float64(3), "id": "d", "pages": []any{
		map[string]any{"id": "p", "children": []any{
			map[string]any{"id": "r", "type": "shape", "shape": "rect",
				"fills": []any{map[string]any{"type": "solid", "color": map[string]any{"space": "srgb", "r": 0.0, "g": 0.5, "b": 1.0, "a": 1.0}}}},
		}},
	}}
	out := migrateFile(f)
	node := asObj(asArr(asObj(asArr(out["pages"])[0])["children"])[0])
	fill := asObj(asArr(node["fills"])[0])
	srgb := asObj(asObj(fill["color"])["srgb"])
	if srgb == nil || asNum(srgb["b"]) != 1.0 {
		t.Fatalf("solid fill color should convert to srgb shape: %+v", fill)
	}
	// A linear gradient fill becomes the unified gradient shape.
	f2 := DesignFile{"schemaVersion": float64(3), "id": "d", "pages": []any{
		map[string]any{"id": "p", "children": []any{
			map[string]any{"id": "g", "type": "shape", "fills": []any{map[string]any{
				"type": "linear", "angle": 45.0,
				"stops": []any{map[string]any{"offset": 0.0, "color": map[string]any{"space": "srgb", "r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0}}},
			}}}},
		}},
	}
	g := asObj(asArr(asObj(asArr(migrateFile(f2)["pages"])[0])["children"])[0])
	gf := asObj(asArr(g["fills"])[0])
	if gf["type"] != "gradient" || gf["gradient"] != "linear" {
		t.Fatalf("linear fill should become unified gradient: %+v", gf)
	}
	stop := asObj(asArr(gf["stops"])[0])
	if stop["position"] != 0.0 || asObj(asObj(stop["color"])["srgb"]) == nil {
		t.Fatalf("gradient stop should carry position + srgb color: %+v", stop)
	}
}

func TestMigrateV5Animation(t *testing.T) {
	f := DesignFile{"schemaVersion": float64(5), "id": "d", "pages": []any{
		map[string]any{"id": "p", "children": []any{
			map[string]any{"id": "n", "type": "shape", "animations": []any{map[string]any{"preset": "slideL", "durationMs": 300.0}}},
		}},
	}}
	out := migrateFile(f)
	node := asObj(asArr(asObj(asArr(out["pages"])[0])["children"])[0])
	ent := asObj(asObj(node["animation"])["entrance"])
	if ent["preset"] != "pan" || asNum(ent["durationMs"]) != 300.0 {
		t.Fatalf("legacy slideL animation should lift to entrance pan: %+v", ent)
	}
}

func TestMigrateNoOpAtCurrent(t *testing.T) {
	f := DesignFile{"schemaVersion": float64(currentSchemaVersion), "id": "d", "pages": []any{}}
	if got := migrateFile(f); schemaVersionOf(got) != currentSchemaVersion {
		t.Fatalf("current file should be a no-op")
	}
}

func TestNormalizePageDimsFromContent(t *testing.T) {
	// A current-version file whose page has no width/height: dims are derived
	// from the content bounding box (max x+w, y+h over nodes).
	f := DesignFile{"schemaVersion": float64(currentSchemaVersion), "id": "d", "pages": []any{
		map[string]any{"id": "p", "children": []any{
			map[string]any{"id": "a", "type": "shape", "transform": map[string]any{"x": 80.0, "y": 60.0}, "size": map[string]any{"width": 1760.0, "height": 900.0}},
		}},
	}}
	out := migrateFile(f)
	p := asObj(asArr(out["pages"])[0])
	if asNum(p["width"]) != 1840 || asNum(p["height"]) != 960 {
		t.Fatalf("derived dims = %vx%v, want 1840x960", p["width"], p["height"])
	}
}

func TestNormalizePageDimsReusesSiblingAndDefaults(t *testing.T) {
	// One valid page seeds the size for a sibling that is missing dims.
	f := DesignFile{"schemaVersion": float64(currentSchemaVersion), "id": "d", "pages": []any{
		map[string]any{"id": "p1", "width": 1920.0, "height": 1080.0, "children": []any{}},
		map[string]any{"id": "p2", "children": []any{}},
	}}
	out := migrateFile(f)
	p2 := asObj(asArr(out["pages"])[1])
	if asNum(p2["width"]) != 1920 || asNum(p2["height"]) != 1080 {
		t.Fatalf("sibling dims = %vx%v, want 1920x1080", p2["width"], p2["height"])
	}
	// No pages, no nodes -> default 1080 fallback (no panic).
	g := DesignFile{"schemaVersion": float64(currentSchemaVersion), "id": "d", "pages": []any{
		map[string]any{"id": "x", "children": []any{}},
	}}
	gp := asObj(asArr(migrateFile(g)["pages"])[0])
	if asNum(gp["width"]) != 1080 || asNum(gp["height"]) != 1080 {
		t.Fatalf("fallback dims = %vx%v, want 1080x1080", gp["width"], gp["height"])
	}
}

func TestNormalizePageDimsLeavesValidUntouched(t *testing.T) {
	f := DesignFile{"schemaVersion": float64(currentSchemaVersion), "id": "d", "pages": []any{
		map[string]any{"id": "p", "width": 1240.0, "height": 1754.0, "children": []any{}},
	}}
	p := asObj(asArr(migrateFile(f)["pages"])[0])
	if asNum(p["width"]) != 1240 || asNum(p["height"]) != 1754 {
		t.Fatalf("valid dims changed: %vx%v", p["width"], p["height"])
	}
}
