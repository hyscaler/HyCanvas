package stock

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Iconify (api.iconify.design) is a keyless, open aggregator of 200,000+ icons
// across 200+ open-source sets. It is queried on the anonymous tier; the TTL
// cache below absorbs repeat searches. Icons come back as raw SVG path bodies
// which we assemble into inline, recolorable SVG (fill="currentColor"), so the
// editor can retint them like any other vector asset. Each set's SPDX license
// is read once from the collections endpoint and stamped onto every icon it
// produces, feeding the design's attribution/provenance system.
const (
	iconifyBaseURL    = "https://api.iconify.design"
	iconifyCacheTTL   = 30 * time.Minute
	iconifyCacheCap   = 100
	iconifyMaxSets    = 12 // distinct prefixes fetched per search (bounds upstream calls)
	iconifyLicenseTTL = 24 * time.Hour
	// After a failed /collections fetch, wait this long before retrying so a
	// license-endpoint outage doesn't block every icon search on the client
	// timeout. Icon search serves the bundled seed until licenses load.
	iconifyLicenseRetry = 5 * time.Minute
)

// setLicense is one icon set's licensing, from /collections.
type setLicense struct {
	title string // e.g. "Apache 2.0"
	spdx  string // e.g. "Apache-2.0"
	url   string
}

type icCacheEntry struct {
	assets  []map[string]any
	fetched time.Time
}

type iconify struct {
	enabled bool
	baseURL string
	client  *http.Client

	mu    sync.Mutex
	cache map[string]icCacheEntry

	licMu        sync.Mutex
	licenses     map[string]setLicense // prefix -> license
	licFetched   time.Time             // last successful load
	licAttempted time.Time             // last fetch attempt (success or failure), for negative-cache backoff
}

// newIconify wires the provider. STOCK_ICON_PROVIDER=off disables live icon
// search entirely (bundled catalog only, e.g. air-gapped self-hosts).
func newIconify() *iconify {
	return &iconify{
		enabled: os.Getenv("STOCK_ICON_PROVIDER") != "off",
		baseURL: iconifyBaseURL,
		client:  &http.Client{Timeout: 8 * time.Second},
		cache:   map[string]icCacheEntry{},
	}
}

// handles reports whether this provider actively serves the given kind. A
// disabled provider reports false so callers treat it as absent and serve the
// bundled catalog, instead of a live-capable kind that produces nothing.
func (i *iconify) handles(kind string) bool { return i != nil && i.enabled && kind == "icon" }

// search queries Iconify for icons matching q.Text, assembles inline SVG for
// each, and returns catalog-shaped assets. Returns nil on any failure so the
// caller serves the bundled seed instead.
func (i *iconify) search(ctx context.Context, q Query) []map[string]any {
	if i == nil || !i.enabled {
		return nil
	}
	limit := q.Limit
	if limit <= 0 {
		limit = defaultSearchLimit
	}
	if limit > maxSearchLimit {
		limit = maxSearchLimit
	}
	key := q.Text + "|" + strconv.Itoa(limit) + "|" + strconv.Itoa(q.Offset)
	if assets, ok := i.cacheGet(key); ok {
		return assets
	}

	// 1. search -> ordered list of "prefix:name" icon ids.
	v := url.Values{}
	v.Set("query", q.Text)
	// Fetch a bit beyond the page so grouping/assembly still fills it after any
	// icon that fails to resolve; the offset is applied to the assembled list.
	v.Set("limit", strconv.Itoa(min(limit+q.Offset+20, 120)))
	names := i.getJSONNames(ctx, i.baseURL+"/search?"+v.Encode())
	if len(names) == 0 {
		return nil
	}

	// 2. group ids by set prefix, preserving first-seen order of both.
	order := []string{}
	byPrefix := map[string][]string{}
	for _, id := range names {
		prefix, name, ok := strings.Cut(id, ":")
		if !ok || prefix == "" || name == "" {
			continue
		}
		if _, seen := byPrefix[prefix]; !seen {
			if len(order) >= iconifyMaxSets {
				continue // bound the number of upstream set fetches
			}
			order = append(order, prefix)
		}
		byPrefix[prefix] = append(byPrefix[prefix], name)
	}

	// 3. fetch each set's icon bodies in bulk and assemble inline SVG.
	i.ensureLicenses(ctx)
	// Without the license map we cannot label attribution correctly (a CC-BY set
	// would look attribution-free), so don't serve unverified icons: return nil
	// and let the caller fall back to the bundled seed (whose licenses are known).
	i.licMu.Lock()
	haveLicenses := i.licenses != nil
	i.licMu.Unlock()
	if !haveLicenses {
		return nil
	}
	built := map[string]map[string]any{} // id -> asset
	for _, prefix := range order {
		for id, a := range i.fetchSet(ctx, prefix, byPrefix[prefix]) {
			built[id] = a
		}
	}
	if len(built) == 0 {
		return nil
	}

	// 4. emit in search-result order (relevance), applying offset + limit.
	// Cap the capacity hint by how many results actually exist, so the
	// allocation can never exceed the real result set even if limit were large
	// (it is already clamped to maxSearchLimit above; this keeps the bound local
	// and obvious at the allocation site).
	capHint := limit
	if capHint > len(built) {
		capHint = len(built)
	}
	assets := make([]map[string]any, 0, capHint)
	skipped := 0
	for _, id := range names {
		a, ok := built[id]
		if !ok {
			continue
		}
		if skipped < q.Offset {
			skipped++
			continue
		}
		assets = append(assets, a)
		if len(assets) >= limit {
			break
		}
	}
	i.cachePut(key, assets)
	return assets
}

