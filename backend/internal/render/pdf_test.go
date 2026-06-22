package render

import (
	"bytes"
	"strings"
	"testing"
)

func TestToPDF(t *testing.T) {
	pdf, err := ToPDF(sampleDesign(), 0)
	if err != nil {
		t.Fatalf("ToPDF: %v", err)
	}
	if !bytes.HasPrefix(pdf, []byte("%PDF-1.7")) {
		t.Fatal("missing PDF header")
	}
	s := string(pdf)
	for _, m := range []string{
		"/Type /Catalog", "/Type /Pages", "/Type /Page",
		"/MediaBox [0 0 200 100]", "/BaseFont /Helvetica",
		" re\n", // rect op (background + rect node)
		" Tj\n", // text op
		" c\n",  // ellipse/curve op
		"xref", "trailer", "startxref",
	} {
		if !strings.Contains(s, m) {
			t.Fatalf("pdf missing %q", m)
		}
	}
	if !strings.HasSuffix(strings.TrimSpace(s), "%%EOF") {
		t.Fatal("missing EOF trailer")
	}
	// The single xref free entry + one entry per object must be present.
	if !strings.Contains(s, "0000000000 65535 f") {
		t.Fatal("missing xref free entry")
	}
	if _, err := ToPDF(sampleDesign(), 9); err != ErrPageRange {
		t.Fatalf("out-of-range page should error, got %v", err)
	}
}
