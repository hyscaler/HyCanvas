package aistudio

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// Archetype and visualRole are two views of one decision. Whichever a reply
// names, both must be filled afterwards, or half the pipeline reads a blank.
func TestOutlineArchetypeAndRoleDeriveEachOther(t *testing.T) {
	o := &DesignOutline{Pages: []OutlineItem{
		{Title: "Old client", VisualRole: "comparison", Points: []string{"a", "b"}},         // role only
		{Title: "New reply", Archetype: "bigNumber", Stat: &Stat{Value: "42%", Label: "x"}}, // archetype only
		{Title: "Nothing named", Points: []string{"a"}},                                     // neither
		{Title: "Nonsense", Archetype: "hologram", VisualRole: "sparkle", Points: []string{"a"}},
	}}
	if err := validateOutline(o); err != nil {
		t.Fatalf("validate: %v", err)
	}
	want := []struct{ arch, role string }{
		{"bullets", "comparison"}, // no columns, so not a twoColumn; the NAMED role is kept
		{"bigNumber", "data"},
		{"bullets", "content"},
		{"bullets", "content"},
	}
	for i, w := range want {
		if o.Pages[i].Archetype != w.arch || o.Pages[i].VisualRole != w.role {
			t.Errorf("page %d: got %s/%s, want %s/%s", i, o.Pages[i].Archetype, o.Pages[i].VisualRole, w.arch, w.role)
		}
	}
}

// A comparison that arrives WITH columns keeps its form; the downgrade above is
// only for payloads that did not survive.
func TestOutlineComparisonWithColumnsStaysTwoColumn(t *testing.T) {
	o := &DesignOutline{Pages: []OutlineItem{{
		Title: "Before and after", VisualRole: "comparison",
		Columns: []Column{{Heading: "Before", Points: []string{"slow"}}, {Heading: "After", Points: []string{"fast"}}},
	}}}
	if err := validateOutline(o); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if o.Pages[0].Archetype != "twoColumn" || o.Pages[0].VisualRole != "comparison" {
		t.Fatalf("got %s/%s", o.Pages[0].Archetype, o.Pages[0].VisualRole)
	}
}

// Budgets are enforced here so the composer can trust every length it sees.
// Clipping lands on a word boundary: a long field becomes a phrase, not a
// syllable.
func TestOutlineFieldsAreClippedToBudgets(t *testing.T) {
	long := strings.Repeat("word ", 60)
	o := &DesignOutline{Pages: []OutlineItem{{
		Archetype: "process", Title: long, Subhead: long,
		Steps:  []Step{{Label: long, Detail: long}, {Label: "two"}, {Label: "three"}, {Label: "four"}, {Label: "five"}, {Label: "six"}, {Label: "seven"}},
		Points: []string{long, "a", "b", "c", "d", "e", "f", "g"},
		Image:  &ImageIntent{Subject: long, Treatment: "hologram"},
	}}}
	if err := validateOutline(o); err != nil {
		t.Fatalf("validate: %v", err)
	}
	p := o.Pages[0]
	checks := []struct {
		name string
		got  int
		max  int
	}{
		{"title", len([]rune(p.Title)), maxTitleChars},
		{"subhead", len([]rune(p.Subhead)), maxSubheadChars},
		{"step label", len([]rune(p.Steps[0].Label)), maxStepLabelChars},
		{"step detail", len([]rune(p.Steps[0].Detail)), maxStepDetail},
		{"steps", len(p.Steps), maxSteps},
		{"points", len(p.Points), maxPoints},
		{"point", len([]rune(p.Points[0])), maxPointChars},
		{"image subject", len([]rune(p.Image.Subject)), maxImageSubject},
	}
	for _, c := range checks {
		if c.got > c.max {
			t.Errorf("%s: %d exceeds budget %d", c.name, c.got, c.max)
		}
	}
	if strings.HasSuffix(p.Title, "wor") || strings.HasSuffix(p.Title, " ") {
		t.Fatalf("title should clip on a word boundary, got %q", p.Title)
	}
	if p.Image.Treatment != "photo" {
		t.Fatalf("unknown treatment should default to photo, got %q", p.Image.Treatment)
	}
}

