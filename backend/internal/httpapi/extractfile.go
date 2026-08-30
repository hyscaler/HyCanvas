// POST /ai/extract-file: server-side text extraction from office documents
// (.docx/.pptx/.xlsx) for AI generation grounding (F28 T15). The browser has
// no OOXML reader, so the server unzips the document and walks the XML
// directly: paragraphs for a docx, slide texts in deck order for a pptx, and
// tab-separated sheet rows for an xlsx. Validated by BOTH extension and MIME,
// size-capped, RFC 7807 errors. Extraction only - nothing is stored.

package httpapi

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
)

const (
	// maxOfficeFileBytes caps the uploaded document (multipart part), matching
	// the reference's office-ingestion scale.
	maxOfficeFileBytes = 20 << 20 // 20 MiB
	// maxExtractedChars caps the returned text; the client caps its combined
	// source budget separately.
	maxExtractedChars = 200_000
)

// officeMIME maps the accepted extensions to their canonical MIME types. Both
// checks run: a renamed file fails MIME, a re-typed body fails the extension.
var officeMIME = map[string]string{
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

func mountExtractFile(api chi.Router, acct *accounts.Service) {
	api.With(requireAuth(acct)).Post("/ai/extract-file", extractFileHandler())
}

func extractFileHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Base64 JSON, the repo's file-transport convention (see uploadAsset):
		// the body cap covers the ~4/3 base64 expansion of the file cap.
		r.Body = http.MaxBytesReader(w, r.Body, (maxOfficeFileBytes/3)*4+4096)
		var body struct {
			Filename   string `json:"filename"`
			MimeType   string `json:"mimeType"`
			DataBase64 string `json:"dataBase64"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			// Distinguish the body-cap trip (413) from plain malformed JSON (400).
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				problemWithCode(w, r, http.StatusRequestEntityTooLarge, "Payload Too Large", "the file exceeds the 20 MiB extraction limit", "extract_file_too_large")
				return
			}
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		ext := strings.ToLower(path.Ext(body.Filename))
		wantMIME, okExt := officeMIME[ext]
		if !okExt {
			problemWithCode(w, r, http.StatusUnsupportedMediaType, "Unsupported Media Type", "only .docx, .pptx, and .xlsx files can be extracted", "extract_file_unsupported")
			return
		}
		// MIME AND extension: the declared content type must agree with the
		// extension (a generic octet-stream from picky browsers is tolerated;
		// the zip signature check below still applies).
		if body.MimeType != "" && body.MimeType != "application/octet-stream" && body.MimeType != wantMIME {
			problemWithCode(w, r, http.StatusUnsupportedMediaType, "Unsupported Media Type", "only .docx, .pptx, and .xlsx files can be extracted", "extract_file_unsupported")
			return
		}
		data, err := base64.StdEncoding.DecodeString(body.DataBase64)
		if err != nil || len(data) == 0 {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		if len(data) > maxOfficeFileBytes {
			problemWithCode(w, r, http.StatusRequestEntityTooLarge, "Payload Too Large", "the file exceeds the 20 MiB extraction limit", "extract_file_too_large")
			return
		}
		// Every OOXML document is a zip; a non-zip body is a lying extension.
		if len(data) < 4 || data[0] != 'P' || data[1] != 'K' {
			problemWithCode(w, r, http.StatusUnsupportedMediaType, "Unsupported Media Type", "only .docx, .pptx, and .xlsx files can be extracted", "extract_file_unsupported")
			return
		}

		var text string
		switch ext {
		case ".docx":
			text, err = extractDocx(data)
		case ".pptx":
			text, err = extractPptx(data)
		case ".xlsx":
			text, err = extractXlsx(data)
		}
		if err != nil {
			problemWithCode(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", "the document could not be read", "extract_file_unreadable")
			return
		}
		text = strings.TrimSpace(text)
		if len(text) > maxExtractedChars {
			// Rune-safe cut: back off to a boundary rather than splitting UTF-8.
			cut := maxExtractedChars
			for cut > 0 && (text[cut]&0xC0) == 0x80 {
				cut--
			}
			text = text[:cut]
		}
		writeJSON(w, http.StatusOK, map[string]string{"name": body.Filename, "text": text})
	}
}

// zipFile opens one archive member, returning nil when absent.
func zipEntry(zr *zip.Reader, name string) []byte {
	for _, f := range zr.File {
		if f.Name != name {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil
		}
		defer rc.Close()
		b, err := io.ReadAll(io.LimitReader(rc, maxOfficeFileBytes))
		if err != nil {
			return nil
		}
		return b
	}
	return nil
}

// collectText walks an OOXML fragment and gathers the character data of every
// element named `tag` (e.g. "t" for both w:t and a:t), in document order.
// Whole-element granularity: consecutive runs join without separators, which
// matches how the source text was split into runs.
func collectText(xmlData []byte, tag string) []string {
	dec := xml.NewDecoder(bytes.NewReader(xmlData))
	var out []string
	depth := 0 // >0 while inside a matching element
	var buf strings.Builder
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == tag {
				depth++
			}
		case xml.EndElement:
			if t.Name.Local == tag && depth > 0 {
				depth--
				if depth == 0 {
					out = append(out, buf.String())
					buf.Reset()
				}
			}
		case xml.CharData:
			if depth > 0 {
				buf.Write(t)
			}
		}
	}
	return out
}

// extractDocx returns the document's paragraphs, one line each: w:p elements
// delimit paragraphs, their w:t runs concatenate.
func extractDocx(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", err
	}
	doc := zipEntry(zr, "word/document.xml")
	if doc == nil {
		return "", fmt.Errorf("word/document.xml missing")
	}
	// Paragraph-granular walk with a DEPTH counter: w:p nests (a text box
	// inside a paragraph carries its own w:p), and a boolean would close the
	// outer paragraph at the inner's end, dropping everything after the shape.
	dec := xml.NewDecoder(bytes.NewReader(doc))
	var paragraphs []string
	var para strings.Builder
	paraDepth := 0
	inText := false
	flush := func() {
		if s := strings.TrimSpace(para.String()); s != "" {
			paragraphs = append(paragraphs, s)
		}
		para.Reset()
	}
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "p":
				paraDepth++
			case "t":
				inText = true
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "p":
				if paraDepth > 0 {
					paraDepth--
					if paraDepth == 0 {
						flush()
					}
				}
			case "t":
				inText = false
			}
		case xml.CharData:
			if paraDepth > 0 && inText {
				para.Write(t)
			}
		}
	}
	return strings.Join(paragraphs, "\n"), nil
}

var slideNameRe = regexp.MustCompile(`^ppt/slides/slide(\d+)\.xml$`)

// extractPptx returns each slide's text in DECK order (slide file names sort
// numerically, not lexically: slide10 follows slide9), one block per slide.
func extractPptx(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", err
	}
	type slide struct {
		n    int
		name string
	}
	var slides []slide
	for _, f := range zr.File {
		if m := slideNameRe.FindStringSubmatch(f.Name); m != nil {
			n, _ := strconv.Atoi(m[1])
			slides = append(slides, slide{n: n, name: f.Name})
		}
	}
	if len(slides) == 0 {
		return "", fmt.Errorf("no slides")
	}
	sort.Slice(slides, func(i, j int) bool { return slides[i].n < slides[j].n })
	var blocks []string
	for _, s := range slides {
		texts := collectText(zipEntry(zr, s.name), "t") // a:t runs
		var lines []string
		for _, t := range texts {
			if s := strings.TrimSpace(t); s != "" {
				lines = append(lines, s)
			}
		}
		if len(lines) > 0 {
			blocks = append(blocks, fmt.Sprintf("[Slide %d]\n%s", s.n, strings.Join(lines, "\n")))
		}
	}
	return strings.Join(blocks, "\n\n"), nil
}

// extractXlsx returns each sheet's rows tab-separated, one row per line, in
// the WORKBOOK's display order and under the user-visible sheet names
// (xl/workbook.xml + its rels; sheetN.xml file numbering is creation order
// and diverges after deletes/reorders). Cells land in their REFERENCED
// columns (Excel omits empty cells, so positional appends would shift values
// under the wrong headers), shared strings are resolved, rich inline strings
// join their runs into one cell, and formulas contribute cached values.
func extractXlsx(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", err
	}
	shared := xlsxSharedStrings(zr)
	sheets := xlsxSheetOrder(zr)
	if len(sheets) == 0 {
		return "", fmt.Errorf("no sheets")
	}
	var blocks []string
	for _, sh := range sheets {
		rows := xlsxSheetRows(zipEntry(zr, sh.path), shared)
		if len(rows) > 0 {
			blocks = append(blocks, fmt.Sprintf("[Sheet: %s]\n%s", sh.name, strings.Join(rows, "\n")))
		}
	}
	return strings.Join(blocks, "\n\n"), nil
}

type xlsxSheet struct {
	name string
	path string
}

// xlsxSheetOrder reads the workbook's sheet list (display order + names) and
// resolves each sheet's worksheet part via the workbook rels. Falls back to
// numeric file order with synthetic names when either part is missing.
func xlsxSheetOrder(zr *zip.Reader) []xlsxSheet {
	rels := map[string]string{} // rId -> part path
	if b := zipEntry(zr, "xl/_rels/workbook.xml.rels"); b != nil {
		dec := xml.NewDecoder(bytes.NewReader(b))
		for {
			tok, err := dec.Token()
			if err != nil {
				break
			}
			if t, ok := tok.(xml.StartElement); ok && t.Name.Local == "Relationship" {
				var id, target string
				for _, a := range t.Attr {
					switch a.Name.Local {
					case "Id":
						id = a.Value
					case "Target":
						target = a.Value
					}
				}
				if id != "" && target != "" {
					if !strings.HasPrefix(target, "/") {
						target = "xl/" + strings.TrimPrefix(target, "./")
					} else {
						target = strings.TrimPrefix(target, "/")
					}
					rels[id] = target
				}
			}
		}
	}
	var sheets []xlsxSheet
	if b := zipEntry(zr, "xl/workbook.xml"); b != nil {
		dec := xml.NewDecoder(bytes.NewReader(b))
		for {
			tok, err := dec.Token()
			if err != nil {
				break
			}
			if t, ok := tok.(xml.StartElement); ok && t.Name.Local == "sheet" {
				var name, rid string
				for _, a := range t.Attr {
					switch a.Name.Local {
					case "name":
						name = a.Value
					case "id": // r:id resolves to Local "id" in the r namespace
						rid = a.Value
					}
				}
				if path, ok := rels[rid]; ok && name != "" {
					sheets = append(sheets, xlsxSheet{name: name, path: path})
				}
			}
		}
	}
	if len(sheets) > 0 {
		return sheets
	}
	// Fallback: numeric file order, synthetic names.
	var names []string
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "xl/worksheets/sheet") && strings.HasSuffix(f.Name, ".xml") {
			names = append(names, f.Name)
		}
	}
	sheetNum := func(name string) int {
		n, _ := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(name, "xl/worksheets/sheet"), ".xml"))
		return n
	}
	sort.Slice(names, func(i, j int) bool { return sheetNum(names[i]) < sheetNum(names[j]) })
	for i, n := range names {
		sheets = append(sheets, xlsxSheet{name: fmt.Sprintf("Sheet %d", i+1), path: n})
	}
	return sheets
}

// xlsxSharedStrings reads the shared-string table (si entries in order; plain
// t or rich runs both concatenate).
func xlsxSharedStrings(zr *zip.Reader) []string {
	b := zipEntry(zr, "xl/sharedStrings.xml")
	if b == nil {
		return nil
	}
	var shared []string
	dec := xml.NewDecoder(bytes.NewReader(b))
	var cur strings.Builder
	inSI, inT := false, false
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "si":
				inSI = true
			case "t":
				inT = true
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "si":
				shared = append(shared, cur.String())
				cur.Reset()
				inSI = false
			case "t":
				inT = false
			}
		case xml.CharData:
			if inSI && inT {
				cur.Write(t)
			}
		}
	}
	return shared
}

// colIndexFromRef turns a cell reference's column letters into a 0-based
// index ("A1" -> 0, "BC12" -> 54); -1 when the ref carries no letters.
func colIndexFromRef(ref string) int {
	n := 0
	seen := false
	for _, ch := range ref {
		if ch >= 'A' && ch <= 'Z' {
			n = n*26 + int(ch-'A') + 1
			seen = true
			continue
		}
		break
	}
	if !seen {
		return -1
	}
	return n - 1
}

// xlsxSheetRows walks one worksheet: cells land at their REFERENCED column
// (missing cells stay empty), a cell's value accumulates across every v/t
// inside it (rich inline strings are several t runs, ONE cell), and shared
// refs resolve at cell end.
func xlsxSheetRows(sheet []byte, shared []string) []string {
	if sheet == nil {
		return nil
	}
	dec := xml.NewDecoder(bytes.NewReader(sheet))
	var rows []string
	cells := map[int]string{}
	maxCol := -1
	nextCol := 0 // positional fallback for cells without an r attribute
	curCol := 0
	cellType := ""
	var val strings.Builder
	inCell, inV := false, false
	flushRow := func() {
		if maxCol < 0 {
			return
		}
		out := make([]string, maxCol+1)
		for c, v := range cells {
			if c >= 0 && c <= maxCol {
				out[c] = v
			}
		}
		if line := strings.TrimRight(strings.Join(out, "\t"), "\t"); strings.TrimSpace(line) != "" {
			rows = append(rows, line)
		}
		cells = map[int]string{}
		maxCol = -1
		nextCol = 0
	}
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "row":
				cells = map[int]string{}
				maxCol = -1
				nextCol = 0
			case "c":
				inCell = true
				cellType = ""
				val.Reset()
				curCol = nextCol
				for _, a := range t.Attr {
					switch a.Name.Local {
					case "t":
						cellType = a.Value
					case "r":
						if c := colIndexFromRef(a.Value); c >= 0 {
							curCol = c
						}
					}
				}
			case "v", "t":
				if inCell {
					inV = true
				}
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "row":
				flushRow()
			case "c":
				if inCell {
					s := val.String()
					if cellType == "s" {
						if i, err := strconv.Atoi(strings.TrimSpace(s)); err == nil && i >= 0 && i < len(shared) {
							s = shared[i]
						}
					}
					cells[curCol] = s
					if curCol > maxCol {
						maxCol = curCol
					}
					nextCol = curCol + 1
					inCell = false
				}
			case "v", "t":
				inV = false
			}
		case xml.CharData:
			if inCell && inV {
				val.Write(t)
			}
		}
	}
	return rows
}
