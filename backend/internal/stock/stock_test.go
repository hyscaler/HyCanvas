package stock

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
)

func stripSchema(dsn string) string {
	for _, sep := range []string{"?schema=", "&schema="} {
		if i := strings.Index(dsn, sep); i >= 0 {
			return dsn[:i]
		}
	}
	return dsn
}

func TestSeedAndSearch(t *testing.T) {
	if len(seed.Stock) < 10 || len(seed.Collections) < 1 {
		t.Fatalf("seed not loaded: %d assets, %d collections", len(seed.Stock), len(seed.Collections))
	}
	// Empty query returns the default page (results are always capped: the
	// bundled library holds thousands of assets with inline SVG).
	if got := searchStock(seed.Stock, Query{}); len(got) != defaultSearchLimit {
		t.Fatalf("empty query should return the default page: %d", len(got))
	}
	// Paging: an explicit limit is honored, absurd limits cap, offset walks and
	// falls off the end cleanly.
	if got := searchStock(seed.Stock, Query{Limit: 5, Offset: 2}); len(got) != 5 {
		t.Fatalf("limit 5 should return 5: %d", len(got))
	}
	if got := searchStock(seed.Stock, Query{Limit: 100000}); len(got) != maxSearchLimit {
		t.Fatalf("limit should cap at %d: %d", maxSearchLimit, len(got))
	}
	if got := searchStock(seed.Stock, Query{Offset: len(seed.Stock) + 1}); len(got) != 0 {
		t.Fatalf("offset past the end should return nothing: %d", len(got))
	}
	// A kind filter narrows results and only returns that kind.
	photos := searchStock(seed.Stock, Query{Kind: "photo"})
	if len(photos) == 0 {
		t.Fatal("expected some photo assets")
	}
	for _, a := range photos {
		if str(a["kind"]) != "photo" {
			t.Fatalf("kind filter leaked: %v", a["kind"])
		}
	}
	// proxyURLAllowed: allowlisted https host ok; others rejected.
	s := &Service{}
	if !s.proxyURLAllowed("https://picsum.photos/id/1/600") {
		t.Fatal("allowlisted host should pass")
	}
	if s.proxyURLAllowed("https://evil.example.com/x.png") || s.proxyURLAllowed("http://picsum.photos/x") {
		t.Fatal("non-allowlisted host / non-https should be rejected")
	}
}

// TestBundledLibrary covers the ingested open-licensed packs (scripts/
// ingest-stock.mjs): they load at init, are searchable, carry inline SVG for
// editable-vector insertion, and license metadata flows through for attribution.
func TestBundledLibrary(t *testing.T) {
	if len(seed.Stock) < 5000 {
		t.Fatalf("bundled library not loaded: %d assets", len(seed.Stock))
	}
	// A Tabler icon is findable by text and carries sane fields.
	hearts := searchStock(seed.Stock, Query{Text: "heart", Kind: "icon"})
	if len(hearts) == 0 {
		t.Fatal("expected tabler heart icons")
	}
	a := hearts[0]
	svg := str(a["svg"])
	if !strings.HasPrefix(svg, "<svg") || !strings.Contains(svg, "xmlns=") {
		t.Fatalf("library asset missing inline svg: %q", svg[:min(len(svg), 60)])
	}
	if strings.Contains(strings.ToLower(svg), "<script") {
		t.Fatal("library svg must be sanitized")
	}
	// Twemoji assets require attribution and say so in their license metadata.
	emoji := searchStock(seed.Stock, Query{Text: "grinning", Kind: "sticker"})
	if len(emoji) == 0 {
		t.Fatal("expected twemoji grinning face")
	}
	lic, _ := emoji[0]["license"].(map[string]any)
	if lic == nil || lic["attributionRequired"] != true {
		t.Fatalf("twemoji license must require attribution: %v", emoji[0]["license"])
	}
	// Pack collections exist and the collection filter scopes to the pack.
	inPack := searchStock(seed.Stock, Query{CollectionID: "twemoji", Limit: maxSearchLimit})
	if len(inPack) == 0 {
		t.Fatal("expected twemoji collection results")
	}
	for _, e := range inPack {
		if str(e["pack"]) != "twemoji" {
			t.Fatalf("collection filter leaked: %v", e["pack"])
		}
	}
	// The illustration packs (opendoodles, openpeeps, lukaszadam,
	// illlustrations) load and the kind filter reaches all of them.
	illos := searchStock(seed.Stock, Query{Kind: "illustration", Limit: maxSearchLimit, Offset: 0})
	illos = append(illos, searchStock(seed.Stock, Query{Kind: "illustration", Limit: maxSearchLimit, Offset: maxSearchLimit})...)
	if len(illos) < 300 {
		t.Fatalf("expected the illustration packs to load: %d", len(illos))
	}
	packs := map[string]bool{}
	for _, a := range illos {
		packs[str(a["pack"])] = true
		if lic, _ := a["license"].(map[string]any); lic == nil || lic["attributionRequired"] != false {
			t.Fatalf("illustrations are CC0/MIT, no attribution: %v", a["license"])
		}
	}
	for _, p := range []string{"opendoodles", "openpeeps", "lukaszadam", "illlustrations"} {
		if !packs[p] {
			t.Fatalf("illustration pack missing from kind filter: %s (got %v)", p, packs)
		}
	}
	// No library SVG may carry a <style> block: inline previews would leak its
	// class rules document-wide (the ingest inlines them per element).
	for _, a := range seed.Stock {
		if svg := str(a["svg"]); svg != "" && strings.Contains(strings.ToLower(svg), "<style") {
			t.Fatalf("library svg with document-global <style>: %v", a["id"])
		}
	}
	// Every library asset id is unique across the whole catalog.
	if len(stockByID) != len(seed.Stock) {
		t.Fatalf("duplicate asset ids: %d unique of %d", len(stockByID), len(seed.Stock))
	}
}

