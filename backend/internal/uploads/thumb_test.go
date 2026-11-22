package uploads

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/storage"
)

func TestThumbWidth(t *testing.T) {
	for _, c := range []struct{ in, want int }{{1, 256}, {256, 256}, {257, 512}, {520, 1024}, {1024, 1024}, {5000, 1024}} {
		if got := ThumbWidth(c.in); got != c.want {
			t.Errorf("ThumbWidth(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}

// exifJPEG wraps a JPEG's pixels with an EXIF APP1 segment carrying the
// given orientation, in the given byte order.
func exifJPEG(t *testing.T, img image.Image, orient uint16, bo binary.ByteOrder) []byte {
	t.Helper()
	var body bytes.Buffer
	if err := jpeg.Encode(&body, img, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	tiff := new(bytes.Buffer)
	if bo == binary.LittleEndian {
		tiff.WriteString("II")
	} else {
		tiff.WriteString("MM")
	}
	_ = binary.Write(tiff, bo, uint16(42))
	_ = binary.Write(tiff, bo, uint32(8))
	_ = binary.Write(tiff, bo, uint16(1))      // one entry
	_ = binary.Write(tiff, bo, uint16(0x0112)) // Orientation
	_ = binary.Write(tiff, bo, uint16(3))      // SHORT
	_ = binary.Write(tiff, bo, uint32(1))
	_ = binary.Write(tiff, bo, orient)
	_ = binary.Write(tiff, bo, uint16(0))
	_ = binary.Write(tiff, bo, uint32(0)) // no next IFD
	app1 := append([]byte("Exif\x00\x00"), tiff.Bytes()...)
	out := []byte{0xFF, 0xD8, 0xFF, 0xE1}
	out = binary.BigEndian.AppendUint16(out, uint16(len(app1)+2))
	out = append(out, app1...)
	return append(out, body.Bytes()[2:]...) // the rest of the JPEG after its SOI
}

func TestJPEGOrientation(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 8, 4))
	for _, bo := range []binary.ByteOrder{binary.LittleEndian, binary.BigEndian} {
		for o := uint16(1); o <= 8; o++ {
			if got := jpegOrientation(exifJPEG(t, img, o, bo)); got != int(o) {
				t.Errorf("orientation %d (%v) read as %d", o, bo, got)
			}
		}
	}
	var plain bytes.Buffer
	_ = jpeg.Encode(&plain, img, nil)
	if got := jpegOrientation(plain.Bytes()); got != 1 {
		t.Errorf("a JPEG without EXIF should read as 1, got %d", got)
	}
	if got := jpegOrientation([]byte("not a jpeg")); got != 1 {
		t.Errorf("garbage should read as 1, got %d", got)
	}
	if got := jpegOrientation([]byte{0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF, 1, 2}); got != 1 {
		t.Errorf("a truncated segment should read as 1, got %d", got)
	}
}

func TestApplyOrientation(t *testing.T) {
	// A 2x1 image: red on the left, blue on the right.
	src := image.NewNRGBA(image.Rect(0, 0, 2, 1))
	red, blue := color.NRGBA{255, 0, 0, 255}, color.NRGBA{0, 0, 255, 255}
	src.Set(0, 0, red)
	src.Set(1, 0, blue)
	at := func(img image.Image, x, y int) color.NRGBA { return color.NRGBAModel.Convert(img.At(x, y)).(color.NRGBA) }

	if got := applyOrientation(src, 1); got.Bounds().Dx() != 2 || at(got, 0, 0) != red {
		t.Error("orientation 1 must leave the image alone")
	}
	if got := applyOrientation(src, 2); at(got, 0, 0) != blue || at(got, 1, 0) != red {
		t.Error("orientation 2 mirrors left to right")
	}
	if got := applyOrientation(src, 3); at(got, 0, 0) != blue {
		t.Error("orientation 3 rotates 180")
	}
	// 6: shown rotated a quarter turn clockwise, so the stored left edge
	// (red) ends up on top, in a 1 wide by 2 tall image.
	got := applyOrientation(src, 6)
	if got.Bounds().Dx() != 1 || got.Bounds().Dy() != 2 || at(got, 0, 0) != red || at(got, 0, 1) != blue {
		t.Errorf("orientation 6: %v top=%v bottom=%v", got.Bounds(), at(got, 0, 0), at(got, 0, 1))
	}
	// 8: the other way, so the stored left edge ends up at the bottom.
	got = applyOrientation(src, 8)
	if got.Bounds().Dx() != 1 || got.Bounds().Dy() != 2 || at(got, 0, 0) != blue || at(got, 0, 1) != red {
		t.Errorf("orientation 8: %v top=%v bottom=%v", got.Bounds(), at(got, 0, 0), at(got, 0, 1))
	}
}

// TestThumbnail_DB: a large image is served downscaled at a variant width and
// kept in storage; a small one, a non-image and a zero width fall back to the
// original; a transparent image stays a PNG; deleting the asset removes its
// variants.
func TestThumbnail_DB(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping DB integration test")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stripSchema(dsn))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	store, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	acct := accounts.NewService(tx, "test-jwt-secret")
	owner, ws, _, err := acct.Signup(ctx, "thumb+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	svc := NewService(tx, store, acct)

	photo := image.NewRGBA(image.Rect(0, 0, 2000, 1000))
	for y := 0; y < 1000; y++ {
		for x := 0; x < 2000; x++ {
			photo.Set(x, y, color.RGBA{uint8(x / 8), uint8(y / 4), 120, 255})
		}
	}
	var jb bytes.Buffer
	_ = jpeg.Encode(&jb, photo, &jpeg.Options{Quality: 90})
	up := func(name string, data []byte) string {
		a, err := svc.Upload(ctx, owner.ID, ws.ID, name, base64.StdEncoding.EncodeToString(data), nil, "")
		if err != nil {
			t.Fatalf("upload %s: %v", name, err)
		}
		return a.ID
	}
	id := up("photo.jpg", jb.Bytes())

	data, mime, err := svc.Thumbnail(ctx, id, 500)
	if err != nil {
		t.Fatalf("Thumbnail: %v", err)
	}
	if mime != "image/jpeg" || len(data) >= jb.Len() {
		t.Fatalf("want a smaller JPEG, got %s %d bytes (original %d)", mime, len(data), jb.Len())
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width != 512 || cfg.Height != 256 {
		t.Fatalf("want 512x256, got %dx%d err=%v", cfg.Width, cfg.Height, err)
	}
	if ok, _ := store.Exists(thumbKey(id, 512)); !ok {
		t.Fatal("the variant should be kept in storage")
	}
	again, _, err := svc.Thumbnail(ctx, id, 400)
	if err != nil || !bytes.Equal(again, data) {
		t.Fatalf("a width in the same bucket should serve the stored variant: err=%v", err)
	}
	// Wider than the image is worth: no upscaling.
	small := image.NewRGBA(image.Rect(0, 0, 300, 200))
	var sb bytes.Buffer
	_ = png.Encode(&sb, small)
	if _, _, err := svc.Thumbnail(ctx, up("small.png", sb.Bytes()), 512); !errors.Is(err, ErrNoThumb) {
		t.Fatalf("a small image should fall back to the original, got %v", err)
	}
	if _, _, err := svc.Thumbnail(ctx, id, 0); !errors.Is(err, ErrNoThumb) {
		t.Fatalf("a zero width should fall back to the original, got %v", err)
	}
	// Transparency survives: a PNG with alpha stays a PNG.
	clear := image.NewNRGBA(image.Rect(0, 0, 1200, 600))
	for x := 0; x < 600; x++ {
		for y := 0; y < 600; y++ {
			clear.Set(x, y, color.NRGBA{200, 30, 30, 255})
		}
	}
	var cb bytes.Buffer
	_ = png.Encode(&cb, clear)
	tdata, tmime, err := svc.Thumbnail(ctx, up("cutout.png", cb.Bytes()), 256)
	if err != nil || tmime != "image/png" {
		t.Fatalf("a transparent image should stay PNG: %s err=%v", tmime, err)
	}
	timg, err := png.Decode(bytes.NewReader(tdata))
	if err != nil || timg.Bounds().Dx() != 256 {
		t.Fatalf("decode transparent thumb: %v", err)
	}
	if _, _, _, a := timg.At(250, 10).RGBA(); a != 0 {
		t.Fatal("the transparent half should still be transparent")
	}
	// An upright phone photo (orientation 6) comes out upright: taller than wide.
	rot := exifJPEG(t, photo, 6, binary.BigEndian)
	rdata, _, err := svc.Thumbnail(ctx, up("phone.jpg", rot), 256)
	if err != nil {
		t.Fatalf("Thumbnail rotated: %v", err)
	}
	rcfg, _, _ := image.DecodeConfig(bytes.NewReader(rdata))
	if rcfg.Width != 256 || rcfg.Height != 512 {
		t.Fatalf("an orientation-6 photo should be 256x512, got %dx%d", rcfg.Width, rcfg.Height)
	}

	if err := svc.Remove(ctx, owner.ID, id); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if ok, _ := store.Exists(thumbKey(id, 512)); ok {
		t.Fatal("deleting the asset should delete its variants")
	}
}
