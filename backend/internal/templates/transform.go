// Deep-copy + style extraction (pure ports of @hc/templates deepcopy.ts +
// style.ts), operating on the opaque DesignFile JSON.
package templates

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"

	"github.com/google/uuid"
)

// DeepCopyForNew clones a design with fresh ids for use as a new, decoupled
// design (the exported entry point for bulk-create's per-row copies). The source
// is never mutated.
func DeepCopyForNew(file map[string]any) map[string]any {
	clone, _ := deepCopyDesign(file)
	return clone
}

// deepCopyDesign clones a design with fresh ids (design, pages, all nodes),
// rewriting internal references (mask child, boolean operands, connector
// endpoints). The source is never mutated. Returns the copy + old->new id map.
func deepCopyDesign(file map[string]any) (map[string]any, map[string]string) {
	clone := deepCloneJSON(file)
	idMap := map[string]string{}
	gen := func() string { return "n-" + uuid.NewString() }

	clone["id"] = gen()
	for _, p := range asArr(clone["pages"]) {
		page := asObj(p)
		if page == nil {
			continue
		}
		newPID := gen()
		if old := asStr(page["id"]); old != "" {
			idMap[old] = newPID
		}
		page["id"] = newPID
		for _, root := range asArr(page["children"]) {
			visitTree(asObj(root), func(n map[string]any) {
				fresh := gen()
				if old := asStr(n["id"]); old != "" {
					idMap[old] = fresh
				}
				n["id"] = fresh
			})
		}
	}
	// Rewrite connector endpoint attachments pointing within the copied design.
	for _, p := range asArr(clone["pages"]) {
		for _, root := range asArr(asObj(p)["children"]) {
			visitTree(asObj(root), func(n map[string]any) {
				if asStr(n["type"]) != "connector" {
					return
				}
				for _, key := range []string{"start", "end"} {
					ep := asObj(n[key])
					attach := asObj(ep["attach"])
					if attach == nil {
						continue
					}
					if old := asStr(attach["nodeId"]); old != "" {
						if nw, ok := idMap[old]; ok {
							attach["nodeId"] = nw
						}
					}
				}
			})
		}
	}
	return clone, idMap
}

func visitTree(node map[string]any, fn func(map[string]any)) {
	if node == nil {
		return
	}
	fn(node)
	for _, c := range asArr(node["children"]) {
		visitTree(asObj(c), fn)
	}
	if asStr(node["type"]) == "mask" {
		if child := asObj(node["child"]); child != nil {
			visitTree(child, fn)
		}
	}
	if asStr(node["type"]) == "boolean" {
		for _, op := range asArr(node["operands"]) {
			visitTree(asObj(op), fn)
		}
	}
}

func deepCloneJSON(v map[string]any) map[string]any {
	raw, _ := json.Marshal(v)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return out
}

// --- extractStyle (pragmatic port of @hc/templates style.ts) -------------

const maxPalette = 6

var roleNames = []string{"heading", "subheading", "body", "accent"}

func hexOfColor(c map[string]any) string {
	srgb := asObj(c["srgb"])
	ch := func(v float64) int { return int(math.Round(math.Max(0, math.Min(1, v)) * 255)) }
	return fmt.Sprintf("#%02x%02x%02x", ch(asNum(srgb["r"])), ch(asNum(srgb["g"])), ch(asNum(srgb["b"])))
}

func colorsInFills(fills []any, out *[]string) {
	for _, f := range fills {
		fo := asObj(f)
		switch asStr(fo["type"]) {
		case "solid":
			if c := asObj(fo["color"]); c != nil {
				*out = append(*out, hexOfColor(c))
			}
		default:
			for _, s := range asArr(fo["stops"]) {
				if c := asObj(asObj(s)["color"]); c != nil {
					*out = append(*out, hexOfColor(c))
				}
			}
		}
	}
}

type runStyle struct {
	size   float64
	family string
	weight float64
}

// extractStyle walks the scene graph collecting a palette (most-frequent fill
// hexes), typography (distinct run styles by size into roles), and effect kinds.
func extractStyle(file map[string]any) StyleDescriptor {
	colorFreq := map[string]int{}
	effects := map[string]bool{}
	var runs []runStyle

	var walk func(nodes []any)
	walk = func(nodes []any) {
		for _, n := range nodes {
			node := asObj(n)
			if node == nil {
				continue
			}
			var cols []string
			colorsInFills(asArr(node["fills"]), &cols)
			if stroke := asObj(node["stroke"]); stroke != nil {
				if sf := asObj(stroke["fill"]); sf != nil {
					colorsInFills([]any{sf}, &cols)
				}
			}
			for _, hex := range cols {
				colorFreq[hex]++
			}
			for _, e := range asArr(node["effects"]) {
				if k := asStr(asObj(e)["kind"]); k != "" {
					effects[k] = true
				}
			}
			for _, para := range asArr(node["content"]) {
				for _, run := range asArr(asObj(para)["runs"]) {
					st := asObj(asObj(run)["style"])
					if st == nil {
						continue
					}
					size := asNum(st["fontSize"])
					if size == 0 {
						size = 16
					}
					fam := asStr(st["fontFamily"])
					if fam == "" {
						fam = "sans-serif"
					}
					runs = append(runs, runStyle{size: size, family: fam, weight: asNum(st["fontWeight"])})
				}
			}
			walk(asArr(node["children"]))
		}
	}
	for _, p := range asArr(file["pages"]) {
		walk(asArr(asObj(p)["children"]))
	}

	// Palette: most-frequent hexes first.
	type hc struct {
		hex   string
		count int
	}
	var freq []hc
	for h, c := range colorFreq {
		freq = append(freq, hc{h, c})
	}
	sort.SliceStable(freq, func(i, j int) bool { return freq[i].count > freq[j].count })
	palette := []string{}
	for i, f := range freq {
		if i >= maxPalette {
			break
		}
		palette = append(palette, f.hex)
	}

	// Typography: distinct run styles by descending size into roles.
	distinct := map[string]runStyle{}
	for _, r := range runs {
		key := fmt.Sprintf("%g-%s-%g", r.size, r.family, r.weight)
		distinct[key] = r
	}
	var ranked []runStyle
	for _, r := range distinct {
		ranked = append(ranked, r)
	}
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].size > ranked[j].size })
	typography := []map[string]any{}
	for i, r := range ranked {
		if i >= 4 {
			break
		}
		typography = append(typography, map[string]any{"role": roleNames[i], "family": r.family, "weight": r.weight})
	}

	effectList := []string{}
	for k := range effects {
		effectList = append(effectList, k)
	}
	sort.Strings(effectList)
	return StyleDescriptor{Palette: palette, Typography: typography, Effects: effectList}
}
