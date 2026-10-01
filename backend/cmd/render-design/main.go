// Command render-design rasterizes one design file (the JSON the composer
// or the API writes) to PNGs, one per page, for visual review of generated
// decks. A dev tool for auditing the AI composer's output; not part of the
// product. Text draws in the renderer's fallback face unless a directory of
// Family-Weight.ttf files is given.
//
//	go run ./cmd/render-design -in deck.json -out /tmp/deck [-edge 960] [-fonts dir]
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"hycanvas/backend/internal/render"
)

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
	in := flag.String("in", "", "design file JSON (required)")
	out := flag.String("out", "", "output directory for PNGs (required)")
	edge := flag.Float64("edge", 960, "target length of the longest page edge in pixels")
	fontDir := flag.String("fonts", "", "dir of Family-Weight.ttf files for glyph-true text (optional)")
	prefix := flag.String("prefix", "p", "file name prefix")
	flag.Parse()
	if *in == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "usage: render-design -in deck.json -out dir [-edge 960] [-fonts dir]")
		os.Exit(2)
	}
	if *fontDir != "" {
		n, err := registerFontDir(*fontDir)
		if err != nil {
			fmt.Fprintln(os.Stderr, "fonts:", err)
			os.Exit(1)
		}
		fmt.Println("registered", n, "font faces")
	}
	raw, err := os.ReadFile(*in)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var file map[string]any
	if err := json.Unmarshal(raw, &file); err != nil {
		fmt.Fprintln(os.Stderr, "parse:", err)
		os.Exit(1)
	}
	if err := os.MkdirAll(*out, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	pages, _ := file["pages"].([]any)
	for i := range pages {
		p, _ := pages[i].(map[string]any)
		w, _ := p["width"].(float64)
		h, _ := p["height"].(float64)
		scale := math.Min(1, *edge/math.Max(w, h))
		png, err := render.ToPNG(render.Design(file), i, scale)
		if err != nil {
			fmt.Println("ERR page", i+1, err)
			continue
		}
		name := fmt.Sprintf("%s%02d.png", *prefix, i+1)
		if err := os.WriteFile(filepath.Join(*out, name), png, 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	fmt.Println("rendered", len(pages), "pages to", *out)
}
