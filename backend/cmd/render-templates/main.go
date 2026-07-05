// render-templates rasterizes every template in the embedded seed catalog to
// PNG, one file per page. A dev tool for visually auditing template quality
// and (re)generating preview images; text draws in the renderer's fallback
// font, so it previews layout and color, not the final typography.
//
//	go run ./cmd/render-templates -out /tmp/tpl-previews [-seed internal/templates/seed.json] [-edge 800]
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"hycanvas/backend/internal/render"
)

// registerFontDir loads every Family-Weight.ttf in dir into the render
// package's font registry, so text rasters in its real face.
func registerFontDir(dir string) (int, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".ttf") {
			continue
		}
		base := strings.TrimSuffix(name, ".ttf")
		i := strings.LastIndex(base, "-")
		if i < 0 {
			continue
		}
		weight, err := strconv.Atoi(base[i+1:])
		if err != nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return n, err
		}
		if err := render.RegisterFont(base[:i], weight, data); err != nil {
			return n, fmt.Errorf("%s: %w", name, err)
		}
		n++
	}
	return n, nil
}

func main() {
	seedPath := flag.String("seed", "internal/templates/seed.json", "path to the template seed JSON")
	outDir := flag.String("out", "", "output directory for PNGs (required)")
	edge := flag.Float64("edge", 800, "target length of the longest page edge in pixels")
	fontDir := flag.String("fonts", "", "dir of Family-Weight.ttf files for glyph-true text (optional)")
	flag.Parse()
	if *fontDir != "" {
		n, err := registerFontDir(*fontDir)
		if err != nil {
			fmt.Fprintln(os.Stderr, "fonts:", err)
			os.Exit(1)
		}
		fmt.Printf("registered %d real fonts\n", n)
	}
	if *outDir == "" {
		fmt.Fprintln(os.Stderr, "usage: render-templates -out <dir>")
		os.Exit(2)
	}
	raw, err := os.ReadFile(*seedPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "read seed:", err)
		os.Exit(1)
	}
	// The seed is a bare array of {template, file} entries.
	var entries []struct {
		Template map[string]any `json:"template"`
		File     map[string]any `json:"file"`
	}
	if err := json.Unmarshal(raw, &entries); err != nil {
		fmt.Fprintln(os.Stderr, "parse seed:", err)
		os.Exit(1)
	}
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "mkdir:", err)
		os.Exit(1)
	}
	rendered, failed := 0, 0
	for _, e := range entries {
		id, _ := e.Template["id"].(string)
		pages, _ := e.File["pages"].([]any)
		for i := range pages {
			p, _ := pages[i].(map[string]any)
			w, _ := p["width"].(float64)
			h, _ := p["height"].(float64)
			long := max(w, h)
			scale := 1.0
			if long > 0 {
				scale = *edge / long
			}
			png, err := render.ToPNG(e.File, i, scale)
			if err != nil {
				fmt.Printf("FAIL %s page %d: %v\n", id, i, err)
				failed++
				continue
			}
			name := fmt.Sprintf("%s-p%d.png", id, i)
			if err := os.WriteFile(filepath.Join(*outDir, name), png, 0o644); err != nil {
				fmt.Fprintln(os.Stderr, "write:", err)
				os.Exit(1)
			}
			rendered++
		}
	}
	fmt.Printf("rendered %d pages (%d failed) -> %s\n", rendered, failed, *outDir)
	if failed > 0 {
		os.Exit(1)
	}
}
