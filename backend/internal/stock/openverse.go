package stock

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Openverse is queried on the anonymous tier (no key), which is rate limited;
// the TTL cache below absorbs repeat searches so browsing the same query does
// not burn the shared allowance.
const (
	ovBaseURL  = "https://api.openverse.org"
	ovCacheTTL = 10 * time.Minute
	ovCacheCap = 100
)

// ovLicenseTypes maps the only Openverse licenses we accept to the catalog
// license types. cc0/pdm/by keep placed photos commercially safe with at most
// attribution; share-alike and non-commercial variants are never requested,
// and the mapper drops them again in case the endpoint misbehaves.
var ovLicenseTypes = map[string]string{"cc0": "cc0", "pdm": "public-domain", "by": "cc-by"}

// openverse is the live photo provider. It complements the bundled seed: on
// any failure search returns nil and the caller serves the seed instead, so a
// slow or unreachable provider never breaks stock search.
type openverse struct {
	enabled bool
	baseURL string // swapped for an httptest server in tests
	client  *http.Client
	mu      sync.Mutex
	cache   map[string]ovCacheEntry
}

type ovCacheEntry struct {
	assets  []map[string]any
	fetched time.Time
}

// newOpenverse wires the provider. STOCK_PHOTO_PROVIDER=off disables live
// search entirely (bundled catalog only, e.g. air-gapped self-hosts).
func newOpenverse() *openverse {
	return &openverse{
		enabled: os.Getenv("STOCK_PHOTO_PROVIDER") != "off",
		baseURL: ovBaseURL,
		client:  &http.Client{Timeout: 8 * time.Second},
		cache:   map[string]ovCacheEntry{},
	}
}

// ovResult is the subset of an Openverse image record the catalog needs.
type ovResult struct {
	ID                string `json:"id"`
	Title             string `json:"title"`
	URL               string `json:"url"`
	Thumbnail         string `json:"thumbnail"`
	Width             int    `json:"width"`
	Height            int    `json:"height"`
	License           string `json:"license"`
	Attribution       string `json:"attribution"`
	ForeignLandingURL string `json:"foreign_landing_url"`
	Creator           string `json:"creator"`
	Tags              []struct {
		Name string `json:"name"`
	} `json:"tags"`
}

// search queries Openverse for photos matching q.Text, paged with the same
// limit rules as searchStock. It returns nil on any failure (disabled,
// network error, non-200, decode error): callers fall back to the seed.
func (o *openverse) search(ctx context.Context, q Query) []map[string]any {
	if o == nil || !o.enabled {
		return nil
	}
	limit := q.Limit
	if limit <= 0 {
		limit = defaultSearchLimit
	}
	if limit > maxSearchLimit {
		limit = maxSearchLimit
	}
	// Openverse pages are 1-based; translate the catalog's offset paging.
	page := 1 + q.Offset/limit
	if q.Offset < 0 {
		page = 1
	}
	key := q.Text + "|" + strconv.Itoa(page) + "|" + strconv.Itoa(limit)
	if assets, ok := o.cacheGet(key); ok {
		return assets
	}
	v := url.Values{}
	v.Set("q", q.Text)
	v.Set("license", "cc0,pdm,by")
	v.Set("page_size", strconv.Itoa(limit))
	v.Set("page", strconv.Itoa(page))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, o.baseURL+"/v1/images/?"+v.Encode(), nil)
	if err != nil {
		return nil
	}
	// Openverse asks anonymous clients to identify themselves.
	req.Header.Set("User-Agent", "HyCanvas/1.0 (self-hosted; https://github.com/hyscaler/hycanvas)")
	res, err := o.client.Do(req)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil
	}
	var body struct {
		Results []ovResult `json:"results"`
	}
	// A page is small; cap the read so a misbehaving endpoint cannot balloon memory.
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&body); err != nil {
		return nil
	}
	var assets []map[string]any
	for _, r := range body.Results {
		if a := o.toAsset(r); a != nil {
			assets = append(assets, a)
		}
	}
	o.cachePut(key, assets)
	return assets
}

// toAsset maps one Openverse record to the catalog asset shape produced by
// loadLibrary, so search results mix transparently with the seed. Records
// without a source URL or outside ovLicenseTypes are dropped: the request
// already filters licenses, but the response is never trusted.
func (o *openverse) toAsset(r ovResult) map[string]any {
	licType, ok := ovLicenseTypes[r.License]
	if !ok || r.URL == "" {
		return nil
	}
	title := r.Title
	if title == "" {
		title = "Photo"
	}
	tags := make([]any, 0, len(r.Tags)+1)
	seen := map[string]bool{}
	for _, t := range r.Tags {
		if len(tags) == 8 {
			break
		}
		name := strings.ToLower(t.Name)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		tags = append(tags, name)
	}
	if !seen["photo"] {
		tags = append(tags, "photo")
	}
	// Only trust thumbnails Openverse hosts itself; anything else (or an
	// unparsable value) is replaced with the canonical thumbnail endpoint.
	preview := r.Thumbnail
	if p, err := url.Parse(r.Thumbnail); err != nil || p.Host != "api.openverse.org" {
		preview = o.baseURL + "/v1/images/" + r.ID + "/thumbnail/"
	}
	return map[string]any{
		"id":             "ov-" + r.ID,
		"kind":           "photo",
		"title":          title,
		"tags":           tags,
		"previewUrl":     preview,
		"sourceUrl":      r.URL,
		"width":          float64(r.Width),
		"height":         float64(r.Height),
		"format":         "jpg",
		"animated":       false,
		"dominantColors": []any{},
		"collectionIds":  []any{"openverse"},
		"pack":           "openverse",
		"category":       "photos",
		"license": map[string]any{
			"type":                licType,
			"holder":              r.Creator,
			"attributionRequired": r.License == "by",
			"attributionText":     r.Attribution,
			"attributionUrl":      r.ForeignLandingURL,
		},
	}
}

func (o *openverse) cacheGet(key string) ([]map[string]any, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	e, ok := o.cache[key]
	if !ok || time.Since(e.fetched) > ovCacheTTL {
		return nil, false
	}
	return e.assets, true
}

// cachePut stores a fetched page. The cache is bounded at ovCacheCap entries:
// expired entries go first, then the oldest, so a burst of distinct queries
// cannot grow the map without limit.
func (o *openverse) cachePut(key string, assets []map[string]any) {
	o.mu.Lock()
	defer o.mu.Unlock()
	now := time.Now()
	if len(o.cache) >= ovCacheCap {
		for k, e := range o.cache {
			if now.Sub(e.fetched) > ovCacheTTL {
				delete(o.cache, k)
			}
		}
	}
	for len(o.cache) >= ovCacheCap {
		oldest := ""
		for k, e := range o.cache {
			if oldest == "" || e.fetched.Before(o.cache[oldest].fetched) {
				oldest = k
			}
		}
		delete(o.cache, oldest)
	}
	o.cache[key] = ovCacheEntry{assets: assets, fetched: now}
}
