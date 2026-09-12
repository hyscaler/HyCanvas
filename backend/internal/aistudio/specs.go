package aistudio

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"
)

// These mirror the @hc/aistudio TypeScript types. Only validation lives here
// (not layout), so the contract is enforced on both sides.

var visualRoles = map[string]bool{
	"cover": true, "agenda": true, "content": true,
	"comparison": true, "quote": true, "data": true, "closing": true,
}

var chartTypes = map[string]bool{
	"bar": true, "line": true, "area": true, "pie": true, "donut": true, "scatter": true, "radar": true,
}

// OutlineItem is one page of a generated design outline.
type OutlineItem struct {
	Title      string   `json:"title"`
	Points     []string `json:"points"`
	VisualRole string   `json:"visualRole"`
	// Note is the page's speaker note: 1-3 spoken-style plain-text sentences
	// adding presenter context and delivery cues, never a restatement of the
	// slide text. Optional so older clients and replies keep validating.
	Note string `json:"note,omitempty"`

	// Archetype is the slide's compositional form, chosen by the model as part
	// of planning the story rather than inferred from bullets afterwards. Every
	// field below is optional and additive: an older client ignores them and
	// still validates, and a reply that omits them normalizes to the archetype
	// its visualRole implies. Budgets are enforced in validateOutline so the
	// composer can trust the lengths it receives.
	Archetype string       `json:"archetype,omitempty"`
	Subhead   string       `json:"subhead,omitempty"`
	Stat      *Stat        `json:"stat,omitempty"`
	Quote     *Quote       `json:"quote,omitempty"`
	Steps     []Step       `json:"steps,omitempty"`
	Columns   []Column     `json:"columns,omitempty"`
	Image     *ImageIntent `json:"image,omitempty"`
	Chart     *ChartData   `json:"chart,omitempty"`
}

// Stat is the content of a big-number slide: one figure at display scale, its
// unit, and the line that says what it means.
type Stat struct {
	Value string `json:"value"`
	Unit  string `json:"unit,omitempty"`
	Label string `json:"label"`
}

// Quote is a pull quote with its source.
type Quote struct {
	Text        string `json:"text"`
	Attribution string `json:"attribution,omitempty"`
}

// Step is one stage of a process slide. Steps are the one place numbering is
// information rather than decoration: the content IS a sequence.
type Step struct {
	Label  string `json:"label"`
	Detail string `json:"detail,omitempty"`
}

// Column is one side of a comparison or one cell of a three-up.
type Column struct {
	Heading string   `json:"heading"`
	Points  []string `json:"points"`
}

// ImageIntent is what the picture on a slide should show and how it should be
// treated. Subject is written in English regardless of the deck's language, so
// the image pipeline can route it to stock or generation.
type ImageIntent struct {
	Subject   string `json:"subject"`
	Treatment string `json:"treatment,omitempty"` // photo | illustration | abstract
}

// ChartData is a small dataset for a chart slide, in the shape the chart node
// takes: categories along one axis, one or more named series of values
// (ChartSeries is shared with the chart tool below).
type ChartData struct {
	Kind       string        `json:"kind"` // bar | line | pie | donut
	Categories []string      `json:"categories"`
	Series     []ChartSeries `json:"series"`
}

// archetypes is the set the model may choose from. Mirrors `archetypes` in
// packages/aistudio/src/outline.ts; change them together.
var archetypes = map[string]bool{
	"cover": true, "agenda": true, "section": true, "statement": true, "bigNumber": true,
	"bullets": true, "twoColumn": true, "threeUp": true, "process": true, "quote": true,
	"imageCaption": true, "chart": true, "closing": true,
}

// archetypeForRole is the default form for a page that named only a visual
// role, which is every page from a client or model predating archetypes.
var archetypeForRole = map[string]string{
	"cover": "cover", "agenda": "agenda", "content": "bullets", "comparison": "twoColumn",
	"quote": "quote", "data": "bigNumber", "closing": "closing",
}

// roleForArchetype keeps visualRole populated for readers that still key on
// it (page treatment, older layout preference tables).
var roleForArchetype = map[string]string{
	"cover": "cover", "agenda": "agenda", "section": "content", "statement": "content",
	"bigNumber": "data", "bullets": "content", "twoColumn": "comparison", "threeUp": "content",
	"process": "content", "quote": "quote", "imageCaption": "content", "chart": "data", "closing": "closing",
}

