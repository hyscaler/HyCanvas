// Pure data-merge core (port of @hc/templates fill.ts), operating on the opaque
// DesignFile JSON (map[string]any). Text fields set their node's first run text;
// image fields point the node's image source at a URL. The source design is
// never mutated (applyFill clones first).
package bulkcreate

import (
	"encoding/json"
	"fmt"
)

// FillValue is one field's value: text fields use Text, image fields use ImageURL.
type FillValue struct {
	Text     string `json:"text,omitempty"`
	ImageURL string `json:"imageUrl,omitempty"`
}

// FillValues is a fill row keyed by fillable-field nodeId.
type FillValues map[string]FillValue

// Field is a fillable-field descriptor (matches the SDK FillableFieldSummary).
type Field struct {
	NodeID      string         `json:"nodeId"`
	Kind        string         `json:"kind"`
	Label       string         `json:"label"`
	Hint        string         `json:"hint,omitempty"`
	Constraints map[string]any `json:"constraints,omitempty"`
}

func cloneFile(file map[string]any) map[string]any {
	b, _ := json.Marshal(file)
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return out
}

func asArr(v any) []any { a, _ := v.([]any); return a }
func asObj(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// findNode walks pages -> children (recursing into children, mask child, boolean
// operands) and returns the node with id, or nil.
func findNode(file map[string]any, id string) map[string]any {
	var found map[string]any
	var visit func(n map[string]any)
	visit = func(n map[string]any) {
		if found != nil || n == nil {
			return
		}
		if s, _ := n["id"].(string); s == id {
			found = n
			return
		}
		for _, c := range asArr(n["children"]) {
			visit(asObj(c))
		}
		if t, _ := n["type"].(string); t == "mask" {
			if ch := asObj(n["child"]); ch != nil {
				visit(ch)
			}
		}
		if t, _ := n["type"].(string); t == "boolean" {
			for _, op := range asArr(n["operands"]) {
				visit(asObj(op))
			}
		}
	}
	for _, p := range asArr(file["pages"]) {
		for _, root := range asArr(asObj(p)["children"]) {
			visit(asObj(root))
		}
	}
	return found
}

// fillTextNode sets a text node's copy, handling both the Paragraph (content[0]
// carries runs) and TableCell (content is the run array) shapes.
func fillTextNode(node map[string]any, text string) bool {
	content := asArr(node["content"])
	if len(content) == 0 {
		return false
	}
	first := asObj(content[0])
	if first == nil {
		return false
	}
	if runs := asArr(first["runs"]); runs != nil {
		if len(runs) == 0 {
			return false
		}
		run := asObj(runs[0])
		newRun := map[string]any{}
		for k, v := range run {
			newRun[k] = v
		}
		newRun["text"] = text
		first["runs"] = []any{newRun}
		node["content"] = []any{first}
		return true
	}
	if _, ok := first["text"]; ok {
		newFirst := map[string]any{}
		for k, v := range first {
			newFirst[k] = v
		}
		newFirst["text"] = text
		node["content"] = []any{newFirst}
		return true
	}
	return false
}

// fillImageNode points an image node (or a node's first image fill) at imageURL.
func fillImageNode(node map[string]any, imageURL string) bool {
	src := map[string]any{"assetId": imageURL, "naturalWidth": 0, "naturalHeight": 0}
	if t, _ := node["type"].(string); t == "image" {
		node["source"] = src
		delete(node, "crop")
		return true
	}
	for _, f := range asArr(node["fills"]) {
		fm := asObj(f)
		if fm == nil {
			continue
		}
		if ft, _ := fm["type"].(string); ft == "image" {
			fm["source"] = src
			delete(fm, "crop")
			return true
		}
	}
	return false
}

// ApplyFill substitutes a row of values into a clone of file. ids are preserved
// (a single autofill stays the same design); the input is never mutated.
func ApplyFill(file map[string]any, values FillValues) map[string]any {
	clone := cloneFile(file)
	for nodeID, value := range values {
		hasText := value.Text != ""
		hasImage := value.ImageURL != ""
		if !hasText && !hasImage {
			continue
		}
		node := findNode(clone, nodeID)
		if node == nil {
			continue
		}
		if hasText {
			fillTextNode(node, value.Text)
		}
		if hasImage {
			fillImageNode(node, value.ImageURL)
		}
	}
	return clone
}

// ValidateFillRow checks a row against the fields' constraints, returning the
// first problem (required presence + text maxChars; image aspect is deferred).
func ValidateFillRow(fields []Field, values FillValues) (bool, string) {
	for _, field := range fields {
		v, has := values[field.NodeID]
		present := has && (v.Text != "" || v.ImageURL != "")
		req, _ := field.Constraints["required"].(bool)
		if req && !present {
			return false, fmt.Sprintf("%s is required", field.Label)
		}
		if field.Kind == "text" {
			if mc, ok := numConstraint(field.Constraints["maxChars"]); ok && v.Text != "" && len([]rune(v.Text)) > mc {
				return false, fmt.Sprintf("%s exceeds %d characters", field.Label, mc)
			}
		}
	}
	return true, ""
}

func numConstraint(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	}
	return 0, false
}