// TestBrowseOrder covers the no-text browse ranking: photos and illustrations
// lead, icon packs trail, colorful before monochrome within a kind, and the
// order is deterministic so offset paging never overlaps.
func TestBrowseOrder(t *testing.T) {
	got := searchStock(seed.Stock, Query{Limit: maxSearchLimit})
	if len(got) == 0 || str(got[0]["kind"]) != "photo" {
		t.Fatalf("browse should open on photos: %v", got[0]["kind"])
	}
	prevRank, prevScore := 0, math.Inf(1)
	for _, a := range got {
		r := browseKindRank(a)
		if r < prevRank {
			t.Fatalf("kind precedence violated at %v", a["id"])
		}
		s := colorfulness(a)
		if r == prevRank && s > prevScore+1e-9 {
			t.Fatalf("colorfulness order violated at %v", a["id"])
		}
		prevRank, prevScore = r, s
	}
	// Deterministic paging: consecutive pages never overlap.
	p1 := searchStock(seed.Stock, Query{Limit: 60})
	p2 := searchStock(seed.Stock, Query{Limit: 60, Offset: 60})
	seen := map[string]bool{}
	for _, a := range p1 {
		seen[str(a["id"])] = true
	}
	for _, a := range p2 {
		if seen[str(a["id"])] {
			t.Fatalf("page overlap: %v", a["id"])
		}
	}
	// A text query still ranks by relevance, not browse order.
	hearts := searchStock(seed.Stock, Query{Text: "heart"})
	if len(hearts) == 0 || textRelevance(hearts[0], "heart") == 0 {
		t.Fatal("text search must rank by relevance")
	}
}

// TestFilters covers the facet aggregation the filter UI is built from: every
// value is kind-scoped with a real count, the known catalog facets are present,
// and a facet filter narrows search to exactly that facet.
func TestFilters(t *testing.T) {
	f := (&Service{}).Filters()
	find := func(vs []FacetValue, kind, id string) *FacetValue {
		for i := range vs {
			if vs[i].Kind == kind && vs[i].ID == id {
				return &vs[i]
			}
		}
		return nil
	}
	// Icon styles: line (seed icons), outline + filled (the tabler packs).
	for _, style := range []string{"line", "outline", "filled"} {
		if v := find(f.Styles, "icon", style); v == nil || v.Count == 0 {
			t.Fatalf("missing icon style facet %q: %+v", style, f.Styles)
		}
	}
	// Pack categories surface under their pack's kind.
	if v := find(f.Categories, "icon", "health"); v == nil || v.Count < 500 {
		t.Fatalf("healthicons category facet missing or undercounted: %+v", v)
	}
	if find(f.Categories, "sticker", "emoji") == nil {
		t.Fatal("emoji category facet missing")
	}
	if find(f.Categories, "illustration", "characters") == nil {
		t.Fatal("characters category facet missing")
	}
	// Seed photos carry an orientation.
	if find(f.Orientations, "photo", "landscape") == nil {
		t.Fatal("landscape orientation facet missing")
	}
	// Values arrive sorted by count desc so clients render them as-is.
	for i := 1; i < len(f.Categories); i++ {
		if f.Categories[i-1].Count < f.Categories[i].Count {
			t.Fatal("categories must be sorted by count desc")
		}
	}
	// A style filter scopes search to exactly the assets carrying that style.
	filled := searchStock(seed.Stock, Query{Kind: "icon", Style: "filled", Limit: maxSearchLimit})
	if len(filled) == 0 {
		t.Fatal("expected filled-style icons")
	}
	for _, a := range filled {
		if str(a["pack"]) != "tabler-filled" {
			t.Fatalf("style filter leaked: %v", a["id"])
		}
	}
}

