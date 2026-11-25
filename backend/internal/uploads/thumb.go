// Downscaled copies of image assets for previews.
//
// A dashboard card draws a design a few hundred pixels wide, but used to
// download every image in it at full resolution: a deck of phone photos is
// tens of megabytes for a thumbnail. The thumb endpoint serves the same image
// at one of a few fixed widths, made on first request and kept in storage
// beside the original, so a card downloads kilobytes instead.
//
// It is an optimisation only. Whenever a smaller copy cannot or should not be
// made (not a still image, already small, too large to decode safely, a
// decode error) the caller gets ErrNoThumb and serves the original, so a
// client may always ask for the thumb.

package uploads

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"strconv"
	"strings"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // decode WebP uploads
)

// ErrNoThumb means no downscaled copy applies: serve the original instead.
var ErrNoThumb = errors.New("no thumbnail for this asset")

// thumbWidths are the widths a thumb is made at. A request is served the
// smallest one that is at least as wide as it asks for, so the set of stored
// variants per asset stays small whatever widths clients send.
var thumbWidths = []int{256, 512, 1024}

const (
	// thumbMaxSourceBytes and thumbMaxPixels bound what is decoded: a decoded
	// image costs 4 bytes a pixel, and a tiny file can declare huge dimensions.
	thumbMaxSourceBytes = 64 << 20
	thumbMaxPixels      = 80_000_000
	thumbJPEGQuality    = 82
)

// thumbSlots bounds concurrent resizes; each holds a decoded image in memory.
var thumbSlots = make(chan struct{}, 2)

// ThumbWidth snaps a requested width to the variant that serves it.
func ThumbWidth(requested int) int {
	for _, w := range thumbWidths {
		if requested <= w {
			return w
		}
	}
	return thumbWidths[len(thumbWidths)-1]
}

func thumbKey(assetID string, width int) string {
	return "thumbs/" + assetID + "_" + strconv.Itoa(width)
}

// deleteThumbs removes an asset's stored variants (best effort).
func (s *Service) deleteThumbs(assetID string) {
	for _, w := range thumbWidths {
		_ = s.storage.Delete(thumbKey(assetID, w))
	}
}

// Thumbnail returns the asset downscaled to the variant width that serves
// `width`, with its MIME type. ErrNoThumb means the original should be served.
func (s *Service) Thumbnail(ctx context.Context, id string, width int) ([]byte, string, error) {
	if width <= 0 {
		return nil, "", ErrNoThumb
	}
	rec, err := s.getAsset(ctx, id)
	if err != nil {
		return nil, "", err
	}
	mime := ""
	if rec.MimeType != nil {
		mime = strings.ToLower(*rec.MimeType)
	}
	// Still raster images only. A GIF may be animated and an SVG is a document,
	// so both are left to the original.
	if mime != "image/jpeg" && mime != "image/png" && mime != "image/webp" {
		return nil, "", ErrNoThumb
	}
	if rec.ByteSize != nil && *rec.ByteSize > thumbMaxSourceBytes {
		return nil, "", ErrNoThumb
	}
	w := ThumbWidth(width)
	key := thumbKey(id, w)
	if cached, err := s.storage.Get(key); err == nil && len(cached) > 0 {
		return cached, thumbMime(cached), nil
	}

	src, err := s.storage.Get(rec.StorageKey)
	if err != nil || len(src) == 0 || len(src) > thumbMaxSourceBytes {
		return nil, "", ErrNoThumb
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(src))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		return nil, "", ErrNoThumb
	}
	if int64(cfg.Width)*int64(cfg.Height) > thumbMaxPixels {
		return nil, "", ErrNoThumb
	}
	orient := 1
	if mime == "image/jpeg" {
		orient = jpegOrientation(src)
	}
	// Width as a browser shows it: orientations 5 to 8 swap the axes.
	shownW := cfg.Width
	if orient >= 5 {
		shownW = cfg.Height
	}
	// Never upscale, and a copy barely smaller than the original is not worth
	// storing a second file for.
	if shownW <= w+w/8 {
		return nil, "", ErrNoThumb
	}

	select {
	case thumbSlots <- struct{}{}:
		defer func() { <-thumbSlots }()
	case <-ctx.Done():
		return nil, "", ctx.Err()
	}
	img, _, err := image.Decode(bytes.NewReader(src))
	if err != nil {
		return nil, "", ErrNoThumb
	}
	img = applyOrientation(img, orient)
	b := img.Bounds()
	h := b.Dy() * w / b.Dx()
	if h < 1 {
		h = 1
	}
	dst := image.NewNRGBA(image.Rect(0, 0, w, h))
	// The kernel scaler averages over the source area, so a large reduction
	// does not alias the way nearest or plain bilinear sampling would.
	xdraw.BiLinear.Scale(dst, dst.Bounds(), img, b, xdraw.Src, nil)

	var out bytes.Buffer
	if opaque(dst) {
		if err := jpeg.Encode(&out, dst, &jpeg.Options{Quality: thumbJPEGQuality}); err != nil {
			return nil, "", ErrNoThumb
		}
	} else {
		enc := png.Encoder{CompressionLevel: png.BestSpeed}
		if err := enc.Encode(&out, dst); err != nil {
			return nil, "", ErrNoThumb
		}
	}
	data := out.Bytes()
	// Stored for next time; a failed write only costs the next request a resize.
	_, _ = s.storage.Put(key, data)
	return data, thumbMime(data), nil
}

