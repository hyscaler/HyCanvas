package render

import (
	"bytes"
	"regexp"
	"strings"
	"testing"
)

// A page exercising every tagging decision: a decorative banner, a described
// image, an undescribed image, a bare rectangle, and text. The reading order
// deliberately reverses z-order and names an id that no longer exists.
func taggedProbePage() map[string]any {
	solid := func(r, g, b float64) map[string]any {
		return map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b}}}
	}
	xf := func(x, y float64) map[string]any {
		return map[string]any{"x": x, "y": y, "scaleX": 1.0, "scaleY": 1.0}
	}
	return map[string]any{
		"id": "p1", "name": "Quarterly Results", "width": 400.0, "height": 300.0,
		"background": solid(1, 1, 1),
		"children": []any{
			map[string]any{"id": "banner", "type": "shape", "shape": "rect", "decorative": true,
				"transform": xf(0, 0), "size": map[string]any{"width": 400.0, "height": 60.0},
				"fills": []any{solid(0.9, 0.9, 0.95)}},
			map[string]any{"id": "photo", "type": "image", "alt": "Team at the offsite",
				"transform": xf(10, 80), "size": map[string]any{"width": 100.0, "height": 80.0}},
			map[string]any{"id": "caption", "type": "text", "transform": xf(10, 200),
				"size": map[string]any{"width": 300.0, "height": 40.0},
				"content": []any{map[string]any{"runs": []any{
					map[string]any{"text": "Revenue up 12%", "style": map[string]any{"fontSize": 18.0}}}}}},
			map[string]any{"id": "undescribed", "type": "image", "transform": xf(200, 80),
				"size": map[string]any{"width": 60.0, "height": 60.0}},
			map[string]any{"id": "plain-rect", "type": "shape", "shape": "rect", "transform": xf(300, 10),
				"size": map[string]any{"width": 40.0, "height": 40.0}, "fills": []any{solid(0.2, 0.4, 0.8)}},
		},
		"readingOrder": []any{"caption", "undescribed", "photo", "id-that-no-longer-exists"},
	}
}

func mustToPDF(t *testing.T, page map[string]any) string {
	t.Helper()
	out, err := ToPDF(Design(map[string]any{"pages": []any{page}}), 0)
	if err != nil {
		t.Fatalf("ToPDF: %v", err)
	}
	return string(out)
}

func TestTaggedPDFDeclaresStructure(t *testing.T) {
	pdf := mustToPDF(t, taggedProbePage())
	for _, want := range []string{
		"/MarkInfo << /Marked true >>",
		"/StructTreeRoot",
		"/StructParents 0",
		"/Lang (en-US)",
		"/Type /StructTreeRoot",
		"/S /Document",
		"/S /Sect",
		"/T (Quarterly Results)", // the slide name is the section's title
		"/Alt (Team at the offsite)",
	} {
		if !strings.Contains(pdf, want) {
			t.Errorf("tagged PDF is missing %q", want)
		}
	}
}

// The structure tree must read in the authored order even though the content
// stream draws in z-order. This is the whole point of the reading-order field.
func TestTaggedPDFStructureFollowsReadingOrder(t *testing.T) {
	pdf := mustToPDF(t, taggedProbePage())

	// Marked content is emitted while drawing, so MCIDs follow z-order:
	// photo (0), caption (1), undescribed (2). Decorative and undescribed
	// geometry never take an id.
	bdc := regexp.MustCompile(`/(\w+) <</MCID (\d+)>> BDC`).FindAllStringSubmatch(pdf, -1)
	gotDraw := make([]string, len(bdc))
	for i, m := range bdc {
		gotDraw[i] = m[1] + ":" + m[2]
	}
	wantDraw := []string{"Figure:0", "P:1", "Figure:2"}
	if strings.Join(gotDraw, ",") != strings.Join(wantDraw, ",") {
		t.Errorf("content stream marked in %v, want z-order %v", gotDraw, wantDraw)
	}

	// Structure elements are emitted in reading order: caption, undescribed,
	// photo. Their /K values are the MCIDs above, so the tree reverses z-order.
	elems := regexp.MustCompile(`/Type /StructElem /S /(\w+) /P \d+ 0 R /Pg \d+ 0 R /K (\d+)`).FindAllStringSubmatch(pdf, -1)
	gotRead := make([]string, len(elems))
	for i, m := range elems {
		gotRead[i] = m[1] + ":" + m[2]
	}
	wantRead := []string{"P:1", "Figure:2", "Figure:0"}
	if strings.Join(gotRead, ",") != strings.Join(wantRead, ",") {
		t.Errorf("structure tree reads %v, want reading order %v", gotRead, wantRead)
	}
}

// Decorative nodes and undescribed geometry become artifacts: present on the
// page, absent from the tree. A screen reader steps over them.
func TestTaggedPDFArtifactsPresentationalContent(t *testing.T) {
	pdf := mustToPDF(t, taggedProbePage())
	// background + decorative banner + bare rectangle
	if got := strings.Count(pdf, "/Artifact BMC"); got != 3 {
		t.Errorf("got %d artifacts, want 3 (background, decorative banner, bare rect)", got)
	}
	// Every opened sequence is closed, or a viewer rejects the page.
	opened := strings.Count(pdf, "BDC") + strings.Count(pdf, "BMC")
	if closed := strings.Count(pdf, "EMC"); opened != closed {
		t.Errorf("%d marked sequences opened, %d closed", opened, closed)
	}
}

