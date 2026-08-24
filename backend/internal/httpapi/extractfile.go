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
			problemWithCode(w, r, http.StatusRequestEntityTooLarge, "Payload Too Large", "the file exceeds the 20 MiB extraction limit", "extract_file_too_large")
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
			text = text[:maxExtractedChars]
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
	// Paragraph-granular walk: track w:p boundaries, join w:t runs inside.
	dec := xml.NewDecoder(bytes.NewReader(doc))
	var paragraphs []string
	var para strings.Builder
	inPara, inText := false, false
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "p":
				inPara = true
			case "t":
				inText = true
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "p":
				if inPara {
					if s := strings.TrimSpace(para.String()); s != "" {
						paragraphs = append(paragraphs, s)
					}
					para.Reset()
					inPara = false
				}
			case "t":
				inText = false
			}
		case xml.CharData:
			if inPara && inText {
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

// extractXlsx returns each sheet's rows tab-separated, one row per line, with
// shared strings resolved (the common cell-text encoding) and inline strings
// handled. Formulas contribute their cached values.
func extractXlsx(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", err
	}
	// Shared strings: si elements in order; each may hold plain t or rich runs.
	var shared []string
	if ss := zipEntry(zr, "xl/sharedStrings.xml"); ss != nil {
		dec := xml.NewDecoder(bytes.NewReader(ss))
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
	}
	// Sheets in workbook order (sheetN.xml sorts numerically like slides).
	var names []string
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "xl/worksheets/sheet") && strings.HasSuffix(f.Name, ".xml") {
			names = append(names, f.Name)
		}
	}
	if len(names) == 0 {
		return "", fmt.Errorf("no sheets")
	}
	sheetNum := func(name string) int {
		s := strings.TrimSuffix(strings.TrimPrefix(name, "xl/worksheets/sheet"), ".xml")
		n, _ := strconv.Atoi(s)
		return n
	}
	sort.Slice(names, func(i, j int) bool { return sheetNum(names[i]) < sheetNum(names[j]) })

	var blocks []string
	for si, name := range names {
		dec := xml.NewDecoder(bytes.NewReader(zipEntry(zr, name)))
		var rows []string
		var cells []string
		var cellType string
		var val strings.Builder
		inV := false
		for {
			tok, err := dec.Token()
			if err != nil {
				break
			}
			switch t := tok.(type) {
			case xml.StartElement:
				switch t.Name.Local {
				case "row":
					cells = cells[:0]
				case "c":
					cellType = ""
					for _, a := range t.Attr {
						if a.Name.Local == "t" {
							cellType = a.Value
						}
					}
				case "v", "t":
					inV = true
					val.Reset()
				}
			case xml.EndElement:
				switch t.Name.Local {
				case "row":
					if line := strings.TrimRight(strings.Join(cells, "\t"), "\t"); strings.TrimSpace(line) != "" {
						rows = append(rows, line)
					}
				case "c":
					// nothing: the v/t handler already appended
				case "v", "t":
					if inV {
						s := val.String()
						if cellType == "s" {
							if i, err := strconv.Atoi(strings.TrimSpace(s)); err == nil && i >= 0 && i < len(shared) {
								s = shared[i]
							}
						}
						cells = append(cells, s)
						inV = false
					}
				}
			case xml.CharData:
				if inV {
					val.Write(t)
				}
			}
		}
		if len(rows) > 0 {
			blocks = append(blocks, fmt.Sprintf("[Sheet %d]\n%s", si+1, strings.Join(rows, "\n")))
		}
	}
	return strings.Join(blocks, "\n\n"), nil
}