// getJSONNames GETs a search response and returns its icon id list.
func (i *iconify) getJSONNames(ctx context.Context, u string) []string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("User-Agent", "HyCanvas/1.0 (self-hosted; https://github.com/hyscaler/hycanvas)")
	res, err := i.client.Do(req)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil
	}
	var body struct {
		Icons []string `json:"icons"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 2<<20)).Decode(&body); err != nil {
		return nil
	}
	return body.Icons
}

// icSet is the subset of a /{prefix}.json bulk response we assemble SVG from.
type icSet struct {
	Prefix string `json:"prefix"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Icons  map[string]struct {
		Body   string `json:"body"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
	} `json:"icons"`
}

// fetchSet bulk-fetches the given icon names from one set and returns assembled
// assets keyed by "prefix:name". Any failure yields an empty map (search then
// falls back to the seed if nothing at all resolves).
func (i *iconify) fetchSet(ctx context.Context, prefix string, names []string) map[string]map[string]any {
	out := map[string]map[string]any{}
	if len(names) == 0 {
		return out
	}
	v := url.Values{}
	v.Set("icons", strings.Join(names, ","))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, i.baseURL+"/"+url.PathEscape(prefix)+".json?"+v.Encode(), nil)
	if err != nil {
		return out
	}
	req.Header.Set("User-Agent", "HyCanvas/1.0 (self-hosted; https://github.com/hyscaler/hycanvas)")
	res, err := i.client.Do(req)
	if err != nil {
		return out
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return out
	}
	var set icSet
	if err := json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(&set); err != nil {
		return out
	}
	lic := i.licenseFor(prefix)
	for name, ic := range set.Icons {
		w, h := ic.Width, ic.Height
		if w == 0 {
			w = set.Width
		}
		if h == 0 {
			h = set.Height
		}
		if w == 0 {
			w = 24
		}
		if h == 0 {
			h = 24
		}
		if strings.TrimSpace(ic.Body) == "" {
			continue
		}
		out[prefix+":"+name] = i.toAsset(prefix, name, ic.Body, w, h, lic)
	}
	return out
}

// toAsset builds a catalog asset (with inline, recolorable SVG) from one icon.
func (i *iconify) toAsset(prefix, name, body string, w, h int, lic setLicense) map[string]any {
	svg := fmt.Sprintf(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d">%s</svg>`,
		w, h, w, h, body,
	)
	title := strings.ReplaceAll(name, "-", " ")
	// Tags: the set prefix, the words in the name, and the kind, deduped.
	tags := []any{}
	seen := map[string]bool{}
	addTag := func(t string) {
		t = strings.ToLower(strings.TrimSpace(t))
		if t == "" || seen[t] || len(tags) >= 8 {
			return
		}
		seen[t] = true
		tags = append(tags, t)
	}
	addTag(prefix)
	for _, part := range strings.FieldsFunc(name, func(r rune) bool { return r == '-' || r == '_' }) {
		addTag(part)
	}
	addTag("icon")
	licType := "open"
	if lic.spdx != "" {
		licType = lic.spdx
	}
	attrText := lic.title
	if attrText == "" {
		attrText = "Iconify (" + prefix + ")"
	}
	// A set present in the license map but with a blank SPDX has an unverified
	// license; be conservative and require attribution rather than assume it is
	// attribution-free (search() already refuses to serve icons when the whole
	// license map is unavailable).
	attributionRequired := lic.spdx == "" || requiresAttribution(lic.spdx)
	attrURL := lic.url
	if attrURL == "" {
		attrURL = "https://icon-sets.iconify.design/" + prefix + "/" + name + "/"
	}
	return map[string]any{
		"id":             "iconify-" + prefix + "-" + name,
		"kind":           "icon",
		"title":          title,
		"tags":           tags,
		"previewUrl":     i.baseURL + "/" + prefix + "/" + name + ".svg",
		"sourceUrl":      "https://icon-sets.iconify.design/" + prefix + "/" + name + "/",
		"width":          float64(w),
		"height":         float64(h),
		"format":         "svg",
		"animated":       false,
		"svg":            svg,
		"dominantColors": []any{},
		"collectionIds":  []any{"iconify", "iconify:" + prefix},
		"pack":           "iconify:" + prefix,
		"category":       "icons",
		// live marks an upstream-provider asset (not in the bundled catalog):
		// favorites/recents don't apply and drag-to-canvas is disabled (the icon
		// inserts as inline-SVG vector on click, not as a proxied image URL).
		"live": true,
		// Open-source icon sets are commercially usable; a handful (Apache/MIT/
		// ISC/CC-BY) ask for attribution, which the provenance layer records.
		"license": map[string]any{
			"type":                licType,
			"holder":              lic.title,
			"attributionRequired": attributionRequired,
			"attributionText":     attrText,
			"attributionUrl":      attrURL,
		},
	}
}

