package render

// Apply an image's alpha mask on the export path (ImageNode.alphaMask, v20).
//
// Background removal is non-destructive: the original photo stays in `source`
// and the cutout is a grayscale mask beside it (white keeps, black hides). The
// browser composites the two at draw time. Without the same step here, every
// export would show the background the editor had removed, which is the worst
// kind of divergence because the file looks plausible.
//
// The two are flattened into one PNG rather than mapped onto SVG <mask> or PDF
// /SMask. The image is already raster, so those primitives preserve nothing a
// pre-composited PNG loses, and using them would mean three separate
// implementations to keep in agreement. One flatten serves all three backends.

import (
	"bytes"
	"image"
	"image/draw"
	"image/png"
)

// CompositeAlphaMask multiplies an image's alpha by a grayscale mask and
// re-encodes it as PNG.
//
// Reports false when either input will not decode, in which case the caller
// uses the ORIGINAL image unmasked. Both outcomes are wrong once a mask exists,
// but exporting the whole photo is visible and recoverable, whereas failing to
// draw leaves a hole nobody can trace back to a mask that would not decode.
func CompositeAlphaMask(imgData, maskData []byte) ([]byte, bool) {
	src, _, err := image.Decode(bytes.NewReader(imgData))
	if err != nil {
		return nil, false
	}
	mask, _, err := image.Decode(bytes.NewReader(maskData))
	if err != nil {
		return nil, false
	}

	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return nil, false
	}
	out := image.NewNRGBA(image.Rect(0, 0, w, h))
	draw.Draw(out, out.Bounds(), src, b.Min, draw.Src)

	// The mask is authored against the image, but nothing guarantees the two
	// were saved at the same pixel size (a downscaled mask is a reasonable
	// optimisation). Sampling by ratio rather than assuming parity keeps a
	// mismatched pair correct instead of clipping or panicking.
	mb := mask.Bounds()
	mw, mh := mb.Dx(), mb.Dy()
	if mw <= 0 || mh <= 0 {
		return nil, false
	}

	for y := 0; y < h; y++ {
		my := mb.Min.Y + y*mh/h
		for x := 0; x < w; x++ {
			mx := mb.Min.X + x*mw/w
			mr, mg, mbb, ma := mask.At(mx, my).RGBA()
			// Rec. 601 luma, matching the browser's maskedImage.ts so the two
			// runtimes agree on what a given grey means.
			lum := (299*uint32(mr>>8) + 587*uint32(mg>>8) + 114*uint32(mbb>>8)) / 1000
			// A mask that already carries alpha (a cutout PNG rather than a
			// grayscale one) must not be counted twice.
			cov := lum * (ma >> 8) / 255

			i := out.PixOffset(x, y)
			// NRGBA is NOT premultiplied, so only the alpha channel scales;
			// touching the colour channels here would darken the edge.
			out.Pix[i+3] = uint8(uint32(out.Pix[i+3]) * cov / 255)
		}
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, out); err != nil {
		return nil, false
	}
	return buf.Bytes(), true
}

// AlphaMaskAssetID is the mask asset a node references, or "" when it has none.
func AlphaMaskAssetID(node map[string]any) string {
	m, _ := node["alphaMask"].(map[string]any)
	if m == nil {
		return ""
	}
	id, _ := m["assetId"].(string)
	return id
}
