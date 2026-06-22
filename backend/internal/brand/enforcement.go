// Brand-lock enforcement over a DesignFile (doc 18 FR-4, AC-3, server side):
// walk the scene graph, collect every color + font family in use, and reject a
// save that introduces out-of-kit values while the matching lock is on and the
// saver lacks manage-brand. Color matching tolerates rounding drift via a
// perceptual deltaE threshold; fonts match case-insensitively by family. Ported
// from the NestJS brand-enforcement.ts. The DesignFile is opaque JSON here.
package brand

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"

	"hycanvas/backend/internal/color"
)

// ErrBrandLocked is returned when a save violates an active brand lock.
var ErrBrandLocked = errors.New("brand locked")

// colorTolerance: max deltaE for a color to count as matching a brand swatch
// (~2 is below the just-noticeable-difference threshold).
const colorTolerance = 2.0

// Violation is a single out-of-kit value found on save.
type Violation struct {
	Kind   string // "color" | "font"
	Value  string // hex for a color, family for a font
	NodeID string
}

type rgb struct{ r, g, b float64 }

func srgbOf(colorObj map[string]any) (rgb, bool) {
	srgb, ok := colorObj["srgb"].(map[string]any)
	if !ok {
		return rgb{}, false
	}
	r, _ := srgb["r"].(float64)
	g, _ := srgb["g"].(float64)
	b, _ := srgb["b"].(float64)
	return rgb{r, g, b}, true
}

func hexOf(c rgb) string {
	ch := func(v float64) int {
		return int(math.Round(math.Max(0, math.Min(1, v)) * 255))
	}
	return fmt.Sprintf("#%02x%02x%02x", ch(c.r), ch(c.g), ch(c.b))
}

// eachFillColor extracts the colors a fill paints (solid color or gradient stops).
func eachFillColor(fill map[string]any, out *[]rgb) {
	switch fill["type"] {
	case "solid":
		if c, ok := srgbOf(asObjMap(fill["color"])); ok {
			*out = append(*out, c)
		}
	default:
		if stops, ok := fill["stops"].([]any); ok {
			for _, s := range stops {
				if c, ok := srgbOf(asObjMap(asObjMap(s)["color"])); ok {
					*out = append(*out, c)
				}
			}
		}
	}
}

func asObjMap(v any) map[string]any { m, _ := v.(map[string]any); return m }
func asArrAny(v any) []any          { a, _ := v.([]any); return a }

type colorAt struct {
	c      rgb
	nodeID string
}
type fontAt struct {
	family string
	nodeID string
}

func collectNodeColors(node map[string]any, out *[]colorAt) {
	id, _ := node["id"].(string)
	for _, f := range asArrAny(node["fills"]) {
		var cs []rgb
		eachFillColor(asObjMap(f), &cs)
		for _, c := range cs {
			*out = append(*out, colorAt{c, id})
		}
	}
	if stroke := asObjMap(node["stroke"]); stroke != nil {
		if sf := asObjMap(stroke["fill"]); sf != nil {
			var cs []rgb
			eachFillColor(sf, &cs)
			for _, c := range cs {
				*out = append(*out, colorAt{c, id})
			}
		}
		if c, ok := srgbOf(asObjMap(stroke["color"])); ok {
			*out = append(*out, colorAt{c, id})
		}
	}
	for _, para := range asArrAny(node["content"]) {
		for _, run := range asArrAny(asObjMap(para)["runs"]) {
			style := asObjMap(asObjMap(run)["style"])
			if sf := asObjMap(style["fill"]); sf != nil {
				var cs []rgb
				eachFillColor(sf, &cs)
				for _, c := range cs {
					*out = append(*out, colorAt{c, id})
				}
			}
			if c, ok := srgbOf(asObjMap(style["color"])); ok {
				*out = append(*out, colorAt{c, id})
			}
		}
	}
}

func collectNodeFonts(node map[string]any, out *[]fontAt) {
	if node["type"] != "text" {
		return
	}
	id, _ := node["id"].(string)
	for _, para := range asArrAny(node["content"]) {
		for _, run := range asArrAny(asObjMap(para)["runs"]) {
			style := asObjMap(asObjMap(run)["style"])
			if fam, ok := style["fontFamily"].(string); ok && fam != "" {
				*out = append(*out, fontAt{fam, id})
			}
		}
	}
}

func walkBrand(nodes []any, colors *[]colorAt, fonts *[]fontAt) {
	for _, n := range nodes {
		node := asObjMap(n)
		if node == nil {
			continue
		}
		collectNodeColors(node, colors)
		collectNodeFonts(node, fonts)
		walkBrand(asArrAny(node["children"]), colors, fonts)
	}
}