// requiresAttribution is true for icon-set licenses that ask for a credit.
// Permissive licenses (MIT/ISC/Apache/BSD) do not require notice on rendered
// output; CC-BY does. A blank SPDX returns false here, but toAsset treats a
// blank/unknown set license conservatively (attribution required) so an
// unverified set is never served as attribution-free.
func requiresAttribution(spdx string) bool {
	return strings.HasPrefix(strings.ToUpper(spdx), "CC-BY")
}

// ensureLicenses lazily loads (and refreshes) the per-set license map from the
// collections endpoint. Failure leaves the map empty; icons still resolve with
// an "open" placeholder license and a source link.
func (i *iconify) ensureLicenses(ctx context.Context) {
	i.licMu.Lock()
	loaded := i.licenses != nil && time.Since(i.licFetched) < iconifyLicenseTTL
	backingOff := i.licenses == nil && time.Since(i.licAttempted) < iconifyLicenseRetry
	if loaded || backingOff {
		i.licMu.Unlock()
		return
	}
	// Record the attempt up front so a failing endpoint backs off instead of
	// being retried (and blocking on the client timeout) on every search.
	i.licAttempted = time.Now()
	i.licMu.Unlock()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, i.baseURL+"/collections", nil)
	if err != nil {
		return
	}
	req.Header.Set("User-Agent", "HyCanvas/1.0 (self-hosted; https://github.com/hyscaler/hycanvas)")
	res, err := i.client.Do(req)
	if err != nil {
		return
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return
	}
	var raw map[string]struct {
		License struct {
			Title string `json:"title"`
			SPDX  string `json:"spdx"`
			URL   string `json:"url"`
		} `json:"license"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(&raw); err != nil {
		return
	}
	m := make(map[string]setLicense, len(raw))
	for prefix, c := range raw {
		m[prefix] = setLicense{title: c.License.Title, spdx: c.License.SPDX, url: c.License.URL}
	}
	i.licMu.Lock()
	i.licenses = m
	i.licFetched = time.Now()
	i.licMu.Unlock()
}

func (i *iconify) licenseFor(prefix string) setLicense {
	i.licMu.Lock()
	defer i.licMu.Unlock()
	return i.licenses[prefix]
}

func (i *iconify) cacheGet(key string) ([]map[string]any, bool) {
	i.mu.Lock()
	defer i.mu.Unlock()
	e, ok := i.cache[key]
	if !ok || time.Since(e.fetched) > iconifyCacheTTL {
		return nil, false
	}
	return e.assets, true
}

func (i *iconify) cachePut(key string, assets []map[string]any) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if len(i.cache) >= iconifyCacheCap {
		// Drop expired first, then the oldest, so a burst of distinct queries
		// cannot grow the map without bound.
		var oldestKey string
		var oldest time.Time
		for k, e := range i.cache {
			if time.Since(e.fetched) > iconifyCacheTTL {
				delete(i.cache, k)
			}
		}
		if len(i.cache) >= iconifyCacheCap {
			first := true
			for k, e := range i.cache {
				if first || e.fetched.Before(oldest) {
					oldestKey, oldest, first = k, e.fetched, false
				}
			}
			if oldestKey != "" {
				delete(i.cache, oldestKey)
			}
		}
	}
	i.cache[key] = icCacheEntry{assets: assets, fetched: time.Now()}
}
