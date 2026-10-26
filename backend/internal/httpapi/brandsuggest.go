// Brand identity suggestion for the brand guide wizard (#54).
// POST /ai/brand-suggest takes what the wizard already knows about a brand
// (name, description, the website scan's own words, colors, observed fonts,
// and optionally the logo image) and returns a DRAFT voice and type pairing.
// Like brand-from-url it never touches a brand kit: the user reviews the
// draft in the wizard before anything is saved.

package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/aistudio"
)

// The logo rides inline as a data URL or bare base64. Logos are small; 2 MiB
// of base64 covers a 1.5 MB image, and the client downsizes before sending.
const brandSuggestMaxBody = 2 << 20

var suggestHexRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func brandSuggestHandler(studio *aistudio.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID string   `json:"workspaceId"`
			Name        string   `json:"name"`
			Description string   `json:"description"`
			Headings    []string `json:"headings"`
			Colors      []string `json:"colors"`
			Fonts       []string `json:"fonts"`
			Logo        string   `json:"logo"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, brandSuggestMaxBody)).Decode(&body); err != nil || body.WorkspaceID == "" {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid brand suggestion request", "invalid_brand_suggest_request")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
			return
		}
		if studio == nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid AI request or no provider configured", "ai_not_configured")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), extractTimeout*4)
		defer cancel()

		var colors []string
		for _, c := range body.Colors {
			if c = strings.ToLower(strings.TrimSpace(c)); suggestHexRe.MatchString(c) && len(colors) < 8 {
				colors = append(colors, c)
			}
		}
		var page []string
		for _, h := range body.Headings {
			if h = clipText(strings.TrimSpace(h), 120); h != "" && len(page) < 6 {
				page = append(page, h)
			}
		}

		// The logo reading is optional twice over: no logo, or a provider
		// that cannot see images, simply means the suggestion goes without.
		logoNotes := ""
		if logo := strings.TrimSpace(body.Logo); logo != "" {
			if notes, err := studio.DescribeLogo(ctx, body.WorkspaceID, logo); err == nil {
				logoNotes = notes
			}
		}

		got, err := studio.SuggestBrandIdentity(ctx, body.WorkspaceID, aistudio.BrandIdentityInput{
			Name:          body.Name,
			Description:   body.Description,
			PageContext:   strings.Join(page, "\n"),
			LogoNotes:     logoNotes,
			Colors:        colors,
			ObservedFonts: body.Fonts,
		})
		if errors.Is(err, aistudio.ErrBrandIdentityEmpty) {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", err.Error(), "brand_suggest_needs_context")
			return
		}
		if err != nil {
			aiStudioProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"name": got.Name,
			"voice": map[string]any{
				"tone":       got.Tone,
				"doSay":      got.DoSay,
				"dontSay":    got.DontSay,
				"sampleCopy": got.SampleCopy,
			},
			"fonts":     map[string]string{"heading": got.HeadingFont, "body": got.BodyFont},
			"logoNotes": logoNotes,
		})
	}
}

// clipText trims s to at most n runes.
func clipText(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > n {
		return string(r[:n])
	}
	return string(r)
}
