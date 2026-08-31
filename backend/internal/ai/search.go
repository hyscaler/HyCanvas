// Web-search provider support for AI generation grounding (F28 T16): a
// per-workspace search config stored like the AI provider config (key
// encrypted at rest with the same machinery), and the search transport for
// the two provider shapes - one hosted search API keyed per workspace, and a
// self-hosted metasearch endpoint (SearXNG-compatible JSON) behind the same
// SSRF gate as every other user-supplied URL. Results are cleaned to
// title/url/content and treated as UNTRUSTED reference material by callers.

package ai

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/auth/secrets"
)

// ErrSearchNotConfigured is returned when a workspace has no search provider;
// callers degrade gracefully (generation proceeds without search).
var ErrSearchNotConfigured = errors.New("web search is not configured")

// SearchProviderTavily is the hosted search API (BYO key); SearchProviderSearx
// is a self-hosted SearXNG-compatible metasearch endpoint (BYO base URL).
const (
	SearchProviderTavily = "tavily"
	SearchProviderSearx  = "searxng"
)

var searchProviderSet = map[string]bool{SearchProviderTavily: true, SearchProviderSearx: true}

// SearchConfigInput is the set payload. Provider "" clears the config.
type SearchConfigInput struct {
	Provider string
	BaseURL  *string
	APIKey   string
}

// SearchConfigView is the public config (never includes the key).
type SearchConfigView struct {
	Provider string  `json:"provider"`
	BaseURL  *string `json:"baseUrl"`
	HasKey   bool    `json:"hasKey"`
}

// SearchResult is one cleaned search hit.
type SearchResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Content string `json:"content"`
}

type searchRow struct {
	provider  string
	baseURL   *string
	keyCipher *string
	keyIV     *string
	keyTag    *string
}