// Content budgets, in characters. The composer sizes type from slot geometry
// and steps down a ladder when copy runs long; these caps are where "runs long"
// stops being the composer's problem and becomes the writer's. Mirrored in
// outline.ts as archetypeBudgets.
const (
	maxTitleChars     = 60
	maxSubheadChars   = 120
	maxStatementChars = 90
	maxPointChars     = 90
	maxPoints         = 5
	maxStatValueChars = 12
	maxStatUnitChars  = 8
	maxStatLabelChars = 60
	maxQuoteChars     = 200
	maxAttribChars    = 60
	maxSteps          = 5
	maxStepLabelChars = 30
	maxStepDetail     = 90
	maxColumns        = 3
	maxColHeadChars   = 40
	maxColPoints      = 4
	maxImageSubject   = 140
	maxChartCats      = 8
	maxChartSeries    = 3
)

// DesignOutline is the editable plan returned by the outline endpoint.
type DesignOutline struct {
	Title string        `json:"title"`
	Theme string        `json:"theme"`
	Pages []OutlineItem `json:"pages"`
}

func validateOutline(o *DesignOutline) error {
	if strings.TrimSpace(o.Title) == "" {
		o.Title = "Untitled"
	}
	clean := o.Pages[:0]
	for _, p := range o.Pages {
		// Archetype and role are two views of one decision. A reply that names
		// only one gets the other derived, so every downstream reader sees both
		// filled in whichever generation of client or model produced the page.
		if !archetypes[p.Archetype] {
			p.Archetype = ""
		}
		if !visualRoles[p.VisualRole] {
			p.VisualRole = ""
		}
		if p.Archetype == "" && p.VisualRole != "" {
			p.Archetype = archetypeForRole[p.VisualRole]
		}
		if p.Archetype == "" {
			p.Archetype = "bullets"
		}
		pts := p.Points[:0]
		for _, pt := range p.Points {
			if t := clipRunes(strings.TrimSpace(pt), maxPointChars); t != "" {
				pts = append(pts, t)
			}
		}
		if len(pts) > maxPoints {
			pts = pts[:maxPoints]
		}
		p.Points = pts
		p.Note = normalizeNote(p.Note)
		normalizeArchetypeFields(&p)
		if strings.TrimSpace(p.Title) == "" && len(p.Points) == 0 {
			continue
		}
		if strings.TrimSpace(p.Title) == "" {
			p.Title = "Untitled"
		}
		clean = append(clean, p)
	}
	o.Pages = clean
	if len(o.Pages) == 0 {
		return errors.New("outline has no usable pages")
	}
	return nil
}

// clipRunes cuts s to at most n code points on a word boundary where one is
// available in the back 40%, so a long field shortens to a phrase rather than
// to a syllable.
func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	cut := string(r[:n])
	if i := strings.LastIndex(cut, " "); i > n*6/10 {
		cut = cut[:i]
	}
	return strings.TrimRight(cut, " ,;:-")
}

