package persistence

import (
	"errors"
	"strconv"
	"strings"
	"testing"
)

// node is a tiny helper for building valid-shaped nodes in tests.
func node(id, typ string, children ...any) map[string]any {
	n := map[string]any{"id": id, "type": typ}
	if children != nil {
		n["children"] = children
	}
	return n
}

func validDesign() DesignFile {
	return DesignFile{
		"schemaVersion": float64(currentSchemaVersion),
		"id":            "d1",
		"title":         "T",
		"pages": []any{
			map[string]any{"id": "p1", "children": []any{
				node("n1", "shape"),
				node("g1", "group", node("n2", "text"), node("n3", "image")),
			}},
			map[string]any{"id": "p2", "children": []any{}},
		},
	}
}

func TestValidateForWrite_Accepts(t *testing.T) {
	if err := validateForWrite(validDesign()); err != nil {
		t.Fatalf("a valid design should pass: %v", err)
	}
	// The factory's blank design must always pass (schemaVersion is a native int).
	if err := validateForWrite(createBlankDesign("d2", "Blank")); err != nil {
		t.Fatalf("createBlankDesign should pass: %v", err)
	}
}

func TestValidateForWrite_Rejects(t *testing.T) {
	mut := func(fn func(d DesignFile)) DesignFile {
		d := validDesign()
		fn(d)
		return d
	}
	cases := []struct {
		name string
		file DesignFile
		want string // substring expected in the error
	}{
		{"nil", nil, "nil"},
		{"missing id", mut(func(d DesignFile) { delete(d, "id") }), "missing string id"},
		{"empty id", mut(func(d DesignFile) { d["id"] = "" }), "missing string id"},
		{"pages not array", mut(func(d DesignFile) { d["pages"] = "nope" }), "non-empty array"},
		{"pages empty", mut(func(d DesignFile) { d["pages"] = []any{} }), "non-empty array"},
		{"page not object", mut(func(d DesignFile) { d["pages"] = []any{"x"} }), "not an object"},
		{"page missing id", mut(func(d DesignFile) { d["pages"] = []any{map[string]any{}} }), "missing string id"},
		{"dup page id", mut(func(d DesignFile) {
			d["pages"] = []any{map[string]any{"id": "p"}, map[string]any{"id": "p"}}
		}), "duplicate page id"},
		{"node not object", mut(func(d DesignFile) {
			d["pages"] = []any{map[string]any{"id": "p", "children": []any{"x"}}}
		}), "node is not an object"},
		{"node missing id", mut(func(d DesignFile) {
			d["pages"] = []any{map[string]any{"id": "p", "children": []any{map[string]any{"type": "shape"}}}}
		}), "node missing string id"},
		{"node missing type", mut(func(d DesignFile) {
			d["pages"] = []any{map[string]any{"id": "p", "children": []any{map[string]any{"id": "n"}}}}
		}), "missing string type"},
		{"dup node id", mut(func(d DesignFile) {
			d["pages"] = []any{map[string]any{"id": "p", "children": []any{node("n", "shape"), node("n", "text")}}}
		}), "duplicate node id"},
		{"dup node id across pages", mut(func(d DesignFile) {
			d["pages"] = []any{
				map[string]any{"id": "p1", "children": []any{node("dup", "shape")}},
				map[string]any{"id": "p2", "children": []any{node("dup", "text")}},
			}
		}), "duplicate node id"},
		{"children not array", mut(func(d DesignFile) {
			d["pages"] = []any{map[string]any{"id": "p", "children": []any{map[string]any{"id": "n", "type": "group", "children": "x"}}}}
		}), "children is not an array"},
		{"schemaVersion future", mut(func(d DesignFile) { d["schemaVersion"] = float64(currentSchemaVersion + 1) }), "out of range"},
		{"schemaVersion zero", mut(func(d DesignFile) { d["schemaVersion"] = float64(0) }), "out of range"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateForWrite(tc.file)
			if err == nil {
				t.Fatalf("expected rejection")
			}
			if !errors.Is(err, ErrInvalidFile) {
				t.Fatalf("expected ErrInvalidFile, got %v", err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q should contain %q", err.Error(), tc.want)
			}
		})
	}
}

