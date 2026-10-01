package aistudio

import (
	"context"
	"errors"
	"testing"
)

type textOnlyAI struct{}

func (textOnlyAI) Text(context.Context, string, string, string) (string, error) { return "", nil }
func (textOnlyAI) TextStructured(context.Context, string, string, string, string) (string, error) {
	return "", nil
}

type seeingAI struct {
	textOnlyAI
	reply string
	got   string
}

func (a *seeingAI) DescribeImage(_ context.Context, _, _, instruction string) (string, error) {
	a.got = instruction
	return a.reply, nil
}

func TestReviewPageReadsFencedFindingsAndHoldsTheVocabulary(t *testing.T) {
	ai := &seeingAI{reply: "```json\n{\"issues\":[{\"kind\":\"Overlap\",\"detail\":\"The label wraps under the figure.\"},{\"kind\":\"spacing\",\"detail\":\"Too much air on the right.\"},{\"kind\":\"empty\",\"detail\":\"\"}]}\n```"}
	svc := NewService(nil, ai)
	got, err := svc.ReviewPage(context.Background(), "ws", "AAAA", "The pilot in numbers")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Kind != "overlap" || got[1].Kind != "other" || got[0].Detail != "The label wraps under the figure." {
		t.Fatalf("findings = %+v", got)
	}
	if ai.got == "" || ai.got[len(ai.got)-1] != '.' {
		t.Fatalf("instruction should carry the heading, got %q", ai.got)
	}
}

func TestReviewPageIsSkippedOnATextOnlyProvider(t *testing.T) {
	svc := NewService(nil, textOnlyAI{})
	if _, err := svc.ReviewPage(context.Background(), "ws", "AAAA", ""); !errors.Is(err, ErrReviewUnsupported) {
		t.Fatalf("want ErrReviewUnsupported, got %v", err)
	}
}

func TestParseReviewFindingsTreatsGarbageAsClean(t *testing.T) {
	if got := parseReviewFindings("I could not see anything wrong with this slide."); got != nil {
		t.Fatalf("want no findings, got %+v", got)
	}
	if got := parseReviewFindings("{\"issues\":[]}"); len(got) != 0 {
		t.Fatalf("want empty, got %+v", got)
	}
}
