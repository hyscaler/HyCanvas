package persistence

import (
	"errors"
	"fmt"
)

// ErrInvalidFile is returned when a client-supplied design file fails the
// structural validation gate on write. Defense in depth (F16): the relay cannot
// validate the opaque Yjs update stream, so the open-format boundary is where a
// malformed or malicious document is rejected before it persists. Other clients
// and the renderer load a stored snapshot verbatim, so a structurally broken file
// (duplicate node ids, non-object nodes, absurd depth) must never be written. The
// HTTP layer maps this to 422.
var ErrInvalidFile = errors.New("invalid design file")

const (
	// maxNodeDepth bounds the page/node tree so a pathological deeply-nested
	// document cannot overflow the recursive walkers (a DoS vector). Real designs
	// nest a handful of group/frame levels; 64 is far beyond any legitimate use.
	maxNodeDepth = 64
	// maxNodeCount bounds the total node count per document (gross-payload guard;
	// the wire/storage size limits also apply).
	maxNodeCount = 100000
)

// validateForWrite structurally validates a client-supplied DesignFile before it
// is persisted. It checks only HARD structural invariants - ids present and
// unique, node types present, arrays well-formed, bounded depth/count, sane
// schemaVersion - so forward-compatible node types and unknown fields still pass;
// field-level schema validation stays in the frontend (@hc/schema). Returns
// ErrInvalidFile (wrapped with a human-readable reason) on the first violation.
func validateForWrite(file DesignFile) error {
	if file == nil {
		return fmt.Errorf("%w: file is nil", ErrInvalidFile)
	}
	if id, ok := file["id"].(string); !ok || id == "" {
		return fmt.Errorf("%w: missing string id", ErrInvalidFile)
	}
	if v, ok := asInt(file["schemaVersion"]); ok && (v < 1 || v > currentSchemaVersion) {
		return fmt.Errorf("%w: schemaVersion %d out of range (1..%d)", ErrInvalidFile, v, currentSchemaVersion)
	}
	pages, ok := file["pages"].([]any)
	if !ok || len(pages) == 0 {
		return fmt.Errorf("%w: pages must be a non-empty array", ErrInvalidFile)
	}
	pageIDs := make(map[string]bool, len(pages))
	nodeIDs := map[string]bool{}
	count := 0
	for i, p := range pages {
		page, ok := p.(map[string]any)
		if !ok {
			return fmt.Errorf("%w: page %d is not an object", ErrInvalidFile, i)
		}
		pid, ok := page["id"].(string)
		if !ok || pid == "" {
			return fmt.Errorf("%w: page %d missing string id", ErrInvalidFile, i)
		}
		if pageIDs[pid] {
			return fmt.Errorf("%w: duplicate page id %q", ErrInvalidFile, pid)
		}
		pageIDs[pid] = true
		if raw, present := page["children"]; present {
			children, ok := raw.([]any)
			if !ok {
				return fmt.Errorf("%w: page %q children is not an array", ErrInvalidFile, pid)
			}
			if err := validateNodes(children, nodeIDs, &count, 1); err != nil {
				return err
			}
		}
	}
	return nil
}

// validateNodes recursively validates a children array: each node is an object
// with a non-empty string id (globally unique) and a non-empty string type, and
// any nested children is itself an array. Depth- and count-bounded.
func validateNodes(nodes []any, ids map[string]bool, count *int, depth int) error {
	if depth > maxNodeDepth {
		return fmt.Errorf("%w: node tree deeper than %d", ErrInvalidFile, maxNodeDepth)
	}
	for _, n := range nodes {
		node, ok := n.(map[string]any)
		if !ok {
			return fmt.Errorf("%w: node is not an object", ErrInvalidFile)
		}
		*count++
		if *count > maxNodeCount {
			return fmt.Errorf("%w: more than %d nodes", ErrInvalidFile, maxNodeCount)
		}
		id, ok := node["id"].(string)
		if !ok || id == "" {
			return fmt.Errorf("%w: node missing string id", ErrInvalidFile)
		}
		if ids[id] {
			return fmt.Errorf("%w: duplicate node id %q", ErrInvalidFile, id)
		}
		ids[id] = true
		typ, ok := node["type"].(string)
		if !ok || typ == "" {
			return fmt.Errorf("%w: node %q missing string type", ErrInvalidFile, id)
		}
		if raw, present := node["children"]; present {
			kids, ok := raw.([]any)
			if !ok {
				return fmt.Errorf("%w: node %q children is not an array", ErrInvalidFile, id)
			}
			if err := validateNodes(kids, ids, count, depth+1); err != nil {
				return err
			}
		}
		// Some node types nest other nodes OUTSIDE `children`: a mask's single
		// `child`, a boolean op's `operands` array. Their nested nodes live in the
		// same global id namespace (id-regeneration on paste/duplicate relies on
		// it), so validate them too - same id-uniqueness, type, and depth/count
		// bounds. Type-gated so a forward-compatible node that happens to carry a
		// `child`/`operands` field with different meaning still passes.
		if typ == "mask" {
			if raw, present := node["child"]; present {
				child, ok := raw.(map[string]any)
				if !ok {
					return fmt.Errorf("%w: node %q child is not an object", ErrInvalidFile, id)
				}
				if err := validateNodes([]any{child}, ids, count, depth+1); err != nil {
					return err
				}
			}
		}
		if typ == "boolean" {
			if raw, present := node["operands"]; present {
				ops, ok := raw.([]any)
				if !ok {
					return fmt.Errorf("%w: node %q operands is not an array", ErrInvalidFile, id)
				}
				if err := validateNodes(ops, ids, count, depth+1); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// asInt reads a JSON number (float64 from json.Unmarshal, or a native int from an
// in-process file) as an int.
func asInt(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	default:
		return 0, false
	}
}