// An archetype whose payload is missing falls back to a form its content can
// support, rather than composing an empty big number or a one-column split.
func TestOutlineArchetypeDowngradesWithoutPayload(t *testing.T) {
	cases := []struct {
		in   OutlineItem
		want string
	}{
		{OutlineItem{Title: "t", Archetype: "bigNumber"}, "bullets"},
		{OutlineItem{Title: "t", Archetype: "process", Steps: []Step{{Label: "only one"}}}, "bullets"},
		{OutlineItem{Title: "t", Archetype: "twoColumn", Columns: []Column{{Heading: "one"}}}, "bullets"},
		{OutlineItem{Title: "t", Archetype: "chart"}, "bullets"},
		{OutlineItem{Title: "t", Archetype: "imageCaption"}, "statement"},
		{OutlineItem{Title: "t", Archetype: "quote"}, "statement"},
		// A quote with no quote payload but a first point promotes the point.
		{OutlineItem{Title: "t", Archetype: "quote", Points: []string{"Less, but better."}}, "quote"},
		{OutlineItem{Title: "t", Archetype: "chart", Chart: &ChartData{Kind: "bar", Categories: []string{"Q1"}, Series: []ChartSeries{{Name: "s", Values: []float64{1, 2, 3}}}}}, "chart"},
		// Phase 7 forms: a grid of one figure is a bigNumber, of none a list.
		{OutlineItem{Title: "t", Archetype: "kpiGrid"}, "bullets"},
		{OutlineItem{Title: "t", Archetype: "kpiGrid", Stats: []Stat{{Value: "40", Label: "x"}}}, "bigNumber"},
		{OutlineItem{Title: "t", Archetype: "kpiGrid", Stats: []Stat{{Value: "40", Label: "x"}, {Value: "3", Label: "y"}}}, "kpiGrid"},
		{OutlineItem{Title: "t", Archetype: "timeline", Steps: []Step{{Label: "one", When: "2019"}}}, "bullets"},
		{OutlineItem{Title: "t", Archetype: "timeline", Steps: []Step{{Label: "one", When: "2019"}, {Label: "two"}}}, "timeline"},
		{OutlineItem{Title: "t", Archetype: "table"}, "bullets"},
		{OutlineItem{Title: "t", Archetype: "table", Table: &TableData{Columns: []string{"a"}, Rows: [][]string{{""}}}}, "bullets"},
		{OutlineItem{Title: "t", Archetype: "table", Table: &TableData{Columns: []string{"a", "b"}, Rows: [][]string{{"1", "2", "extra"}}}}, "table"},
		{OutlineItem{Title: "t", Archetype: "team"}, "bullets"},
		{OutlineItem{Title: "t", Archetype: "team", People: []Person{{Name: "Ada", Role: "Lead"}}}, "team"},
	}
	for i, c := range cases {
		o := &DesignOutline{Pages: []OutlineItem{c.in}}
		if err := validateOutline(o); err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
		if got := o.Pages[0].Archetype; got != c.want {
			t.Errorf("case %d: archetype %q, want %q", i, got, c.want)
		}
	}
	// A kpiGrid of one figure carries it over as the page's stat, a table row
	// is cut to the header's width, and a column icon is lower-cased.
	one := &DesignOutline{Pages: []OutlineItem{{Title: "t", Archetype: "kpiGrid", Stats: []Stat{{Value: "40", Unit: "%", Label: "x"}}}}}
	_ = validateOutline(one)
	if one.Pages[0].Stat == nil || one.Pages[0].Stat.Value != "40" {
		t.Fatalf("single figure should become the page's stat: %+v", one.Pages[0].Stat)
	}
	tbl := &DesignOutline{Pages: []OutlineItem{{Title: "t", Archetype: "table", Table: &TableData{Columns: []string{"a", "b"}, Rows: [][]string{{"1", "2", "extra"}, {"", ""}, {"3"}}}}}}
	_ = validateOutline(tbl)
	if rows := tbl.Pages[0].Table.Rows; len(rows) != 2 || len(rows[0]) != 2 || rows[1][1] != "" {
		t.Fatalf("table rows should match the header and drop empty rows: %v", rows)
	}
	col := &DesignOutline{Pages: []OutlineItem{{Title: "t", Archetype: "twoColumn", Columns: []Column{{Heading: "a", Icon: " Shield "}, {Heading: "b"}}}}}
	_ = validateOutline(col)
	if col.Pages[0].Columns[0].Icon != "shield" {
		t.Fatalf("icon keyword should be trimmed and lower-cased, got %q", col.Pages[0].Columns[0].Icon)
	}
	// Page, stat and step icons are normalized the same way.
	ic := &DesignOutline{Pages: []OutlineItem{{Title: "t", Archetype: "timeline", Icon: " Rocket ", Steps: []Step{{Label: "a", Icon: "Leaf"}, {Label: "b"}}, Stats: []Stat{{Value: "1", Label: "x", Icon: " USERS"}}}}}
	_ = validateOutline(ic)
	if pg := ic.Pages[0]; pg.Icon != "rocket" || pg.Steps[0].Icon != "leaf" || pg.Stats[0].Icon != "users" {
		t.Fatalf("icon fields not normalized: %+v", pg)
	}
	if !strings.Contains(outlineSchema, `"icon":{"type":"string"`) {
		t.Fatal("schema should offer icon keywords")
	}
	// An illustration keyword on the picture intent is normalized like an icon.
	il := &DesignOutline{Pages: []OutlineItem{{Title: "t", Archetype: "cover", Image: &ImageIntent{Subject: "a rocket", Illustration: " Rocket "}}}}
	_ = validateOutline(il)
	if il.Pages[0].Image == nil || il.Pages[0].Image.Illustration != "rocket" {
		t.Fatalf("illustration keyword not normalized: %+v", il.Pages[0].Image)
	}
	if !strings.Contains(outlineSchema, `"illustration":{"type":"string"`) {
		t.Fatal("schema should offer illustration keywords")
	}
	// A stat value is the bare figure; a headline carries no dash separator.
	fig := &DesignOutline{Pages: []OutlineItem{{Title: "Harborline \u2014 Board Update", Archetype: "kpiGrid", Stats: []Stat{{Value: "\u219367%", Label: "a"}, {Value: "\u25b2 3.2M", Label: "b"}, {Value: "-11%", Label: "c"}}}}}
	_ = validateOutline(fig)
	if pg := fig.Pages[0]; pg.Title != "Harborline: Board Update" || pg.Stats[0].Value != "67%" || pg.Stats[1].Value != "3.2M" || pg.Stats[2].Value != "-11%" {
		t.Fatalf("figure/title normalization: %+v", pg)
	}
	// The chart case above also trims values to the category count.
	o := &DesignOutline{Pages: []OutlineItem{{Title: "t", Archetype: "chart", Chart: &ChartData{Kind: "bar", Categories: []string{"Q1"}, Series: []ChartSeries{{Name: "s", Values: []float64{1, 2, 3}}}}}}}
	_ = validateOutline(o)
	if n := len(o.Pages[0].Chart.Series[0].Values); n != 1 {
		t.Fatalf("series values should be trimmed to the categories, got %d", n)
	}
}

