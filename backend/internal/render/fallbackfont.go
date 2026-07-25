package render

import (
	_ "embed"

	"golang.org/x/image/font/opentype"
)

// fallbackTTF is Liberation Sans Regular (SIL Open Font License 1.1; see
// fonts/LiberationSans-LICENSE.txt), embedded as the default face for server
// raster text. It is metric-compatible with Arial/Helvetica, which the browser's
// system-ui font stack resolves to on most platforms, so width-driven layout
// (chart legend fitting, table alignment, text wrap) matches the editor far more
// closely than the previous embedded Go font did.
//
//go:embed fonts/LiberationSans-Regular.ttf
var fallbackTTF []byte

// fallbackFontLicense is the SIL OFL 1.1 license for the embedded font, compiled
// into the binary so the license travels with the font (as the OFL requires).
//
//go:embed fonts/LiberationSans-LICENSE.txt
var fallbackFontLicense string

// FallbackFontLicense returns the license text for the embedded fallback font.
func FallbackFontLicense() string { return fallbackFontLicense }

// fallbackFont is the parsed embedded fallback face, or nil if it fails to parse
// (callers then fall back to goregular).
var fallbackFont = func() *opentype.Font {
	f, err := opentype.Parse(fallbackTTF)
	if err != nil {
		return nil
	}
	return f
}()
