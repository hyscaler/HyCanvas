// Brand-color selection for the brand-kit-from-domain draft (F28 T21). The
// deterministic page scan surfaces every color the site actually uses; this
// one structured call is the judgment layer, separating the brand's palette
// from neutral page chrome using the page's own words (title, description).
// On any model failure the caller keeps the scan's frequency order, so the
// draft degrades rather than blocks.

package aistudio

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

const brandColorsSchema = `{"type":"object","additionalProperties":false,"required":["colors"],"properties":{"colors":{"type":"array","minItems":3,"maxItems":6,"items":{"type":"string","pattern":"^#[0-9a-fA-F]{6}$"}}}}`

type brandColorsReply struct {
	Colors []string `json:"colors"`
}

var brandHexRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// PickBrandColors chooses the 3..6 colors most plausibly belonging to the
// BRAND from the candidates a page scan observed (given with their sources),
// guided by the page's title and description. Returns nil on any failure;
// candidates outside the observed set are refused, so the model can only
// reorder and filter what the page really contained.
func (s *Service) PickBrandColors(ctx context.Context, workspaceID, pageSummary string, candidates []string) []string {
	if len(candidates) == 0 {
		return nil
	}
	allowed := make(map[string]bool, len(candidates))
	for _, c := range candidates {
		allowed[strings.ToLower(c)] = true
	}
	system := "You identify a company's brand colors from the colors observed on its web page. " +
		"Choose ONLY from the observed candidates; prefer distinctive brand hues over neutral page chrome (plain greys, near-white backgrounds, default link blue) " +
		"unless the brand is clearly monochrome; order from most to least defining; return 3 to 6 colors as 6-digit lowercase hex. " +
		"Output ONLY a single JSON object, no prose/markdown/fences. Schema: " + brandColorsSchema
	user := fmt.Sprintf("%s\n\nObserved candidate colors, most frequent first: %s", strings.TrimSpace(pageSummary), strings.Join(candidates, ", "))
	res, err := generateValidated(ctx, s, workspaceID, system, user, brandColorsSchema, false, func(v *brandColorsReply) error {
		out := make([]string, 0, len(v.Colors))
		seen := map[string]bool{}
		for _, c := range v.Colors {
			c = strings.ToLower(strings.TrimSpace(c))
			if !brandHexRe.MatchString(c) || !allowed[c] || seen[c] {
				continue
			}
			seen[c] = true
			out = append(out, c)
		}
		need := 3
		if len(candidates) < need {
			need = len(candidates)
		}
		if len(out) < need {
			return fmt.Errorf("selected %d valid candidate colors, need at least %d chosen from the observed list", len(out), need)
		}
		v.Colors = out
		return nil
	})
	if err != nil {
		return nil
	}
	return res.Colors
}
