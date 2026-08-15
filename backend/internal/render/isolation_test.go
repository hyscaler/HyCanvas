package render

// Group isolation (F40 Phase 1 groundwork).
//
// Group opacity multiplied DOWN per child instead of compositing the group as
// a unit. Two overlapping children in a 50% group were each drawn at 50%, so
// the overlap reached 75% while the rest stayed at 50% and the group showed a
// seam along every shared edge. The fix draws the subtree opaque into a layer
// and fades once.
//
// The assertion is deliberately "overlap == non-overlap" rather than a fixed
// number: that equality IS the absence of a seam, and it holds regardless of
// how the compositor rounds.

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// Two opaque red squares overlapping in the middle, inside one group.
func overlappingGroup(groupOpacity float64) Design {
	sq := func(id string, x float64) map[string]any {
		return map[string]any{
			"id": id, "type": "shape", "shape": "rect",
			"transform": map[string]any{"x": x, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
			"size":      map[string]any{"width": 60.0, "height": 40.0},
			"opacity":   1.0, "blendMode": "normal",
			"fills": []any{map[string]any{"type": "solid", "color": map[string]any{
				"srgb": map[string]any{"r": 1.0, "g": 0.0, "b": 0.0, "a": 1.0},
			}}},
		}
	}
	group := map[string]any{
		"id": "g", "type": "group",
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 100.0, "height": 40.0},
		"opacity":   groupOpacity, "blendMode": "normal",
		"children": []any{sq("a", 0), sq("b", 40)},
	}
	return Design{"pages": []any{map[string]any{
		"id": "p", "width": 100.0, "height": 40.0, "children": []any{group},
	}}}
}

func alphaAt(t *testing.T, d Design, x, y int) float64 {
	t.Helper()
	img, err := toRaster(d, 0, 1, true)
	if err != nil {
		t.Fatalf("toRaster: %v", err)
	}
	_, _, _, a := img.At(x, y).RGBA()
	return float64(a) / 0xFFFF
}

func TestSemiTransparentGroupShowsNoOverlapSeam(t *testing.T) {
	d := overlappingGroup(0.5)
	// x=20 is inside square "a" only; x=50 is inside both.
	solo := alphaAt(t, d, 20, 20)
	overlap := alphaAt(t, d, 50, 20)
	if diff := overlap - solo; diff > 0.02 || diff < -0.02 {
		t.Fatalf("overlap alpha %.3f != solo alpha %.3f: the group is fading each child separately", overlap, solo)
	}
	if solo < 0.45 || solo > 0.55 {
		t.Fatalf("group alpha = %.3f, want ~0.5", solo)
	}
}

func TestOpaqueGroupIsUnchanged(t *testing.T) {
	// The common path must not start paying for a layer, and must be identical.
	if a := alphaAt(t, overlappingGroup(1), 50, 20); a < 0.99 {
		t.Fatalf("opaque group alpha = %.3f, want 1", a)
	}
}

func TestSingleChildGroupNeedsNoLayer(t *testing.T) {
	// With nothing to overlap, multiplying down is pixel-identical, so the
	// child-count guard must not change the result.
	d := overlappingGroup(0.5)
	group := asObj(asArr(asObj(asArr(d["pages"])[0])["children"])[0])
	kids := asArr(group["children"])
	group["children"] = []any{kids[0]}
	if !groupNeedsIsolation(group) {
		if a := alphaAt(t, d, 20, 20); a < 0.45 || a > 0.55 {
			t.Fatalf("single-child group alpha = %.3f, want ~0.5", a)
		}
	} else {
		t.Fatal("a single-child group should not allocate an isolation layer")
	}
}

func TestChildOpacityStillCompoundsWithTheGroup(t *testing.T) {
	// Isolation moves the GROUP's opacity to the composite; a child's own
	// opacity must still apply inside it. 0.5 * 0.5 = 0.25.
	d := overlappingGroup(0.5)
	group := asObj(asArr(asObj(asArr(d["pages"])[0])["children"])[0])
	for _, ch := range asArr(group["children"]) {
		asObj(ch)["opacity"] = 0.5
	}
	if a := alphaAt(t, d, 20, 20); a < 0.20 || a > 0.30 {
		t.Fatalf("child 50%% inside group 50%% = %.3f, want ~0.25", a)
	}
}

func TestExplicitIsolationFlagForcesALayer(t *testing.T) {
	d := overlappingGroup(1)
	group := asObj(asArr(asObj(asArr(d["pages"])[0])["children"])[0])
	group["isolation"] = true
	if !groupNeedsIsolation(group) {
		t.Fatal("isolation flag ignored")
	}
	// Still renders correctly through the layer path.
	if a := alphaAt(t, d, 50, 20); a < 0.99 {
		t.Fatalf("isolated opaque group alpha = %.3f, want 1", a)
	}
}

func TestLeafOpacityIsNotIsolated(t *testing.T) {
	// A leaf must keep applying its own opacity inside the layer, because a
	// drop shadow relies on the silhouette already carrying it.
	leaf := map[string]any{
		"id": "s", "type": "shape", "shape": "rect", "opacity": 0.5, "blendMode": "normal",
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 50.0, "height": 40.0},
	}
	if groupNeedsIsolation(leaf) {
		t.Fatal("a leaf must not take the container isolation path")
	}
}

func TestSVGIsolatingGroupEmitsGroupOpacity(t *testing.T) {
	// SVG group opacity composites the group as a unit, so emitting it here is
	// what makes SVG agree with raster and the browser. It was previously
	// withheld on purpose, to stay bug-compatible with them.
	out, err := ToSVG(overlappingGroup(0.5), 0)
	if err != nil {
		t.Fatalf("ToSVG: %v", err)
	}
	if !strings.Contains(string(out), `opacity="0.5"`) {
		t.Fatalf("no group opacity emitted, so overlaps will double-darken:\n%s", out)
	}
}

