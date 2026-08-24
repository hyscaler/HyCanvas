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
	if providerChanged && in.APIKey == "" && existing.keyCipher != nil {
		return nil, ErrKeyRequiredForProviderChange
	}
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
		return nil, ErrBadRequest
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
			"key_cipher" = CASE WHEN $4 IS NOT NULL THEN $4 ELSE "ai_search_configs"."key_cipher" END,
			"key_iv"     = CASE WHEN $5 IS NOT NULL THEN $5 ELSE "ai_search_configs"."key_iv" END,
			"key_tag"    = CASE WHEN $6 IS NOT NULL THEN $6 ELSE "ai_search_configs"."key_tag" END,
			"updated_at" = now()`
	if _, err := s.db.Exec(ctx, q, workspaceID, in.Provider, baseURL, cipher, iv, tag); err != nil {
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
	if maxResults > 10 {
		maxResults = 10
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

// cleanResults trims, drops empty hits, and caps the list.
func cleanResults(in []SearchResult, max int) []SearchResult {
	out := make([]SearchResult, 0, max)
	for _, r := range in {
		r.Title = strings.TrimSpace(r.Title)
		r.URL = strings.TrimSpace(r.URL)
		r.Content = strings.TrimSpace(r.Content)
		if r.URL == "" || (r.Title == "" && r.Content == "") {
			continue
		}
		if len(r.Content) > 2000 {
			r.Content = r.Content[:2000]
		}
		out = append(out, r)
		if len(out) >= max {
			break
		}
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
