package httpapi

import (
	"context"
	"errors"
	"strings"
	"testing"

	"hycanvas/backend/internal/ai"
)

func standIn(id, prompt string, w, h float64) map[string]any {
	return map[string]any{
		"id": id, "type": "shape", "name": "Image", "shape": "rect", "cornerRadius": 8.0,
		"fills":     []any{map[string]any{"type": "solid"}},
		"transform": map[string]any{"x": 10.0, "y": 20.0},
		"size":      map[string]any{"width": w, "height": h},
		"data":      map[string]any{"placeholderId": id, "aiImagePrompt": prompt},
	}
}

func deckWith(nodes ...map[string]any) map[string]any {
	children := make([]any, 0, len(nodes))
	for _, n := range nodes {
		children = append(children, n)
	}
	return map[string]any{"pages": []any{map[string]any{"children": children}}}
}

// A filled region becomes the image node the editor would have made: same id
// and geometry, the shape-only fields gone, an asset ref appended.
func TestPlaceGeneratedImagesReplacesStandInsAndRecordsAssets(t *testing.T) {
	file := deckWith(standIn("a", "a dune at dawn, photo", 1600, 900), standIn("b", "marsh grass", 600, 900))
	gen := func(_ context.Context, _, prompt, size string) (string, error) {
		return "data:image/png;base64,aW1n-" + size, nil
	}
	up := func(_ context.Context, _, _, img string) (string, string, string, bool) {
		return "asset-" + img[len(img)-9:], "/assets/x", "image/png", true
	}
	res := placeGeneratedImages(context.Background(), file, "u", "ws", gen, up)
	if res.Requested != 2 || res.Placed != 2 || res.Unsupported {
		t.Fatalf("placement = %+v", res)
	}
	nodes := asSlice(asMap(asSlice(file["pages"])[0])["children"])
	a := asMap(nodes[0])
	if a["type"] != "image" || a["fit"] != "cover" || a["id"] != "a" {
		t.Fatalf("stand-in not converted: %+v", a)
	}
	if _, still := a["shape"]; still {
		t.Fatal("shape-only fields must be removed from the image node")
	}
	if asMap(a["data"])["placeholderId"] != "a" {
		t.Fatal("the tag must survive so the editor still recognises the region")
	}
	// Aspect drives the requested size: a wide region asks for a wide image.
	if asMap(a["source"])["assetId"] != "asset-1792x1024" {
		t.Fatalf("wide region should request 1792x1024, got %v", asMap(a["source"])["assetId"])
	}
	if asMap(asMap(nodes[1])["source"])["assetId"] != "asset-1024x1792" {
		t.Fatal("tall region should request 1024x1792")
	}
	if n := len(asSlice(file["assets"])); n != 2 {
		t.Fatalf("expected 2 asset refs, got %d", n)
	}
}

// A region that fails keeps its stand-in, exactly as the editor shows for the
// same situation, and the rest of the deck still gets its pictures.
func TestPlaceGeneratedImagesKeepsTheStandInOnFailure(t *testing.T) {
	file := deckWith(standIn("a", "fails", 100, 100), standIn("b", "works", 100, 100))
	gen := func(_ context.Context, _, prompt, _ string) (string, error) {
		if prompt == "fails" {
			return "", errors.New("provider timeout")
		}
		return "https://cdn.example/img.png", nil
	}
	up := func(_ context.Context, _, _, _ string) (string, string, string, bool) {
		return "id", "/assets/id", "image/png", true
	}
	res := placeGeneratedImages(context.Background(), file, "u", "ws", gen, up)
	if res.Requested != 2 || res.Placed != 1 || res.Unsupported {
		t.Fatalf("placement = %+v", res)
	}
	nodes := asSlice(asMap(asSlice(file["pages"])[0])["children"])
	if asMap(nodes[0])["type"] != "shape" {
		t.Fatal("the failed region must keep its stand-in")
	}
	if asMap(nodes[1])["type"] != "image" {
		t.Fatal("the other region must still be filled")
	}
}

// A provider that cannot make images is not a failure to report per region:
// every stand-in stays, and the result says why, once.
func TestPlaceGeneratedImagesReportsAnUnsupportedProvider(t *testing.T) {
	file := deckWith(standIn("a", "x", 100, 100))
	gen := func(context.Context, string, string, string) (string, error) { return "", ai.ErrImageUnsupported }
	up := func(context.Context, string, string, string) (string, string, string, bool) { return "", "", "", false }
	res := placeGeneratedImages(context.Background(), file, "u", "ws", gen, up)
	if !res.Unsupported || res.Placed != 0 {
		t.Fatalf("placement = %+v", res)
	}
}

// Spend is bounded whatever the deck asks for.
func TestPlaceGeneratedImagesIsCapped(t *testing.T) {
	nodes := make([]map[string]any, 0, 12)
	for i := 0; i < 12; i++ {
		nodes = append(nodes, standIn(string(rune('a'+i)), "p", 100, 100))
	}
	file := deckWith(nodes...)
	calls := 0
	gen := func(context.Context, string, string, string) (string, error) { calls++; return "https://x/y.png", nil }
	up := func(context.Context, string, string, string) (string, string, string, bool) {
		return "id", "/a", "image/png", true
	}
	res := placeGeneratedImages(context.Background(), file, "u", "ws", gen, up)
	if res.Requested != maxGeneratedImagesPerDeck || res.Placed != maxGeneratedImagesPerDeck {
		t.Fatalf("placement = %+v", res)
	}
}

