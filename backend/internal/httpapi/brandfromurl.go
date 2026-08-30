// Brand kit draft from a company domain (F28 T21). POST /ai/brand-from-url
// fetches the page through the same SSRF-hardened path as extract-url and
// reduces it to a brand DRAFT: candidate logo URLs (icon links, social-card
// images, logo-hinted <img>s), a palette (theme-color plus every hex observed
// in inline styles and <style> blocks, frequency-ranked, optionally re-ranked
// by one structured model pass over the page's own title/description), and
// font-family guesses (webfont links first, then CSS declarations). The reply
// is a draft the user confirms in the brand panel before ANYTHING is saved;
// this endpoint never touches a brand kit.

package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"golang.org/x/net/html"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/aistudio"
)

func mountBrandFromURL(api chi.Router, studio *aistudio.Service, acct *accounts.Service) {
	api.With(requireAuth(acct)).Post("/ai/brand-from-url", brandFromURLHandler(studio, acct))
}

// brandScan is the deterministic part of the draft: everything observed on
// the page itself, before any model judgment.
type brandScan struct {
	Title       string
	Description string
	ThemeColor  string
	LogoURLs    []string
	Colors      []string // frequency-ranked candidate hexes (theme-color first)
	Fonts       []string
}

var hexColorRe = regexp.MustCompile(`#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b`)

// A standalone "logo" token (word-ish boundaries), so logout/catalogo/dialogo
// never qualify while acme-logo.svg and class="logo" do.
var logoTokenRe = regexp.MustCompile(`(?:^|[^a-z])logo(?:[^a-z]|$)`)
var fontFamilyRe = regexp.MustCompile("(?i)font-family\\s*:\\s*([^;}{]+)")

// Families that mean "the platform default", not a brand choice.
var genericFonts = map[string]bool{
	"sans-serif": true, "serif": true, "monospace": true, "cursive": true, "fantasy": true,
	"system-ui": true, "ui-sans-serif": true, "ui-serif": true, "ui-monospace": true, "ui-rounded": true,
	"-apple-system": true, "blinkmacsystemfont": true, "inherit": true, "initial": true, "unset": true, "revert": true,
}

func normalizeHex(h string) string {
	h = strings.ToLower(h)
	if len(h) == 4 { // #abc -> #aabbcc
		return "#" + strings.Repeat(string(h[1]), 2) + strings.Repeat(string(h[2]), 2) + strings.Repeat(string(h[3]), 2)
	}
	if len(h) == 9 { // #rrggbbaa -> #rrggbb (the alpha byte is not a swatch)
		return h[:7]
	}
	return h
}

// nearExtreme reports pure/near white and black, which are page chrome on
// almost every site and never a useful brand swatch on their own.
func nearExtreme(hex string) bool {
	var r, g, b int
	if _, err := fmt.Sscanf(hex, "#%02x%02x%02x", &r, &g, &b); err != nil {
		return true
	}
	lum := (r + g + b) / 3
	return lum >= 245 || lum <= 10
}

// cleanFontFamily extracts the FIRST family of a declaration, unquoted, or ""
// when it is generic/dynamic.
func cleanFontFamily(decl string) string {
	first := strings.TrimSpace(strings.SplitN(decl, ",", 2)[0])
	first = strings.Trim(first, `"'`)
	if first == "" || strings.HasPrefix(first, "var(") || genericFonts[strings.ToLower(first)] {
		return ""
	}
	return first
}

// webfontFamilies parses a Google-Fonts-style CSS href: family=Name:wght@..
// (CSS2, repeated) and family=Name|Other (CSS1). The query is split by hand
// because the CSS2 axis syntax carries semicolons (wght@500;700), which the
// standard query parser rejects pair-by-pair.
func webfontFamilies(href string) []string {
	u, err := url.Parse(href)
	if err != nil {
		return nil
	}
	var out []string
	for _, pair := range strings.Split(u.RawQuery, "&") {
		if !strings.HasPrefix(pair, "family=") {
			continue
		}
		fam, err := url.QueryUnescape(strings.TrimPrefix(pair, "family="))
		if err != nil {
			continue
		}
		for _, part := range strings.Split(fam, "|") {
			name := strings.SplitN(part, ":", 2)[0]
			name = strings.ReplaceAll(name, "+", " ")
			if name = strings.TrimSpace(name); name != "" {
				out = append(out, name)
			}
		}
	}
	return out
}

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if strings.EqualFold(a.Key, key) {
			return strings.TrimSpace(a.Val)
		}
	}
	return ""
}

