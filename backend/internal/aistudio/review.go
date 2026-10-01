package aistudio

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"
)

// The render-and-review pass. The composer measures what it can (overlap,
// bounds, contrast) and repairs what it can, but some defects only a look
// catches: a word wrapped under a figure by a font the estimate did not
// know, a label that reads as clipped, a page that is mostly air. A
// provider that can read images looks at each rendered page and names what
// it sees, in a fixed vocabulary, and both doors surface the findings: the
// API in the job's quality result, the editor as a turn in the conversation.

// ErrReviewUnsupported is returned when the workspace's provider cannot read
// images; the caller skips the pass rather than failing the generation.
var ErrReviewUnsupported = errors.New("provider cannot review rendered pages")

// imageReader is the vision call the AI proxy exposes; the studio's generator
// interface is text-only on purpose, so the capability is checked at run time.
type imageReader interface {
	DescribeImage(ctx context.Context, workspaceID, imageBase64, instruction string) (string, error)
}

// PageFinding is one defect the reviewer saw on a rendered page.
type PageFinding struct {
	// Kind is one of overlap, clipped, overflow, unreadable, empty, other.
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

var findingKinds = map[string]bool{"overlap": true, "clipped": true, "overflow": true, "unreadable": true, "empty": true, "other": true}

const (
	maxFindings      = 6
	maxFindingDetail = 200
)

const reviewInstruction = "You are reviewing one slide of a generated presentation, rendered as an image. Report only visible layout defects: text overlapping other text or a picture, text cut off at a box or page edge, an element running past the page, text too small or too faint to read, or a page that is mostly empty. Ignore style, tone and wording. Reply with ONLY a JSON object, no prose, no code fence: {\"issues\":[{\"kind\":\"overlap|clipped|overflow|unreadable|empty|other\",\"detail\":\"one plain sentence naming the element and where\"}]}. A soft, flat colour block with nothing in it is a picture placeholder, not a defect. An empty list means the slide is clean. At most 6 issues."

// ReviewPage asks the provider to look at one rendered page (a PNG, base64,
// optionally a data URL) and returns the defects it named. The reply is
// parsed strictly: a fence is stripped, kinds outside the vocabulary become
// "other", details are clipped, and anything unparseable is no findings
// rather than an error, since a look that says nothing is not a failure.
func (s *Service) ReviewPage(ctx context.Context, workspaceID, imageBase64, title string) ([]PageFinding, error) {
	reader, ok := s.ai.(imageReader)
	if !ok {
		return nil, ErrReviewUnsupported
	}
	instr := reviewInstruction
	if t := strings.TrimSpace(title); t != "" {
		instr += " The slide's heading is: " + clipRunes(t, 80) + "."
	}
	out, err := reader.DescribeImage(ctx, workspaceID, imageBase64, instr)
	if err != nil {
		return nil, err
	}
	return parseReviewFindings(out), nil
}

// parseReviewFindings reads the reviewer's JSON out of whatever wrapping the
// model put around it.
func parseReviewFindings(text string) []PageFinding {
	t := strings.TrimSpace(text)
	t = strings.TrimPrefix(t, "```json")
	t = strings.TrimPrefix(t, "```")
	t = strings.TrimSuffix(t, "```")
	if i := strings.Index(t, "{"); i > 0 {
		t = t[i:]
	}
	if j := strings.LastIndex(t, "}"); j >= 0 && j < len(t)-1 {
		t = t[:j+1]
	}
	var reply struct {
		Issues []PageFinding `json:"issues"`
	}
	if err := json.Unmarshal([]byte(t), &reply); err != nil {
		return nil
	}
	var out []PageFinding
	for _, f := range reply.Issues {
		if len(out) >= maxFindings {
			break
		}
		kind := strings.ToLower(strings.TrimSpace(f.Kind))
		if !findingKinds[kind] {
			kind = "other"
		}
		detail := strings.TrimSpace(f.Detail)
		if detail == "" {
			continue
		}
		if utf8.RuneCountInString(detail) > maxFindingDetail {
			detail = clipRunes(detail, maxFindingDetail)
		}
		out = append(out, PageFinding{Kind: kind, Detail: detail})
	}
	return out
}