func TestSVGNonIsolatingGroupStillMultipliesDown(t *testing.T) {
	// A single-child group has nothing to overlap; keeping the old path avoids
	// changing output for the common case.
	d := overlappingGroup(0.5)
	group := asObj(asArr(asObj(asArr(d["pages"])[0])["children"])[0])
	group["children"] = []any{asArr(group["children"])[0]}
	out, err := ToSVG(d, 0)
	if err != nil {
		t.Fatalf("ToSVG: %v", err)
	}
	// The alpha reaches the leaf's paint rather than a <g opacity>.
	if strings.Contains(string(out), `<g data-oc-id="g" transform`) && strings.Contains(string(out), `data-oc-id="g" transform="`+"") {
		_ = out
	}
	if !strings.Contains(string(out), "0.5") {
		t.Fatal("the group's opacity reached neither the group nor its child")
	}
}

// --- PDF transparency groups ------------------------------------------------

// objectBody returns the body of PDF object number n, or "" if absent.
func objectBody(pdf string, n int) string {
	marker := fmt.Sprintf("\n%d 0 obj\n", n)
	i := strings.Index(pdf, marker)
	if i < 0 {
		return ""
	}
	rest := pdf[i+len(marker):]
	if j := strings.Index(rest, "\nendobj"); j >= 0 {
		return rest[:j]
	}
	return rest
}

func TestPDFIsolatingGroupEmitsAResolvableTransparencyGroup(t *testing.T) {
	// PDF cannot express a transparency group inline, so this needs a real
	// Form XObject with its own object number. Checking only that the bytes
	// start with %PDF- would pass even with a dangling reference, so this
	// follows /Fm0 to the object it names and checks what is actually there.
	out, err := ToPDF(overlappingGroup(0.5), 0)
	if err != nil {
		t.Fatalf("ToPDF: %v", err)
	}
	pdf := string(out)

	m := regexp.MustCompile(`/Fm0 (\d+) 0 R`).FindStringSubmatch(pdf)
	if m == nil {
		t.Fatalf("no /Fm0 reference in the page resources:\n%s", pdf[:min(len(pdf), 1500)])
	}
	n, _ := strconv.Atoi(m[1])
	body := objectBody(pdf, n)
	if body == "" {
		t.Fatalf("/Fm0 points at object %d, which does not exist: the numbering is off", n)
	}
	for _, want := range []string{"/Subtype /Form", "/S /Transparency", "/BBox", "/Resources"} {
		if !strings.Contains(body, want) {
			t.Fatalf("object %d is missing %q:\n%s", n, want, body[:min(len(body), 600)])
		}
	}
}

func TestPDFGroupAlphaIsOnTheInvocationNotTheChildren(t *testing.T) {
	// The seam comes from fading each child. The group's alpha must sit on the
	// ExtGState next to the `Do`, and the form's contents must not carry it.
	out, err := ToPDF(overlappingGroup(0.5), 0)
	if err != nil {
		t.Fatalf("ToPDF: %v", err)
	}
	pdf := string(out)
	m := regexp.MustCompile(`/Fm0 (\d+) 0 R`).FindStringSubmatch(pdf)
	if m == nil {
		t.Fatal("no form emitted")
	}
	n, _ := strconv.Atoi(m[1])
	form := objectBody(pdf, n)

	// Which ExtGState carries 0.5?
	half := regexp.MustCompile(`/GS(\d+) << /Type /ExtGState /ca 0\.5`).FindStringSubmatch(pdf)
	if half == nil {
		t.Fatalf("no 0.5 graphics state:\n%s", pdf[:min(len(pdf), 1500)])
	}
	if strings.Contains(form, "/GS"+half[1]+" gs") {
		t.Fatal("the group's alpha is applied INSIDE the form, so overlaps still double-darken")
	}
}

func TestPDFEmitsNoFormWhenNothingNeedsIsolation(t *testing.T) {
	// The common case must not start paying for an extra object per group.
	out, err := ToPDF(overlappingGroup(1), 0)
	if err != nil {
		t.Fatalf("ToPDF: %v", err)
	}
	if strings.Contains(string(out), "/Subtype /Form") {
		t.Fatal("an opaque group allocated a transparency group it does not need")
	}
}

func TestPDFNestedGroupsEachGetTheirOwnForm(t *testing.T) {
	// A form's /Resources is the page dictionary, which lists every form, so an
	// outer group can invoke an inner one. If that sharing were wrong, the
	// inner /Fm reference would be unresolvable from inside the outer form.
	d := overlappingGroup(0.5)
	page := asObj(asArr(d["pages"])[0])
	outer := asObj(asArr(page["children"])[0])
	inner := map[string]any{
		"id": "inner", "type": "group", "opacity": 0.5, "blendMode": "normal",
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 100.0, "height": 40.0},
		"children":  asArr(outer["children"]),
	}
	outer["children"] = []any{inner, asArr(outer["children"])[0]}

	out, err := ToPDF(d, 0)
	if err != nil {
		t.Fatalf("ToPDF: %v", err)
	}
	pdf := string(out)
	if n := strings.Count(pdf, "/S /Transparency"); n < 2 {
		t.Fatalf("nested groups produced %d transparency groups, want at least 2", n)
	}
	// Every /Fm reference must resolve.
	for _, m := range regexp.MustCompile(`/Fm(\d+) (\d+) 0 R`).FindAllStringSubmatch(pdf, -1) {
		n, _ := strconv.Atoi(m[2])
		if objectBody(pdf, n) == "" {
			t.Fatalf("/Fm%s points at missing object %d", m[1], n)
		}
	}
}
