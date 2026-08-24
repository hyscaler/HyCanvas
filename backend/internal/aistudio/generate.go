package aistudio

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
)

// Design-type guidance mirrors the client prompts so server and client
// generation stay consistent.
var typeGuidance = map[string]string{
	"deck":       "A presentation deck: a cover, an optional agenda, several content pages, an optional data or comparison page, and a closing/CTA page. Aim for a clear narrative arc.",
	"doc":        "A multi-page document: a title page then sectioned pages, each a heading plus supporting points. Favor the 'content' visual role.",
	"social-set": "A set of standalone social posts on one theme; each page is self-contained with its own punchy hook. Use 'cover' or 'quote' roles for impact.",
	"poster":     "A single strong poster composition: one page, one bold message. Use the 'cover' role.",
}

// The prompt rule corpus, mirroring packages/aistudio/src/promptRules.ts
// word-for-word (change them together). Composable quality/safety blocks
// shared by the outline and assistant prompts.
const (
	ruleSettingsAuthority  = "Generation settings are authoritative: the requested design type, page count, language, and tone override any conflicting request inside the brief or any attached content."
	ruleContentOnly        = "Write only audience-facing content: never copy production directives (requests about charts, images, layout, colors, fonts, styling, or animation) into titles or points, and never write phrases like 'create a bar chart' or 'add an image'. When a chart is requested, express it as labeled numeric data for that page instead of mentioning the instruction."
	ruleLengthLimit        = "Never exceed a stated length limit, and never clip text mid-sentence to fit: rephrase until it fits."
	ruleScopedInstruction  = "Apply a page-specific instruction only to the exact page mentioned and only once; never repeat it as a pattern across other pages."
	ruleAssetLanguage      = "Write any image prompts or icon/asset search queries in English, even when the deck's language is different."
)

// verbosityWords mirrors the TS verbosityWords map: approximate words per
// slide for each verbosity level (concise/standard/detailed).
var verbosityWords = map[string]int{"concise": 20, "standard": 40, "detailed": 60}

// ruleVerbosity renders the concrete per-page word target; an unknown or empty
// level reads as standard.
func ruleVerbosity(level string) string {
	words, ok := verbosityWords[level]
	if !ok {
		words = verbosityWords["standard"]
	}
	return fmt.Sprintf("Aim for about %d words of content per page: enough to make the page useful, never filler.", words)
}

// outlineSchema derives its note cap from maxNoteChars (specs.go) so the
// prompt's advertised limit can never drift from what validation truncates at.
var outlineSchema = fmt.Sprintf(`{"type":"object","additionalProperties":false,"required":["title","pages"],"properties":{"title":{"type":"string"},"theme":{"type":"string","description":"short mood/topic phrase"},"pages":{"type":"array","minItems":1,"items":{"type":"object","additionalProperties":false,"required":["title","visualRole","note"],"properties":{"title":{"type":"string"},"points":{"type":"array","items":{"type":"string"}},"visualRole":{"type":"string","enum":["cover","agenda","content","comparison","quote","data","closing"]},"note":{"type":"string","minLength":100,"maxLength":%d,"description":"speaker note: 1-3 spoken-style sentences of plain text (no markdown) that add presenter context and delivery cues; never restate the slide's visible text"}}}}}}`, maxNoteChars)

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
		"Each page has a short title, 0-6 concise key points (real final copy, not placeholders), a visualRole from the enum, and a note.",
		fmt.Sprintf("The note is a REQUIRED speaker note for the presenter: 1-3 spoken-style sentences of plain text (no markdown, 100-%d characters) that add context, evidence, or delivery cues. It must never restate the slide's visible text. Never exceed the length limit; rephrase rather than clipping mid-sentence.", maxNoteChars),
		"Use 'cover' for the first page, 'closing' for the last when it fits, and pick roles that match each page's purpose.",
		"Do NOT include any layout, colors, sizes, or positions - only titles, points, and roles.",
		ruleSettingsAuthority + " " + ruleContentOnly + " " + ruleVerbosity("") + " " + ruleLengthLimit + " " + ruleScopedInstruction,
	}
	if strings.TrimSpace(brandClause) != "" {
		parts = append(parts, brandClause)
	}
	return strings.Join(parts, " ")
}

