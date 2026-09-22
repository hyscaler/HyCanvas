// Images for API-composed decks.
//
// The composer leaves a tagged stand-in in every picture region (a shape node
// carrying data.placeholderId and data.aiImagePrompt), which is what the
// editor's image queue replaces one by one. A deck made through the API or
// MCP had no such queue, so its pictures stayed grey rectangles and the job
// result said so. This runs the same replacement server-side, before the deck
// is persisted, through the workspace's own image provider.
//
// Bounded on purpose: at most a handful of images per deck, a few in flight at
// once, each on its own clock, and a region that fails keeps its stand-in.
// Images are the slowest and most expensive step of a generation, and a deck
// with two placeholders left is a better outcome than a deck that never
// arrives.

package httpapi

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"hycanvas/backend/internal/ai"
	"hycanvas/backend/internal/uploads"
)

const (
	// maxGeneratedImagesPerDeck caps the spend one API call can trigger.
	maxGeneratedImagesPerDeck = 6
	// imageConcurrency is how many regions render at once; providers rate
	// limit, and three keeps a six-image deck under a minute without tripping
	// them.
	imageConcurrency = 3
	// perImageTimeout bounds one region; the job's own clock bounds the rest.
	perImageTimeout = 90 * time.Second
)

// imageGenerator produces an image for a prompt at a size, as a data URL or
// an http(s) URL. ai.Service.Image satisfies it.
type imageGenerator func(ctx context.Context, workspaceID, prompt, size string) (string, error)

// imageUploader stores a generated image and returns the asset id, its URL,
// and its mime type. The uploads service satisfies it through uploadAdapter.
type imageUploader func(ctx context.Context, userID, workspaceID, img string) (id, url, mime string, ok bool)

// imagePlacement is the outcome for the job result.
type imagePlacement struct {
	Requested int `json:"requested"`
	Placed    int `json:"placed"`
	// Unsupported is true when the workspace's provider cannot generate
	// images at all, so every region was left as a stand-in on purpose.
	Unsupported bool `json:"unsupported,omitempty"`
}

// generatedRegion is one stand-in to fill.
type generatedRegion struct {
	node   map[string]any
	prompt string
	size   string
}

// pictureSizeFor picks the provider size string from the region's aspect.
func pictureSizeFor(node map[string]any) string {
	sz := asMap(node["size"])
	w, h := asFloat(sz["width"]), asFloat(sz["height"])
	switch {
	case w > h*1.3:
		return "1792x1024"
	case h > w*1.3:
		return "1024x1792"
	default:
		return "1024x1024"
	}
}

// taggedRegions collects the stand-ins in page order, capped.
func taggedRegions(file map[string]any) []generatedRegion {
	var out []generatedRegion
	for _, pg := range asSlice(file["pages"]) {
		for _, ch := range asSlice(asMap(pg)["children"]) {
			n := asMap(ch)
			data := asMap(n["data"])
			prompt, _ := data["aiImagePrompt"].(string)
			if strings.TrimSpace(prompt) == "" || n["type"] != "shape" {
				continue
			}
			out = append(out, generatedRegion{node: n, prompt: prompt, size: pictureSizeFor(n)})
			if len(out) >= maxGeneratedImagesPerDeck {
				return out
			}
		}
	}
	return out
}

// placeGeneratedImages fills the deck's tagged regions in place and returns
// what happened. It never returns an error: a region that cannot be filled
// keeps its stand-in, which is exactly what the editor shows for the same
// situation.
func placeGeneratedImages(ctx context.Context, file map[string]any, userID, workspaceID string, gen imageGenerator, up imageUploader) imagePlacement {
	regions := taggedRegions(file)
	result := imagePlacement{Requested: len(regions)}
	if len(regions) == 0 || gen == nil || up == nil {
		return result
	}

	type outcome struct {
		region generatedRegion
		id     string
		url    string
		mime   string
		ok     bool
		unsup  bool
	}
	outcomes := make([]outcome, len(regions))
	var wg sync.WaitGroup
	sem := make(chan struct{}, imageConcurrency)
	for i, r := range regions {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, r generatedRegion) {
			defer wg.Done()
			defer func() { <-sem }()
			ictx, cancel := context.WithTimeout(ctx, perImageTimeout)
			defer cancel()
			img, err := gen(ictx, workspaceID, r.prompt, r.size)
			if err != nil {
				outcomes[i] = outcome{region: r, unsup: isImageUnsupported(err)}
				return
			}
			id, url, mime, ok := up(ictx, userID, workspaceID, img)
			outcomes[i] = outcome{region: r, id: id, url: url, mime: mime, ok: ok}
		}(i, r)
	}
	wg.Wait()

	// Apply sequentially: the file is one document, and two goroutines must
	// not append to its asset list at once.
	assets := asSlice(file["assets"])
	for _, o := range outcomes {
		if o.unsup {
			result.Unsupported = true
		}
		if !o.ok {
			continue
		}
		becomeImageNode(o.region.node, o.id)
		assets = append(assets, map[string]any{"id": o.id, "kind": "image", "url": o.url, "mime": o.mime})
		result.Placed++
	}
	file["assets"] = assets
	return result
}

// becomeImageNode turns a stand-in shape into the image node the editor would
// have made for it: same id, geometry and tags, the shape-only fields gone.
// Keeping the id means anything that referenced the stand-in (reading order,
// an animation) still points at the picture.
func becomeImageNode(n map[string]any, assetID string) {
	n["type"] = "image"
	n["name"] = "Image"
	n["source"] = map[string]any{"assetId": assetID, "naturalWidth": 0, "naturalHeight": 0}
	n["fit"] = "cover"
	for _, k := range []string{"shape", "cornerRadius", "sides", "innerRadius", "pathData", "fills", "stroke", "points"} {
		delete(n, k)
	}
}

// isImageUnsupported reports the capability rejection, which means "leave all
// regions alone" rather than "this one failed".
func isImageUnsupported(err error) bool {
	return errors.Is(err, ai.ErrImageUnsupported)
}

// uploadAdapter stores a generated image through the uploads service and
// reports the asset id the file needs. It mirrors persistAIImage, which only
// returned the URL because the editor minted its own asset ids.
func uploadAdapter(up *uploads.Service) imageUploader {
	if up == nil {
		return nil
	}
	return func(ctx context.Context, userID, workspaceID, img string) (string, string, string, bool) {
		var (
			asset uploads.UploadedAsset
			err   error
		)
		switch {
		case strings.HasPrefix(img, "data:"):
			parts := strings.SplitN(img, ",", 2)
			if len(parts) != 2 || parts[1] == "" {
				return "", "", "", false
			}
			asset, err = up.Upload(ctx, userID, workspaceID, "ai-image.png", parts[1], nil, "")
		case strings.HasPrefix(img, "http://"), strings.HasPrefix(img, "https://"):
			asset, err = up.ImportFromURL(ctx, userID, workspaceID, img, nil)
		default:
			return "", "", "", false
		}
		if err != nil || asset.URL == "" || asset.ID == "" {
			return "", "", "", false
		}
		mime := "image/png"
		if asset.MimeType != nil && *asset.MimeType != "" {
			mime = *asset.MimeType
		}
		return asset.ID, asset.URL, mime, true
	}
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func asSlice(v any) []any {
	s, _ := v.([]any)
	return s
}

func asFloat(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	}
	return 0
}
