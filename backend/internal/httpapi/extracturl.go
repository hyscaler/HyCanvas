// URL-to-text extraction for document/URL-to-deck ingestion (doc 28 FR-23).
// The browser cannot fetch arbitrary pages (CORS), so the server fetches and
// reduces the page to readable text (title + headings/paragraphs/list items)
// that the deck generator grounds an outline in.
//
// SSRF hardening: this endpoint fetches attacker-chosen URLs from inside the
// deployment, so it must never become an internal-network probe. Scheme is
// http(s) only; the HOSTNAME resolves first and every resolved address must be
// public (loopback, RFC1918, link-local incl. 169.254.169.254 metadata, ULA,
// unspecified, and the IPv6 ranges that carry an IPv4 inside them so NAT64 or
// 6to4 cannot translate a way back in, all refuse); redirects re-validate each
// hop; the response is size-capped and time-limited; only html/plain parses.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/net/html"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/media"
)

const (
	extractMaxBytes    = 5 << 20 // 5 MiB page cap
	extractMaxText     = 60_000  // returned text cap (the client trims further for prompts)
	extractTimeout     = 15 * time.Second
	extractMaxRedirect = 4
)

func mountExtractURL(api chi.Router, acct *accounts.Service) {
	api.With(requireAuth(acct)).Post("/ai/extract-url", extractURLHandler())
	api.With(requireAuth(acct)).Post("/data/fetch", dataFetchHandler())
}