// normalizeArchetypeFields clips every typed field to its budget and drops a
// typed payload that is empty or malformed, so the composer never has to
// second-guess a half-filled stat or a one-column comparison. A page whose
// archetype needs a payload it does not have falls back to the plain form its
// content can support: no stat means no big number.
func normalizeArchetypeFields(p *OutlineItem) {
	p.Title = clipRunes(strings.TrimSpace(p.Title), maxTitleChars)
	p.Subhead = clipRunes(strings.TrimSpace(p.Subhead), maxSubheadChars)
	if p.Archetype == "statement" {
		p.Title = clipRunes(p.Title, maxStatementChars)
	}
	if p.Stat != nil {
		p.Stat.Value = clipRunes(strings.TrimSpace(p.Stat.Value), maxStatValueChars)
		p.Stat.Unit = clipRunes(strings.TrimSpace(p.Stat.Unit), maxStatUnitChars)
		p.Stat.Label = clipRunes(strings.TrimSpace(p.Stat.Label), maxStatLabelChars)
		if p.Stat.Value == "" {
			p.Stat = nil
		}
	}
	if p.Quote != nil {
		p.Quote.Text = clipRunes(strings.TrimSpace(p.Quote.Text), maxQuoteChars)
		p.Quote.Attribution = clipRunes(strings.TrimSpace(p.Quote.Attribution), maxAttribChars)
		if p.Quote.Text == "" {
			p.Quote = nil
		}
	}
	steps := p.Steps[:0]
	for _, st := range p.Steps {
		st.Label = clipRunes(strings.TrimSpace(st.Label), maxStepLabelChars)
		st.Detail = clipRunes(strings.TrimSpace(st.Detail), maxStepDetail)
		if st.Label != "" {
			steps = append(steps, st)
		}
	}
	if len(steps) > maxSteps {
		steps = steps[:maxSteps]
	}
	p.Steps = steps
	cols := p.Columns[:0]
	for _, c := range p.Columns {
		c.Heading = clipRunes(strings.TrimSpace(c.Heading), maxColHeadChars)
		cp := c.Points[:0]
		for _, pt := range c.Points {
			if t := clipRunes(strings.TrimSpace(pt), maxPointChars); t != "" {
				cp = append(cp, t)
			}
		}
		if len(cp) > maxColPoints {
			cp = cp[:maxColPoints]
		}
		c.Points = cp
		if c.Heading != "" || len(c.Points) > 0 {
			cols = append(cols, c)
		}
	}
	if len(cols) > maxColumns {
		cols = cols[:maxColumns]
	}
	p.Columns = cols
	if p.Image != nil {
		p.Image.Subject = clipRunes(strings.TrimSpace(p.Image.Subject), maxImageSubject)
		switch p.Image.Treatment {
		case "photo", "illustration", "abstract":
		default:
			p.Image.Treatment = "photo"
		}
		if p.Image.Subject == "" {
			p.Image = nil
		}
	}
	if p.Chart != nil {
		switch p.Chart.Kind {
		case "bar", "line", "pie", "donut":
		default:
			p.Chart.Kind = "bar"
		}
		if len(p.Chart.Categories) > maxChartCats {
			p.Chart.Categories = p.Chart.Categories[:maxChartCats]
		}
		series := p.Chart.Series[:0]
		for _, sr := range p.Chart.Series {
			if len(sr.Values) > len(p.Chart.Categories) {
				sr.Values = sr.Values[:len(p.Chart.Categories)]
			}
			if len(sr.Values) > 0 {
				series = append(series, sr)
			}
		}
		if len(series) > maxChartSeries {
			series = series[:maxChartSeries]
		}
		p.Chart.Series = series
		if len(p.Chart.Categories) == 0 || len(p.Chart.Series) == 0 {
			p.Chart = nil
		}
	}
	// Downgrade an archetype whose payload did not survive.
	switch p.Archetype {
	case "bigNumber":
		if p.Stat == nil {
			p.Archetype = "bullets"
		}
	case "quote":
		if p.Quote == nil {
			if len(p.Points) > 0 {
				p.Quote = &Quote{Text: clipRunes(p.Points[0], maxQuoteChars)}
			} else {
				p.Archetype = "statement"
			}
		}
	case "process":
		if len(p.Steps) < 2 {
			p.Archetype = "bullets"
		}
	case "twoColumn":
		if len(p.Columns) < 2 {
			p.Archetype = "bullets"
		}
	case "threeUp":
		if len(p.Columns) < 2 {
			p.Archetype = "bullets"
		}
	case "imageCaption":
		if p.Image == nil {
			p.Archetype = "statement"
		}
	case "chart":
		if p.Chart == nil {
			p.Archetype = "bullets"
		}
	}
	// A downgrade changes the FORM, never a role the reply named: an old-style
	// comparison page (role only, points only) keeps its role and the layout
	// that role has always had, and merely gains archetype "bullets".
	if p.VisualRole == "" {
		p.VisualRole = roleForArchetype[p.Archetype]
	}
}

// maxNoteChars mirrors maxNoteChars in packages/aistudio/src/outline.ts: the
// prompt asks for 100..500 chars and validation truncates defensively rather
// than failing the outline.
const maxNoteChars = 500

// normalizeNote flattens a speaker note to plain single-paragraph text
// (collapsing whitespace runs) and caps its length at a sentence boundary where
// one exists, mid-word truncation only as a last resort. Mirrors normalizeNote
// in packages/aistudio/src/outline.ts.
func normalizeNote(s string) string {
	// Whitespace class: unicode.IsSpace plus U+FEFF, i.e. the union of Go
	// IsSpace and JS \s - the TS mirror collapses the same union (JS \s plus
	// U+0085), so both sides flatten identically.
	flat := strings.Join(strings.FieldsFunc(s, func(r rune) bool {
		return unicode.IsSpace(r) || r == '\uFEFF'
	}), " ")
	// Fast path: byte length is >= the rune count, so an under-cap byte length
	// can never hide an over-cap note.
	if len(flat) <= maxNoteChars {
		return flat
	}
	runes := []rune(flat)
	if len(runes) <= maxNoteChars {
		return flat
	}
	cut := string(runes[:maxNoteChars]) // rune-safe: never split a UTF-8 sequence
	end := -1
	for _, sep := range []string{". ", "! ", "? "} {
		if i := strings.LastIndex(cut, sep); i > end {
			end = i
		}
	}
	// Compare in RUNES to match the TS side (LastIndex returns a byte offset,
	// which overstates the position in multi-byte text). Slicing at end+1 is
	// still byte-safe because the separator is ASCII.
	if end >= 0 && utf8.RuneCountInString(cut[:end]) > maxNoteChars/2 {
		return cut[:end+1]
	}
	return cut
}

