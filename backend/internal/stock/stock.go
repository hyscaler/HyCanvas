// Package stock ports the NestJS stock module (doc 13): a global, read-only
// stock catalog (embedded seed of 42 assets + 11 collections), search, per-user
// favorites + recents, and an allowlisted image proxy (SSRF-guarded) so the
// editor places stock from our own origin. Search is a pure port of @hc/stock.
// Insertion to native nodes happens client-side. Assets are opaque JSON.
package stock

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hycanvas/backend/internal/media"
)

//go:embed stock.json
var stockJSON []byte

// The bundled open-licensed asset library (ingested by scripts/ingest-stock.mjs):
// per-pack dirs of raw SVG files plus an index.json with asset metadata, the
// pack license, and a collection entry. Embedded so the single self-host binary
// ships the full library.
//
//go:embed library
var libraryFS embed.FS

// Errors map to RFC 7807 statuses at the HTTP layer.
var (
	ErrNotFound   = errors.New("not found")
	ErrBadRequest = errors.New("bad request")
)

// proxyAllowlist are the hosts the image proxy may fetch from (the seed sources).
var proxyAllowlist = map[string]bool{"picsum.photos": true, "fastly.picsum.photos": true}

const recentsCap = 30

type seedData struct {
	Stock       []map[string]any `json:"stock"`
	Collections []any            `json:"collections"`
}

var seed = func() seedData {
	var d seedData
	_ = json.Unmarshal(stockJSON, &d)
	loadLibrary(&d)
	return d
}()

// loadLibrary appends every bundled library pack to the seed catalog. Each
// asset's SVG is inlined (the client inserts it as editable vectors, same as
// the seeded icons) and enriched with the pack's kind/category/license, so
// search, favorites, recents, and attribution treat packs like any other asset.
func loadLibrary(d *seedData) {
	packs, err := libraryFS.ReadDir("library")
	if err != nil {
		return // no packs bundled yet (before the first ingest run)
	}
	for _, p := range packs {
		if !p.IsDir() {
			continue
		}
		dir := "library/" + p.Name()
		raw, err := libraryFS.ReadFile(dir + "/index.json")
		if err != nil {
			continue
		}
		var idx struct {
			Pack       string           `json:"pack"`
			Kind       string           `json:"kind"`
			Category   string           `json:"category"`
			License    map[string]any   `json:"license"`
			Collection map[string]any   `json:"collection"`
			Assets     []map[string]any `json:"assets"`
		}
		if err := json.Unmarshal(raw, &idx); err != nil {
			continue
		}
		for _, a := range idx.Assets {
			file, _ := a["file"].(string)
			svg, err := libraryFS.ReadFile(dir + "/" + file)
			if err != nil {
				continue
			}
			delete(a, "file")
			a["svg"] = string(svg)
			a["kind"] = idx.Kind
			a["category"] = idx.Category
			a["license"] = idx.License
			a["pack"] = idx.Pack
			a["format"] = "svg"
			a["animated"] = false
			a["previewUrl"] = ""
			a["sourceUrl"] = ""
			a["collectionIds"] = []any{idx.Pack}
			// stockMatches expects style as an array (seed assets use one).
			if s, ok := a["style"].(string); ok {
				a["style"] = []any{s}
			}
			d.Stock = append(d.Stock, a)
		}
		if idx.Collection != nil {
			if idx.Kind != "" {
				idx.Collection["kind"] = idx.Kind
			}
			d.Collections = append(d.Collections, idx.Collection)
		}
	}
}

var stockByID = func() map[string]map[string]any {
	m := map[string]map[string]any{}
	for _, a := range seed.Stock {
		if id, ok := a["id"].(string); ok {
			m[id] = a
		}
	}
	return m
}()

// FacetValue is one value of a filterable facet, scoped to an asset kind so
// the client can offer only the filters that apply to what the user browses.
type FacetValue struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Count int    `json:"count"`
}

// Filters are the catalog's filterable facets, aggregated from the bundled
// assets at init and sorted by count (desc) then id, ready to render as-is.
// New packs, categories, or orientations surface here with no client change.
type Filters struct {
	Categories   []FacetValue `json:"categories"`
	Styles       []FacetValue `json:"styles"`
	Orientations []FacetValue `json:"orientations"`
}