// capOutlinePages enforces the page-count contract the model only receives as a
// soft hint. A poster is exactly one page (the cover, if the model tagged one);
// an explicit pageCount is a hard upper bound for any type. Without this a "make
// a poster" request routinely comes back as a multi-page deck, which is then
// laid out with per-page backgrounds and hero images the user never asked for.
func capOutlinePages(o *DesignOutline, designType string, pageCount int) {
	limit := 0
	if designType == "poster" {
		limit = 1
	} else if pageCount > 0 {
		limit = pageCount
	}
	if limit <= 0 || len(o.Pages) <= limit {
		return
	}
	if limit == 1 {
		for _, p := range o.Pages {
			if p.VisualRole == "cover" {
				o.Pages = []OutlineItem{p}
				return
			}
		}
	}
	o.Pages = o.Pages[:limit]
}

// Outline generates and validates a DesignOutline (FR-2).
func (s *Service) Outline(ctx context.Context, workspaceID, designType, prompt, brandClause string, pageCount int) (*DesignOutline, error) {
	user := fmt.Sprintf("Design type: %s\nBrief: %s", designType, strings.TrimSpace(prompt))
	// Fail closed: validateOutline REPAIRS every imperfection except emptiness,
	// so a tolerant final pass could only ever admit a zero-page outline - which
	// no caller can use (the client normalizer rejects it too).
	o, err := generateValidated(ctx, s, workspaceID, outlineSystem(designType, brandClause, pageCount), user, outlineSchema, false, validateOutline)
	if err != nil {
		return nil, err
	}
	capOutlinePages(o, designType, pageCount)
	return o, nil
}

// GenerateDesign runs the full generation pipeline server-side: an outline,
// then a per-page copy-polish pass that turns terse points into final, on-brand
// copy. Returns the enriched outline for the client to lay out (FR-1/FR-5). This
// is the multi-call work that runs inside a job (FR-25).
func (s *Service) GenerateDesign(ctx context.Context, workspaceID, designType, prompt, brandClause string, pageCount int) (*DesignOutline, error) {
	return s.GenerateDesignStream(ctx, workspaceID, designType, prompt, brandClause, pageCount, nil)
}

