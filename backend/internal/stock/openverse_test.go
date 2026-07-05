package stock

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// ovFixture is a three-result Openverse page: a CC BY photo (attribution must
// carry through), a CC0 photo with an off-openverse thumbnail (the preview
// must be composed) and an untitled record, and a by-nc photo the mapper must
// drop even though the request itself already filters licenses.
const ovFixture = `{
  "result_count": 3,
  "results": [
    {
      "id": "aaa-111",
      "title": "Golden Gate at Dusk",
      "url": "https://live.example.org/aaa-111.jpg",
      "thumbnail": "https://api.openverse.org/v1/images/aaa-111/thumbnail/",
      "width": 4000,
      "height": 3000,
      "license": "by",
      "license_version": "2.0",
      "attribution": "\"Golden Gate at Dusk\" by Ansel is licensed under CC BY 2.0.",
      "foreign_landing_url": "https://www.flickr.com/photos/ansel/aaa-111",
      "creator": "Ansel",
      "tags": [{"name": "Bridge"}, {"name": "Sunset"}]
    },
    {
      "id": "bbb-222",
      "title": "",
      "url": "https://live.example.org/bbb-222.jpg",
      "thumbnail": "https://cdn.example.net/bbb-222-small.jpg",
      "width": 1200,
      "height": 1600,
      "license": "cc0",
      "license_version": "1.0",
      "attribution": "",
      "foreign_landing_url": "https://museum.example.org/bbb-222",
      "creator": "Nadar",
      "tags": []
    },
    {
      "id": "ccc-333",
      "title": "Not For Sale",
      "url": "https://live.example.org/ccc-333.jpg",
      "thumbnail": "https://api.openverse.org/v1/images/ccc-333/thumbnail/",
      "width": 800,
      "height": 600,
      "license": "by-nc",
      "license_version": "4.0",
      "attribution": "\"Not For Sale\" by Nope is licensed under CC BY-NC 4.0.",
      "foreign_landing_url": "https://www.flickr.com/photos/nope/ccc-333",
      "creator": "Nope",
      "tags": [{"name": "Money"}]
    }
  ]
}`