// TestSearchPhotoProvider covers the Search gate: text photo searches go to the
// live provider, everything else (and provider failure) serves the seed.
func TestSearchPhotoProvider(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"results":[{"id":"abc","title":"Sunset","url":"https://photos.example.com/sunset.jpg","license":"cc0","width":800,"height":600}]}`))
	}))
	defer srv.Close()
	s := &Service{ov: &openverse{enabled: true, baseURL: srv.URL, client: srv.Client(), cache: map[string]ovCacheEntry{}}}
	ctx := context.Background()

	// kind=photo with text hits the provider.
	got, err := s.Search(ctx, Query{Kind: "photo", Text: "sunset"}, "")
	if err != nil || len(got) != 1 || str(got[0]["id"]) != "ov-abc" {
		t.Fatalf("photo text search should use the provider: %v %v", got, err)
	}
	// No text browses the bundled seed (placeholders), not the provider.
	got, _ = s.Search(ctx, Query{Kind: "photo"}, "")
	for _, a := range got {
		if strings.HasPrefix(str(a["id"]), "ov-") {
			t.Fatal("browse without text must not hit the provider")
		}
	}
	// Non-photo searches never hit the provider.
	got, _ = s.Search(ctx, Query{Kind: "icon", Text: "heart"}, "")
	if len(got) == 0 || strings.HasPrefix(str(got[0]["id"]), "ov-") {
		t.Fatalf("icon search must stay on the seed: %v", got[0]["id"])
	}
	// An active facet (category/style/orientation/color) keeps a text photo
	// search on the bundled seed: the provider can't apply facets and would
	// silently return unfiltered results.
	got, _ = s.Search(ctx, Query{Kind: "photo", Text: "nature", Category: "nature"}, "")
	for _, a := range got {
		if strings.HasPrefix(str(a["id"]), "ov-") {
			t.Fatal("facet-filtered search must not hit the provider")
		}
	}
	// A dead provider falls back to the seed instead of erroring.
	s.ov.baseURL = "http://127.0.0.1:1"
	s.ov.cache = map[string]ovCacheEntry{}
	if _, err := s.Search(ctx, Query{Kind: "photo", Text: "sunset"}, ""); err != nil {
		t.Fatalf("provider failure must fall back, not error: %v", err)
	}
}

func TestStock_DB(t *testing.T) {
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

	acct := accounts.NewService(tx, "test-jwt-secret")
	owner, _, _, err := acct.Signup(ctx, "stock+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	svc := NewService(tx)
	id := seed.Stock[0]["id"].(string)

	// Toggle favorite on, then it appears in favorites + flags search results.
	on, err := svc.ToggleFavorite(ctx, owner.ID, id)
	if err != nil || !on {
		t.Fatalf("toggle on: %v %v", on, err)
	}
	favs, _ := svc.ListFavorites(ctx, owner.ID)
	if len(favs) != 1 || favs[0]["id"] != id || favs[0]["favorited"] != true {
		t.Fatalf("favorites wrong: %+v", favs)
	}
	res, _ := svc.Search(ctx, Query{}, owner.ID)
	for _, a := range res {
		if a["id"] == id && a["favorited"] != true {
			t.Fatalf("search should flag the favorite")
		}
	}
	// Toggle off.
	if off, _ := svc.ToggleFavorite(ctx, owner.ID, id); off {
		t.Fatal("toggle off should return false")
	}
	if favs, _ := svc.ListFavorites(ctx, owner.ID); len(favs) != 0 {
		t.Fatalf("favorites should be empty after toggle off")
	}

	// Recents: record two. (The test runs in one transaction, so now() is frozen
	// and usedAt ties; assert membership, not order, which the runtime gets right.)
	id2 := seed.Stock[1]["id"].(string)
	_ = svc.RecordRecent(ctx, owner.ID, id)
	_ = svc.RecordRecent(ctx, owner.ID, id2)
	recents, _ := svc.ListRecents(ctx, owner.ID)
	got := map[string]bool{}
	for _, a := range recents {
		got[a["id"].(string)] = true
	}
	if len(recents) != 2 || !got[id] || !got[id2] {
		t.Fatalf("recents wrong: %+v", recents)
	}
	// Unknown id rejected.
	if err := svc.RecordRecent(ctx, owner.ID, "nope"); err != ErrNotFound {
		t.Fatalf("unknown recent should be NotFound, got %v", err)
	}
}