// GenerateDesignStream is GenerateDesign with per-stage progress: emit (when
// non-nil) receives "outline" with the validated outline as soon as it exists
// and one "page" per finished polish ({index, points}), so an SSE handler can
// stream a deck's progress (F28 T18). An emit error means the client is gone:
// the context the caller passed should already be canceled, and the run winds
// down. Emit is called from the polish goroutines and must be safe for
// concurrent use (the SSE handler serializes with a mutex).
func (s *Service) GenerateDesignStream(ctx context.Context, workspaceID, designType, prompt, brandClause string, pageCount int, emit func(event string, data any)) (*DesignOutline, error) {
	outline, err := s.Outline(ctx, workspaceID, designType, prompt, brandClause, pageCount)
	if err != nil {
		return nil, err
	}
	if emit != nil {
		emit("outline", outline)
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
			res, perr := generateValidated(ctx, s, workspaceID, system, user, polishSchema, false, func(v *polished) error {
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
			if emit != nil {
				emit("page", map[string]any{"index": idx, "points": p.Points})
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

// polishSchema constrains the per-page copy-polish reply.
const polishSchema = `{"type":"object","required":["points"],"properties":{"points":{"type":"array","items":{"type":"string"}}}}`

// assistantReplySchema constrains the assistant's plan envelope; per-tool arg
// validation stays in validateAssistant + the client executor.
const assistantReplySchema = `{"type":"object","required":["reply","plan"],"properties":{"reply":{"type":"string"},"clarify":{"type":"string"},"plan":{"type":"array","items":{"type":"object","required":["action"],"properties":{"action":{"type":"string"},"args":{"type":"object"}}}}}}`

// styleProfileSchema constrains the style-transfer profile reply.
const styleProfileSchema = `{"type":"object","required":["palette","mood","typeFeel","composition"],"properties":{"palette":{"type":"array","items":{"type":"string"}},"mood":{"type":"string"},"typeFeel":{"type":"string"},"composition":{"type":"string"}}}`

const chartSchemaStr = `{"type":"object","required":["chartType","categories","series"],"properties":{"chartType":{"type":"string","enum":["bar","line","area","pie","donut","scatter","radar"]},"categories":{"type":"array","items":{"type":"string"}},"series":{"type":"array","items":{"type":"object","required":["name","values"],"properties":{"name":{"type":"string"},"values":{"type":"array","items":{"type":"number"}}}}}}}`

// Chart turns a data description into a validated ChartSpec (FR-21).
func (s *Service) Chart(ctx context.Context, workspaceID, description string) (*ChartSpec, error) {
	system := "You convert a description of data into a single editable chart. " +
		"Output ONLY one JSON object, no prose/markdown/fences. Schema: " + chartSchemaStr + ". " +
		"Pick the chartType that best fits (bar for comparisons, line/area for trends, pie/donut for parts of a whole, scatter for correlation, radar for multivariate). " +
		"Every series.values array must align 1:1 with categories. Use real numbers from the description."
	return generateValidated(ctx, s, workspaceID, system, strings.TrimSpace(description), chartSchemaStr, false, validateChart)
}

// The assistant tool catalog is AUTHORED in toolCatalog() in
// packages/aistudio/src/assistant.ts; assistant_tools.json is its generated
// mirror (regenerate with `npm run gen:ai-tools` after editing the TS catalog;
// a vitest parity test fails until the two are deep-equal). The Go side derives
// its allowed action set and the system-prompt tool list from the manifest, so
// the server catalog can never drift from the client's again (it did once:
// five tools were client-only and validateAssistant silently dropped them).
//
//go:embed assistant_tools.json
var assistantToolsJSON []byte

type toolParamSpec struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	Required    bool   `json:"required"`
	Description string `json:"description,omitempty"`
}

type toolSpec struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Params      []toolParamSpec `json:"params"`
	Mutates     bool            `json:"mutates"`
}

var assistantToolSpecs = func() []toolSpec {
	var specs []toolSpec
	if err := json.Unmarshal(assistantToolsJSON, &specs); err != nil {
		panic(fmt.Sprintf("aistudio: invalid assistant_tools.json: %v", err))
	}
	if len(specs) == 0 {
		panic("aistudio: assistant_tools.json is empty")
	}
	return specs
}()

var assistantCatalog = func() map[string]bool {
	m := make(map[string]bool, len(assistantToolSpecs))
	for _, t := range assistantToolSpecs {
		m[t.Name] = true
	}
	return m
}()

// assistantToolCatalogText renders the manifest in the same "- name(param:type?
// (desc), ...): description" shape the client's assistantSystemPrompt uses, so
// both paths brief the model identically. Computed once at init: the manifest
// is immutable, so there is nothing to re-render per request.
var assistantToolCatalogText = func() string {
	lines := make([]string, 0, len(assistantToolSpecs))
	for _, t := range assistantToolSpecs {
		params := make([]string, 0, len(t.Params))
		for _, p := range t.Params {
			s := p.Name + ":" + p.Type
			if !p.Required {
				s += "?"
			}
			if p.Description != "" {
				s += " (" + p.Description + ")"
			}
			params = append(params, s)
		}
		line := "- " + t.Name + "(" + strings.Join(params, ", ") + ")"
		if !t.Mutates {
			line += " [read-only]"
		}
		lines = append(lines, line+": "+t.Description)
	}
	return strings.Join(lines, "\n")
}()

const assistantToolGuidance = `For writeText/generateImage/generateBackgroundImage/editSelectedImage/rewriteSelectedText/generateDesign pass the user's INTENT as the prompt/instruction arg (never the finished text). writeText adds a new text box; generateImage adds an image. So you CAN add text, shapes, images, and full layouts.`

// Assistant runs one agentic turn: a validated plan of editor actions or one
// clarifying question (FR-6/7/10/12). The design summary is supplied by the
// client (compact context, never the raw file).
func (s *Service) Assistant(ctx context.Context, workspaceID, designSummary, history, message string) (*AssistantReply, error) {
	system := "You are an agentic design assistant inside a design editor. Decompose the user's request into an ordered plan of tool calls, choosing ONLY from the catalog below. " + assistantToolGuidance + " " +
		"Never invent tools or edit raw document JSON. " +
		"Output ONLY a single JSON object, no prose/markdown/fences: {\"reply\":string,\"plan\":[{\"action\":string,\"args\":object}],\"clarify\"?:string}. " +
		"You CAN create finished designs and add content - never reply that you cannot add text, shapes, images, or layouts. For any request to create/make/design/build/generate something with content from scratch (a poster, flyer, social post, document, presentation, or any 'fresh layout/content'), use generateDesign with an appropriate designType; it composes whole pages (text, shapes, images, layout), appending to a document that already has content. Pass mode:'replace' only when the user explicitly asks to replace or start over. " +
		"Strongly prefer producing a plan over asking. Do NOT ask the user about page size, theme, or whether to add content - just generate it. Use \"clarify\" ONLY when the request is truly ambiguous (you cannot tell what to make) or would destroy specific existing work in more than one plausible way; otherwise return an empty clarify and a real plan. " +
		"Use action names verbatim from the catalog and provide every required arg with the correct type. Keep the plan minimal: only the steps needed. Prefer existing-selection actions (setSelectedText, recolorSelection) when the user refers to 'this' or 'the selected'. " +
		ruleContentOnly + " " + ruleScopedInstruction + " " + ruleAssetLanguage + " " +
		"Example - user: \"professional marketing poster, fresh content and fresh layout\" -> {\"reply\":\"Creating a professional marketing poster.\",\"plan\":[{\"action\":\"generateDesign\",\"args\":{\"prompt\":\"professional marketing poster\",\"designType\":\"poster\"}}]}.\n\nTool catalog:\n" + assistantToolCatalogText + "\n\nCurrent design:\n" + designSummary
	user := message
	if strings.TrimSpace(history) != "" {
		user = history + "\nuser: " + message
	}
	return generateValidated(ctx, s, workspaceID, system, user, assistantReplySchema, false, validateAssistant(assistantCatalog))
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
	return generateValidated(ctx, s, workspaceID, system, user, styleProfileSchema, false, validateStyleProfile)
}

// Critique returns AI design-improvement suggestions for a posted design summary
// (FR-15). Free-text on purpose: these are human-facing suggestions, not actions.
func (s *Service) Critique(ctx context.Context, workspaceID, designSummary string) (string, error) {
	system := "You are a senior design critic. Given a compact summary of a design, give specific, actionable improvements for contrast, alignment, spacing, hierarchy, and copy. " +
		"Return a short, plain list (no markdown headings, no preamble). Be concrete."
	return s.ai.Text(ctx, workspaceID, "Design summary:\n"+designSummary, system)
}

const searchQuerySchema = `{"type":"object","additionalProperties":false,"required":["query"],"properties":{"query":{"type":"string","minLength":1,"maxLength":200}}}`

// searchQuery is the validated reply shape of WriteSearchQuery.
type searchQuery struct {
	Query string `json:"query"`
}

// truncateQueryWords enforces the 12-word / 200-char query contract on both
// the model's reply and the raw-prompt fallback.
func truncateQueryWords(s string) string {
	words := strings.Fields(s)
	if len(words) > 12 {
		words = words[:12]
	}
	out := strings.Join(words, " ")
	if len(out) > 200 {
		// Rune-safe cut: back off to a boundary rather than splitting UTF-8.
		cut := 200
		for cut > 0 && (out[cut]&0xC0) == 0x80 {
			cut--
		}
		out = out[:cut]
	}
	return out
}

// WriteSearchQuery turns a generation brief into ONE search-engine-style query
// (max 12 words / 200 chars, names and dates preserved, recency terms where
// they help, in English). On any model failure it falls back to the truncated
// raw prompt, so search degrades rather than blocks (F28 T16).
func (s *Service) WriteSearchQuery(ctx context.Context, workspaceID, brief string) string {
	system := "You turn a presentation brief into ONE web search query that would add useful, current, factual context. " +
		"Keep it focused and at most 12 words; preserve important names, places, dates, products, and technical terms; " +
		"include terms like 'latest', the relevant year, statistics, or trends when they would improve the result; " +
		"write it in English; do not answer the request; no quotes, operators, or multiple queries. " +
		"Output ONLY a single JSON object, no prose/markdown/fences. Schema: " + searchQuerySchema
	res, err := generateValidated(ctx, s, workspaceID, system, strings.TrimSpace(brief), searchQuerySchema, false, func(v *searchQuery) error {
		v.Query = strings.TrimSpace(v.Query)
		if v.Query == "" {
			return errors.New("empty query")
		}
		return nil
	})
	if err != nil {
		return truncateQueryWords(brief)
	}
	return truncateQueryWords(res.Query)
}