// The schema the model is shown must name every archetype the validator
// accepts, and nothing else, or the two drift and replies start downgrading.
func TestOutlineSchemaNamesEveryArchetype(t *testing.T) {
	for a := range archetypes {
		if !strings.Contains(outlineSchema, `"`+a+`"`) {
			t.Errorf("schema is missing archetype %q", a)
		}
	}
	if !strings.Contains(outlineSchema, `"required":["title","archetype","note"]`) {
		t.Fatal("archetype should be required per page")
	}
}

// ShortenPage is the one second pass the reviewer's report can request. It
// must keep the slide's form and every typed payload, and it must never fail
// a generation: a bad reply returns the page unchanged.
func TestShortenPageKeepsTheFormAndSurvivesBadReplies(t *testing.T) {
	page := OutlineItem{
		Title: "Why the shoreline is retreating faster than anyone planned for", Archetype: "bullets", VisualRole: "content",
		Points: []string{"Erosion is accelerating on the north shore every winter", "Two villages have already relocated inland"},
		Note:   "Say this slowly.", Image: &ImageIntent{Subject: "cliff", Treatment: "photo"},
		Aside: "the number that surprised us", Drawing: "camping", Signature: "stickyWall", Pairs: []Pair{{Label: "North", Value: "40%"}},
	}
	// A good reply: shorter copy, same form.
	gen := &stubGen{replies: []string{`{"title":"Why the shoreline is retreating","archetype":"bullets","points":["Erosion accelerating on the north shore","Two villages already relocated"]}`}}
	svc := NewService(nil, gen)
	out := svc.ShortenPage(context.Background(), "ws", page, "")
	if out.Archetype != "bullets" || len(out.Points) != 2 || out.Title == page.Title {
		t.Fatalf("shortened page wrong: %+v", out)
	}
	if out.Note != page.Note || out.Image == nil {
		t.Fatal("shortening must carry the note and the image intent through")
	}
	// The kit's voice and vocabulary are not copy; they ride through unchanged.
	if out.Aside != page.Aside || out.Drawing != page.Drawing || out.Signature != page.Signature || len(out.Pairs) != 1 || out.Pairs[0].Value != "40%" {
		t.Fatalf("shortening must carry the aside, drawing, signature and pairs through, got %+v", out)
	}

	// A reply that drops the payload the form needs would downgrade it; the
	// original is kept instead.
	stat := OutlineItem{Title: "Erosion", Archetype: "bigNumber", VisualRole: "data", Stat: &Stat{Value: "40%", Label: "more erosion since 2019"}}
	gen = &stubGen{replies: []string{`{"title":"Erosion","archetype":"bigNumber","points":["forty percent more"]}`}}
	svc = NewService(nil, gen)
	if got := svc.ShortenPage(context.Background(), "ws", stat, ""); got.Stat == nil || got.Archetype != "bigNumber" {
		t.Fatalf("a reply that loses the stat must be rejected, got %+v", got)
	}

	// Junk, every pass: the page comes back untouched, no error.
	gen = &stubGen{replies: []string{"junk", "junk", "junk", "junk", "junk"}}
	svc = NewService(nil, gen)
	if got := svc.ShortenPage(context.Background(), "ws", page, ""); got.Title != page.Title {
		t.Fatalf("junk replies must leave the page unchanged, got %+v", got)
	}
}

