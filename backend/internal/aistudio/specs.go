package aistudio

import (
	"errors"
	"strings"
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
}

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
		if !visualRoles[p.VisualRole] {
			p.VisualRole = "content"
		}
		pts := p.Points[:0]
		for _, pt := range p.Points {
			if t := strings.TrimSpace(pt); t != "" {
				pts = append(pts, t)
			}
		}
		p.Points = pts
		p.Note = normalizeNote(p.Note)
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

// maxNoteChars mirrors maxNoteChars in packages/aistudio/src/outline.ts: the
// prompt asks for 100..500 chars and validation truncates defensively rather
// than failing the outline.
const maxNoteChars = 500

// normalizeNote flattens a speaker note to plain single-paragraph text
// (collapsing whitespace runs) and caps its length at a sentence boundary where
// one exists, mid-word truncation only as a last resort. Mirrors normalizeNote
// in packages/aistudio/src/outline.ts.
func normalizeNote(s string) string {
	flat := strings.Join(strings.Fields(s), " ")
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
	if end >= 0 && len([]rune(cut[:end])) > maxNoteChars/2 {
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
		// A genuinely empty plan (the model proposed nothing) is allowed.
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