// resolveHTTP resolves a possibly-relative ref against base and keeps only
// http(s) and data:image results (anything else is useless as a logo <img>).
func resolveHTTP(base *url.URL, ref string) string {
	if ref == "" {
		return ""
	}
	if strings.HasPrefix(ref, "data:image/") {
		// Cap inline candidates: a page can embed multi-MiB data URIs, and an
		// uncapped one would balloon the JSON reply (the client uploads the
		// chosen one as an asset, so small favicons still work end to end).
		if len(ref) > 64*1024 {
			return ""
		}
		return ref
	}
	u, err := base.Parse(ref)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	return u.String()
}

// scanBrandHTML walks the page once, collecting every deterministic brand
// signal. Pure: no network, no model.
func scanBrandHTML(raw []byte, base *url.URL) brandScan {
	scan := brandScan{}
	doc, err := html.Parse(strings.NewReader(string(raw)))
	if err != nil {
		return scan
	}
	// Logo candidates in priority buckets: logo-hinted <img> (the thing that
	// IS the logo) > apple-touch-icon (large, brand-drawn) > mask/shortcut
	// icons > social-card images (often a banner, still useful).
	var logoImg, touchIcon, plainIcon, socialImg []string
	colorCount := map[string]int{}
	colorFirst := map[string]int{} // first-seen order for stable ties
	seq := 0
	countHexes := func(css string) {
		for _, m := range hexColorRe.FindAllString(css, -1) {
			h := normalizeHex(m)
			if nearExtreme(h) {
				continue
			}
			if _, ok := colorFirst[h]; !ok {
				colorFirst[h] = seq
				seq++
			}
			colorCount[h]++
		}
	}
	var webfonts, cssFonts []string
	fontSeen := map[string]bool{}
	addFont := func(list *[]string, fam string) {
		if fam == "" || fontSeen[strings.ToLower(fam)] {
			return
		}
		fontSeen[strings.ToLower(fam)] = true
		*list = append(*list, fam)
	}
	var walk func(n *html.Node, depth int)
	walk = func(n *html.Node, depth int) {
		if depth > 512 {
			return // a hostile page of unclosed tags must not overflow the stack
		}
		if n.Type == html.ElementNode {
			switch n.Data {
			case "title":
				if scan.Title == "" && n.FirstChild != nil && n.FirstChild.Type == html.TextNode {
					scan.Title = strings.TrimSpace(n.FirstChild.Data)
				}
			case "meta":
				name := strings.ToLower(attr(n, "name"))
				prop := strings.ToLower(attr(n, "property"))
				content := attr(n, "content")
				switch {
				case name == "theme-color" && content != "":
					if m := hexColorRe.FindString(content); m != "" && scan.ThemeColor == "" {
						scan.ThemeColor = normalizeHex(m)
					}
				case name == "description" && scan.Description == "":
					scan.Description = content
				case (prop == "og:image" || prop == "og:logo" || name == "twitter:image") && content != "":
					if u := resolveHTTP(base, content); u != "" {
						socialImg = append(socialImg, u)
					}
				}
			case "link":
				rel := strings.ToLower(attr(n, "rel"))
				href := attr(n, "href")
				switch {
				case strings.Contains(rel, "apple-touch-icon"):
					if u := resolveHTTP(base, href); u != "" {
						touchIcon = append(touchIcon, u)
					}
				case strings.Contains(rel, "icon"): // icon, shortcut icon, mask-icon
					if u := resolveHTTP(base, href); u != "" {
						plainIcon = append(plainIcon, u)
					}
				case strings.Contains(rel, "stylesheet"):
					if u, err := base.Parse(href); err == nil {
						host := strings.ToLower(u.Hostname())
						if host == "fonts.googleapis.com" || host == "fonts.bunny.net" {
							for _, fam := range webfontFamilies(href) {
								addFont(&webfonts, fam)
							}
						}
					}
				}
			case "img":
				hint := strings.ToLower(attr(n, "src") + " " + attr(n, "class") + " " + attr(n, "id") + " " + attr(n, "alt"))
				if logoTokenRe.MatchString(hint) {
					if u := resolveHTTP(base, attr(n, "src")); u != "" {
						logoImg = append(logoImg, u)
					}
				}
			case "style":
				if n.FirstChild != nil && n.FirstChild.Type == html.TextNode {
					countHexes(n.FirstChild.Data)
					for _, m := range fontFamilyRe.FindAllStringSubmatch(n.FirstChild.Data, -1) {
						addFont(&cssFonts, cleanFontFamily(m[1]))
					}
				}
			}
			if style := attr(n, "style"); style != "" {
				countHexes(style)
				for _, m := range fontFamilyRe.FindAllStringSubmatch(style, -1) {
					addFont(&cssFonts, cleanFontFamily(m[1]))
				}
			}
			if n.Data == "script" || n.Data == "noscript" || n.Data == "template" {
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c, depth+1)
		}
	}
	walk(doc, 0)

	// Palette: theme-color first (the site's own declaration), then observed
	// hexes by frequency (first-seen order breaks ties deterministically).
	type cc struct {
		hex   string
		count int
		first int
	}
	ranked := make([]cc, 0, len(colorCount))
	for h, c := range colorCount {
		ranked = append(ranked, cc{h, c, colorFirst[h]})
	}
	sort.Slice(ranked, func(i, j int) bool {
		if ranked[i].count != ranked[j].count {
			return ranked[i].count > ranked[j].count
		}
		return ranked[i].first < ranked[j].first
	})
	if scan.ThemeColor != "" && !nearExtreme(scan.ThemeColor) {
		scan.Colors = append(scan.Colors, scan.ThemeColor)
	}
	for _, c := range ranked {
		if c.hex == scan.ThemeColor {
			continue
		}
		scan.Colors = append(scan.Colors, c.hex)
		if len(scan.Colors) >= 12 { // pre-cap; the reply caps at 6
			break
		}
	}

	// Logos: priority buckets, deduped, capped.
	logoSeen := map[string]bool{}
	for _, bucket := range [][]string{logoImg, touchIcon, plainIcon, socialImg} {
		for _, u := range bucket {
			if logoSeen[u] || len(scan.LogoURLs) >= 6 {
				continue
			}
			logoSeen[u] = true
			scan.LogoURLs = append(scan.LogoURLs, u)
		}
	}

	// Fonts: explicit webfont loads first (a deliberate brand choice), then
	// CSS declarations, capped at 4.
	scan.Fonts = append(scan.Fonts, webfonts...)
	for _, f := range cssFonts {
		already := false
		for _, w := range scan.Fonts {
			if strings.EqualFold(w, f) {
				already = true
				break
			}
		}
		if !already {
			scan.Fonts = append(scan.Fonts, f)
		}
	}
	if len(scan.Fonts) > 4 {
		scan.Fonts = scan.Fonts[:4]
	}
	return scan
}

