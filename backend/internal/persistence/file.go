// DesignFile handling for the persistence lifecycle. The open file format is
// treated as opaque JSON (map[string]any): the service serializes it, content-
// addresses it by sha-256, does a lightweight structural validation, walks its
// node ids (for the diff + comment orphan detection), and reads/writes the meta
// object (brand assignment, locked regions, etc.). Full @hc/schema validation
// and cross-version migration live in the frontend; the Go service round-trips
// the file verbatim.
package persistence

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

// currentSchemaVersion mirrors @hc/schema CURRENT_SCHEMA_VERSION.
const currentSchemaVersion = 16

// CurrentSchemaVersion is the exported mirror of currentSchemaVersion for other
// packages (e.g. convert) so they cannot pin a second, drifting copy.
const CurrentSchemaVersion = currentSchemaVersion

// DesignFile is the open file format, handled opaquely.
type DesignFile map[string]any

func serialize(file DesignFile) ([]byte, error) {
	return json.Marshal(file)
}

func checksum(buf []byte) string {
	sum := sha256.Sum256(buf)
	return hex.EncodeToString(sum[:])
}

func snapshotKey(designID, checksum string) string {
	return "designs/" + designID + "/snapshots/" + checksum + ".ocd"
}

// validFile does a lightweight structural check: the file must have a string id
// and a pages array. Full schema validation is the frontend's responsibility.
func validFile(file DesignFile) bool {
	if file == nil {
		return false
	}
	if _, ok := file["id"].(string); !ok {
		return false
	}
	if _, ok := file["pages"].([]any); !ok {
		return false
	}
	return true
}

// schemaVersionOf reads the file's schemaVersion (defaulting to current).
func schemaVersionOf(file DesignFile) int {
	if v, ok := file["schemaVersion"].(float64); ok {
		return int(v)
	}
	return currentSchemaVersion
}

// docKindOf reads file.meta.kind, or "" when absent.
func docKindOf(file DesignFile) string {
	if meta, ok := file["meta"].(map[string]any); ok {
		if k, ok := meta["kind"].(string); ok {
			return k
		}
	}
	return ""
}

// withID returns a shallow copy of the file with its id set (the stored blob is
// self-describing: its id mirrors the design row).
func withID(file DesignFile, id string) DesignFile {
	out := make(DesignFile, len(file)+1)
	for k, v := range file {
		out[k] = v
	}
	out["id"] = id
	return out
}

// withMeta returns a copy of the file with a replaced meta object.
func withMeta(file DesignFile, meta map[string]any) DesignFile {
	out := make(DesignFile, len(file))
	for k, v := range file {
		out[k] = v
	}
	out["meta"] = meta
	return out
}

// metaOf returns a mutable copy of the file's meta object (never nil).
func metaOf(file DesignFile) map[string]any {
	out := map[string]any{}
	if meta, ok := file["meta"].(map[string]any); ok {
		for k, v := range meta {
			out[k] = v
		}
	}
	return out
}

// createBlankDesign mirrors @hc/schema createBlankDesign: a single white 1080
// page, current schema version. ids are caller-supplied so they mirror the row.
func createBlankDesign(id, title string) DesignFile {
	return DesignFile{
		"format":        "hycanvas.design",
		"schemaVersion": currentSchemaVersion,
		"id":            id,
		"title":         title,
		"unit":          "px",
		"dpi":           96,
		"pages": []any{
			map[string]any{
				"id":         id + "-p1",
				"name":       "Page 1",
				"width":      1080,
				"height":     1080,
				"background": map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": 1, "g": 1, "b": 1, "a": 1}}},
				"children":   []any{},
			},
		},
		"assets": []any{},
		"fonts":  []any{},
		"meta":   map[string]any{},
	}
}

// CollectNodeIDs walks every page's node tree and returns the set of node ids
// (for comment orphan detection, doc 17 FR-1).
func CollectNodeIDs(file DesignFile) map[string]bool {
	ids := map[string]bool{}
	pages, _ := file["pages"].([]any)
	for _, p := range pages {
		page, _ := p.(map[string]any)
		if page == nil {
			continue
		}
		children, _ := page["children"].([]any)
		walkNodes(children, ids)
	}
	return ids
}

func walkNodes(nodes []any, ids map[string]bool) {
	for _, n := range nodes {
		node, _ := n.(map[string]any)
		if node == nil {
			continue
		}
		if id, ok := node["id"].(string); ok {
			ids[id] = true
		}
		if kids, ok := node["children"].([]any); ok {
			walkNodes(kids, ids)
		}
	}
}

// computeDiff is the lightweight structural diff (doc 04 FR-6): page + node
// adds/removes, and node changes by JSON value compare.
func computeDiff(from, to DesignFile) DiffSummary {
	fromPages := pageIDs(from)
	toPages := pageIDs(to)
	d := DiffSummary{}
	for id := range toPages {
		if !fromPages[id] {
			d.PagesAdded++
		}
	}
	for id := range fromPages {
		if !toPages[id] {
			d.PagesRemoved++
		}
	}
	a := nodeMap(from)
	b := nodeMap(to)
	for id, node := range b {
		prev, ok := a[id]
		if !ok {
			d.NodesAdded++
		} else if !jsonEqual(prev, node) {
			d.NodesChanged++
		}
	}
	for id := range a {
		if _, ok := b[id]; !ok {
			d.NodesRemoved++
		}
	}
	// meta carries entire document models (video timeline, doc body, sheet
	// cells), so a node-tree-only diff would report zero changes for real
	// edits on those document kinds. An absent meta key and an empty meta
	// object are the same document; don't report that as a change.
	normMeta := func(f DesignFile) any {
		if m := asObj(f["meta"]); len(m) > 0 {
			return m
		}
		return nil
	}
	d.MetaChanged = !jsonEqual(normMeta(from), normMeta(to))
	return d
}

func pageIDs(file DesignFile) map[string]bool {
	out := map[string]bool{}
	pages, _ := file["pages"].([]any)
	for _, p := range pages {
		if page, ok := p.(map[string]any); ok {
			if id, ok := page["id"].(string); ok {
				out[id] = true
			}
		}
	}
	return out
}

func nodeMap(file DesignFile) map[string]any {
	m := map[string]any{}
	pages, _ := file["pages"].([]any)
	for _, p := range pages {
		page, _ := p.(map[string]any)
		if page == nil {
			continue
		}
		children, _ := page["children"].([]any)
		collectNodes(children, m)
	}
	return m
}

func collectNodes(nodes []any, m map[string]any) {
	for _, n := range nodes {
		node, _ := n.(map[string]any)
		if node == nil {
			continue
		}
		if id, ok := node["id"].(string); ok {
			m[id] = node
		}
		if kids, ok := node["children"].([]any); ok {
			collectNodes(kids, m)
		}
	}
}

func jsonEqual(a, b any) bool {
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	return string(ab) == string(bb)
}
