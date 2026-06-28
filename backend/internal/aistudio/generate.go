package aistudio

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

// Design-type guidance mirrors the client prompts so server and client
// generation stay consistent.
var typeGuidance = map[string]string{
	"deck":       "A presentation deck: a cover, an optional agenda, several content pages, an optional data/comparison page, and a closing/CTA page. Aim for a clear narrative arc.",
	"doc":        "A multi-page document: a title page then sectioned pages, each a heading plus supporting points. Favor the 'content' visual role.",
	"social-set": "A set of standalone social posts on one theme; each page is self-contained with its own punchy hook.",
	"poster":     "A single strong poster composition: one page, one bold message. Use the 'cover' role.",
}

const outlineSchema = `{"type":"object","required":["title","pages"],"properties":{"title":{"type":"string"},"theme":{"type":"string"},"pages":{"type":"array","items":{"type":"object","required":["title","visualRole"],"properties":{"title":{"type":"string"},"points":{"type":"array","items":{"type":"string"}},"visualRole":{"type":"string","enum":["cover","agenda","content","comparison","quote","data","closing"]}}}}}}`

func outlineSystem(designType, brandClause string, pageCount int) string {
	guide := typeGuidance[designType]
	if guide == "" {
		guide = typeGuidance["deck"]
	}
	count := ""
	if pageCount > 0 {
		count = fmt.Sprintf("Aim for about %d pages. ", pageCount)
	}
	parts := []string{
		"You are an expert content strategist and presentation designer.",
		"Plan the structure of this design as an editable outline. " + guide,
		count + "Output ONLY a single JSON object, no prose, no markdown, no code fences.",
		"Schema: " + outlineSchema + ".",
		"Each page has a short title, 0-6 concise key points (real final copy, not placeholders), and a visualRole from the enum.",
		"Use 'cover' for the first page and 'closing' for the last when it fits.",
		"Do NOT include any layout, colors, sizes, or positions - only titles, points, and roles.",
	}
	if strings.TrimSpace(brandClause) != "" {
		parts = append(parts, brandClause)
	}
	return strings.Join(parts, " ")
}

// Outline generates and validates a DesignOutline (FR-2).
func (s *Service) Outline(ctx context.Context, workspaceID, designType, prompt, brandClause string, pageCount int) (*DesignOutline, error) {
	user := fmt.Sprintf("Design type: %s\nBrief: %s", designType, strings.TrimSpace(prompt))
	return generateValidated(ctx, s, workspaceID, outlineSystem(designType, brandClause, pageCount), user, validateOutline)
}

