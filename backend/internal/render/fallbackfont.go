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

// fallbackBoldTTF is Liberation Sans Bold (same family and license), used for
// unregistered / "system" text at weight 600 and above. Without it a bold
// title in a stock video template rendered in the regular face on the server,
// narrower and lighter than the editor shows it (#90).
//
//go:embed fonts/LiberationSans-Bold.ttf
var fallbackBoldTTF []byte

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

// fallbackBoldFont is the parsed embedded bold face, or nil.
var fallbackBoldFont = func() *opentype.Font {
	f, err := opentype.Parse(fallbackBoldTTF)
	if err != nil {
		return nil
	}
	return f
}()

// fallbackFor is the face for text whose family is not registered: the page's
// default font, or its bold cut for a weight of 600 and above when the default
// is the embedded Liberation Sans.
func (rc *rctx) fallbackFor(weight int) *opentype.Font {
	if weight >= 600 && rc.font == fallbackFont && fallbackBoldFont != nil {
		return fallbackBoldFont
	}
	return rc.font
}
