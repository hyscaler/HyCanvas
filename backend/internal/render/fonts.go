// Optional real-font registry for the raster exporter. By default text draws
// in the embedded fallback (goregular); a host can register actual font files
// (e.g. the design's Google Fonts) so server-side rasters are glyph-true.
// Lookup never fails: an unregistered family falls back to the embedded font.
package render

import (
	"strings"
	"sync"

	"golang.org/x/image/font/opentype"
)

type fontKey struct {
	family string
	weight int
}

var (
	fontMu  sync.RWMutex
	fontReg = map[fontKey]*opentype.Font{}
)

// normFamily canonicalizes a family name for lookup ("Space Mono" == "SpaceMono").
func normFamily(f string) string {
	return strings.ToLower(strings.ReplaceAll(f, " ", ""))
}

// RegisterFont parses and registers font bytes for a family/weight pair.
func RegisterFont(family string, weight int, data []byte) error {
	f, err := opentype.Parse(data)
	if err != nil {
		return err
	}
	fontMu.Lock()
	defer fontMu.Unlock()
	fontReg[fontKey{normFamily(family), weight}] = f
	return nil
}

// lookupFont returns the registered font nearest in weight for the family, or
// nil when the family has no registered faces (caller falls back).
func lookupFont(family string, weight int) *opentype.Font {
	fontMu.RLock()
	defer fontMu.RUnlock()
	fam := normFamily(family)
	var best *opentype.Font
	bestDist := 1 << 30
	for k, f := range fontReg {
		if k.family != fam {
			continue
		}
		d := k.weight - weight
		if d < 0 {
			d = -d
		}
		if d < bestDist {
			bestDist = d
			best = f
		}
	}
	return best
}