// ChartSeries is one named numeric series.
type ChartSeries struct {
	Name   string    `json:"name"`
	Values []float64 `json:"values"`
}

// ChartSpec is a validated, editable chart definition.
type ChartSpec struct {
	ChartType  string        `json:"chartType"`
	Categories []string      `json:"categories"`
	Series     []ChartSeries `json:"series"`
}

func validateChart(c *ChartSpec) error {
	if !chartTypes[c.ChartType] {
		c.ChartType = "bar"
	}
	cats := c.Categories[:0]
	for _, x := range c.Categories {
		if t := strings.TrimSpace(x); t != "" {
			cats = append(cats, t)
		}
	}
	c.Categories = cats
	if len(c.Categories) == 0 {
		return errors.New("chart has no categories")
	}
	if len(c.Series) == 0 {
		return errors.New("chart has no series")
	}
	for i := range c.Series {
		if strings.TrimSpace(c.Series[i].Name) == "" {
			c.Series[i].Name = "Series"
		}
		// Align values 1:1 with categories (pad with 0, truncate extras).
		vals := make([]float64, len(c.Categories))
		copy(vals, c.Series[i].Values)
		c.Series[i].Values = vals
	}
	return nil
}

// PlanStep is one assistant action.
type PlanStep struct {
	Action string         `json:"action"`
	Args   map[string]any `json:"args"`
}

// AssistantReply is the assistant's structured response. Plan is omitempty so the
// clarify path (Plan == nil) does not serialize "plan":null, which would violate
// the SDK's non-null plan contract.
type AssistantReply struct {
	Reply   string     `json:"reply"`
	Clarify string     `json:"clarify,omitempty"`
	Plan    []PlanStep `json:"plan,omitempty"`
}

// validateAssistant accepts a known set of action names; the client re-validates
// arg types before executing, so here we only enforce a well-formed envelope and
// drop unknown actions. If the model returned ONLY invented tools (every step
// dropped) and gave no clarify, that is a malformed reply: return an error so the
// retry loop asks again rather than silently accepting an empty plan.
func validateAssistant(catalog map[string]bool) func(*AssistantReply) error {
	return func(a *AssistantReply) error {
		if strings.TrimSpace(a.Clarify) != "" {
			a.Plan = nil
			if a.Reply == "" {
				a.Reply = a.Clarify
			}
			return nil
		}
		original := len(a.Plan)
		kept := a.Plan[:0]
		for _, s := range a.Plan {
			if catalog[s.Action] {
				kept = append(kept, s)
			}
		}
		a.Plan = kept
		if original > 0 && len(kept) == 0 {
			return errors.New("every planned action was an unknown tool")
		}
		// An empty plan is fine on its own: the assistant is allowed to just
		// answer. Saying NOTHING and planning nothing is not, and it validated
		// happily because each field is individually optional. The turn then
		// succeeded with a 200 and an empty bubble: no answer, no action, no
		// error to explain either. Rejecting it here spends a repair pass with
		// the reason fed back, and a model that still says nothing twice
		// surfaces as a real failure the caller can report.
		if len(a.Plan) == 0 && strings.TrimSpace(a.Reply) == "" {
			return errors.New("the reply said nothing and planned nothing")
		}
		return nil
	}
}

// StyleProfile captures the feel extracted from a reference for style transfer.
type StyleProfile struct {
	Palette     []string `json:"palette"`
	Mood        string   `json:"mood"`
	TypeFeel    string   `json:"typeFeel"`
	Composition string   `json:"composition"`
}

var hexColor = func() func(string) bool {
	return func(s string) bool {
		s = strings.TrimSpace(s)
		if len(s) != 4 && len(s) != 7 {
			return false
		}
		if s[0] != '#' {
			return false
		}
		for _, c := range s[1:] {
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
				return false
			}
		}
		return true
	}
}()

func validateStyleProfile(p *StyleProfile) error {
	pal := p.Palette[:0]
	for _, c := range p.Palette {
		if hexColor(c) {
			pal = append(pal, strings.ToLower(strings.TrimSpace(c)))
		}
	}
	p.Palette = pal
	if len(p.Palette) == 0 {
		return errors.New("style profile has no usable palette colors")
	}
	return nil
}