// An undescribed image stays a /Figure rather than becoming an artifact:
// silently hiding it from assistive technology would be worse than exposing it
// undescribed, which a PDF/UA checker can then flag.
func TestUndescribedImageStaysInTheTree(t *testing.T) {
	if role := tagRole(map[string]any{"type": "image"}); role != tagFigure {
		t.Errorf("undescribed image role = %q, want %q", role, tagFigure)
	}
	if role := tagRole(map[string]any{"type": "image", "decorative": true}); role != "" {
		t.Errorf("decorative image should be an artifact, got %q", role)
	}
	if role := tagRole(map[string]any{"type": "shape"}); role != "" {
		t.Errorf("bare shape should be an artifact, got %q", role)
	}
	if role := tagRole(map[string]any{"type": "shape", "altText": "Org chart"}); role != tagFigure {
		t.Errorf("described shape should be a figure, got %q", role)
	}
	if role := tagRole(map[string]any{"type": "sticky"}); role != tagParagraph {
		t.Errorf("sticky carries words, want %q, got %q", tagParagraph, role)
	}
}

// nodeAltText mirrors a11y.ts: the generic field wins, and the pre-v12
// image-only `alt` still describes images written by older clients.
func TestNodeAltTextPrefersGenericFieldAndKeepsLegacyAlt(t *testing.T) {
	cases := []struct {
		node map[string]any
		want string
	}{
		{map[string]any{"type": "image", "altText": "New", "alt": "Old"}, "New"},
		{map[string]any{"type": "image", "alt": "Old"}, "Old"},
		{map[string]any{"type": "image", "altText": "  spaced  "}, "spaced"},
		{map[string]any{"type": "shape", "alt": "ignored on non-images"}, ""},
		{map[string]any{"type": "image"}, ""},
	}
	for _, c := range cases {
		if got := nodeAltText(c.node); got != c.want {
			t.Errorf("nodeAltText(%v) = %q, want %q", c.node, got, c.want)
		}
	}
}

