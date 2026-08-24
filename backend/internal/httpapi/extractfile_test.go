package httpapi

// Office-format extraction (F28 T15): fixtures are built in memory as minimal
// valid OOXML zips, so the tests need no binary files in the repo.

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

func buildZip(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range entries {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestExtractDocx(t *testing.T) {
	doc := `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>First paragraph, </w:t></w:r><w:r><w:t>joined runs.</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Second — with émojis 🎉 and Ünïcode.</w:t></w:r></w:p>
    <w:p></w:p>
    <w:p><w:r><w:t>Third.</w:t></w:r></w:p>
  </w:body>
</w:document>`
	data := buildZip(t, map[string]string{"word/document.xml": doc})
	text, err := extractDocx(data)
	if err != nil {
		t.Fatal(err)
	}
	want := "First paragraph, joined runs.\nSecond — with émojis 🎉 and Ünïcode.\nThird."
	if text != want {
		t.Fatalf("docx text = %q, want %q", text, want)
	}
}

func TestExtractPptxDeckOrder(t *testing.T) {
	slide := func(text string) string {
		return `<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>` + text + `</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`
	}
	// slide10 must follow slide9, not slide1 (numeric, not lexical, order).
	data := buildZip(t, map[string]string{
		"ppt/slides/slide10.xml": slide("Tenth"),
		"ppt/slides/slide2.xml":  slide("Second"),
		"ppt/slides/slide1.xml":  slide("First"),
		"ppt/slides/slide9.xml":  slide("Ninth"),
	})
	text, err := extractPptx(data)
	if err != nil {
		t.Fatal(err)
	}
	order := []string{"[Slide 1]", "First", "[Slide 2]", "Second", "[Slide 9]", "Ninth", "[Slide 10]", "Tenth"}
	pos := -1
	for _, needle := range order {
		i := strings.Index(text, needle)
		if i <= pos {
			t.Fatalf("deck order wrong: %q not after previous marker in\n%s", needle, text)
		}
		pos = i
	}
}

func TestExtractXlsxSharedStringsAndRows(t *testing.T) {
	shared := `<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Region</t></si><si><r><t>Rev</t></r><r><t>enue</t></r></si><si><t>North</t></si></sst>`
	sheet := `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1234.5</v></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>Inline</t></is></c></row>
  </sheetData>
</worksheet>`
	data := buildZip(t, map[string]string{
		"xl/sharedStrings.xml":    shared,
		"xl/worksheets/sheet1.xml": sheet,
	})
	text, err := extractXlsx(data)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Region\tRevenue", "North\t1234.5", "Inline"} {
		if !strings.Contains(text, want) {
			t.Fatalf("xlsx text missing %q:\n%s", want, text)
		}
	}
}

func TestExtractRejectsNonOffice(t *testing.T) {
	if _, err := extractDocx([]byte("not a zip at all")); err == nil {
		t.Fatal("non-zip must error")
	}
	// A valid zip missing the expected member also errors.
	data := buildZip(t, map[string]string{"unrelated.txt": "x"})
	if _, err := extractDocx(data); err == nil {
		t.Fatal("zip without word/document.xml must error")
	}
	if _, err := extractPptx(data); err == nil {
		t.Fatal("zip without slides must error")
	}
	if _, err := extractXlsx(data); err == nil {
		t.Fatal("zip without sheets must error")
	}
}

func TestExtractXlsxSparseCellsAndRichStrings(t *testing.T) {
	// Excel omits empty cells: C2's value must land under column C, not B.
	// A rich inline string (two t runs) is ONE cell, not two.
	sheet := `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><r><t>Rev</t></r><r><t>enue</t></r></is></c><c r="B1" t="inlineStr"><is><t>Units</t></is></c><c r="C1" t="inlineStr"><is><t>Zone</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>North</t></is></c><c r="C2"><v>30</v></c></row>
  </sheetData>
</worksheet>`
	data := buildZip(t, map[string]string{"xl/worksheets/sheet1.xml": sheet})
	text, err := extractXlsx(data)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "Revenue\tUnits\tZone") {
		t.Fatalf("rich runs split into cells:\n%s", text)
	}
	if !strings.Contains(text, "North\t\t30") {
		t.Fatalf("sparse cell not placed at its referenced column:\n%s", text)
	}
}

func TestExtractXlsxWorkbookOrderAndNames(t *testing.T) {
	sheet := func(v string) string {
		return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>` + v + `</t></is></c><c r="B1"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>x</t></is></c><c r="B2"><v>2</v></c></row></sheetData></worksheet>`
	}
	workbook := `<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Revenue" sheetId="7" r:id="rId2"/>
    <sheet name="Costs" sheetId="3" r:id="rId1"/>
  </sheets>
</workbook>`
	rels := `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="t" Target="worksheets/sheet2.xml"/>
</Relationships>`
	data := buildZip(t, map[string]string{
		"xl/workbook.xml":            workbook,
		"xl/_rels/workbook.xml.rels": rels,
		"xl/worksheets/sheet1.xml":   sheet("CostRow"),
		"xl/worksheets/sheet2.xml":   sheet("RevRow"),
	})
	text, err := extractXlsx(data)
	if err != nil {
		t.Fatal(err)
	}
	// Display order: Revenue (sheet2) first, Costs (sheet1) second - the
	// opposite of file-number order - under the user-visible names.
	iRev := strings.Index(text, "[Sheet: Revenue]")
	iCost := strings.Index(text, "[Sheet: Costs]")
	if iRev < 0 || iCost < 0 || iRev > iCost {
		t.Fatalf("workbook order/names not honored:\n%s", text)
	}
	if !strings.Contains(text[iRev:iCost], "RevRow") {
		t.Fatalf("sheet name mapped to the wrong worksheet part:\n%s", text)
	}
}