// The outline schema is a formatted string; every verb must be filled and
// the result must parse, or the model is handed a broken schema.
func TestOutlineSchemaIsWellFormedJSONWithTheKitFields(t *testing.T) {
	if strings.Contains(outlineSchema, "%!") {
		t.Fatalf("outlineSchema has an unfilled verb: %.120s", outlineSchema[strings.Index(outlineSchema, "%!"):])
	}
	var v map[string]any
	if err := json.Unmarshal([]byte(outlineSchema), &v); err != nil {
		t.Fatalf("outlineSchema is not JSON: %v", err)
	}
	props := v["properties"].(map[string]any)
	for _, k := range []string{"style", "organization", "kicker", "farewell"} {
		if _, ok := props[k]; !ok {
			t.Fatalf("root property %q missing", k)
		}
	}
	page := props["pages"].(map[string]any)["items"].(map[string]any)["properties"].(map[string]any)
	for _, k := range []string{"aside", "drawing", "signature", "pairs"} {
		if _, ok := page[k]; !ok {
			t.Fatalf("page property %q missing", k)
		}
	}
	if got := page["aside"].(map[string]any)["maxLength"]; got != float64(maxAsideChars) {
		t.Fatalf("aside maxLength %v, want %d", got, maxAsideChars)
	}
}