var stockFilters = func() Filters {
	type key struct{ facet, kind, id string }
	counts := map[key]int{}
	for _, a := range seed.Stock {
		kind := str(a["kind"])
		if c := str(a["category"]); c != "" {
			counts[key{"category", kind, c}]++
		}
		if o := str(a["orientation"]); o != "" {
			counts[key{"orientation", kind, o}]++
		}
		for _, v := range arr(a["style"]) {
			if sv := str(v); sv != "" {
				counts[key{"style", kind, sv}]++
			}
		}
	}
	f := Filters{Categories: []FacetValue{}, Styles: []FacetValue{}, Orientations: []FacetValue{}}
	for k, n := range counts {
		v := FacetValue{ID: k.id, Kind: k.kind, Count: n}
		switch k.facet {
		case "category":
			f.Categories = append(f.Categories, v)
		case "style":
			f.Styles = append(f.Styles, v)
		case "orientation":
			f.Orientations = append(f.Orientations, v)
		}
	}
	for _, vs := range [][]FacetValue{f.Categories, f.Styles, f.Orientations} {
		sort.Slice(vs, func(i, j int) bool {
			if vs[i].Count != vs[j].Count {
				return vs[i].Count > vs[j].Count
			}
			return vs[i].ID < vs[j].ID
		})
	}
	return f
}()

// DBTX is the query surface (satisfied by *pgxpool.Pool and pgx.Tx).
type DBTX interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Service is the stock module.
type Service struct {
	db     DBTX
	client *http.Client
	ov     *openverse
}

// NewService wires the stock service.
func NewService(db DBTX) *Service {
	return &Service{
		db:     db,
		client: &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		ov:     newOpenverse(),
	}
}

// Query is the stock search query.
type Query struct {
	Text         string
	Kind         string
	Orientation  string
	Color        string
	Category     string
	Style        string
	CollectionID string
	// Paging: the bundled library is ~10k assets with inline SVG, so responses
	// are always capped. Limit <= 0 uses the default page size.
	Limit  int
	Offset int
}

const (
	defaultSearchLimit = 60
	maxSearchLimit     = 200
)

// --- search (pure port of @hc/stock) -------------------------------------

func textRelevance(a map[string]any, q string) int {
	needle := strings.ToLower(q)
	title := strings.ToLower(str(a["title"]))
	if title == needle {
		return 100
	}
	score := 0
	if strings.Contains(title, needle) {
		score += 50
	}
	for _, t := range arr(a["tags"]) {
		ts := strings.ToLower(str(t))
		if ts == needle {
			score += 20
		} else if strings.Contains(ts, needle) {
			score += 8
		}
	}
	return score
}

func colorMatches(a map[string]any, hex string) bool {
	target, ok := hexToRGB(hex)
	if !ok {
		return false
	}
	for _, c := range arr(a["dominantColors"]) {
		rgb, ok := hexToRGB(str(c))
		if !ok {
			continue
		}
		d := math.Sqrt(math.Pow(rgb[0]-target[0], 2) + math.Pow(rgb[1]-target[1], 2) + math.Pow(rgb[2]-target[2], 2))
		if d <= 70 {
			return true
		}
	}
	return false
}

// browseKindRank orders kinds for browsing: photos and illustrations lead,
// icon packs trail, so an unfiltered browse opens on rich imagery instead of
// thousands of monochrome glyphs.
func browseKindRank(a map[string]any) int {
	switch str(a["kind"]) {
	case "photo":
		return 0
	case "illustration":
		return 1
	case "sticker":
		return 2
	case "icon":
		return 3
	}
	return 4
}

// colorfulness scores an asset's dominant palette: the widest channel spread
// (chroma) across the dominant colors, plus a small bonus per extra vivid
// color. Monochrome assets score 0.
func colorfulness(a map[string]any) float64 {
	best, vivid := 0.0, 0
	for _, c := range arr(a["dominantColors"]) {
		rgb, ok := hexToRGB(str(c))
		if !ok {
			continue
		}
		mx := math.Max(rgb[0], math.Max(rgb[1], rgb[2]))
		mn := math.Min(rgb[0], math.Min(rgb[1], rgb[2]))
		chroma := (mx - mn) / 255
		if chroma > best {
			best = chroma
		}
		if chroma >= 0.25 {
			vivid++
		}
	}
	if vivid > 4 {
		vivid = 4
	}
	return best + 0.05*float64(vivid)
}

