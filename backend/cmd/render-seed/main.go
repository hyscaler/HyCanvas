// Command render-seed rasterizes every built-in template in a seed.json to
// PNGs for visual review (template authoring aid; not part of the product).
package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"

	"hycanvas/backend/internal/render"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: render-seed <seed.json> <outdir>")
		os.Exit(2)
	}
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var entries []struct {
		Template map[string]any `json:"template"`
		File     map[string]any `json:"file"`
	}
	if err := json.Unmarshal(raw, &entries); err != nil {
		panic(err)
	}
	if err := os.MkdirAll(os.Args[2], 0o755); err != nil {
		panic(err)
	}
	for _, e := range entries {
		id, _ := e.Template["id"].(string)
		pages, _ := e.File["pages"].([]any)
		for i := range pages {
			p, _ := pages[i].(map[string]any)
			w, _ := p["width"].(float64)
			h, _ := p["height"].(float64)
			scale := math.Min(1, 800/math.Max(w, h))
			png, err := render.ToPNG(render.Design(e.File), i, scale)
			if err != nil {
				fmt.Println("ERR", id, i, err)
				continue
			}
			name := id + ".png"
			if len(pages) > 1 {
				name = fmt.Sprintf("%s-p%d.png", id, i)
			}
			if err := os.WriteFile(filepath.Join(os.Args[2], name), png, 0o644); err != nil {
				panic(err)
			}
		}
	}
	fmt.Println("rendered", len(entries), "templates")
}
