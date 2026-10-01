// Command render-frames rasterizes one page of a design file as a PNG frame
// sequence with its entrance motion posed at each frame, the way the video
// preview and the timeline exporter pose an animated element. A dev tool for
// turning a composed deck into video footage (frames go to ffmpeg); not part
// of the product.
//
//	go run ./cmd/render-frames -in deck.json -page 0 -fps 30 -seconds 5 -out /tmp/frames [-fonts dir] [-hold 0]
//
// Frames are written as <prefix>%05d.png at the page's own size (or scaled
// by -scale). -hold adds seconds of settled frames after the motion, so a
// slide rests before the cut.
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

// revealText cuts a text node's runs to the part a typewriter (by rune) or
// word-wipe (by word) entrance has revealed at tMs; the raster poses
// position and opacity but leaves content reveal to its caller.
func revealText(node map[string]any, tMs float64) {
	anim, _ := node["animation"].(map[string]any)
	ent, _ := anim["entrance"].(map[string]any)
	if ent == nil {
		return
	}
	preset, _ := ent["preset"].(string)
	if preset != "typewriter" && preset != "word-wipe" {
		return
	}
	delay, _ := ent["delayMs"].(float64)
	dur, _ := ent["durationMs"].(float64)
	if dur <= 0 {
		return
	}
	frac := (tMs - delay) / dur
	if frac >= 1 {
		return
	}
	if frac < 0 {
		frac = 0
	}
	content, _ := node["content"].([]any)
	var units []string
	for _, para := range content {
		pm, _ := para.(map[string]any)
		for _, run := range asAny(pm["runs"]) {
			rm, _ := run.(map[string]any)
			text, _ := rm["text"].(string)
			if preset == "word-wipe" {
				units = append(units, strings.Fields(text)...)
			} else {
				for _, r := range text {
					units = append(units, string(r))
				}
			}
		}
	}
	budget := int(float64(len(units)) * frac)
	for _, para := range content {
		pm, _ := para.(map[string]any)
		for _, run := range asAny(pm["runs"]) {
			rm, _ := run.(map[string]any)
			text, _ := rm["text"].(string)
			var kept string
			if preset == "word-wipe" {
				words := strings.Fields(text)
				n := len(words)
				if n > budget {
					n = budget
				}
				kept = strings.Join(words[:n], " ")
				budget -= n
			} else {
				runes := []rune(text)
				n := len(runes)
				if n > budget {
					n = budget
				}
				kept = string(runes[:n])
				budget -= n
			}
			rm["text"] = kept
		}
	}
}

func asAny(v any) []any {
	a, _ := v.([]any)
	return a
}

func main() {
	in := flag.String("in", "", "design file JSON (required)")
	page := flag.Int("page", 0, "zero-based page index")
	fps := flag.Float64("fps", 30, "frames per second")
	seconds := flag.Float64("seconds", 4, "seconds of footage (motion included)")
	hold := flag.Float64("hold", 0, "extra seconds of settled frames after the motion")
	out := flag.String("out", "", "output directory (required)")
	prefix := flag.String("prefix", "f_", "frame file prefix")
	scale := flag.Float64("scale", 1, "raster scale")
	fontDir := flag.String("fonts", "", "dir of Family-Weight.ttf files (optional)")
	start := flag.Int("start", 0, "first frame number to write")
	flag.Parse()
	if *in == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "usage: render-frames -in deck.json -page 0 -fps 30 -seconds 5 -out dir")
		os.Exit(2)
	}
	if *fontDir != "" {
		if _, err := registerFontDir(*fontDir); err != nil {
			fmt.Fprintln(os.Stderr, "fonts:", err)
			os.Exit(1)
		}
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
	if *page < 0 || *page >= len(pages) {
		fmt.Fprintln(os.Stderr, "page out of range")
		os.Exit(1)
	}
	src, _ := pages[*page].(map[string]any)
	children, _ := src["children"].([]any)
	total := int((*seconds + *hold) * *fps)
	clipMs := (*seconds + *hold) * 1000
	written := 0
	for f := 0; f < total; f++ {
		tMs := float64(f) / *fps * 1000
		posed := make([]any, 0, len(children))
		for _, ch := range children {
			node, _ := ch.(map[string]any)
			if node == nil {
				continue
			}
			if render.NodeIsAnimated(node) {
				// Exit motion is the timeline's business; pose the entrance only.
				p := render.PoseElementNode(node, tMs, 0)
				revealText(p, tMs)
				posed = append(posed, p)
			} else {
				posed = append(posed, node)
			}
			_ = clipMs
		}
		pageCopy := map[string]any{}
		for k, v := range src {
			pageCopy[k] = v
		}
		pageCopy["children"] = posed
		fileCopy := map[string]any{}
		for k, v := range file {
			fileCopy[k] = v
		}
		fileCopy["pages"] = []any{pageCopy}
		png, err := render.ToPNG(render.Design(fileCopy), 0, *scale)
		if err != nil {
			fmt.Fprintln(os.Stderr, "frame", f, err)
			os.Exit(1)
		}
		name := fmt.Sprintf("%s%05d.png", *prefix, *start+f)
		if err := os.WriteFile(filepath.Join(*out, name), png, 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		written++
	}
	fmt.Printf("wrote %d frames to %s\n", written, *out)
}
