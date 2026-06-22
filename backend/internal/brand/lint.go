// Brand linter + pre-export gate (doc 18 FR-7/FR-8), porting @hc/brandkit
// lint.ts + gate.ts. A pure rule engine over the design file (map[string]any)
// and a resolved kit: off-brand color/font (when locked), low-contrast text,
// logo misuse, and margin spacing. The gate turns the violations into an
// export-blocking decision under lintPolicy "block". Reuses the color/kit
// extraction helpers in enforcement.go so the live lint and the persist gate
// agree. The editor runs the same rules client-side.
package brand

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"hycanvas/backend/internal/color"
)

const (
	aaNormal        = 4.5 // WCAG AA normal-text contrast
	aspectTolerance = 0.02
)

// LintViolation is one finding (matches the SDK BrandLintViolation).
type LintViolation struct {
	ID       string         `json:"id"`
	Kind     string         `json:"kind"`
	Severity string         `json:"severity"`
	NodeID   string         `json:"nodeId"`
	PageID   string         `json:"pageId"`
	Message  string         `json:"message"`
	Fix      map[string]any `json:"fix,omitempty"`
}

// GateResult is the pre-export decision (matches the SDK BrandLintResult).
type GateResult struct {
	Policy     string          `json:"policy"`
	Blocked    bool            `json:"blocked"`
	Violations []LintViolation `json:"violations"`
}

type lintKit struct {
	palette  []rgb
	families map[string]bool
	swapFont string
	logoIDs  map[string]bool
	logoMin  map[string]float64
	controls BrandControls
}

func numAt(m map[string]any, k string) float64 {
	switch n := m[k].(type) {
	case float64:
		return n
	case int:
		return float64(n)
	}
	return 0
}

func strAt(v any) string { s, _ := v.(string); return s }

// parseLintKit builds the lint inputs from a resolved kit row, reusing the
// palette/family extraction shared with the locked-save enforcement.
func parseLintKit(row *BrandKitRow) lintKit {
	bk := view(*row)
	k := lintKit{
		palette:  kitColors(bk),
		families: kitFontFamilies(bk),
		controls: bk.Controls,
		logoIDs:  map[string]bool{},
		logoMin:  map[string]float64{},
	}

	var fonts []map[string]any
	_ = json.Unmarshal(bk.Fonts, &fonts)
	for _, f := range fonts {
		fam := strAt(f["fontFamily"])
		if fam == "" {
			continue
		}
		if k.swapFont == "" || f["role"] == "body" {
			k.swapFont = fam
		}
	}

	var logos []map[string]any
	_ = json.Unmarshal(bk.Logos, &logos)
	for _, l := range logos {
		variants := asObjMap(l["variants"])
		for _, id := range []string{strAt(l["assetId"]), strAt(variants["dark"]), strAt(variants["light"])} {
			if id != "" {
				k.logoIDs[id] = true
			}
		}
		if id := strAt(l["assetId"]); id != "" {
			if m := numAt(l, "minSizePx"); m > 0 {
				k.logoMin[id] = m
			}
		}
	}
	return k
}

func nearestDistance(c rgb, palette []rgb) (float64, rgb) {
	best := math.Inf(1)
	var bc rgb
	for _, p := range palette {
		if d := color.DeltaE(c.r, c.g, c.b, p.r, p.g, p.b); d < best {
			best, bc = d, p
		}
	}
	return best, bc
}

// walkTyped visits each node (recursing children + mask child + boolean
// operands) for the contrast/logo/spacing passes that need node type/geometry.
func walkTyped(nodes []any, visit func(n map[string]any)) {
	for _, raw := range nodes {
		n := asObjMap(raw)
		if n == nil {
			continue
		}
		visit(n)
		walkTyped(asArrAny(n["children"]), visit)
		if n["type"] == "mask" {
			if ch := asObjMap(n["child"]); ch != nil {
				visit(ch)
			}
		}
		if n["type"] == "boolean" {
			walkTyped(asArrAny(n["operands"]), visit)
		}
	}
}

func pageBackground(page map[string]any) (rgb, bool) {
	bg := asObjMap(page["background"])
	if bg == nil {
		return rgb{}, false
	}
	var cs []rgb
	eachFillColor(bg, &cs)
	if len(cs) == 0 {
		return rgb{}, false
	}
	return cs[0], true
}