func TestValidateForWrite_DepthBound(t *testing.T) {
	// Build a chain of nested groups deeper than maxNodeDepth (unique ids so the
	// depth bound is what trips, not the duplicate-id check).
	var deepest any = node("leaf", "shape")
	for i := 0; i < maxNodeDepth+2; i++ {
		deepest = node("g"+strconv.Itoa(i), "group", deepest)
	}
	d := DesignFile{
		"id":    "d",
		"pages": []any{map[string]any{"id": "p", "children": []any{deepest}}},
	}
	err := validateForWrite(d)
	if err == nil || !errors.Is(err, ErrInvalidFile) || !strings.Contains(err.Error(), "deeper than") {
		t.Fatalf("expected a depth-bound rejection, got %v", err)
	}
}

func TestValidateForWrite_MaskAndBooleanNesting(t *testing.T) {
	page := func(children ...any) DesignFile {
		return DesignFile{"id": "d", "pages": []any{map[string]any{"id": "p", "children": children}}}
	}
	mask := func(id string, child map[string]any) map[string]any {
		return map[string]any{"id": id, "type": "mask", "child": child}
	}
	boolean := func(id string, operands ...any) map[string]any {
		return map[string]any{"id": id, "type": "boolean", "operands": operands}
	}

	// Well-formed mask + boolean nesting passes.
	if err := validateForWrite(page(
		mask("m1", node("c1", "image")),
		boolean("b1", node("o1", "shape"), node("o2", "shape")),
	)); err != nil {
		t.Fatalf("valid mask/boolean nesting should pass: %v", err)
	}

	cases := []struct {
		name string
		file DesignFile
		want string
	}{
		{"mask child dup id", page(node("dup", "shape"), mask("m", node("dup", "image"))), "duplicate node id"},
		{"mask child missing type", page(mask("m", map[string]any{"id": "c"})), "missing string type"},
		{"mask child not object", page(map[string]any{"id": "m", "type": "mask", "child": "x"}), "child is not an object"},
		{"boolean operand dup id", page(node("dup", "shape"), boolean("b", node("dup", "shape"))), "duplicate node id"},
		{"boolean operand missing type", page(boolean("b", map[string]any{"id": "o"})), "missing string type"},
		{"boolean operands not array", page(map[string]any{"id": "b", "type": "boolean", "operands": "x"}), "operands is not an array"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateForWrite(tc.file)
			if err == nil || !errors.Is(err, ErrInvalidFile) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected ErrInvalidFile containing %q, got %v", tc.want, err)
			}
		})
	}

	// A deep mask-in-mask chain (nesting via `child`, not `children`) trips the
	// depth bound, proving the DoS guard now covers mask nesting.
	var deepest map[string]any = node("leaf", "shape")
	for i := 0; i < maxNodeDepth+2; i++ {
		deepest = mask("m"+strconv.Itoa(i), deepest)
	}
	err := validateForWrite(page(deepest))
	if err == nil || !strings.Contains(err.Error(), "deeper than") {
		t.Fatalf("deep mask chain should trip the depth bound, got %v", err)
	}
}

func TestValidateForWrite_AcceptsForwardCompatNode(t *testing.T) {
	// A future/unknown node type with arbitrary extra fields must still pass
	// (forward compatibility): only structural invariants are enforced.
	d := DesignFile{
		"id": "d",
		"pages": []any{map[string]any{"id": "p", "children": []any{
			map[string]any{"id": "n", "type": "future-widget", "raw": map[string]any{"anything": []any{1.0, 2.0}}},
		}}},
	}
	if err := validateForWrite(d); err != nil {
		t.Fatalf("forward-compat node should pass: %v", err)
	}
}