func thumbMime(data []byte) string {
	if len(data) > 3 && data[0] == 0xFF && data[1] == 0xD8 {
		return "image/jpeg"
	}
	return "image/png"
}

func opaque(img *image.NRGBA) bool { return img.Opaque() }

// jpegOrientation reads the EXIF orientation (1 to 8) of a JPEG, or 1 when it
// has none. Browsers apply it when they draw the file, so a thumb made from
// the raw pixels of a rotated phone photo would come out sideways.
func jpegOrientation(data []byte) int {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 1
	}
	i := 2
	for i+4 <= len(data) {
		if data[i] != 0xFF {
			return 1
		}
		marker := data[i+1]
		if marker == 0xDA || marker == 0xD9 { // image data: no EXIF before it
			return 1
		}
		size := int(binary.BigEndian.Uint16(data[i+2 : i+4]))
		if size < 2 || i+2+size > len(data) {
			return 1
		}
		seg := data[i+4 : i+2+size]
		if marker == 0xE1 && len(seg) >= 14 && string(seg[:6]) == "Exif\x00\x00" {
			return tiffOrientation(seg[6:])
		}
		i += 2 + size
	}
	return 1
}

func tiffOrientation(t []byte) int {
	if len(t) < 8 {
		return 1
	}
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 1
	}
	off := int(bo.Uint32(t[4:8]))
	if off < 8 || off+2 > len(t) {
		return 1
	}
	n := int(bo.Uint16(t[off : off+2]))
	for k := 0; k < n; k++ {
		e := off + 2 + k*12
		if e+12 > len(t) {
			return 1
		}
		if bo.Uint16(t[e:e+2]) == 0x0112 { // Orientation
			v := int(bo.Uint16(t[e+8 : e+10]))
			if v >= 1 && v <= 8 {
				return v
			}
			return 1
		}
	}
	return 1
}

// applyOrientation returns the image as a viewer shows it for an EXIF
// orientation: 2 mirrored, 3 rotated 180, 4 flipped, 5 to 8 the transposed
// forms (6 is the common "phone held upright").
func applyOrientation(src image.Image, orient int) image.Image {
	if orient <= 1 || orient > 8 {
		return src
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	dw, dh := w, h
	if orient >= 5 {
		dw, dh = h, w
	}
	dst := image.NewNRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var dx, dy int
			switch orient {
			case 2:
				dx, dy = w-1-x, y
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dx, dy = x, h-1-y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			default: // 8
				dx, dy = y, w-1-x
			}
			dst.Set(dx, dy, src.At(b.Min.X+x, b.Min.Y+y))
		}
	}
	return dst
}