func lintFile(file map[string]any, kit lintKit) []LintViolation {
	out := []LintViolation{}
	if kit.controls.LintPolicy == "off" {
		return out
	}
	pages := asArrAny(file["pages"])

	// Off-brand colors.
	if kit.controls.LockColors && len(kit.palette) > 0 {
		seen := map[string]bool{}
		for _, pr := range pages {
			page := asObjMap(pr)
			pageID := strAt(page["id"])
			var colors []colorAt
			var fonts []fontAt
			if bg, ok := pageBackground(page); ok {
				colors = append(colors, colorAt{bg, pageID})
			}
			walkBrand(asArrAny(page["children"]), &colors, &fonts)
			for _, u := range colors {
				dist, near := nearestDistance(u.c, kit.palette)
				if dist <= colorTolerance {
					continue
				}
				hex := hexOf(u.c)
				key := "color:" + hex + "@" + u.nodeID
				if seen[key] {
					continue
				}
				seen[key] = true
				out = append(out, LintViolation{
					ID: key, Kind: "off-brand-color", Severity: "warn", NodeID: u.nodeID, PageID: pageID,
					Message: fmt.Sprintf("Color %s is not in the brand palette.", hex),
					Fix:     map[string]any{"kind": "snap_color", "from": hex, "to": hexOf(near)},
				})
			}
		}
	}

	// Off-brand fonts.
	if kit.controls.LockFonts && len(kit.families) > 0 {
		seen := map[string]bool{}
		for _, pr := range pages {
			page := asObjMap(pr)
			pageID := strAt(page["id"])
			var colors []colorAt
			var fonts []fontAt
			walkBrand(asArrAny(page["children"]), &colors, &fonts)
			for _, f := range fonts {
				if kit.families[strings.ToLower(strings.TrimSpace(f.family))] {
					continue
				}
				key := "font:" + f.family + "@" + f.nodeID
				if seen[key] {
					continue
				}
				seen[key] = true
				v := LintViolation{
					ID: key, Kind: "off-brand-font", Severity: "warn", NodeID: f.nodeID, PageID: pageID,
					Message: fmt.Sprintf("Font %q is not an approved brand font.", f.family),
				}
				if kit.swapFont != "" && !strings.EqualFold(strings.TrimSpace(kit.swapFont), strings.TrimSpace(f.family)) {
					v.Fix = map[string]any{"kind": "swap_font", "from": f.family, "to": kit.swapFont}
				}
				out = append(out, v)
			}
		}
	}

	// Low-contrast text (advisory whenever a kit is present).
	for _, pr := range pages {
		page := asObjMap(pr)
		pageID := strAt(page["id"])
		bg := rgb{1, 1, 1}
		if c, ok := pageBackground(page); ok {
			bg = c
		}
		walkTyped(asArrAny(page["children"]), func(n map[string]any) {
			if n["type"] != "text" {
				return
			}
			fg, ok := firstTextColor(n)
			if !ok {
				return
			}
			ratio := color.ContrastRatio(fg.r, fg.g, fg.b, bg.r, bg.g, bg.b)
			if ratio >= aaNormal {
				return
			}
			out = append(out, LintViolation{
				ID: "contrast:" + strAt(n["id"]), Kind: "low-contrast", Severity: "warn",
				NodeID: strAt(n["id"]), PageID: pageID,
				Message: fmt.Sprintf("Text contrast %.1f:1 is below WCAG AA (4.5:1).", ratio),
			})
		})
	}

	// Logo misuse.
	if len(kit.logoIDs) > 0 {
		for _, pr := range pages {
			page := asObjMap(pr)
			pageID := strAt(page["id"])
			walkTyped(asArrAny(page["children"]), func(n map[string]any) {
				if n["type"] != "image" {
					return
				}
				assetID := strAt(asObjMap(n["source"])["assetId"])
				if assetID == "" || !kit.logoIDs[assetID] {
					return
				}
				nodeID := strAt(n["id"])
				t := asObjMap(n["transform"])
				sx, sy := math.Abs(scaleOr1(t, "scaleX")), math.Abs(scaleOr1(t, "scaleY"))
				if sx > 0 && sy > 0 && math.Abs(sx-sy)/math.Max(sx, sy) > aspectTolerance {
					out = append(out, LintViolation{
						ID: "logo-aspect:" + nodeID, Kind: "logo-misuse", Severity: "error", NodeID: nodeID, PageID: pageID,
						Message: "Logo is distorted (non-uniform scale). Scale it uniformly.",
						Fix:     map[string]any{"kind": "restore_logo", "reason": "aspect"},
					})
				}
				for _, f := range asArrAny(n["fills"]) {
					if asObjMap(f)["type"] == "solid" {
						out = append(out, LintViolation{
							ID: "logo-recolor:" + nodeID, Kind: "logo-misuse", Severity: "error", NodeID: nodeID, PageID: pageID,
							Message: "Logo appears recolored. Use an approved logo variant instead.",
						})
						break
					}
				}
				if min := kit.logoMin[assetID]; min > 0 {
					if w := numAt(asObjMap(n["size"]), "width") * sx; w > 0 && w < min {
						out = append(out, LintViolation{
							ID: "logo-size:" + nodeID, Kind: "logo-misuse", Severity: "warn", NodeID: nodeID, PageID: pageID,
							Message: fmt.Sprintf("Logo is below its minimum size (%.0fpx).", min),
							Fix:     map[string]any{"kind": "restore_logo", "reason": "min_size"},
						})
					}
				}
			})
		}
	}

	// Spacing (opt-in via meta.brandMargin).
	if margin := numAt(asObjMap(file["meta"]), "brandMargin"); margin > 0 {
		for _, pr := range pages {
			page := asObjMap(pr)
			pageID := strAt(page["id"])
			pw, ph := numAt(page, "width"), numAt(page, "height")
			walkTyped(asArrAny(page["children"]), func(n map[string]any) {
				t, sz := asObjMap(n["transform"]), asObjMap(n["size"])
				if t == nil || sz == nil {
					return
				}
				x, y, nw, nh := numAt(t, "x"), numAt(t, "y"), numAt(sz, "width"), numAt(sz, "height")
				if x < margin || y < margin || x+nw > pw-margin || y+nh > ph-margin {
					out = append(out, LintViolation{
						ID: "spacing:" + strAt(n["id"]), Kind: "spacing", Severity: "info",
						NodeID: strAt(n["id"]), PageID: pageID,
						Message: fmt.Sprintf("Element extends into the %.0fpx brand margin.", margin),
					})
				}
			})
		}
	}

	return out
}

