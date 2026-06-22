package render

import (
	"bytes"
	"image"
	"image/png"
	"testing"
)

func TestToPNG(t *testing.T) {
	data, err := ToPNG(sampleDesign(), 0, 1)
	if err != nil {
		t.Fatalf("ToPNG: %v", err)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode png: %v", err)
	}
	b := img.Bounds()
	if b.Dx() != 200 || b.Dy() != 100 {
		t.Fatalf("png dimensions wrong: %dx%d", b.Dx(), b.Dy())
	}
	// The red rect (fill rgb(255,0,0)) sits at x[10..60], y[20..60]; sample center.
	r, g, bl, _ := img.At(30, 40).RGBA()
	if r>>8 < 200 || g>>8 > 60 || bl>>8 > 60 {
		t.Fatalf("expected red at (30,40), got r=%d g=%d b=%d", r>>8, g>>8, bl>>8)
	}
	// Background is white (top-left corner, away from any shape).
	wr, wg, wb, _ := img.At(190, 5).RGBA()
	if wr>>8 < 240 || wg>>8 < 240 || wb>>8 < 240 {
		t.Fatalf("expected white background, got r=%d g=%d b=%d", wr>>8, wg>>8, wb>>8)
	}
}

func TestToPNGScale(t *testing.T) {
	data, err := ToPNG(sampleDesign(), 0, 2)
	if err != nil {
		t.Fatalf("ToPNG x2: %v", err)
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode config: %v", err)
	}
	if cfg.Width != 400 || cfg.Height != 200 {
		t.Fatalf("scaled dimensions wrong: %dx%d", cfg.Width, cfg.Height)
	}
}

func TestToJPEG(t *testing.T) {
	data, err := ToJPEG(sampleDesign(), 0, 1, 80)
	if err != nil {
		t.Fatalf("ToJPEG: %v", err)
	}
	if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
		t.Fatalf("decode jpeg: %v", err)
	}
}

func TestRasterPageRange(t *testing.T) {
	if _, err := ToPNG(sampleDesign(), 7, 1); err != ErrPageRange {
		t.Fatalf("out-of-range page should error, got %v", err)
	}
}
