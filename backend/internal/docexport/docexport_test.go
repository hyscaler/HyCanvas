package docexport

import (
	"archive/zip"
	"bytes"
	"io"
	"strings"
	"testing"
)

func sampleDoc() map[string]any {
	return map[string]any{
		"title": "My Doc",
		"meta": map[string]any{"doc": map[string]any{
			"blockOrder": []any{"b2", "b1"},
			"blocks": []any{
				map[string]any{"id": "b1", "type": "paragraph", "text": map[string]any{"runs": []any{
					map[string]any{"text": "Hello ", "marks": []any{"bold"}},
					map[string]any{"text": "world & <friends>"},
				}}},
				map[string]any{"id": "b2", "type": "heading", "level": float64(1), "text": map[string]any{"runs": []any{
					map[string]any{"text": "Title Heading"},
				}}},
				map[string]any{"id": "b3", "type": "list", "style": "numbered", "items": []any{
					map[string]any{"text": map[string]any{"runs": []any{map[string]any{"text": "one"}}}, "depth": float64(0)},
				}},
			},
		}},
	}
}

func TestResolveBlocksOrder(t *testing.T) {
	blocks := ResolveBlocks(sampleDoc())
	// blockOrder is [b2, b1]; b3 not listed -> appended last.
	if len(blocks) != 3 || blocks[0].Type != "heading" || blocks[1].Type != "paragraph" || blocks[2].Type != "list" {
		t.Fatalf("order wrong: %+v", blocks)
	}
	if blocks[0].Level != 1 {
		t.Fatalf("heading level: %d", blocks[0].Level)
	}
}

func TestBuildDOCX(t *testing.T) {
	blocks := ResolveBlocks(sampleDoc())
	out, err := BuildDOCX(blocks, "My Doc")
	if err != nil {
		t.Fatalf("BuildDOCX: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(out), int64(len(out)))
	if err != nil {
		t.Fatalf("not a valid zip: %v", err)
	}
	files := map[string]string{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		files[f.Name] = string(b)
	}
	for _, want := range []string{"[Content_Types].xml", "_rels/.rels", "word/document.xml"} {
		if _, ok := files[want]; !ok {
			t.Fatalf("missing %s", want)
		}
	}
	doc := files["word/document.xml"]
	if !strings.Contains(doc, "Title Heading") || !strings.Contains(doc, "<w:b/>") {
		t.Fatalf("document.xml missing content/marks")
	}
	// XML special chars escaped.
	if !strings.Contains(doc, "world &amp; &lt;friends&gt;") {
		t.Fatalf("text not escaped: %s", doc)
	}
}

func TestBuildPDF(t *testing.T) {
	blocks := ResolveBlocks(sampleDoc())
	out, err := BuildPDF(blocks, "My Doc")
	if err != nil {
		t.Fatalf("BuildPDF: %v", err)
	}
	if !bytes.HasPrefix(out, []byte("%PDF-1.4")) {
		t.Fatal("missing PDF header")
	}
	if !bytes.Contains(out, []byte("%%EOF")) {
		t.Fatal("missing EOF trailer")
	}
	if !bytes.Contains(out, []byte("/Type /Catalog")) || !bytes.Contains(out, []byte("/Type /Page ")) {
		t.Fatal("missing catalog/page objects")
	}
	if !bytes.Contains(out, []byte("(My Doc)")) {
		t.Fatal("title not drawn")
	}
	if !bytes.Contains(out, []byte("startxref")) {
		t.Fatal("missing xref")
	}
}