func stockMatches(a map[string]any, q Query) bool {
	if q.Text != "" && textRelevance(a, q.Text) == 0 {
		return false
	}
	if q.Kind != "" && str(a["kind"]) != q.Kind {
		return false
	}
	if q.Orientation != "" && str(a["orientation"]) != q.Orientation {
		return false
	}
	if q.Category != "" && str(a["category"]) != q.Category {
		return false
	}
	if q.Color != "" && !colorMatches(a, q.Color) {
		return false
	}
	if q.Style != "" {
		ok := false
		for _, s := range arr(a["style"]) {
			if str(s) == q.Style {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	if q.CollectionID != "" {
		ok := false
		for _, c := range arr(a["collectionIds"]) {
			if str(c) == q.CollectionID {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	return true
}

func searchStock(assets []map[string]any, q Query) []map[string]any {
	var matched []map[string]any
	for _, a := range assets {
		if stockMatches(a, q) {
			matched = append(matched, a)
		}
	}
	if q.Text != "" {
		sort.SliceStable(matched, func(i, j int) bool {
			si, sj := textRelevance(matched[i], q.Text), textRelevance(matched[j], q.Text)
			if si != sj {
				return si > sj
			}
			return str(matched[i]["title"]) < str(matched[j]["title"])
		})
	} else {
		// Browse order (no text to rank by): photos/illustrations before icon
		// packs, most colorful first within a kind. Deterministic (title
		// tiebreak) so offset paging stays stable across requests.
		score := make(map[string]float64, len(matched))
		for _, a := range matched {
			score[str(a["id"])] = colorfulness(a)
		}
		sort.SliceStable(matched, func(i, j int) bool {
			ri, rj := browseKindRank(matched[i]), browseKindRank(matched[j])
			if ri != rj {
				return ri < rj
			}
			si, sj := score[str(matched[i]["id"])], score[str(matched[j]["id"])]
			if si != sj {
				return si > sj
			}
			return str(matched[i]["title"]) < str(matched[j]["title"])
		})
	}
	// Page the ranked results (see Query.Limit): an unbounded response over the
	// bundled library would ship megabytes of inline SVG per request.
	limit := q.Limit
	if limit <= 0 {
		limit = defaultSearchLimit
	}
	if limit > maxSearchLimit {
		limit = maxSearchLimit
	}
	offset := q.Offset
	if offset < 0 {
		offset = 0
	}
	if offset >= len(matched) {
		return nil
	}
	if end := offset + limit; end < len(matched) {
		return matched[offset:end]
	}
	return matched[offset:]
}

// --- public API ----------------------------------------------------------

// Search returns matching catalog assets, each flagged with the user's favorite.
// Text photo searches go to the live Openverse provider (open-licensed, results
// commercially safe); everything else, and any provider failure, is served from
// the bundled catalog. Facet filters (category, style, orientation, color) are
// bundled-only: the provider can't apply them, so an active facet keeps the
// search local rather than returning results that silently ignore it.
func (s *Service) Search(ctx context.Context, q Query, userID string) ([]map[string]any, error) {
	if q.Kind == "photo" && strings.TrimSpace(q.Text) != "" && q.CollectionID == "" &&
		q.Category == "" && q.Style == "" && q.Orientation == "" && q.Color == "" {
		if live := s.ov.search(ctx, q); live != nil {
			return s.withFlags(ctx, live, userID)
		}
	}
	return s.withFlags(ctx, searchStock(seed.Stock, q), userID)
}

// Get returns one catalog asset.
func (s *Service) Get(id string) (map[string]any, error) {
	a, ok := stockByID[id]
	if !ok {
		return nil, ErrNotFound
	}
	return a, nil
}

// Collections returns the curated catalog collections.
func (s *Service) Collections() []any { return seed.Collections }

// Filters returns the filterable facets of the bundled catalog.
func (s *Service) Filters() Filters { return stockFilters }

// ToggleFavorite flips the user's favorite on a stock asset.
func (s *Service) ToggleFavorite(ctx context.Context, userID, stockID string) (bool, error) {
	if _, ok := stockByID[stockID]; !ok {
		return false, ErrNotFound
	}
	isFav, err := s.isFavorite(ctx, userID, stockID)
	if err != nil {
		return false, err
	}
	if isFav {
		return false, s.removeFavorite(ctx, userID, stockID)
	}
	return true, s.addFavorite(ctx, userID, stockID)
}

// ListFavorites returns the user's favorited assets (newest first).
func (s *Service) ListFavorites(ctx context.Context, userID string) ([]map[string]any, error) {
	ids, err := s.favoriteIDs(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for _, id := range ids {
		if a, ok := stockByID[id]; ok {
			out = append(out, withFlag(a, true))
		}
	}
	return out, nil
}

// RecordRecent records a stock asset as recently used (on insertion).
func (s *Service) RecordRecent(ctx context.Context, userID, stockID string) error {
	if _, ok := stockByID[stockID]; !ok {
		return ErrNotFound
	}
	return s.recordRecent(ctx, userID, stockID, recentsCap)
}

// ListRecents returns the user's recently-used assets (most recent first).
func (s *Service) ListRecents(ctx context.Context, userID string) ([]map[string]any, error) {
	ids, err := s.recentIDs(ctx, userID)
	if err != nil {
		return nil, err
	}
	var assets []map[string]any
	for _, id := range ids {
		if a, ok := stockByID[id]; ok {
			assets = append(assets, a)
		}
	}
	return s.withFlags(ctx, assets, userID)
}

func (s *Service) withFlags(ctx context.Context, assets []map[string]any, userID string) ([]map[string]any, error) {
	out := make([]map[string]any, 0, len(assets))
	if userID == "" {
		for _, a := range assets {
			out = append(out, withFlag(a, false))
		}
		return out, nil
	}
	ids, err := s.favoriteIDs(ctx, userID)
	if err != nil {
		return nil, err
	}
	fav := map[string]bool{}
	for _, id := range ids {
		fav[id] = true
	}
	for _, a := range assets {
		out = append(out, withFlag(a, fav[str(a["id"])]))
	}
	return out, nil
}

func withFlag(a map[string]any, favorited bool) map[string]any {
	out := make(map[string]any, len(a)+1)
	for k, v := range a {
		out[k] = v
	}
	out["favorited"] = favorited
	return out
}

// Proxy fetches an allowlisted stock image server-side (SSRF-guarded, redirects
// re-validated each hop) and returns its bytes + mime.
func (s *Service) Proxy(rawURL string) ([]byte, string, error) {
	const maxBytes = 15 * 1024 * 1024
	u := rawURL
	for hop := 0; hop < 4; hop++ {
		if !s.proxyURLAllowed(u) {
			return nil, "", ErrBadRequest
		}
		res, err := s.client.Get(u)
		if err != nil {
			return nil, "", ErrNotFound
		}
		if res.StatusCode >= 300 && res.StatusCode < 400 {
			loc := res.Header.Get("location")
			res.Body.Close()
			if loc == "" {
				return nil, "", ErrNotFound
			}
			next, err := resolveRef(u, loc)
			if err != nil {
				return nil, "", ErrBadRequest
			}
			u = next
			continue
		}
		defer res.Body.Close()
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			return nil, "", ErrNotFound
		}
		mime := res.Header.Get("content-type")
		if mime == "" {
			mime = "image/jpeg"
		}
		if !strings.HasPrefix(mime, "image/") {
			return nil, "", ErrBadRequest
		}
		if cl, err := strconv.ParseInt(res.Header.Get("content-length"), 10, 64); err == nil && cl > maxBytes {
			return nil, "", ErrBadRequest
		}
		bytes, err := io.ReadAll(io.LimitReader(res.Body, maxBytes+1))
		if err != nil || int64(len(bytes)) > maxBytes {
			return nil, "", ErrBadRequest
		}
		return bytes, mime, nil
	}
	return nil, "", ErrBadRequest
}

// proxyURLAllowed enforces https + an allowlisted, non-private host.
func (s *Service) proxyURLAllowed(raw string) bool {
	p := media.ParseURL(raw)
	if p == nil || p.Scheme != "https" || p.Host == "" {
		return false
	}
	if media.IsPrivateIP(p.Host) {
		return false
	}
	return proxyAllowlist[p.Host]
}

func resolveRef(base, ref string) (string, error) {
	b, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	r, err := url.Parse(ref)
	if err != nil {
		return "", err
	}
	return b.ResolveReference(r).String(), nil
}

// --- tiny accessors ------------------------------------------------------

func str(v any) string { s, _ := v.(string); return s }
func arr(v any) []any  { a, _ := v.([]any); return a }

func hexToRGB(hex string) ([3]float64, bool) {
	h := strings.TrimPrefix(hex, "#")
	if len(h) < 6 {
		return [3]float64{}, false
	}
	parse := func(s string) (float64, bool) {
		n, err := strconv.ParseInt(s, 16, 0)
		if err != nil {
			return 0, false
		}
		return float64(n), true
	}
	r, ok1 := parse(h[0:2])
	g, ok2 := parse(h[2:4])
	b, ok3 := parse(h[4:6])
	if !ok1 || !ok2 || !ok3 {
		return [3]float64{}, false
	}
	return [3]float64{r, g, b}, true
}