func brandFromURLHandler(studio *aistudio.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID string `json:"workspaceId"`
			URL         string `json:"url"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || body.URL == "" {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "missing url", "missing_url")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), extractTimeout)
		defer cancel()
		res, err := fetchVetted(ctx, body.URL, "HyCanvas-Brand/1.0 (+brand kit draft)", "text/html")
		if err != nil {
			// Computed detail (the SSRF gate's own reason); one code.
			problemWithCode(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", err.Error(), "brand_from_url_failed")
			return
		}
		defer func() { _ = res.Body.Close() }()
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			problemWithCode(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", fmt.Sprintf("the page returned %d", res.StatusCode), "brand_page_status")
			return
		}
		ctype := res.Header.Get("Content-Type")
		if !strings.Contains(ctype, "text/html") && !strings.Contains(ctype, "application/xhtml") {
			problemWithCode(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", "that URL is not a web page", "brand_url_not_html")
			return
		}
		raw, err := io.ReadAll(io.LimitReader(res.Body, extractMaxBytes))
		if err != nil {
			problemWithCode(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", "could not read that page", "could_not_read_that_page")
			return
		}
		base := res.Request.URL // the FINAL hop, so relative logo refs resolve correctly
		scan := scanBrandHTML(raw, base)

		// The model pass is judgment only: it can reorder and filter the
		// observed candidates, never invent colors, and any failure keeps the
		// deterministic frequency ranking.
		colors := scan.Colors
		if studio != nil && len(scan.Colors) > 0 {
			summary := fmt.Sprintf("Site: %s\nTitle: %s\nDescription: %s", base.Hostname(), scan.Title, scan.Description)
			if picked := studio.PickBrandColors(ctx, body.WorkspaceID, summary, scan.Colors); len(picked) > 0 {
				colors = picked
			}
		}
		if len(colors) > 6 {
			colors = colors[:6]
		}
		name := scan.Title
		if name == "" {
			name = base.Hostname()
		}
		// Empty buckets must serialize as [] (a nil slice marshals as JSON
		// null, and the client types these as arrays).
		if scan.LogoURLs == nil {
			scan.LogoURLs = []string{}
		}
		if colors == nil {
			colors = []string{}
		}
		if scan.Fonts == nil {
			scan.Fonts = []string{}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"name":     name,
			"logoUrls": scan.LogoURLs,
			"colors":   colors,
			"fonts":    scan.Fonts,
		})
	}
}