// The Go resolver must agree with `resolveReadingOrder` in a11y.ts, whose
// guiding rule is that the field can never hide a node.
func TestResolveReadingOrderMirrorsSchemaHelper(t *testing.T) {
	node := func(id string) any { return map[string]any{"id": id} }
	ids := func(ns []any) string {
		out := make([]string, len(ns))
		for i, n := range ns {
			out[i] = asStr(asObj(n)["id"])
		}
		return strings.Join(out, ",")
	}
	children := []any{node("a"), node("b"), node("c")}

	cases := []struct {
		name, want string
		order      []any
	}{
		{"absent order falls back to z-order", "a,b,c", nil},
		{"empty order falls back to z-order", "a,b,c", []any{}},
		{"explicit order wins", "c,a,b", []any{"c", "a", "b"}},
		{"stale ids are ignored", "c,a,b", []any{"c", "gone", "a", "b"}},
		{"partial order is completed in z-order", "c,a,b", []any{"c"}},
		{"a duplicate id is taken once", "c,a,b", []any{"c", "c", "a"}},
	}
	for _, c := range cases {
		page := map[string]any{"children": children, "readingOrder": c.order}
		if got := ids(resolveReadingOrder(page)); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

// A file written before schema v12 has no altText, no decorative, and no
// readingOrder. It must still export, and every node must still be reachable.
func TestPreV12FileStillExportsAndTagsEveryNode(t *testing.T) {
	page := map[string]any{
		"id": "p1", "name": "Old Slide", "width": 200.0, "height": 100.0,
		"children": []any{
			map[string]any{"id": "t1", "type": "text",
				"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0},
				"content":   []any{map[string]any{"runs": []any{map[string]any{"text": "Hello", "style": map[string]any{"fontSize": 12.0}}}}}},
			map[string]any{"id": "i1", "type": "image",
				"transform": map[string]any{"x": 0.0, "y": 20.0, "scaleX": 1.0, "scaleY": 1.0}},
		},
	}
	pdf := mustToPDF(t, page)
	if !strings.HasPrefix(pdf, "%PDF-1.7") || !strings.HasSuffix(pdf, "%%EOF\n") {
		t.Fatal("pre-v12 page did not produce a well-formed PDF")
	}
	if n := strings.Count(pdf, "MCID"); n != 2 { // one per node, in z-order
		t.Errorf("got %d marked-content ids, want 2", n)
	}
	if !strings.Contains(pdf, "/T (Old Slide)") {
		t.Error("slide name should still title the section")
	}
}

// An empty page still yields a valid tree: a Document and an empty Sect.
func TestEmptyPageProducesValidTree(t *testing.T) {
	pdf := mustToPDF(t, map[string]any{"id": "p", "name": "", "width": 100.0, "height": 100.0})
	if !strings.Contains(pdf, "/S /Sect") || !strings.Contains(pdf, "/Nums [0 []]") {
		t.Error("empty page should still carry an empty structure tree")
	}
	if !strings.Contains(pdf, "/T (Slide 1)") {
		t.Error("an unnamed slide should fall back to a generic title")
	}
}

// A whole deck exports as one tagged document: a Document element holding one
// titled Sect per slide, each element pointing at its own page.
func TestDeckPDFTagsEveryPage(t *testing.T) {
	page := func(id, name string) map[string]any {
		return map[string]any{
			"id": id, "name": name, "width": 200.0, "height": 100.0,
			"children": []any{map[string]any{"id": id + "-t", "type": "text",
				"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0},
				"content":   []any{map[string]any{"runs": []any{map[string]any{"text": name, "style": map[string]any{"fontSize": 12.0}}}}}}},
		}
	}
	hidden := page("p3", "Skipped")
	hidden["hidden"] = true
	file := Design(map[string]any{"pages": []any{page("p1", "Intro"), hidden, page("p2", "Outro")}})

	out, err := ToDeckPDF(file)
	if err != nil {
		t.Fatalf("ToDeckPDF: %v", err)
	}
	pdf := string(out)

	// The hidden slide is skipped, exactly as present mode skips it.
	if strings.Contains(pdf, "/T (Skipped)") {
		t.Error("a hidden slide must not appear in the exported deck")
	}
	if !strings.Contains(pdf, "/T (Intro)") || !strings.Contains(pdf, "/T (Outro)") {
		t.Error("every visible slide should title its own section")
	}
	if !strings.Contains(pdf, "/Count 2") {
		t.Error("deck should contain exactly the two visible pages")
	}
	// Marked-content ids restart per page, so each page keys its own entry in
	// the number tree by its own /StructParents index.
	if !strings.Contains(pdf, "/StructParents 0") || !strings.Contains(pdf, "/StructParents 1") {
		t.Error("each page needs its own structure-parents key")
	}
	if !regexp.MustCompile(`/Nums \[0 \[\d+ 0 R\] 1 \[\d+ 0 R\]\]`).MatchString(pdf) {
		t.Error("number tree should carry one entry per page")
	}
	if n := strings.Count(pdf, "/S /Sect"); n != 2 {
		t.Errorf("got %d sections, want one per visible slide", n)
	}
	if n := strings.Count(pdf, "/S /Document"); n != 1 {
		t.Errorf("got %d document elements, want exactly 1", n)
	}
}

// A deck of only hidden slides has nothing to export, and says so rather than
// emitting a PDF with zero pages, which no viewer accepts.
func TestDeckPDFRejectsAnEmptyDeck(t *testing.T) {
	file := Design(map[string]any{"pages": []any{map[string]any{"id": "p", "hidden": true, "width": 10.0, "height": 10.0}}})
	if _, err := ToDeckPDF(file); err != ErrPageRange {
		t.Errorf("want ErrPageRange for an all-hidden deck, got %v", err)
	}
}

// PDF/UA requires /Lang to state the document's ACTUAL natural language. It was
// hardcoded to en-US, so every exported PDF claimed American English whatever it
// contained, and a screen reader pronounced it that way. That is the class of
// defect institutional accessibility review rejects an export for.
func TestPdfLangFollowsTheDocument(t *testing.T) {
	if got := pdfLang(Design{}); got != "en-US" {
		t.Errorf("no language set: got %q, want the en-US fallback", got)
	}
	if got := pdfLang(Design{"meta": map[string]any{"language": "ar"}}); got != "ar" {
		t.Errorf("document language ignored: got %q, want ar", got)
	}
	if got := pdfLang(Design{"meta": map[string]any{"language": "pt-BR"}}); got != "pt-BR" {
		t.Errorf("region subtag lost: got %q", got)
	}
	// /Lang is interpolated into the PDF catalog, so a hostile value must not be
	// able to close the dictionary and inject objects.
	for _, bad := range []string{
		")>> /Evil (x", "en US", "en_US", "toolongsubtagvalue", "a-b-c-d", "",
		"en-\n", "<script>",
	} {
		if got := pdfLang(Design{"meta": map[string]any{"language": bad}}); got != "en-US" {
			t.Errorf("pdfLang(%q) = %q, want the safe fallback", bad, got)
		}
	}
}

// End to end: the catalog carries the document's language.
func TestTaggedPdfEmitsDocumentLanguage(t *testing.T) {
	design := Design{
		"meta": map[string]any{"language": "he-IL"},
		"pages": []any{map[string]any{
			"id": "p1", "name": "עמוד", "width": 200.0, "height": 100.0, "children": []any{},
		}},
	}
	out, err := ToPDF(design, 0)
	if err != nil {
		t.Fatalf("ToPDF: %v", err)
	}
	if !bytes.Contains(out, []byte("/Lang (he-IL)")) {
		t.Fatal("the exported PDF does not declare the document's language")
	}
	if bytes.Contains(out, []byte("/Lang (en-US)")) {
		t.Fatal("the hardcoded en-US language is still being written")
	}
}