// dataFetchHandler proxies a remote CSV/TSV/JSON data source for live-bound
// charts and tables (doc 28 / F27): the browser cannot fetch arbitrary hosts
// (CORS), so the server does, behind the same SSRF gate as extract-url. The
// body returns verbatim (parsing stays client-side), capped at 2 MiB.
func dataFetchHandler() http.HandlerFunc {
	const dataMaxBytes = 2 << 20
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			URL string `json:"url"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || body.URL == "" {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "missing url", "missing_url")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), extractTimeout)
		defer cancel()
		res, err := fetchVetted(ctx, body.URL,
			"HyCanvas-Data/1.0 (+live chart binding)",
			"text/csv, text/tab-separated-values, application/json, text/plain;q=0.9")
		if err != nil {
			problemWithCode(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", err.Error(), "data_fetch_failed")
			return
		}
		defer func() { _ = res.Body.Close() }()
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			problemWithCode(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", fmt.Sprintf("the source returned %d", res.StatusCode), "data_source_status")
			return
		}
		ctype := res.Header.Get("Content-Type")
		if strings.Contains(ctype, "text/html") {
			problemWithCode(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", "that URL returns a web page, not data (use a raw CSV/JSON link)", "data_url_is_web_page")
			return
		}
		// Read one byte past the cap so an oversized source is REJECTED rather
		// than silently truncated: half a CSV row would bind to a chart as if
		// it were the whole dataset.
		raw, err := io.ReadAll(io.LimitReader(res.Body, dataMaxBytes+1))
		if err != nil || len(raw) == 0 {
			problemWithCode(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", "could not read that source", "could_not_read_that_source")
			return
		}
		if len(raw) > dataMaxBytes {
			problemWithCode(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", "that source is larger than 2 MiB", "data_source_too_large")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"text": string(raw)})
	}
}

// vetHop applies the full policy to one absolute URL: http(s) only, and every
// address its hostname resolves to must be public. It returns the address the
// fetch must DIAL, because checking and connecting are two separate DNS
// lookups: a host that answers public for the check and internal for the dial
// (rebinding) walks past any check-only gate. media.IsPrivateIP is the same
// policy the uploads import path uses (it also covers CGNAT 100.64/10, where
// some clouds put their metadata service, and 0.0.0.0/8).
func vetHop(ctx context.Context, raw string) (*url.URL, net.IP, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return nil, nil, errors.New("provide an http(s) URL")
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, u.Hostname())
	if err != nil || len(ips) == 0 {
		return nil, nil, fmt.Errorf("host does not resolve")
	}
	for _, ip := range ips {
		v := ip.IP
		if media.IsPrivateIP(v.String()) || v.IsLoopback() || v.IsPrivate() || v.IsLinkLocalUnicast() ||
			v.IsLinkLocalMulticast() || v.IsUnspecified() || v.IsMulticast() {
			return nil, nil, fmt.Errorf("address not allowed")
		}
	}
	return u, ips[0].IP, nil
}

func validateExtractURL(ctx context.Context, raw string) (*url.URL, error) {
	u, _, err := vetHop(ctx, raw)
	return u, err
}

// fetchVetted GETs rawURL, following at most extractMaxRedirect hops. Each hop
// is vetted and then dialed to the exact IP that was vetted, so the connection
// can only land where the check landed. Redirects are followed by hand
// (ErrUseLastResponse) because every Location needs the same treatment: a
// public host redirecting to an internal one is the classic SSRF bounce.
func fetchVetted(ctx context.Context, rawURL, userAgent, accept string) (*http.Response, error) {
	current := rawURL
	for hop := 0; hop <= extractMaxRedirect; hop++ {
		u, ip, err := vetHop(ctx, current)
		if err != nil {
			return nil, err
		}
		pinned := ip.String()
		client := &http.Client{
			Timeout: extractTimeout,
			Transport: &http.Transport{
				DisableKeepAlives: true,
				DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
					_, port, err := net.SplitHostPort(addr)
					if err != nil {
						return nil, err
					}
					d := &net.Dialer{Timeout: extractTimeout}
					// Hostname stays in the URL for TLS SNI and the Host header;
					// only the address dialed is replaced.
					return d.DialContext(ctx, network, net.JoinHostPort(pinned, port))
				},
			},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
		if err != nil {
			return nil, errors.New("could not fetch that URL")
		}
		req.Header.Set("User-Agent", userAgent)
		req.Header.Set("Accept", accept)
		res, err := client.Do(req)
		if err != nil {
			return nil, errors.New("could not fetch that URL")
		}
		if res.StatusCode >= 300 && res.StatusCode < 400 {
			loc := res.Header.Get("Location")
			_ = res.Body.Close()
			next, perr := u.Parse(loc) // resolves relative Locations against this hop
			if loc == "" || perr != nil {
				return nil, errors.New("could not fetch that URL")
			}
			current = next.String()
			continue
		}
		return res, nil
	}
	return nil, errors.New("too many redirects")
}

func extractURLHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			URL string `json:"url"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || body.URL == "" {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "missing url", "missing_url")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), extractTimeout)
		defer cancel()
		res, err := fetchVetted(ctx, body.URL, "HyCanvas-Ingest/1.0 (+deck import)", "text/html, text/plain;q=0.9")
		if err != nil {
			problemWithCode(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", err.Error(), "url_extract_failed")
			return
		}
		defer func() { _ = res.Body.Close() }()
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			problemWithCode(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", fmt.Sprintf("the page returned %d", res.StatusCode), "url_page_status")
			return
		}
		ctype := res.Header.Get("Content-Type")
		isHTML := strings.Contains(ctype, "text/html") || strings.Contains(ctype, "application/xhtml")
		isPlain := strings.Contains(ctype, "text/plain")
		if !isHTML && !isPlain {
			problemWithCode(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", "only web pages and plain text can be imported", "unsupported_content_type")
			return
		}
		raw, err := io.ReadAll(io.LimitReader(res.Body, extractMaxBytes))
		if err != nil {
			problemWithCode(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", "could not read that page", "could_not_read_that_page")
			return
		}

		title, text := "", ""
		if isPlain {
			text = string(raw)
		} else {
			title, text = htmlToText(raw)
		}
		text = strings.TrimSpace(text)
		if len(text) > extractMaxText {
			text = text[:extractMaxText]
		}
		if text == "" {
			problemWithCode(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", "no readable text on that page", "page_no_readable_text")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"title": title, "text": text})
	}
}

// htmlToText walks the DOM collecting readable content: the <title>, then text
// under content elements, with block-ish boundaries as newlines. script/style/
// nav/header/footer/aside/template subtrees are skipped wholesale.
func htmlToText(raw []byte) (title, text string) {
	doc, err := html.Parse(strings.NewReader(string(raw)))
	if err != nil {
		return "", ""
	}
	var b strings.Builder
	skip := map[string]bool{"script": true, "style": true, "noscript": true, "nav": true, "header": true, "footer": true, "aside": true, "template": true, "svg": true, "iframe": true}
	block := map[string]bool{"p": true, "div": true, "section": true, "article": true, "li": true, "h1": true, "h2": true, "h3": true, "h4": true, "h5": true, "h6": true, "tr": true, "br": true, "blockquote": true, "pre": true}
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if skip[n.Data] {
				return
			}
			if n.Data == "title" && title == "" && n.FirstChild != nil && n.FirstChild.Type == html.TextNode {
				title = strings.TrimSpace(n.FirstChild.Data)
				return
			}
		}
		if n.Type == html.TextNode {
			if t := strings.TrimSpace(n.Data); t != "" {
				b.WriteString(t)
				b.WriteString(" ")
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
		if n.Type == html.ElementNode && block[n.Data] {
			b.WriteString("\n")
		}
	}
	walk(doc)
	// Collapse runaway blank lines.
	lines := strings.Split(b.String(), "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		if t := strings.TrimSpace(l); t != "" {
			out = append(out, t)
		}
	}
	return title, strings.Join(out, "\n")
}