// firstTextColor returns a text node's dominant run color (style.color, then a
// solid run fill).
func firstTextColor(n map[string]any) (rgb, bool) {
	for _, para := range asArrAny(n["content"]) {
		for _, run := range asArrAny(asObjMap(para)["runs"]) {
			style := asObjMap(asObjMap(run)["style"])
			if c, ok := srgbOf(asObjMap(style["color"])); ok {
				return c, true
			}
			if sf := asObjMap(style["fill"]); sf != nil {
				var cs []rgb
				eachFillColor(sf, &cs)
				if len(cs) > 0 {
					return cs[0], true
				}
			}
		}
	}
	return rgb{}, false
}

func scaleOr1(m map[string]any, k string) float64 {
	if m == nil {
		return 1
	}
	if v, ok := m[k].(float64); ok {
		return v
	}
	return 1
}

// LintDesign returns the brand violations for a design (FR-7). Membership-gated.
// With no resolved kit it returns no violations.
func (s *Service) LintDesign(ctx context.Context, designID, userID string) ([]LintViolation, error) {
	ws, err := s.store.GetWorkspaceID(ctx, designID)
	if err != nil {
		return nil, err
	}
	if err := s.assertMember(ctx, userID, ws); err != nil {
		return nil, err
	}
	row, err := s.resolveKitRow(ctx, designID, ws)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return []LintViolation{}, nil
	}
	file, err := s.store.FileFor(ctx, designID, ws)
	if err != nil {
		return nil, err
	}
	return lintFile(file, parseLintKit(row)), nil
}

// LintGate is the pre-export/publish brand gate (FR-8). With no kit or policy
// "off" it never blocks; under "block" any non-info violation blocks.
func (s *Service) LintGate(ctx context.Context, designID, userID string) (GateResult, error) {
	ws, err := s.store.GetWorkspaceID(ctx, designID)
	if err != nil {
		return GateResult{}, err
	}
	if err := s.assertMember(ctx, userID, ws); err != nil {
		return GateResult{}, err
	}
	row, err := s.resolveKitRow(ctx, designID, ws)
	if err != nil {
		return GateResult{}, err
	}
	if row == nil {
		return GateResult{Policy: "off", Blocked: false, Violations: []LintViolation{}}, nil
	}
	file, err := s.store.FileFor(ctx, designID, ws)
	if err != nil {
		return GateResult{}, err
	}
	kit := parseLintKit(row)
	violations := lintFile(file, kit)
	policy := kit.controls.LintPolicy
	blocked := false
	if policy == "block" {
		for _, v := range violations {
			if v.Severity != "info" {
				blocked = true
				break
			}
		}
	}
	return GateResult{Policy: policy, Blocked: blocked, Violations: violations}, nil
}