// GenerateDesign runs the full generation pipeline server-side: an outline,
// then a per-page copy-polish pass that turns terse points into final, on-brand
// copy. Returns the enriched outline for the client to lay out (FR-1/FR-5). This
// is the multi-call work that runs inside a job (FR-25).
func (s *Service) GenerateDesign(ctx context.Context, workspaceID, designType, prompt, brandClause string, pageCount int) (*DesignOutline, error) {
	outline, err := s.Outline(ctx, workspaceID, designType, prompt, brandClause, pageCount)
	if err != nil {
		return nil, err
	}
	// Polish each page's copy. The in-process job runs synchronously (per the
	// platform convention), so to keep total latency near one round-trip rather
	// than N sequential ones, polish pages CONCURRENTLY with a bounded pool. Each
	// goroutine writes only its own page index (distinct memory; no data race),
	// and any failure falls back to the original points so one bad page never
	// aborts the whole deck.
	const maxConcurrent = 4
	sem := make(chan struct{}, maxConcurrent)
	var wg sync.WaitGroup
	for i := range outline.Pages {
		if len(outline.Pages[i].Points) == 0 {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(idx int) {
			defer wg.Done()
			defer func() { <-sem }()
			p := &outline.Pages[idx]
			system := "You are a senior copywriter. Tighten the following slide bullet points into crisp, final, presentation-ready lines. " +
				"Return ONLY a JSON object {\"points\":[\"...\"]} with the same number of lines, no prose or fences. " + brandClause
			user := fmt.Sprintf("Slide title: %s\nPoints:\n- %s", p.Title, strings.Join(p.Points, "\n- "))
			type polished struct {
				Points []string `json:"points"`
			}
			res, perr := generateValidated(ctx, s, workspaceID, system, user, func(v *polished) error {
				clean := v.Points[:0]
				for _, t := range v.Points {
					if strings.TrimSpace(t) != "" {
						clean = append(clean, strings.TrimSpace(t))
					}
				}
				v.Points = clean
				if len(v.Points) == 0 {
					return fmt.Errorf("no polished points")
				}
				return nil
			})
			if perr == nil && len(res.Points) > 0 {
				p.Points = res.Points
			}
		}(i)
	}
	wg.Wait()
	return outline, nil
}

// Variations generates N meaningfully different outline options for one brief
// (FR-4), each from a distinct angle.
func (s *Service) Variations(ctx context.Context, workspaceID, designType, prompt, brandClause string, count int) ([]*DesignOutline, error) {
	if count < 1 {
		count = 1
	}
	if count > 5 {
		count = 5
	}
	angles := []string{
		"Take a bold, benefit-led angle.",
		"Take a data-and-credibility angle.",
		"Take a story/emotional angle.",
		"Take a concise, minimalist angle.",
		"Take a problem-then-solution angle.",
	}
	out := make([]*DesignOutline, 0, count)
	for i := 0; i < count; i++ {
		o, err := s.Outline(ctx, workspaceID, designType, prompt+"\nVariation guidance: "+angles[i%len(angles)], brandClause, 0)
		if err != nil {
			if len(out) > 0 {
				break // keep partial variations rather than failing the whole request
			}
			return nil, err
		}
		out = append(out, o)
	}
	return out, nil
}

const chartSchemaStr = `{"type":"object","required":["chartType","categories","series"],"properties":{"chartType":{"type":"string","enum":["bar","line","area","pie","donut","scatter","radar"]},"categories":{"type":"array","items":{"type":"string"}},"series":{"type":"array","items":{"type":"object","required":["name","values"],"properties":{"name":{"type":"string"},"values":{"type":"array","items":{"type":"number"}}}}}}}`

// Chart turns a data description into a validated ChartSpec (FR-21).
func (s *Service) Chart(ctx context.Context, workspaceID, description string) (*ChartSpec, error) {
	system := "You convert a description of data into a single editable chart. " +
		"Output ONLY one JSON object, no prose/markdown/fences. Schema: " + chartSchemaStr + ". " +
		"Pick the chartType that best fits (bar for comparisons, line/area for trends, pie/donut for parts of a whole, scatter for correlation, radar for multivariate). " +
		"Every series.values array must align 1:1 with categories. Use real numbers from the description."
	return generateValidated(ctx, s, workspaceID, system, strings.TrimSpace(description), validateChart)
}

const assistantTools = `addPage, duplicatePage, setPageBackground(color,color2?,angle?), setSelectedText(text), recolorSelection(color), applyBrand, harmonize, tidyLayout, animatePage, insertChart(chartType,categories,series), resizePage(width,height), writeText(prompt), rewriteSelectedText(instruction), generateImage(prompt,style?), generateBackgroundImage(prompt), editSelectedImage(instruction), generateDesign(prompt,designType?,pageCount?,mode?), critique. For writeText/generateImage/generateBackgroundImage/editSelectedImage/rewriteSelectedText/generateDesign pass the user's INTENT as the prompt/instruction arg (never the finished text). generateDesign CREATES a complete, finished design from scratch - a single poster, flyer, social post, or document, or a multi-page deck - with all text, shapes, images, and layout composed for you (designType: deck|doc|social-set|poster). writeText adds a new text box; generateImage adds an image. So you CAN add text, shapes, images, and full layouts.`

var assistantCatalog = func() map[string]bool {
	names := []string{"addPage", "duplicatePage", "setPageBackground", "setSelectedText", "recolorSelection", "applyBrand", "harmonize", "tidyLayout", "animatePage", "insertChart", "resizePage", "writeText", "rewriteSelectedText", "generateImage", "generateBackgroundImage", "editSelectedImage", "generateDesign", "critique"}
	m := make(map[string]bool, len(names))
	for _, n := range names {
		m[n] = true
	}
	return m
}()

// Assistant runs one agentic turn: a validated plan of editor actions or one
// clarifying question (FR-6/7/10/12). The design summary is supplied by the
// client (compact context, never the raw file).
func (s *Service) Assistant(ctx context.Context, workspaceID, designSummary, history, message string) (*AssistantReply, error) {
	system := "You are an agentic design assistant inside a design editor. Decompose the user's request into an ordered plan of tool calls, choosing ONLY from this catalog: " + assistantTools + ". " +
		"Never invent tools or edit raw document JSON. " +
		"Output ONLY a single JSON object, no prose/markdown/fences: {\"reply\":string,\"plan\":[{\"action\":string,\"args\":object}],\"clarify\"?:string}. " +
		"You CAN create finished designs and add content - never reply that you cannot add text, shapes, images, or layouts. For any request to create/make/design/build/generate something with content from scratch (a poster, flyer, social post, document, presentation, or any 'fresh layout/content'), use generateDesign with an appropriate designType; it composes the whole page (text, shapes, images, layout) and replaces the current page(s). " +
		"Strongly prefer producing a plan over asking. Do NOT ask the user about page size, theme, or whether to add content - just generate it. Use \"clarify\" ONLY when the request is truly ambiguous (you cannot tell what to make) or would destroy specific existing work in more than one plausible way; otherwise return an empty clarify and a real plan. Keep the plan minimal. " +
		"Example - user: \"professional marketing poster, fresh content and fresh layout\" -> {\"reply\":\"Creating a professional marketing poster.\",\"plan\":[{\"action\":\"generateDesign\",\"args\":{\"prompt\":\"professional marketing poster\",\"designType\":\"poster\"}}]}.\n\nCurrent design:\n" + designSummary
	user := message
	if strings.TrimSpace(history) != "" {
		user = history + "\nuser: " + message
	}
	return generateValidated(ctx, s, workspaceID, system, user, validateAssistant(assistantCatalog))
}

// StyleProfile extracts a style profile (palette + feel) from a reference
// description and/or seed colors for style transfer (FR-18).
func (s *Service) StyleProfile(ctx context.Context, workspaceID, referenceText string, seedPalette []string) (*StyleProfile, error) {
	system := "You extract a visual style profile from a description and seed colors. " +
		"Output ONLY a JSON object {\"palette\":[\"#rrggbb\",...],\"mood\":string,\"typeFeel\":string,\"composition\":string}, no prose/fences. " +
		"palette: 3-6 hex colors that capture the look; mood: a few adjectives; typeFeel: e.g. 'geometric sans, tight tracking'; composition: e.g. 'centered, generous whitespace'."
	user := "Reference: " + strings.TrimSpace(referenceText)
	if len(seedPalette) > 0 {
		user += "\nSeed colors: " + strings.Join(seedPalette, ", ")
	}
	return generateValidated(ctx, s, workspaceID, system, user, validateStyleProfile)
}

// Critique returns AI design-improvement suggestions for a posted design summary
// (FR-15). Free-text on purpose: these are human-facing suggestions, not actions.
func (s *Service) Critique(ctx context.Context, workspaceID, designSummary string) (string, error) {
	system := "You are a senior design critic. Given a compact summary of a design, give specific, actionable improvements for contrast, alignment, spacing, hierarchy, and copy. " +
		"Return a short, plain list (no markdown headings, no preamble). Be concrete."
	return s.ai.Text(ctx, workspaceID, "Design summary:\n"+designSummary, system)
}
