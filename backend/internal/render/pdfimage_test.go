package render

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// A PNG whose left half is fully transparent and right half opaque red.
func halfTransparentPNG(t *testing.T) []byte {
	t.Helper()
	rgba := image.NewRGBA(image.Rect(0, 0, 8, 4))
	for y := 0; y < 4; y++ {
		for x := 0; x < 8; x++ {
			if x < 4 {
				rgba.Set(x, y, color.RGBA{})
			} else {
				rgba.Set(x, y, color.RGBA{R: 255, A: 255})
			}
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, rgba); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func solidJPEG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			img.Set(x, y, color.RGBA{B: 255, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func imageNode(id, assetID, alt string, x float64) map[string]any {
	return map[string]any{"id": id, "type": "image", "altText": alt,
		"transform": map[string]any{"x": x, "y": 10.0, "scaleX": 1.0, "scaleY": 1.0},
		"size":      map[string]any{"width": 80.0, "height": 40.0},
		"source":    map[string]any{"assetId": assetID}}
}

// A JPEG rides through untouched as DCTDecode; anything else is decoded and
// written as Flate samples, with transparency in a soft mask.
func TestEncodeImageChoosesTheRightFilter(t *testing.T) {
	jpg, ok := encodeImage("Im0", solidJPEG(t))
	if !ok {
		t.Fatal("JPEG should encode")
	}
	if jpg.filter != "DCTDecode" {
		t.Errorf("JPEG filter = %q, want DCTDecode (no re-encode)", jpg.filter)
	}
	if jpg.w != 16 || jpg.h != 16 {
		t.Errorf("JPEG dimensions = %dx%d, want 16x16", jpg.w, jpg.h)
	}
	if jpg.alpha != nil {
		t.Error("an opaque JPEG needs no soft mask")
	}

	p, ok := encodeImage("Im1", halfTransparentPNG(t))
	if !ok {
		t.Fatal("PNG should encode")
	}
	if p.filter != "FlateDecode" || p.cs != "DeviceRGB" {
		t.Errorf("PNG encoded as %s/%s, want FlateDecode/DeviceRGB", p.filter, p.cs)
	}
	if p.alpha == nil {
		t.Error("a PNG with transparency must carry a soft mask")
	}
}

// An opaque PNG must not grow a pointless soft mask.
func TestOpaquePNGHasNoSoftMask(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < 2; x++ {
			img.Set(x, y, color.RGBA{R: 10, G: 20, B: 30, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	enc, ok := encodeImage("Im0", buf.Bytes())
	if !ok {
		t.Fatal("PNG should encode")
	}
	if enc.alpha != nil {
		t.Error("an opaque image should not emit a soft mask")
	}
}

func TestEncodeImageRejectsGarbage(t *testing.T) {
	if _, ok := encodeImage("Im0", []byte("not an image at all")); ok {
		t.Error("undecodable bytes must not produce an XObject")
	}
}

// The same asset placed twice is embedded once and drawn twice: a logo on every
// slide should not weigh the file down once per placement.
func TestRepeatedAssetIsEmbeddedOnce(t *testing.T) {
	page := map[string]any{"id": "p1", "name": "Pictures", "width": 300.0, "height": 100.0,
		"children": []any{
			imageNode("a", "png", "Left", 10),
			imageNode("b", "png", "Right", 110),
		}}
	src := ImageSource(func(id string) ([]byte, bool) {
		if id == "png" {
			return halfTransparentPNG(t), true
		}
		return nil, false
	})
	out, err := ToPDF(Design(map[string]any{"pages": []any{page}}), 0, src)
	if err != nil {
		t.Fatal(err)
	}
	pdf := string(out)
	if n := strings.Count(pdf, "/Subtype /Image"); n != 2 {
		// the image plus its soft mask, and nothing more
		t.Errorf("got %d image objects, want 2 (one image + one soft mask)", n)
	}
	draws := regexp.MustCompile(`/(Im\d+) Do`).FindAllStringSubmatch(pdf, -1)
	if len(draws) != 2 {
		t.Fatalf("got %d draw ops, want 2", len(draws))
	}
	if draws[0][1] != draws[1][1] {
		t.Errorf("both placements should draw the same XObject, got %s and %s", draws[0][1], draws[1][1])
	}
}

// A missing or undecodable asset degrades to a missing image, never a failed
// export, and the node keeps its description: the picture is gone, the meaning
// is not.
func TestMissingAssetStillCarriesItsDescription(t *testing.T) {
	page := map[string]any{"id": "p1", "name": "Pictures", "width": 300.0, "height": 100.0,
		"children": []any{imageNode("a", "gone", "A chart of revenue", 10)}}
	src := ImageSource(func(string) ([]byte, bool) { return nil, false })
	out, err := ToPDF(Design(map[string]any{"pages": []any{page}}), 0, src)
	if err != nil {
		t.Fatalf("a missing asset must not fail the export: %v", err)
	}
	pdf := string(out)
	if strings.Contains(pdf, " Do") {
		t.Error("nothing should be drawn for a missing asset")
	}
	if !strings.Contains(pdf, "/Alt (A chart of revenue)") {
		t.Error("the description must survive even when the pixels do not")
	}
	if !strings.Contains(pdf, "/S /Figure") {
		t.Error("the node should still enter the structure tree")
	}
}

// Without an ImageSource the encoder behaves exactly as it did before it could
// embed images: no pixels, no XObject, no crash.
func TestNoImageSourceDrawsNothing(t *testing.T) {
	page := map[string]any{"id": "p1", "name": "Pictures", "width": 300.0, "height": 100.0,
		"children": []any{imageNode("a", "png", "Left", 10)}}
	out, err := ToPDF(Design(map[string]any{"pages": []any{page}}), 0)
	if err != nil {
		t.Fatal(err)
	}
	if pdf := string(out); strings.Contains(pdf, "/XObject") {
		t.Error("no image source means no embedded images")
	}
}

// Each page carries its own XObject resources, and the object numbering stays
// consistent when one page embeds images and another does not.
func TestDeckWithImagesNumbersObjectsConsistently(t *testing.T) {
	withImg := map[string]any{"id": "p1", "name": "One", "width": 100.0, "height": 100.0,
		"children": []any{imageNode("a", "png", "Pic", 0)}}
	noImg := map[string]any{"id": "p2", "name": "Two", "width": 100.0, "height": 100.0,
		"children": []any{map[string]any{"id": "t", "type": "text",
			"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0},
			"content":   []any{map[string]any{"runs": []any{map[string]any{"text": "Hi", "style": map[string]any{"fontSize": 12.0}}}}}}}}
	src := ImageSource(func(string) ([]byte, bool) { return halfTransparentPNG(t), true })

	out, err := ToDeckPDF(Design(map[string]any{"pages": []any{withImg, noImg}}), src)
	if err != nil {
		t.Fatal(err)
	}
	pdf := string(out)
	if n := strings.Count(pdf, "/XObject <<"); n != 1 {
		t.Errorf("only the page with an image should declare XObject resources, got %d", n)
	}
	// Every object the xref promises must actually exist, or a viewer rejects
	// the file. The trailer's /Size counts objects plus the free entry.
	sizes := regexp.MustCompile(`/Size (\d+)`).FindStringSubmatch(pdf)
	if sizes == nil {
		t.Fatal("no trailer size")
	}
	declared := len(regexp.MustCompile(`(?m)^\d+ 0 obj$`).FindAllString(pdf, -1))
	if want := declared + 1; sizes[1] != strconv.Itoa(want) {
		t.Errorf("trailer /Size %s but %d objects written", sizes[1], declared)
	}
}
