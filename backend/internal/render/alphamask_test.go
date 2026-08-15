package render

// The export path honours ImageNode.alphaMask (v20).
//
// The failure this guards is the quiet one: without compositing, an export
// looks completely plausible and simply has the background the user removed
// back in it.

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

// solidPNG is a w x h image of one opaque colour.
func solidPNG(t *testing.T, w, h int, c color.NRGBA) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetNRGBA(x, y, c)
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatalf("encode: %v", err)
	}
	return b.Bytes()
}

// halfMask is white on the left half (keep) and black on the right (hide).
func halfMask(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			v := uint8(0)
			if x < w/2 {
				v = 255
			}
			img.SetNRGBA(x, y, color.NRGBA{R: v, G: v, B: v, A: 255})
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatalf("encode: %v", err)
	}
	return b.Bytes()
}

func decodeNRGBA(t *testing.T, data []byte) image.Image {
	t.Helper()
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	return img
}

func TestCompositeAlphaMaskHidesWhereTheMaskIsBlack(t *testing.T) {
	out, ok := CompositeAlphaMask(solidPNG(t, 20, 10, color.NRGBA{R: 255, A: 255}), halfMask(t, 20, 10))
	if !ok {
		t.Fatal("compositing failed")
	}
	img := decodeNRGBA(t, out)
	if _, _, _, a := img.At(4, 5).RGBA(); a < 0xF000 {
		t.Fatalf("kept side is transparent: alpha %d", a)
	}
	if _, _, _, a := img.At(16, 5).RGBA(); a != 0 {
		t.Fatalf("hidden side survived: alpha %d", a)
	}
}

func TestCompositeAlphaMaskKeepsColourAtSoftEdges(t *testing.T) {
	// NRGBA is not premultiplied, so only alpha may scale. Scaling the colour
	// channels too would darken every antialiased mask edge.
	mask := image.NewNRGBA(image.Rect(0, 0, 2, 1))
	mask.SetNRGBA(0, 0, color.NRGBA{R: 128, G: 128, B: 128, A: 255})
	mask.SetNRGBA(1, 0, color.NRGBA{R: 255, G: 255, B: 255, A: 255})
	var mb bytes.Buffer
	if err := png.Encode(&mb, mask); err != nil {
		t.Fatal(err)
	}
	out, ok := CompositeAlphaMask(solidPNG(t, 2, 1, color.NRGBA{R: 255, A: 255}), mb.Bytes())
	if !ok {
		t.Fatal("compositing failed")
	}
	img := decodeNRGBA(t, out)
	r, _, _, a := img.At(0, 0).RGBA()
	if a == 0 || a > 0x9000 {
		t.Fatalf("half-covered pixel alpha = %d, want roughly half", a)
	}
	// Un-premultiplying: the red channel must still read as full red.
	if r*0xFFFF/a < 0xF000 {
		t.Fatalf("colour was darkened at the soft edge: r=%d a=%d", r, a)
	}
}

func TestCompositeAlphaMaskPreservesSoftFalloffProportionally(t *testing.T) {
	// The editor's refinement brush paints a soft radial falloff, so a mask now
	// carries the whole grey range, not just the remover's near-binary values.
	// Each grey must come through as a PROPORTIONAL alpha: an implementation
	// that thresholds or steps would pass the half-grey test above on tolerance
	// while visibly hardening every brushed edge on export.
	levels := []uint8{32, 64, 128, 191, 224}
	mask := image.NewNRGBA(image.Rect(0, 0, len(levels), 1))
	for i, v := range levels {
		mask.SetNRGBA(i, 0, color.NRGBA{R: v, G: v, B: v, A: 255})
	}
	var mb bytes.Buffer
	if err := png.Encode(&mb, mask); err != nil {
		t.Fatal(err)
	}
	out, ok := CompositeAlphaMask(solidPNG(t, len(levels), 1, color.NRGBA{G: 255, A: 255}), mb.Bytes())
	if !ok {
		t.Fatal("compositing failed")
	}
	img := decodeNRGBA(t, out)
	for i, v := range levels {
		_, _, _, a := img.At(i, 0).RGBA()
		got := int(a >> 8)
		if diff := got - int(v); diff < -2 || diff > 2 {
			t.Fatalf("grey %d exported as alpha %d, want within 2", v, got)
		}
	}
}

func TestCompositeAlphaMaskHandlesAMaskOfADifferentSize(t *testing.T) {
	// Nothing guarantees the mask was saved at the image's pixel size; a
	// downscaled mask is a reasonable optimisation and must not clip or panic.
	out, ok := CompositeAlphaMask(solidPNG(t, 40, 20, color.NRGBA{B: 255, A: 255}), halfMask(t, 10, 5))
	if !ok {
		t.Fatal("compositing failed")
	}
	img := decodeNRGBA(t, out)
	if b := img.Bounds(); b.Dx() != 40 || b.Dy() != 20 {
		t.Fatalf("output resized to %v", b)
	}
	if _, _, _, a := img.At(35, 10).RGBA(); a != 0 {
		t.Fatalf("hidden side survived with a smaller mask: alpha %d", a)
	}
}

func TestUndecodableMaskLeavesTheImageIntact(t *testing.T) {
	// Exporting the whole photo is visible and recoverable; failing to draw
	// leaves a hole nobody can trace back to a mask that would not decode.
	if _, ok := CompositeAlphaMask(solidPNG(t, 4, 4, color.NRGBA{A: 255}), []byte("not a png")); ok {
		t.Fatal("a corrupt mask was treated as valid")
	}
}

func TestAlphaMaskAssetID(t *testing.T) {
	if got := AlphaMaskAssetID(map[string]any{}); got != "" {
		t.Fatalf("no mask should report empty, got %q", got)
	}
	node := map[string]any{"alphaMask": map[string]any{"assetId": "m1"}}
	if got := AlphaMaskAssetID(node); got != "m1" {
		t.Fatalf("got %q", got)
	}
}