func TestOpenverseSearch(t *testing.T) {
	t.Setenv("STOCK_PHOTO_PROVIDER", "") // pin the provider on, whatever the host env says
	hits := 0
	var gotQuery url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		gotQuery = r.URL.Query()
		if r.URL.Path != "/v1/images/" {
			t.Errorf("wrong path: %s", r.URL.Path)
		}
		if ua := r.Header.Get("User-Agent"); ua != "HyCanvas/1.0 (self-hosted; https://github.com/hyscaler/hycanvas)" {
			t.Errorf("wrong user agent: %q", ua)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(ovFixture))
	}))
	defer srv.Close()
	o := newOpenverse()
	o.baseURL = srv.URL

	q := Query{Text: "golden gate", Limit: 24, Offset: 48}
	got := o.search(context.Background(), q)
	// The by-nc record is dropped by the mapper's license re-check.
	if len(got) != 2 {
		t.Fatalf("expected 2 mapped assets (by-nc dropped): %d", len(got))
	}
	// The request carries the safe-license filter and translated paging
	// (offset 48 at limit 24 is 1-based page 3).
	if gotQuery.Get("q") != "golden gate" || gotQuery.Get("license") != "cc0,pdm,by" {
		t.Fatalf("wrong q/license params: %v", gotQuery)
	}
	if gotQuery.Get("page_size") != "24" || gotQuery.Get("page") != "3" {
		t.Fatalf("wrong paging params: %v", gotQuery)
	}
	// The CC BY asset: ov- id prefix, attribution carried through, openverse
	// thumbnail kept as-is, tags lowercased with "photo" always present.
	by := got[0]
	if str(by["id"]) != "ov-aaa-111" || str(by["title"]) != "Golden Gate at Dusk" {
		t.Fatalf("by asset mapped wrong: %v %v", by["id"], by["title"])
	}
	if str(by["kind"]) != "photo" || str(by["pack"]) != "openverse" || str(by["category"]) != "photos" || str(by["format"]) != "jpg" {
		t.Fatalf("catalog fields wrong: %+v", by)
	}
	if str(by["sourceUrl"]) != "https://live.example.org/aaa-111.jpg" || by["width"] != float64(4000) || by["height"] != float64(3000) {
		t.Fatalf("source/dimensions wrong: %+v", by)
	}
	if str(by["previewUrl"]) != "https://api.openverse.org/v1/images/aaa-111/thumbnail/" {
		t.Fatalf("openverse-hosted thumbnail should pass through: %v", by["previewUrl"])
	}
	tags := arr(by["tags"])
	tagSet := map[string]bool{}
	for _, tg := range tags {
		tagSet[str(tg)] = true
	}
	if !tagSet["bridge"] || !tagSet["sunset"] || !tagSet["photo"] {
		t.Fatalf("tags should be lowercased and include photo: %v", tags)
	}
	lic, _ := by["license"].(map[string]any)
	if lic == nil || lic["type"] != "cc-by" || lic["attributionRequired"] != true || lic["holder"] != "Ansel" {
		t.Fatalf("by license wrong: %v", by["license"])
	}
	if lic["attributionText"] != "\"Golden Gate at Dusk\" by Ansel is licensed under CC BY 2.0." || lic["attributionUrl"] != "https://www.flickr.com/photos/ansel/aaa-111" {
		t.Fatalf("attribution not carried through: %v", lic)
	}
	// The CC0 asset: title falls back, no attribution required, and the
	// off-openverse thumbnail is replaced with the composed endpoint.
	cc0 := got[1]
	if str(cc0["id"]) != "ov-bbb-222" || str(cc0["title"]) != "Photo" {
		t.Fatalf("cc0 asset mapped wrong: %v %v", cc0["id"], cc0["title"])
	}
	if str(cc0["previewUrl"]) != srv.URL+"/v1/images/bbb-222/thumbnail/" {
		t.Fatalf("foreign thumbnail should be recomposed: %v", cc0["previewUrl"])
	}
	if lic, _ := cc0["license"].(map[string]any); lic == nil || lic["type"] != "cc0" || lic["attributionRequired"] != false {
		t.Fatalf("cc0 license wrong: %v", cc0["license"])
	}
	// A second identical query is served from the cache: no new server hit.
	if again := o.search(context.Background(), q); len(again) != 2 || hits != 1 {
		t.Fatalf("identical query should be cached: %d assets, %d hits", len(again), hits)
	}
	// A different query fetches again and defaults its paging (page_size 60, page 1).
	if other := o.search(context.Background(), Query{Text: "harbor"}); len(other) != 2 || hits != 2 {
		t.Fatalf("new query should fetch: %d assets, %d hits", len(other), hits)
	}
	if gotQuery.Get("page_size") != "60" || gotQuery.Get("page") != "1" {
		t.Fatalf("default paging wrong: %v", gotQuery)
	}
}

func TestOpenverseDisabled(t *testing.T) {
	t.Setenv("STOCK_PHOTO_PROVIDER", "off")
	o := newOpenverse()
	if got := o.search(context.Background(), Query{Text: "anything"}); got != nil {
		t.Fatalf("disabled provider must return nil: %v", got)
	}
}

// Failures never surface an error: the caller falls back to the bundled seed.
func TestOpenverseFailure(t *testing.T) {
	t.Setenv("STOCK_PHOTO_PROVIDER", "")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "rate limited", http.StatusInternalServerError)
	}))
	o := newOpenverse()
	o.baseURL = srv.URL
	if got := o.search(context.Background(), Query{Text: "x"}); got != nil {
		t.Fatalf("non-200 must return nil: %v", got)
	}
	// A dead endpoint (connection refused) degrades the same way.
	srv.Close()
	if got := o.search(context.Background(), Query{Text: "y"}); got != nil {
		t.Fatalf("network error must return nil: %v", got)
	}
}
