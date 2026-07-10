// Image embedding for PDF export (doc 28 FR-22).
//
// The PDF encoder used to skip image nodes entirely, so a server-rendered PDF
// silently lost every photograph. That was tolerable while nothing depended on
// the Go path; it is not tolerable for an accessible export, where the whole
// point is that nothing goes missing.
//
// `render` stays pure: it never reads a file, a database, or the network. The
// caller injects an ImageSource that resolves an asset id to its bytes, exactly
// as the browser engine takes an asset provider. A source that cannot resolve
// an asset yields no pixels rather than an error, so one missing upload
// degrades a single image instead of failing the whole export.
//
// A JPEG is embedded as-is: PDF speaks DCTDecode natively, so re-encoding would
// cost quality for nothing. Everything else is decoded and written as
// Flate-compressed samples, with transparency carried in a soft mask, because
// PDF has no alpha channel of its own.

package render

import (
	"bytes"
	"compress/zlib"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/png" // register PNG for image.Decode
)

// ImageSource resolves a design asset to its raw encoded bytes. The bool is
// false when the asset is unknown, which is not an error: the image simply does
// not draw.
type ImageSource func(assetID string) ([]byte, bool)

// pdfImage is one embedded image, ready to be written as an XObject.
type pdfImage struct {
	name   string // resource name within the page, e.g. Im0
	w, h   int
	filter string // DCTDecode for a passthrough JPEG, FlateDecode otherwise
	cs     string // DeviceRGB or DeviceGray
	data   []byte // the stream bytes, already encoded
	// alpha is a Flate-compressed 8-bit grayscale soft mask, nil when the
	// image is fully opaque. PDF carries transparency in a separate object.
	alpha []byte
}

func flate(b []byte) []byte {
	var out bytes.Buffer
	zw := zlib.NewWriter(&out)
	_, _ = zw.Write(b)
	_ = zw.Close()
	return out.Bytes()
}

// encodeImage turns encoded image bytes into an embeddable XObject.
func encodeImage(name string, data []byte) (*pdfImage, bool) {
	// A baseline JPEG rides through untouched. CMYK is the exception: PDF would
	// need the Adobe inversion convention to read it back, so it takes the slow
	// path and comes out as RGB.
	if len(data) > 2 && data[0] == 0xFF && data[1] == 0xD8 {
		if cfg, err := jpeg.DecodeConfig(bytes.NewReader(data)); err == nil && cfg.ColorModel != color.CMYKModel {
			cs := "DeviceRGB"
			if cfg.ColorModel == color.GrayModel {
				cs = "DeviceGray"
			}
			return &pdfImage{name: name, w: cfg.Width, h: cfg.Height, filter: "DCTDecode", cs: cs, data: data}, true
		}
	}

	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, false
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return nil, false
	}
	rgb := make([]byte, 0, w*h*3)
	mask := make([]byte, 0, w*h)
	opaque := true
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			// RGBA() returns alpha-premultiplied 16-bit values. PDF wants
			// un-premultiplied samples, so divide the color back out.
			r, g, bl, a := img.At(x, y).RGBA()
			if a == 0 {
				rgb = append(rgb, 0, 0, 0)
			} else {
				rgb = append(rgb, byte(r*0xFF/a), byte(g*0xFF/a), byte(bl*0xFF/a))
			}
			m := byte(a >> 8)
			if m != 0xFF {
				opaque = false
			}
			mask = append(mask, m)
		}
	}
	out := &pdfImage{name: name, w: w, h: h, filter: "FlateDecode", cs: "DeviceRGB", data: flate(rgb)}
	if !opaque {
		out.alpha = flate(mask)
	}
	return out, true
}

// xobjects renders the image (and its soft mask, if any) as PDF objects,
// starting at object number `first`. It returns the bodies in order and the
// resource-dictionary entry pointing at the image.
func (im *pdfImage) xobjects(first int) (bodies []string, resource string) {
	smaskRef := ""
	if im.alpha != nil {
		// The mask object follows the image object.
		smaskRef = fmt.Sprintf(" /SMask %d 0 R", first+1)
	}
	bodies = append(bodies, fmt.Sprintf(
		"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /%s /BitsPerComponent 8 /Filter /%s%s /Length %d >>\nstream\n%s\nendstream",
		im.w, im.h, im.cs, im.filter, smaskRef, len(im.data)+1, im.data))
	if im.alpha != nil {
		bodies = append(bodies, fmt.Sprintf(
			"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length %d >>\nstream\n%s\nendstream",
			im.w, im.h, len(im.alpha)+1, im.alpha))
	}
	resource = fmt.Sprintf("/%s %d 0 R ", im.name, first)
	return bodies, resource
}

// assetBytes resolves an image node's pixels through the design's asset table.
// A node whose asset is missing, or whose bytes will not decode, draws nothing:
// it still enters the structure tree, so its description survives even when its
// pixels do not.
func assetBytes(node map[string]any, src ImageSource) (assetID string, data []byte, ok bool) {
	if src == nil {
		return "", nil, false
	}
	source := asObj(node["source"])
	if source == nil {
		return "", nil, false
	}
	assetID = asStr(source["assetId"])
	if assetID == "" {
		return "", nil, false
	}
	data, ok = src(assetID)
	return assetID, data, ok && len(data) > 0
}