// The prompt key is the editor's, byte for byte, so API decks and editor
// decks reuse each other's pictures.
func TestPromptAssetKeyMatchesTheEditor(t *testing.T) {
	if got := promptAssetKey("A dune belt at dawn,  clean professional photography, natural light, no text"); got != "aiimg-54959d50" {
		t.Fatalf("promptAssetKey = %s", got)
	}
	if promptAssetKey("x") == promptAssetKey("y") {
		t.Fatal("different prompts must not share a key")
	}
}

// Routing and subject recovery mirror the editor: a short concrete subject
// goes to stock, a stylized or long one is generated.
func TestImageRoutingMirrorsTheEditor(t *testing.T) {
	if imageSubjectOf("a dune belt at dawn, clean professional photography, natural light, no text") != "a dune belt at dawn" {
		t.Fatal("subject is the text before the first comma")
	}
	if routeImageSource("a dune belt at dawn") != "stock" {
		t.Fatal("a short concrete subject routes to stock")
	}
	if routeImageSource("abstract gradient texture") != "generate" {
		t.Fatal("a stylized marker routes to generation")
	}
	if routeImageSource("volunteers planting marsh grass along a restored shoreline at low tide") != "generate" {
		t.Fatal("a long subject routes to generation")
	}
}

// The ladder: reuse first, stock for a short subject with a free licence,
// generation last, and every landed asset tagged with the prompt key.
func TestPlacePicturesRunsTheEditorLadder(t *testing.T) {
	file := deckWith(
		standIn("reused", "a lighthouse at dusk, clean professional photography, natural light, no text", 800, 600),
		standIn("stock", "a dune belt at dawn, clean professional photography, natural light, no text", 800, 600),
		standIn("gen", "volunteers planting marsh grass along a restored shoreline at low tide, clean professional photography, natural light, no text", 800, 600),
	)
	var genCalls, tagged []string
	src := pictureSources{
		reuse: func(_ context.Context, _, _, key string) (string, string, string, bool) {
			if key == promptAssetKey("a lighthouse at dusk, clean professional photography, natural light, no text") {
				return "old-asset", "/assets/old", "image/png", true
			}
			return "", "", "", false
		},
		stock: func(_ context.Context, _, subject string) (string, string, map[string]any, bool) {
			if subject == "a dune belt at dawn" {
				return "https://photos.example/dune.jpg", "ov-123", map[string]any{"type": "cc0", "attributionRequired": false}, true
			}
			return "", "", nil, false
		},
		gen: func(_ context.Context, _, prompt, _ string) (string, error) {
			genCalls = append(genCalls, prompt)
			return "https://cdn.example/generated.png", nil
		},
		up: func(_ context.Context, _, _, img string) (string, string, string, bool) {
			return "asset-for-" + img[len(img)-8:], "/assets/new", "image/jpeg", true
		},
		tag: func(_ context.Context, _, assetID, key string) { tagged = append(tagged, assetID+"="+key) },
	}
	res := placePictures(context.Background(), file, "u", "ws", src)
	if res.Requested != 3 || res.Placed != 3 || res.Reused != 1 || res.Stock != 1 || res.Generated != 1 {
		t.Fatalf("placement = %+v", res)
	}
	if len(genCalls) != 1 || !strings.HasPrefix(genCalls[0], "volunteers") {
		t.Fatalf("only the long subject should be generated, got %v", genCalls)
	}
	nodes := asSlice(asMap(asSlice(file["pages"])[0])["children"])
	reused, stockNode, gen := asMap(nodes[0]), asMap(nodes[1]), asMap(nodes[2])
	if asMap(reused["source"])["assetId"] != "old-asset" {
		t.Fatal("the reused region must point at the existing asset")
	}
	if d := asMap(stockNode["data"]); d["origin"] != "stock" || d["stockAssetId"] != "ov-123" || asMap(d["license"])["type"] != "cc0" {
		t.Fatalf("stock provenance missing: %v", d)
	}
	if _, has := asMap(gen["data"])["origin"]; has {
		t.Fatal("a generated picture carries no stock provenance")
	}
	// Stock and generated assets are tagged for reuse; the reused one already was.
	if len(tagged) != 2 {
		t.Fatalf("expected the stock and generated assets tagged, got %v", tagged)
	}
}

// A stock hit that demands attribution, or that has no absolute URL, is not
// used automatically.
func TestPickFreeStockPhotoSkipsCreditedAndRelativeHits(t *testing.T) {
	hits := []map[string]any{
		{"id": "by", "sourceUrl": "https://x/by.jpg", "license": map[string]any{"attributionRequired": true}},
		{"id": "bundled", "previewUrl": "/stock/bundled.jpg", "license": map[string]any{"attributionRequired": false}},
		{"id": "free", "sourceUrl": "https://x/free.jpg", "license": map[string]any{"type": "cc0", "attributionRequired": false}},
	}
	src, id, _, ok := pickFreeStockPhoto(hits)
	if !ok || id != "free" || src != "https://x/free.jpg" {
		t.Fatalf("pick = %q %q %v", src, id, ok)
	}
	if _, _, _, ok := pickFreeStockPhoto(hits[:2]); ok {
		t.Fatal("nothing usable must mean no pick")
	}
}
