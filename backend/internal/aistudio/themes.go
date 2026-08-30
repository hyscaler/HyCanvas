// The built-in theme catalog, embedded from the authored TS source (F40 E10/
// E12). scripts/gen-theme-catalog.mjs regenerates theme_catalog.json from
// packages/aistudio/src/themeCatalog.ts; a vitest parity test keeps the two
// deep-equal. The server uses it to validate generation themeIds and to serve
// GET /v1/themes and the MCP list_themes tool - the composer bundle carries
// the same data for the actual composition.
package aistudio

import (
	_ "embed"
	"encoding/json"
)

//go:embed theme_catalog.json
var themeCatalogJSON []byte

// ThemeEntry mirrors the TS ThemeCatalogEntry.
type ThemeEntry struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Style       string   `json:"style"`
	Colors      []string `json:"colors"`
	FontHeading string   `json:"fontHeading"`
	FontBody    string   `json:"fontBody"`
}

var themeCatalog = func() []ThemeEntry {
	var out []ThemeEntry
	if err := json.Unmarshal(themeCatalogJSON, &out); err != nil {
		panic("aistudio: embedded theme_catalog.json is invalid: " + err.Error())
	}
	if len(out) == 0 {
		panic("aistudio: embedded theme_catalog.json is empty")
	}
	return out
}()

var themeIDs = func() map[string]bool {
	m := make(map[string]bool, len(themeCatalog))
	for _, t := range themeCatalog {
		m[t.ID] = true
	}
	return m
}()

// ThemeCatalog returns the built-in themes (id, name, style, slots, fonts).
func ThemeCatalog() []ThemeEntry { return themeCatalog }

// ValidThemeID reports whether id names a built-in catalog theme.
func ValidThemeID(id string) bool { return themeIDs[id] }
