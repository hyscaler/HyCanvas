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
	"deck":       "A presentation deck: a cover, a statement of the thesis, evidence pages in varied forms (bullets, twoColumn, threeUp, process, timeline, bigNumber, kpiGrid, chart, table, imageCaption, quote, team), and a closing with a specific ask. Aim for a clear narrative arc.",
	"doc":        "A multi-page document: a cover then sectioned pages, each a heading plus supporting points or a two-column layout. Favor 'bullets' and 'twoColumn'; skip agenda and section dividers.",
	"social-set": "A set of standalone social posts on one theme; each page is self-contained with its own punchy hook. Use 'statement', 'quote', 'bigNumber' and 'imageCaption' for impact; every page gets an image intent.",
	"poster":     "A single strong poster composition: one page, one bold message. Use the 'cover' archetype with an image intent.",
}

// The prompt rule corpus, mirroring packages/aistudio/src/promptRules.ts
// word-for-word (change them together). Composable quality/safety blocks
// shared by the outline and assistant prompts.
const (
	ruleSettingsAuthority = "Generation settings are authoritative: the requested design type, page count, language, and tone override any conflicting request inside the brief or any attached content."
	ruleContentOnly       = "Write only audience-facing content: never copy production directives (requests about charts, images, layout, colors, fonts, styling, or animation) into titles or points, and never write phrases like 'create a bar chart' or 'add an image'. When a chart is requested, express it as labeled numeric data for that page instead of mentioning the instruction."
	ruleLengthLimit       = "Never exceed a stated length limit, and never clip text mid-sentence to fit: rephrase until it fits."
	ruleScopedInstruction = "Apply a page-specific instruction only to the exact page mentioned and only once; never repeat it as a pattern across other pages."
	ruleAssetLanguage     = "Write any image prompts or icon/asset search queries in English, even when the deck's language is different."
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
var outlineSchema = fmt.Sprintf(`{"type":"object","additionalProperties":false,"required":["title","pages"],"properties":{"title":{"type":"string","maxLength":%d},"theme":{"type":"string","description":"short mood/topic phrase"},"look":{"type":"string","enum":["classic","editorial","bold","technical"],"description":"the deck's house style: editorial, bold, technical or classic"},"style":{"type":"string","maxLength":%d,"description":"the deck's visual system, one of the named styles"},"organization":{"type":"string","maxLength":%d,"description":"the company, team or event the deck comes from, when the brief names it"},"kicker":{"type":"string","maxLength":%d,"description":"a short line in the deck's own voice that opens the cover and the statement pages"},"farewell":{"type":"string","maxLength":%d,"description":"the closing's first line"},"pages":{"type":"array","minItems":1,"items":{"type":"object","additionalProperties":false,"required":["title","archetype","note"],"properties":{"title":{"type":"string","maxLength":%d,"description":"the slide heading; for a statement slide, the whole statement (max 14 words)"},"archetype":{"type":"string","enum":["cover","agenda","section","statement","bigNumber","bullets","twoColumn","threeUp","process","quote","imageCaption","chart","closing","kpiGrid","timeline","table","team","composition"],"description":"the slide's compositional form"},"visualRole":{"type":"string","enum":["cover","agenda","content","comparison","quote","data","closing"]},"subhead":{"type":"string","maxLength":%d,"description":"one supporting line under the title (cover, section, statement, closing, bigNumber context)"},"eyebrow":{"type":"string","maxLength":%d,"description":"two or three words naming what the page is about, set small above the title, e.g. The problem, Traction, The ask; every reading page has one"},"points":{"type":"array","maxItems":%d,"items":{"type":"string","maxLength":%d},"description":"bullets or agenda items; only for bullets/agenda"},"stat":{"type":"object","additionalProperties":false,"required":["value","label"],"properties":{"value":{"type":"string","maxLength":%d,"description":"the figure, e.g. 42%% or 3.2M"},"unit":{"type":"string","maxLength":%d},"label":{"type":"string","maxLength":%d,"description":"what the figure means"},"icon":{"type":"string","maxLength":%d,"description":"one English keyword naming a simple icon for the figure"}}},"icon":{"type":"string","maxLength":%d,"description":"one English keyword naming a simple icon for the page (bullets, statement, bigNumber, cover, section, closing), e.g. shield, clock, users, chart, leaf, globe, bolt, heart, coin, truck, calendar"},"quote":{"type":"object","additionalProperties":false,"required":["text"],"properties":{"text":{"type":"string","maxLength":%d},"attribution":{"type":"string","maxLength":%d}}},"steps":{"type":"array","minItems":2,"maxItems":%d,"items":{"type":"object","additionalProperties":false,"required":["label"],"properties":{"label":{"type":"string","maxLength":%d},"detail":{"type":"string","maxLength":%d},"when":{"type":"string","maxLength":%d,"description":"a short time marker for a timeline step, e.g. 2019, Q3, Week 2"},"icon":{"type":"string","maxLength":%d,"description":"one English keyword naming a simple icon for the step"}}}},"columns":{"type":"array","minItems":2,"maxItems":%d,"items":{"type":"object","additionalProperties":false,"required":["heading","points"],"properties":{"heading":{"type":"string","maxLength":%d},"points":{"type":"array","maxItems":%d,"items":{"type":"string","maxLength":%d}},"icon":{"type":"string","maxLength":%d,"description":"one English keyword naming a simple icon for the column, e.g. shield, clock, users, chart"}}}},"image":{"type":"object","additionalProperties":false,"required":["subject"],"properties":{"subject":{"type":"string","maxLength":%d,"description":"what the picture shows, IN ENGLISH, concrete and specific; no text in the image"},"treatment":{"type":"string","enum":["photo","illustration","abstract"]},"illustration":{"type":"string","maxLength":%d,"description":"one English keyword naming a flat drawing for the page instead of a photo, e.g. growth, handshake, rocket, target, security, chart, analysis, team, idea, money, logistics; use on covers, sections and closings of an internal or product deck"}}},"chart":{"type":"object","additionalProperties":false,"required":["kind","categories","series"],"properties":{"kind":{"type":"string","enum":["bar","line","pie","donut"]},"categories":{"type":"array","maxItems":%d,"items":{"type":"string"}},"series":{"type":"array","minItems":1,"maxItems":%d,"items":{"type":"object","additionalProperties":false,"required":["name","values"],"properties":{"name":{"type":"string"},"values":{"type":"array","items":{"type":"number"}}}}}}},"stats":{"type":"array","minItems":2,"maxItems":%d,"items":{"type":"object","additionalProperties":false,"required":["value","label"],"properties":{"value":{"type":"string","maxLength":%d},"unit":{"type":"string","maxLength":%d},"label":{"type":"string","maxLength":%d},"icon":{"type":"string","maxLength":%d,"description":"one English keyword naming a simple icon for the figure"}}},"description":"2-4 figures that belong together; only for kpiGrid"},"table":{"type":"object","additionalProperties":false,"required":["columns","rows"],"properties":{"columns":{"type":"array","minItems":1,"maxItems":%d,"items":{"type":"string","maxLength":%d}},"rows":{"type":"array","minItems":1,"maxItems":%d,"items":{"type":"array","items":{"type":"string","maxLength":%d}}}},"description":"a small table of real values from the brief or attached material; only for table"},"composition":{"type":"object","additionalProperties":false,"required":["cells"],"properties":{"cells":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"object","additionalProperties":false,"required":["col","span","row","rows","kind"],"properties":{"col":{"type":"integer","minimum":0,"maximum":11},"span":{"type":"integer","minimum":1,"maximum":12},"row":{"type":"integer","minimum":0,"maximum":5},"rows":{"type":"integer","minimum":1,"maximum":6},"kind":{"type":"string","enum":["heading","body","list","figure","label","icon","picture"]},"text":{"type":"string","maxLength":140},"points":{"type":"array","maxItems":4,"items":{"type":"string","maxLength":70}},"value":{"type":"string","maxLength":12},"unit":{"type":"string","maxLength":8},"icon":{"type":"string","maxLength":30},"tone":{"type":"string","enum":["plain","tint","accent","deep"]}}}},"links":{"type":"array","maxItems":8,"items":{"type":"array","minItems":2,"maxItems":2,"items":{"type":"integer","minimum":0}}}},"description":"a bespoke page: up to 8 cells placed on a 12-column by 6-row grid (col 0-11, span, row 0-5, rows), each a heading, body, list, figure, label, icon or picture with an optional tone (tint, accent, deep) that paints a panel behind it; links are pairs of cell indexes drawn as arrows; cells never overlap; only for composition, and only when no catalog form fits"},"aside":{"type":"string","maxLength":%d,"description":"a hand-written remark in the presenter's voice beside the content; about one page in three; never restates the slide"},"drawing":{"type":"string","maxLength":%d,"description":"one keyword naming a full-colour drawing for the page, from the named list"},"signature":{"type":"string","enum":["scoreboard","beforeAfter","funnel","ledger","stickyWall","matrix","runOfShow","poll","definition","healthGrid"],"description":"a form built for this page's content; at most one page per deck"},"pairs":{"type":"array","maxItems":%d,"items":{"type":"object","additionalProperties":false,"required":["label","value"],"properties":{"label":{"type":"string","maxLength":%d},"value":{"type":"string","maxLength":%d}}},"description":"labels and values for a signature form (ledger lines, poll bars, health statuses, funnel figures) or kpiGrid deltas"},"people":{"type":"array","minItems":1,"maxItems":%d,"items":{"type":"object","additionalProperties":false,"required":["name"],"properties":{"name":{"type":"string","maxLength":%d},"role":{"type":"string","maxLength":%d}}},"description":"the people on a team slide; only for team"},"note":{"type":"string","minLength":100,"maxLength":%d,"description":"speaker note: 1-3 spoken-style sentences of plain text (no markdown) that add presenter context and delivery cues; never restate the slide's visible text"}}}}}}`,
	maxTitleChars, maxStyleChars, maxOrgChars, maxKickerChars, maxFarewellChars, maxTitleChars, maxSubheadChars, maxEyebrowChars, maxPoints, maxPointChars,
	maxStatValueChars, maxStatUnitChars, maxStatLabelChars, maxColIcon, maxColIcon, maxQuoteChars, maxAttribChars,
	maxSteps, maxStepLabelChars, maxStepDetail, maxStepWhen, maxColIcon, maxColumns, maxColHeadChars, maxColPoints, maxPointChars, maxColIcon,
	maxImageSubject, maxColIcon, maxChartCats, maxChartSeries,
	maxStats, maxStatValueChars, maxStatUnitChars, maxStatLabelChars, maxColIcon,
	maxTableCols, maxTableCell, maxTableRows, maxTableCell,
	maxAsideChars, maxDrawingChars, maxPairs, maxPairLabelChars, maxPairValueChars,
	maxPeople, maxPersonName, maxPersonRole, maxNoteChars)

func outlineSystem(designType, brandClause string, pageCount int) string {
	guide := typeGuidance[designType]
	if guide == "" {
		guide = typeGuidance["deck"]
	}
	count := ""
	if pageCount > 0 {
		count = fmt.Sprintf("Aim for about %d pages. ", pageCount)
	}
	kitClause := ""
	if designType == "deck" || designType == "" {
		kitClause = kitVocabularyRule
	}
	parts := []string{
		"You are a senior presentation designer and content strategist. You plan a deck the way a designer does: story first, then one compositional form per slide, then copy written to fit that form.",
		"Plan this design as an editable outline. " + guide,
		count + CapacityClause(designType) + " Output ONLY a single JSON object, no prose, no markdown, no code fences.",
		"Schema: " + outlineSchema + ".",
		// The archetype catalog. Named forms are what let the composer put a
		// number at display scale or two columns side by side; a bullet list
		// can only ever be a bullet list.
		"Every page names an archetype, its compositional form: " +
			"'cover' (title + subhead); 'agenda' (title + 3-6 points naming the sections to come, in order; only for decks of 6 or more pages); 'section' (a divider: short title, optional subhead); " +
			"'statement' (ONE idea as the title, at most 14 words, optional subhead; no points); " +
			"'bigNumber' (stat.value + stat.label, optional subhead as context; the figure is the slide); " +
			"'bullets' (title + 3-5 points, each a complete thought under 90 characters); " +
			"'twoColumn' (title + exactly 2 columns, each heading + 2-4 points; for comparisons and before/after); " +
			"'threeUp' (title + exactly 3 columns, each heading + 1-3 points; for features, pillars, options); " +
			"'process' (title + 3-5 steps, each label + detail; ONLY for a real sequence); " +
			"'quote' (quote.text + attribution); 'imageCaption' (title + image.subject + subhead as caption; the picture carries the slide); " +
			"'chart' (title + chart with real numbers from the brief or attached material; never invent data); " +
			"'kpiGrid' (title + 2-4 stats, each value + label; several figures that belong together); " +
			"'timeline' (title + 3-5 steps, each with a short 'when' such as a year or quarter, a label and a detail; for history and roadmaps); " +
			"'table' (title + table.columns and table.rows with real values from the brief or attached material; 2-4 columns, up to 6 rows; never invent data); " +
			"'team' (title + 1-4 people, each name + role; no pictures are generated for people); 'composition' (a bespoke page for what no other form holds: a diagram, a comparison built from shapes, a page that is one typographic gesture; up to 8 cells on a 12-column by 6-row grid, each a heading, body, list, figure, label, icon or picture with an optional tone of tint, accent or deep, cells never overlapping, and optional links drawn as arrows between cells; at most one per deck); " +
			"'closing' (title + subhead as the call to action). " +
			"Every page except the cover names an 'eyebrow': two or three words saying what the page is about (The problem, What we tried, Traction, The ask), set small above the title. " +
			"Icons: a column, a kpiGrid stat, a timeline step, and a bullets, statement, bigNumber, cover, section or closing page may each name an 'icon', one English keyword for a simple icon (shield, clock, users, chart, leaf, globe, bolt, heart, coin, truck, calendar, rocket, target, star, lock, cloud); name one for every item in a set or for none, and name one for most pages that can carry one.",
		// Story arc and rhythm. These are the rules a good deck follows and a
		// generated one never did: a thesis, evidence in varied forms, pacing.
		"Plan a narrative arc before choosing forms: open with the cover, state the thesis as a 'statement' early, build with evidence, and end with a 'closing' that asks for something specific. " +
			"Vary the forms: no more than 40 percent of pages may be 'bullets'; never place the same archetype on two adjacent pages except 'bullets' at most twice in a row; " +
			"use 'bigNumber' whenever the brief or attached material contains a meaningful quantity, 'kpiGrid' when two to four figures belong together, 'timeline' for dated history or a roadmap, and 'table' when the material is a small grid of real values; use 'section' dividers only for decks of 10 or more pages; " +
			"give an 'image' intent to every 'cover', 'imageCaption', 'section' and 'closing' page and to about half of the rest, with a concrete English subject and consistent treatment across the deck; for an internal, product or plan deck, name an 'illustration' keyword on the cover, sections and closing (growth, handshake, rocket, target, security, chart, analysis, team, idea, money, logistics, calendar, map) so a flat drawing stands in for the photo. Name a 'look' for the whole deck: 'editorial' (serif display, hairline rules, paper grounds; for stories, reports, culture, heritage, luxury), 'bold' (colour fields, giant numerals, heavy sans; for launches, campaigns, sport, youth, sales), 'technical' (a visible grid, mono labels, square corners; for engineering, data, infrastructure, developer audiences) or 'classic' (the balanced default); the subject and audience decide, not the mood words alone.",
		"Write copy to fit the form: a title is a headline (under 60 characters), never a sentence with a full stop; points are parallel in structure and start with the same part of speech; a statement is one idea, not a summary; a stat.label says what the number means in plain words. Never write 'Slide 1', 'Introduction' or other structural labels as content. Never use a dash as a separator anywhere in slide copy (titles, subheads, points, labels); use a colon or a new sentence. A stat.value is the bare figure (42%, 3.2M, 312): no arrows, no words, no plus or minus for direction; the label says whether it rose or fell. Every figure comes from the brief or the attached material, exactly as given; never invent, round or extrapolate a number. Set every title, subhead, label and eyebrow in sentence case (the first word and proper nouns capitalized), never in Title Case. An eyebrow is a label of at most 24 characters and a stat label at most 60; a title under 60. Write to fit: copy over a budget is cut at a word, never rephrased. Data-heavy material is split across several table or chart pages, at most eight rows or twelve categories each, never one dense page; a table cell is at most 60 characters.",
		// The kit's vocabulary: the style the deck is set in, its voice, the
		// drawings and the one signature form. Generated from the composer
		// package (kitvocab_gen.go) and held identical to kit/vocab.ts by test.
		// Only a deck is set by the kit, so only a deck's prompt carries it.
		kitClause,
		fmt.Sprintf("The note is a REQUIRED speaker note for the presenter: 1-3 spoken-style sentences of plain text (no markdown, 100-%d characters) that add context, evidence, or delivery cues. It must never restate the slide's visible text. Never exceed the length limit; rephrase rather than clipping mid-sentence.", maxNoteChars),
		"Do NOT include any layout, colors, sizes, or positions. The archetype is the only visual decision you make; the composer owns geometry.",
		ruleSettingsAuthority + " " + ruleContentOnly + " " + ruleVerbosity("") + " " + ruleLengthLimit + " " + ruleScopedInstruction,
	}
	if strings.TrimSpace(brandClause) != "" {
		parts = append(parts, brandClause)
	}
	kept := parts[:0]
	for _, part := range parts {
		if part != "" {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, " ")
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

// ShortenPage asks the model for shorter copy for ONE page whose text the
// composer could not fit, and returns the page with that copy in place. This
// is the second pass the reviewer's report can request, and the only one:
// the budgets and the ladder guarantee an archetype page always fits, so this
// fires for authored template slots that are smaller than the budgets assume.
//
// The reply is normalized like any outline page, so the shortened copy is
// clipped to the budgets and a typed payload that did not survive downgrades
// the form. The archetype itself is kept: shortening changes words, not the
// slide. A failed or useless reply returns the page unchanged, never an error
// that would fail the whole generation over one slide.
func (s *Service) ShortenPage(ctx context.Context, workspaceID string, page OutlineItem, brandClause string) OutlineItem {
	system := "You shorten the copy of ONE presentation slide so it fits its layout. Keep every idea and every number; cut words, not meaning. " +
		"Return the same JSON shape you are given with the same archetype, with roughly 30 percent fewer characters in every text field: title, subhead, points, columns, steps, quote. " +
		"Output ONLY a single JSON object, no prose or fences. " + ruleContentOnly + " " + ruleLengthLimit
	if strings.TrimSpace(brandClause) != "" {
		system += " " + brandClause
	}
	current, err := json.Marshal(page)
	if err != nil {
		return page
	}
	res, err := generateValidated(ctx, s, workspaceID, system, "Slide JSON:\n"+string(current), shortenSchema, false, func(v *OutlineItem) error {
		if strings.TrimSpace(v.Title) == "" && len(v.Points) == 0 && v.Stat == nil && v.Quote == nil && len(v.Columns) == 0 && len(v.Steps) == 0 && len(v.Stats) == 0 && v.Table == nil && len(v.People) == 0 {
			return errors.New("the shortened slide has no content")
		}
		return nil
	})
	if err != nil || res == nil {
		return page
	}
	out := *res
	out.Archetype = page.Archetype
	out.VisualRole = page.VisualRole
	if out.Note == "" {
		out.Note = page.Note
	}
	if out.Image == nil {
		out.Image = page.Image
	}
	if out.Chart == nil {
		out.Chart = page.Chart
	}
	if len(out.Stats) == 0 {
		out.Stats = page.Stats
	}
	if out.Table == nil {
		out.Table = page.Table
	}
	if len(out.People) == 0 {
		out.People = page.People
	}
	if out.Icon == "" {
		out.Icon = page.Icon
	}
	if out.Eyebrow == "" {
		out.Eyebrow = page.Eyebrow
	}
	// The kit's voice and vocabulary are not copy to shorten; they ride through.
	if out.Aside == "" {
		out.Aside = page.Aside
	}
	if out.Drawing == "" {
		out.Drawing = page.Drawing
	}
	if out.Signature == "" {
		out.Signature = page.Signature
	}
	if len(out.Pairs) == 0 {
		out.Pairs = page.Pairs
	}
	normalizeArchetypeFields(&out)
	// A downgrade would mean the shortened reply dropped a payload the form
	// needs; that is a worse slide than a slightly long one.
	if out.Archetype != page.Archetype {
		return page
	}
	return out
}

// shortenSchema is the outline page shape, reused for a single-slide rewrite.
var shortenSchema = `{"type":"object","required":["title","archetype"],"properties":{"title":{"type":"string"},"archetype":{"type":"string"},"subhead":{"type":"string"},"points":{"type":"array","items":{"type":"string"}},"stat":{"type":"object"},"quote":{"type":"object"},"steps":{"type":"array"},"columns":{"type":"array"},"stats":{"type":"array"},"table":{"type":"object"},"people":{"type":"array"},"note":{"type":"string"}}}`

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

const assistantToolGuidance = `For writeText/generateImage/generateBackgroundImage/editSelectedImage/rewriteSelectedText/generateDesign pass the user's INTENT as the prompt/instruction arg (never the finished text). writeText adds a new text box; generateImage adds an image. So you CAN add text, shapes, images, and full layouts. An image the user attached to the message is context for the request (a screenshot of the design, a reference) unless the message explicitly asks to add, insert, put or use the picture in the design; only then plan placeAttachedImage, and never generateImage in its place.`

// Assistant runs one agentic turn: a validated plan of editor actions or one
// clarifying question (FR-6/7/10/12). The design summary is supplied by the
// client (compact context, never the raw file).
func (s *Service) Assistant(ctx context.Context, workspaceID, designSummary, history, message string) (*AssistantReply, error) {
	system := "You are an agentic design assistant inside a design editor. Decompose the user's request into an ordered plan of tool calls, choosing ONLY from the catalog below. " + assistantToolGuidance + " " +
		"Never invent tools or edit raw document JSON. " +
		"Output ONLY a single JSON object, no prose/markdown/fences: {\"reply\":string,\"plan\":[{\"action\":string,\"args\":object}],\"clarify\"?:string}. " +
		"You CAN create finished designs and add content - never reply that you cannot add text, shapes, images, or layouts. For any request to create/make/design/build/generate something with content from scratch (a poster, flyer, social post, document, presentation, or any 'fresh layout/content'), use generateDesign with an appropriate designType; it composes whole pages (text, shapes, images, layout), appending to a document that already has content. Pass mode:'replace' only when the user explicitly asks to replace or start over. " +
		"Strongly prefer producing a plan over asking. Do NOT ask the user about page size, theme, or whether to add content - just generate it. Use \"clarify\" ONLY when the request is truly ambiguous (you cannot tell what to make) or would destroy specific existing work in more than one plausible way; otherwise return an empty clarify and a real plan. " +
		"One exception - a short creation interview for thin briefs: when the user asks for a complete multi-page design (generateDesign for a deck or doc) with a thin brief (about 10 words or fewer), no attached sources, and no earlier clarifying answers in the history, FIRST return one \"clarify\" message asking up to 3 short questions (audience, goal, tone or must-include content) and note they can reply 'just generate' to skip. Once the history contains answers, or the user says 'just generate' in any language, return the plan and fold every answer from the history into the generateDesign prompt. " +
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
