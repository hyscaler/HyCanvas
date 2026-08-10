// Optional real-font registry for the raster exporter. By default text draws in
// the embedded Arial-metric fallback (Liberation Sans, see fallbackfont.go); a
// host can register actual font files (e.g. the design's Google Fonts) so
// server-side rasters are glyph-true. Lookup never fails: an unregistered family
// falls back to the embedded font.
package render

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/image/font"
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

// --- glyph coverage and script fallback --------------------------------------
//
// The embedded fallback (Liberation Sans) covers Latin, Greek and Cyrillic and
// nothing else: no Hebrew, no Arabic, no CJK, no Indic. Text in those scripts
// used to draw as NOTHING, because an uncovered rune was silently skipped, so a
// design exported blank where the canvas showed words. Registering fonts is how
// an operator fixes that, and this picks whichever registered font actually
// covers each rune.

// coversRune reports whether a font has a glyph for r at a nominal size.
func coversRune(f *opentype.Font, r rune) bool {
	face, err := opentype.NewFace(f, &opentype.FaceOptions{Size: 16, DPI: 72})
	if err != nil {
		return false
	}
	defer face.Close()
	_, ok := face.GlyphAdvance(r)
	return ok
}

// fontCovering returns a registered font with a glyph for r, preferring the
// requested family so a design that names a font it registered keeps it.
func fontCovering(r rune, preferFamily string, weight int) *opentype.Font {
	if f := lookupFont(preferFamily, weight); f != nil && coversRune(f, r) {
		return f
	}
	fontMu.RLock()
	defer fontMu.RUnlock()
	for _, f := range fontReg {
		if coversRune(f, r) {
			return f
		}
	}
	return nil
}

// RegisteredFamilies lists the registered family names, for startup logging so
// an operator can see what coverage the server actually has.
func RegisteredFamilies() []string {
	fontMu.RLock()
	defer fontMu.RUnlock()
	seen := map[string]bool{}
	out := []string{}
	for k := range fontReg {
		if !seen[k.family] {
			seen[k.family] = true
			out = append(out, k.family)
		}
	}
	return out
}

// LoadFontDir registers every font file in dir, so a self-hoster can drop in
// the scripts their users write in. Filenames follow the convention the
// template renderer already uses: "Family-Weight.ttf" (weight optional,
// defaulting to 400), for example "NotoSansHebrew-700.ttf" or "NotoSansArabic.ttf".
// Returns the number registered; a file that fails to parse is skipped with an
// error rather than aborting the rest.
func LoadFontDir(dir string) (int, []error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, []error{fmt.Errorf("read font dir: %w", err)}
	}
	var errs []error
	n := 0
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(e.Name()))
		if ext != ".ttf" && ext != ".otf" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", e.Name(), err))
			continue
		}
		base := strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
		family, weight := base, 400
		if i := strings.LastIndex(base, "-"); i > 0 {
			if w, convErr := strconv.Atoi(base[i+1:]); convErr == nil {
				family, weight = base[:i], w
			}
		}
		if err := RegisterFont(family, weight, data); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", e.Name(), err))
			continue
		}
		n++
	}
	return n, errs
}

// faceCovering builds a face for r at the given size, falling back across the
// registry when the preferred family has no glyph. Returns nil when nothing
// covers the rune, which is the caller's signal to draw a visible marker rather
// than silently skip it.
func faceCovering(r rune, preferFamily string, weight int, sizePx float64, embedded *opentype.Font) font.Face {
	if embedded != nil && coversRune(embedded, r) {
		if f := lookupFont(preferFamily, weight); f != nil && coversRune(f, r) {
			face, err := opentype.NewFace(f, &opentype.FaceOptions{Size: sizePx, DPI: 72, Hinting: font.HintingFull})
			if err == nil {
				return face
			}
		}
		face, err := opentype.NewFace(embedded, &opentype.FaceOptions{Size: sizePx, DPI: 72, Hinting: font.HintingFull})
		if err == nil {
			return face
		}
	}
	f := fontCovering(r, preferFamily, weight)
	if f == nil {
		return nil
	}
	face, err := opentype.NewFace(f, &opentype.FaceOptions{Size: sizePx, DPI: 72, Hinting: font.HintingFull})
	if err != nil {
		return nil
	}
	return face
}

// Missing-glyph reporting. A design whose text exports blank is nearly
// impossible to diagnose from the outside, so the first time each script is
// dropped the renderer says so once, rather than per glyph per page.
var (
	missingMu   sync.Mutex
	missingSeen = map[rune]bool{}
	missingLog  func(r rune)
)

// SetMissingGlyphReporter installs a callback invoked once per uncovered rune.
// The server wires this to its logger at startup.
func SetMissingGlyphReporter(fn func(r rune)) {
	missingMu.Lock()
	defer missingMu.Unlock()
	missingLog = fn
}

func noteMissingGlyph(r rune) {
	missingMu.Lock()
	defer missingMu.Unlock()
	if missingSeen[r] || missingLog == nil {
		return
	}
	missingSeen[r] = true
	missingLog(r)
}
