package aistudio

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strings"
)

// SvgDesign is one AI-generated design page as a self-contained SVG document,
// sized to the target artboard. The client converts the SVG to editable
// scene-graph nodes (flattenSvgToNodes) and persists it as a HyCanvas design, so
// unlike an AI image the result stays fully editable (shapes, text, gradients).
type SvgDesign struct {
	Title  string `json:"title"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	SVG    string `json:"svg"`
}

// maxSVGBytes caps a single generated SVG so a runaway reply can't be persisted.
const maxSVGBytes = 200 * 1024

// GenerateSvg asks the model to render a complete, stylish design as a single
// self-contained SVG at width x height, using editable vector primitives (never
// rasterizing, never converting text to paths) so the imported result stays
// fully editable. It reuses the AI proxy (BYO key, policy, metering) and retries
// until the reply is a well-formed SVG or the retry budget is spent.
func (s *Service) GenerateSvg(ctx context.Context, workspaceID, prompt, designType string, width, height int) (*SvgDesign, error) {
	if width <= 0 {
		width = 1920
	}
	if height <= 0 {
		height = 1080
	}
	system := svgSystem(designType, width, height)
	user := fmt.Sprintf("Design type: %s\nBrief: %s", designType, strings.TrimSpace(prompt))
	msg := user
	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		out, err := s.ai.Text(ctx, workspaceID, msg, system)
		if err != nil {
			return nil, err // provider/policy errors propagate unchanged
		}
		svg := extractSVG(out)
		if verr := validateSVG(svg); verr != nil {
			lastErr = verr
			msg = user + "\n\nYour previous reply was rejected: " + verr.Error() +
				". Return ONLY one complete, well-formed <svg>...</svg> document, no prose, no code fences."
			continue
		}
		return &SvgDesign{Title: titleFromPrompt(prompt), Width: width, Height: height, SVG: svg}, nil
	}
	return nil, fmt.Errorf("%w: %v", ErrInvalidOutput, lastErr)
}

// svgSystem is the generation contract: a full-bleed, editable SVG at the target
// size, with real copy and no rasterization or text-as-paths (both would defeat
// the "import as an editable design" goal).
func svgSystem(designType string, w, h int) string {
	return fmt.Sprintf(`You are a design engine that outputs SVG. Produce a complete, modern, visually polished %s as a single self-contained SVG.

Hard requirements:
- Output ONLY the SVG. No markdown, no code fences, no explanation before or after.
- Root: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d">.
- Fill the whole %dx%d canvas (start with a full-bleed background <rect>).
- Use editable primitives only: <rect>, <circle>, <ellipse>, <line>, <polygon>, <text>, and gradients in <defs>.
- NEVER convert text to <path>. Every headline and body stays a <text> element with font-family, font-size, and fill.
- Real, final copy (no lorem ipsum). Clear hierarchy: a strong headline, supporting text, and 1-3 accent shapes.
- Strong contrast and generous spacing. Do not use clipPath, mask, filter, or <use>.`, designType, w, h, w, h, w, h)
}

func titleFromPrompt(p string) string {
	p = strings.TrimSpace(strings.ReplaceAll(p, "\n", " "))
	if p == "" {
		return "AI design"
	}
	if len(p) > 60 {
		p = strings.TrimSpace(p[:60])
	}
	return p
}

// extractSVG pulls the <svg ...>...</svg> document out of a model reply, tolerating
// code fences or surrounding prose. Returns "" when no root is present.
func extractSVG(reply string) string {
	i := strings.Index(reply, "<svg")
	if i < 0 {
		return ""
	}
	end := strings.LastIndex(reply, "</svg>")
	if end < 0 || end < i {
		return ""
	}
	return strings.TrimSpace(reply[i : end+len("</svg>")])
}

// validateSVG checks the string is a well-formed XML document rooted at <svg>,
// within the size cap. Well-formedness matters because the client SVG importer
// parses it as XML.
func validateSVG(svg string) error {
	if svg == "" || !strings.HasPrefix(svg, "<svg") {
		return errors.New("no <svg> root element found")
	}
	if len(svg) > maxSVGBytes {
		return errors.New("SVG is too large")
	}
	dec := xml.NewDecoder(strings.NewReader(svg))
	depth, sawSvg := 0, false
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("malformed XML: %v", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if depth == 0 && t.Name.Local != "svg" {
				return errors.New("root element is not <svg>")
			}
			if t.Name.Local == "svg" {
				sawSvg = true
			}
			depth++
		case xml.EndElement:
			depth--
		}
	}
	if !sawSvg {
		return errors.New("no <svg> element")
	}
	return nil
}