func (s *Service) getSearchRow(ctx context.Context, workspaceID string) (*searchRow, error) {
	const q = `SELECT provider, "base_url", "key_cipher", "key_iv", "key_tag"
		FROM "ai_search_configs" WHERE "workspace_id" = $1`
	var r searchRow
	err := s.db.QueryRow(ctx, q, workspaceID).Scan(&r.provider, &r.baseURL, &r.keyCipher, &r.keyIV, &r.keyTag)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// GetSearchConfig returns the workspace's search config, or nil when unset.
func (s *Service) GetSearchConfig(ctx context.Context, workspaceID string) (*SearchConfigView, error) {
	r, err := s.getSearchRow(ctx, workspaceID)
	if err != nil || r == nil {
		return nil, err
	}
	return &SearchConfigView{Provider: r.provider, BaseURL: r.baseURL, HasKey: r.keyCipher != nil && *r.keyCipher != ""}, nil
}

// SetSearchConfig upserts (or clears, with provider "") the workspace's search
// provider. The same write-boundary rules as the AI config: an explicitly
// supplied base URL is trimmed and SSRF-checked, the metasearch provider
// requires one, the hosted provider requires a key, and a provider change
// must bring the new provider's key rather than silently carrying the old.
func (s *Service) SetSearchConfig(ctx context.Context, workspaceID string, in SearchConfigInput) (*SearchConfigView, error) {
	if in.Provider == "" {
		const del = `DELETE FROM "ai_search_configs" WHERE "workspace_id" = $1`
		if _, err := s.db.Exec(ctx, del, workspaceID); err != nil {
			return nil, err
		}
		return nil, nil
	}
	if !searchProviderSet[in.Provider] {
		return nil, ErrBadRequest
	}
	if in.BaseURL != nil {
		trimmed := strings.TrimSpace(*in.BaseURL)
		in.BaseURL = &trimmed
		if trimmed != "" && !isSafeBaseURL(trimmed, s.allowLocal) {
			return nil, ErrBadRequest
		}
	}
	existing, err := s.getSearchRow(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	providerChanged := existing != nil && existing.provider != in.Provider
	in.APIKey = strings.TrimSpace(in.APIKey)
	// A provider change may not silently carry the old key - but unlike the
	// AI config, a search provider can be KEYLESS (the metasearch endpoint),
	// so switching to one is free: the stored key is cleared below instead of
	// demanded. Only a change to a KEYED provider requires its key.
	if providerChanged && in.APIKey == "" && existing.keyCipher != nil && in.Provider == SearchProviderTavily {
		return nil, ErrKeyRequiredForProviderChange
	}
	clearKey := providerChanged && in.APIKey == "" && in.Provider != SearchProviderTavily
	// Resolve the base URL under the same PATCH semantics as the AI config.
	resolvedBase := ""
	switch {
	case in.BaseURL != nil:
		resolvedBase = *in.BaseURL
	case providerChanged || existing == nil:
		resolvedBase = ""
	default:
		resolvedBase = deref(existing.baseURL)
	}
	if in.Provider == SearchProviderSearx && resolvedBase == "" {
		return nil, ErrBaseURLRequired
	}
	hasStoredKey := existing != nil && !providerChanged && existing.keyCipher != nil
	if in.Provider == SearchProviderTavily && in.APIKey == "" && !hasStoredKey {
		return nil, ErrSearchKeyRequired
	}

	var cipher, iv, tag *string
	if in.APIKey != "" {
		nonce := make([]byte, 12)
		if _, err := rand.Read(nonce); err != nil {
			return nil, err
		}
		enc, err := secrets.EncryptAISecret(in.APIKey, s.secret, nonce)
		if err != nil {
			return nil, err
		}
		cipher, iv, tag = &enc.Cipher, &enc.IV, &enc.Tag
	}
	baseURL := nilIfEmpty(resolvedBase)
	const q = `INSERT INTO "ai_search_configs" ("workspace_id",provider,"base_url","key_cipher","key_iv","key_tag","updated_at")
		VALUES ($1,$2,$3,$4,$5,$6,now())
		ON CONFLICT ("workspace_id") DO UPDATE SET
			provider = EXCLUDED.provider,
			"base_url" = EXCLUDED."base_url",
			"key_cipher" = CASE WHEN $7 THEN NULL WHEN $4 IS NOT NULL THEN $4 ELSE "ai_search_configs"."key_cipher" END,
			"key_iv"     = CASE WHEN $7 THEN NULL WHEN $5 IS NOT NULL THEN $5 ELSE "ai_search_configs"."key_iv" END,
			"key_tag"    = CASE WHEN $7 THEN NULL WHEN $6 IS NOT NULL THEN $6 ELSE "ai_search_configs"."key_tag" END,
			"updated_at" = now()`
	if _, err := s.db.Exec(ctx, q, workspaceID, in.Provider, baseURL, cipher, iv, tag, clearKey); err != nil {
		return nil, err
	}
	return s.GetSearchConfig(ctx, workspaceID)
}

// Search executes one web search through the workspace's configured provider,
// returning at most maxResults (clamped 1..10) cleaned results. Failures of
// the provider surface as ErrBadGateway; a missing config as
// ErrSearchNotConfigured, which callers treat as "proceed without search".
func (s *Service) Search(ctx context.Context, workspaceID, query string, maxResults int) ([]SearchResult, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, ErrBadRequest
	}
	if maxResults < 1 {
		maxResults = 5
	}
	if maxResults > maxSearchResults {
		maxResults = maxSearchResults
	}
	r, err := s.getSearchRow(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, ErrSearchNotConfigured
	}
	switch r.provider {
	case SearchProviderTavily:
		if r.keyCipher == nil || r.keyIV == nil || r.keyTag == nil {
			return nil, ErrSearchNotConfigured
		}
		key, err := secrets.DecryptAISecret(secrets.Encrypted{Cipher: *r.keyCipher, IV: *r.keyIV, Tag: *r.keyTag}, s.secret)
		if err != nil {
			return nil, ErrBadRequest
		}
		return s.searchTavily(deref(r.baseURL), key, query, maxResults)
	case SearchProviderSearx:
		base := deref(r.baseURL)
		if base == "" || !isSafeBaseURL(base, s.allowLocal) {
			return nil, ErrSearchNotConfigured
		}
		return s.searchSearx(base, query, maxResults)
	}
	return nil, ErrSearchNotConfigured
}

// maxSearchResults bounds a single search, and with it the slice cleanResults
// preallocates. One constant so the caller's clamp and the allocation cannot
// drift apart.
const maxSearchResults = 10

// cleanResults trims, drops empty hits, and caps the list.
//
// It clamps `max` itself rather than trusting the caller. Search already
// clamps, so nothing reaches here unbounded today, but the value originates in
// a request body and the guard lived in a different function: any future caller
// would have preallocated whatever a client asked for.
func cleanResults(in []SearchResult, max int) []SearchResult {
	// The low guard is against a NEGATIVE cap, which would panic make. It
	// deliberately does not raise 0 to 1: "cap the list at zero" is a coherent
	// request, and quietly returning one result would be a different function.
	if max < 0 {
		max = 0
	}
	if max > maxSearchResults {
		max = maxSearchResults
	}
	// Capacity is the CONSTANT bound rather than `max`. The clamps above already
	// hold max in [0, maxSearchResults], so this reserves the same order of
	// memory, but it keeps a request-derived value out of make() altogether:
	// the allocation is bounded by construction, not by reasoning about the
	// guards above it. `max` still caps the result count, in the loop below.
	out := make([]SearchResult, 0, maxSearchResults)
	for _, r := range in {
		// Checked BEFORE appending. The check used to sit after, so a cap of
		// zero still yielded one result: the break only fired once the list had
		// already grown past it. No caller passes zero, but "at most n" should
		// not have an exception at n=0.
		if len(out) >= max {
			break
		}
		r.Title = strings.TrimSpace(r.Title)
		r.URL = strings.TrimSpace(r.URL)
		r.Content = strings.TrimSpace(r.Content)
		if r.URL == "" || (r.Title == "" && r.Content == "") {
			continue
		}
		if len(r.Content) > 2000 {
			// Rune-safe: back off to a boundary rather than splitting UTF-8.
			cut := 2000
			for cut > 0 && (r.Content[cut]&0xC0) == 0x80 {
				cut--
			}
			r.Content = r.Content[:cut]
		}
		out = append(out, r)
	}
	return out
}

func (s *Service) searchTavily(base, key, query string, max int) ([]SearchResult, error) {
	raw, err := s.postJSON(httpRequest{
		url:     orDefault(base, "https://api.tavily.com") + "/search",
		headers: map[string]string{"content-type": "application/json", "authorization": "Bearer " + key},
		body:    map[string]any{"query": query, "max_results": max},
	})
	if err != nil {
		return nil, ErrBadGateway
	}
	var j struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	_ = json.Unmarshal(raw, &j)
	results := make([]SearchResult, 0, len(j.Results))
	for _, r := range j.Results {
		results = append(results, SearchResult(r))
	}
	return cleanResults(results, max), nil
}

func (s *Service) searchSearx(base, query string, max int) ([]SearchResult, error) {
	u := strings.TrimRight(base, "/") + "/search?format=json&q=" + url.QueryEscape(query)
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return nil, ErrBadGateway
	}
	raw, err := s.do(req)
	if err != nil {
		return nil, ErrBadGateway
	}
	var j struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	_ = json.Unmarshal(raw, &j)
	results := make([]SearchResult, 0, len(j.Results))
	for _, r := range j.Results {
		results = append(results, SearchResult(r))
	}
	return cleanResults(results, max), nil
}