// kit palette/font extraction from the BrandKit view's raw JSON.
func kitColors(kit BrandKit) []rgb {
	var palettes []struct {
		Colors []struct {
			Value map[string]any `json:"value"`
		} `json:"colors"`
	}
	_ = json.Unmarshal(kit.Palettes, &palettes)
	var out []rgb
	for _, p := range palettes {
		for _, sw := range p.Colors {
			if c, ok := srgbOf(sw.Value); ok {
				out = append(out, c)
			}
		}
	}
	return out
}

func kitFontFamilies(kit BrandKit) map[string]bool {
	var fonts []struct {
		FontFamily string `json:"fontFamily"`
	}
	_ = json.Unmarshal(kit.Fonts, &fonts)
	out := map[string]bool{}
	for _, f := range fonts {
		out[strings.ToLower(strings.TrimSpace(f.FontFamily))] = true
	}
	return out
}

// findBrandViolations returns every out-of-kit color/font a design introduces,
// honoring which locks are on. Empty when nothing is locked or fully on-brand.
func findBrandViolations(file map[string]any, kit BrandKit) []Violation {
	checkColors := kit.Controls.LockColors
	checkFonts := kit.Controls.LockFonts
	if !checkColors && !checkFonts {
		return nil
	}
	var colors []colorAt
	var fonts []fontAt
	for _, p := range asArrAny(file["pages"]) {
		page := asObjMap(p)
		if checkColors {
			if bg := asObjMap(page["background"]); bg != nil {
				var cs []rgb
				eachFillColor(bg, &cs)
				pid, _ := page["id"].(string)
				for _, c := range cs {
					colors = append(colors, colorAt{c, pid})
				}
			}
		}
		walkBrand(asArrAny(page["children"]), &colors, &fonts)
	}

	var violations []Violation
	if checkColors {
		palette := kitColors(kit)
		if len(palette) > 0 {
			seen := map[string]bool{}
			for _, ca := range colors {
				inKit := false
				for _, p := range palette {
					if color.DeltaE(ca.c.r, ca.c.g, ca.c.b, p.r, p.g, p.b) <= colorTolerance {
						inKit = true
						break
					}
				}
				if inKit {
					continue
				}
				hex := hexOf(ca.c)
				key := hex + "@" + ca.nodeID
				if seen[key] {
					continue
				}
				seen[key] = true
				violations = append(violations, Violation{Kind: "color", Value: hex, NodeID: ca.nodeID})
			}
		}
	}
	if checkFonts {
		families := kitFontFamilies(kit)
		if len(families) > 0 {
			seen := map[string]bool{}
			for _, fa := range fonts {
				if families[strings.ToLower(strings.TrimSpace(fa.family))] {
					continue
				}
				key := fa.family + "@" + fa.nodeID
				if seen[key] {
					continue
				}
				seen[key] = true
				violations = append(violations, Violation{Kind: "font", Value: fa.family, NodeID: fa.nodeID})
			}
		}
	}
	return violations
}

// ValidateSnapshot rejects a save that introduces out-of-kit values while a
// brand lock is on and the saver lacks manage-brand (FR-4, AC-3). A manage-brand
// caller is never constrained. No-op when there is no active kit or nothing is
// locked. Returns ErrBrandLocked (with a summary) on a violation.
func (s *Service) ValidateSnapshot(ctx context.Context, designID, workspaceID, userID string, file map[string]any) error {
	if s.access == nil || s.store == nil {
		return nil // design-scope not wired; nothing to enforce
	}
	if s.canManageBrandForDesign(ctx, designID, userID) {
		return nil
	}
	row, err := s.resolveKitRow(ctx, designID, workspaceID)
	if err != nil || row == nil {
		return nil
	}
	kit := view(*row)
	if !kit.Controls.LockColors && !kit.Controls.LockFonts {
		return nil
	}
	violations := findBrandViolations(file, kit)
	if len(violations) == 0 {
		return nil
	}
	parts := make([]string, 0, 5)
	for i, v := range violations {
		if i >= 5 {
			break
		}
		parts = append(parts, v.Kind+" "+v.Value)
	}
	summary := strings.Join(parts, ", ")
	if len(violations) > 5 {
		summary += fmt.Sprintf(" (+%d more)", len(violations)-5)
	}
	return fmt.Errorf("%w: design uses values outside the locked brand kit %q: %s", ErrBrandLocked, kit.Name, summary)
}
