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
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"hycanvas/backend/internal/ai"
	"hycanvas/backend/internal/stock"
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
	// How the placed pictures were sourced: an asset the workspace already
	// had for the same prompt, a licensed stock photo, or a generated image.
	Reused    int `json:"reused,omitempty"`
	Stock     int `json:"stock,omitempty"`
	Generated int `json:"generated,omitempty"`
	// Unsupported is true when the workspace's provider cannot generate
	// images at all; regions the reuse and stock steps could not fill were
	// left as stand-ins on purpose.
	Unsupported bool `json:"unsupported,omitempty"`
}

// pictureSources are the steps of the picture ladder the editor's image queue
// runs, in the same order: reuse an asset already tagged with the prompt
// key, then a free stock photo for a short concrete subject, then generation;
// whatever lands is tagged so the next identical prompt reuses it. Each step
// is a function so the job wires services and the tests wire stand-ins.
type pictureSources struct {
	// reuse finds a workspace asset carrying the prompt's key.
	reuse func(ctx context.Context, userID, workspaceID, key string) (id, url, mime string, ok bool)
	// stock finds a free photo for a short concrete subject and hands back
	// where to fetch it and what to credit.
	stock func(ctx context.Context, userID, subject string) (sourceURL, stockID string, license map[string]any, ok bool)
	gen   imageGenerator
	up    imageUploader
	// tag records the prompt key on a stored asset.
	tag func(ctx context.Context, userID, assetID, key string)
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

// placeGeneratedImages is the generation-only ladder, kept for callers and
// tests that have no reuse or stock step to offer.
func placeGeneratedImages(ctx context.Context, file map[string]any, userID, workspaceID string, gen imageGenerator, up imageUploader) imagePlacement {
	return placePictures(ctx, file, userID, workspaceID, pictureSources{gen: gen, up: up})
}

// placePictures fills the deck's tagged regions in place, through the same
// ladder the editor's image queue runs, and returns what happened. It never
// returns an error: a region no step could fill keeps its stand-in, which is
// exactly what the editor shows for the same situation.
func placePictures(ctx context.Context, file map[string]any, userID, workspaceID string, src pictureSources) imagePlacement {
	regions := taggedRegions(file)
	result := imagePlacement{Requested: len(regions)}
	if len(regions) == 0 || src.up == nil {
		return result
	}

	type outcome struct {
		region generatedRegion
		id     string
		url    string
		mime   string
		ok     bool
		unsup  bool
		source string
		// Provenance for a stock photo, stamped on the node as the editor does.
		provenance map[string]any
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
			key := promptAssetKey(r.prompt)
			// 1. Reuse: the workspace already made this picture once.
			if src.reuse != nil {
				if id, url, mime, ok := src.reuse(ictx, userID, workspaceID, key); ok {
					outcomes[i] = outcome{region: r, id: id, url: url, mime: mime, ok: true, source: "reused"}
					return
				}
			}
			// 2. Stock: a short concrete subject a photo library can match.
			// Routed on the subject, never the stylized prompt, as the editor
			// does; a hit is imported into the workspace, never hotlinked.
			if src.stock != nil {
				if subject := imageSubjectOf(r.prompt); subject != "" && routeImageSource(subject) == "stock" {
					if source, stockID, license, ok := src.stock(ictx, userID, subject); ok {
						if id, url, mime, ok := src.up(ictx, userID, workspaceID, source); ok {
							prov := map[string]any{"origin": "stock", "stockAssetId": stockID}
							if license != nil {
								prov["license"] = license
							}
							if src.tag != nil {
								src.tag(ictx, userID, id, key)
							}
							outcomes[i] = outcome{region: r, id: id, url: url, mime: mime, ok: true, source: "stock", provenance: prov}
							return
						}
					}
				}
			}
			// 3. Generate, then tag the stored asset with the prompt key.
			if src.gen == nil {
				outcomes[i] = outcome{region: r}
				return
			}
			img, err := src.gen(ictx, workspaceID, r.prompt, r.size)
			if err != nil {
				outcomes[i] = outcome{region: r, unsup: isImageUnsupported(err)}
				return
			}
			id, url, mime, ok := src.up(ictx, userID, workspaceID, img)
			if ok && src.tag != nil {
				src.tag(ictx, userID, id, key)
			}
			outcomes[i] = outcome{region: r, id: id, url: url, mime: mime, ok: ok, source: "generated"}
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
		if o.provenance != nil {
			data := asMap(o.region.node["data"])
			if data == nil {
				data = map[string]any{}
				o.region.node["data"] = data
			}
			for k, v := range o.provenance {
				data[k] = v
			}
		}
		assets = append(assets, map[string]any{"id": o.id, "kind": "image", "url": o.url, "mime": o.mime})
		result.Placed++
		switch o.source {
		case "reused":
			result.Reused++
		case "stock":
			result.Stock++
		default:
			result.Generated++
		}
	}
	file["assets"] = assets
	return result
}

// pictureSourcesFor wires the ladder to the services: the uploads service
// for reuse, import and tagging; the stock service for licensed photos; the
// AI service for generation. Any missing service drops its step.
func pictureSourcesFor(aiSvc *ai.Service, up *uploads.Service, st *stock.Service) pictureSources {
	src := pictureSources{up: uploadAdapter(up)}
	if aiSvc != nil {
		src.gen = aiSvc.Image
	}
	if up != nil {
		src.reuse = func(ctx context.Context, userID, workspaceID, key string) (string, string, string, bool) {
			hits, err := up.List(ctx, userID, workspaceID, nil, false, key, "")
			if err != nil || len(hits) == 0 || hits[0].URL == "" {
				return "", "", "", false
			}
			mime := "image/png"
			if hits[0].MimeType != nil && *hits[0].MimeType != "" {
				mime = *hits[0].MimeType
			}
			return hits[0].ID, hits[0].URL, mime, true
		}
		src.tag = func(ctx context.Context, userID, assetID, key string) {
			tags := []string{key}
			_, _ = up.UpdateAsset(ctx, userID, assetID, nil, nil, false, &tags)
		}
	}
	if st != nil {
		src.stock = func(ctx context.Context, userID, subject string) (string, string, map[string]any, bool) {
			hits, err := st.Search(ctx, stock.Query{Text: subject, Kind: "photo", Limit: 5}, userID)
			if err != nil {
				return "", "", nil, false
			}
			return pickFreeStockPhoto(hits)
		}
	}
	return src
}

// pickFreeStockPhoto chooses the first hit an automatic insertion may use:
// one whose license asks for no credit (a generated deck cannot promise the
// attribution compiles) and that has an absolute URL to import from.
func pickFreeStockPhoto(hits []map[string]any) (sourceURL, stockID string, license map[string]any, ok bool) {
	for _, h := range hits {
		lic := asMap(h["license"])
		if req, _ := lic["attributionRequired"].(bool); req {
			continue
		}
		src, _ := h["sourceUrl"].(string)
		if src == "" {
			src, _ = h["previewUrl"].(string)
		}
		if !strings.HasPrefix(src, "http://") && !strings.HasPrefix(src, "https://") {
			continue
		}
		id, _ := h["id"].(string)
		return src, id, lic, true
	}
	return "", "", nil, false
}

// imageSubjectOf recovers the concrete subject from a composed picture
// prompt. The composer writes "<subject>, <treatment style>", so the subject
// is everything before the first comma; a prompt without one is its own
// subject.
func imageSubjectOf(prompt string) string {
	if i := strings.Index(prompt, ","); i >= 0 {
		return strings.TrimSpace(prompt[:i])
	}
	return strings.TrimSpace(prompt)
}

// promptAssetKey is the reuse tag for a prompt, computed exactly as the
// editor computes it (@hc/aistudio promptAssetKey: normalized, FNV-1a
// 32-bit), so a deck generated through the API reuses what the editor made
// for the same prompt, and the other way round.
func promptAssetKey(prompt string) string {
	norm := strings.TrimSpace(strings.Join(strings.Fields(strings.ToLower(prompt)), " "))
	h := uint32(0x811c9dc5)
	for _, r := range norm {
		// The editor hashes UTF-16 code units; every character the composer
		// writes is in the basic plane, where code unit and code point agree.
		h ^= uint32(r)
		h *= 0x01000193
	}
	return fmt.Sprintf("aiimg-%08x", h)
}

// stylizedMarkers mirror the editor's: a prompt carrying one wants a
// generated image, whatever its length.
var stylizedMarkers = regexp.MustCompile(`(?i)\b(abstract|gradient|texture|pattern|illustration|3d|render(?:ed|ing)?|isometric|watercolor|neon|surreal|futuristic|low.?poly|pixel.?art|line.?art|flat.?design|minimalis\w*|vaporwave|cinematic|dramatic|bokeh|logo|icon|background|backdrop|wallpaper|style|styled)\b`)

var glueWords = map[string]bool{"a": true, "an": true, "the": true, "of": true, "in": true, "on": true, "at": true, "with": true, "and": true}

// routeImageSource mirrors the editor's routing: a short concrete subject
// (five significant words or fewer, no stylized marker) is well served by
// stock photography; everything else is generated.
func routeImageSource(prompt string) string {
	p := strings.TrimSpace(prompt)
	if p == "" || stylizedMarkers.MatchString(p) {
		return "generate"
	}
	n := 0
	for _, w := range strings.Fields(strings.ToLower(p)) {
		if !glueWords[w] {
			n++
		}
	}
	if n <= 5 {
		return "stock"
	}
	return "generate"
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
