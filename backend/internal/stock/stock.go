// Package stock ports the NestJS stock module (doc 13): a global, read-only
// stock catalog (embedded seed of 42 assets + 11 collections), search, per-user
// favorites + recents, and an allowlisted image proxy (SSRF-guarded) so the
// editor places stock from our own origin. Search is a pure port of @hc/stock.
// Insertion to native nodes happens client-side. Assets are opaque JSON.
package stock

import (
	"context"
	_ "embed"
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
	return d
}()

var stockByID = func() map[string]map[string]any {
	m := map[string]map[string]any{}
	for _, a := range seed.Stock {
		if id, ok := a["id"].(string); ok {
			m[id] = a
		}
	}
	return m
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
}

// NewService wires the stock service.
func NewService(db DBTX) *Service {
	return &Service{db: db, client: &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
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
}

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
	if q.Text == "" {
		return matched
	}
	sort.SliceStable(matched, func(i, j int) bool {
		si, sj := textRelevance(matched[i], q.Text), textRelevance(matched[j], q.Text)
		if si != sj {
			return si > sj
		}
		return str(matched[i]["title"]) < str(matched[j]["title"])
	})
	return matched
}

// --- public API ----------------------------------------------------------

// Search returns matching catalog assets, each flagged with the user's favorite.
func (s *Service) Search(ctx context.Context, q Query, userID string) ([]map[string]any, error) {
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
