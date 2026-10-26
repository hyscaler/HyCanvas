package aistudio

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// cannedAI answers every structured call with the next queued reply and
// records the prompt it was given.
type cannedAI struct {
	textOnlyAI
	replies []string
	prompts []string
}

func (a *cannedAI) TextStructured(_ context.Context, _, user, _, _ string) (string, error) {
	a.prompts = append(a.prompts, user)
	if len(a.replies) == 0 {
		return "", errors.New("no reply queued")
	}
	r := a.replies[0]
	a.replies = a.replies[1:]
	return r, nil
}

func TestSuggestBrandIdentityKeepsTheGivenNameAndCatalogFonts(t *testing.T) {
	ai := &cannedAI{replies: []string{`{"name":"Something Else","tone":["Warm","warm","Plain-spoken"," Curious "],"doSay":["Short sentences",""],"dontSay":["Jargon"],"sampleCopy":"We bake it fresh.","headingFont":"playfair display","bodyFont":"Inter"}`}}
	svc := NewService(nil, ai)
	got, err := svc.SuggestBrandIdentity(context.Background(), "ws", BrandIdentityInput{
		Name:        "Acme Bakery",
		Description: "A neighbourhood bakery",
		Colors:      []string{"#aa3311"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Acme Bakery" {
		t.Fatalf("name = %q, want the user's own name kept", got.Name)
	}
	if strings.Join(got.Tone, "|") != "Warm|Plain-spoken|Curious" {
		t.Fatalf("tone = %q, want trimmed and de-duplicated", got.Tone)
	}
	if len(got.DoSay) != 1 || got.HeadingFont != "Playfair Display" || got.BodyFont != "Inter" {
		t.Fatalf("got %+v", got)
	}
	if !strings.Contains(ai.prompts[0], "Brand colors: #aa3311") {
		t.Fatalf("prompt should carry the colors: %q", ai.prompts[0])
	}
}

func TestSuggestBrandIdentityRepairsAFontOutsideTheCatalog(t *testing.T) {
	ai := &cannedAI{replies: []string{
		`{"name":"","tone":["Bold","Direct"],"doSay":[],"dontSay":[],"sampleCopy":"Go.","headingFont":"Helvetica Neue","bodyFont":"Inter"}`,
		`{"name":"","tone":["Bold","Direct"],"doSay":[],"dontSay":[],"sampleCopy":"Go.","headingFont":"Brandon Grotesque","bodyFont":"Inter"}`,
	}}
	svc := NewService(nil, ai)
	got, err := svc.SuggestBrandIdentity(context.Background(), "ws", BrandIdentityInput{
		PageContext:   "Title: Trailhead",
		ObservedFonts: []string{"Brandon Grotesque"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.HeadingFont != "Brandon Grotesque" {
		t.Fatalf("an observed font is allowed, got %q", got.HeadingFont)
	}
	if len(ai.prompts) != 2 || !strings.Contains(ai.prompts[1], "allowed fonts") {
		t.Fatalf("want one repair pass naming the rejection, prompts = %d", len(ai.prompts))
	}
}

func TestSuggestBrandIdentityNeedsSomethingToGoOn(t *testing.T) {
	svc := NewService(nil, &cannedAI{})
	if _, err := svc.SuggestBrandIdentity(context.Background(), "ws", BrandIdentityInput{Colors: []string{"#000000"}}); !errors.Is(err, ErrBrandIdentityEmpty) {
		t.Fatalf("want ErrBrandIdentityEmpty, got %v", err)
	}
}

func TestDescribeLogoIsSkippedOnATextOnlyProvider(t *testing.T) {
	svc := NewService(nil, textOnlyAI{})
	if _, err := svc.DescribeLogo(context.Background(), "ws", "AAAA"); !errors.Is(err, ErrReviewUnsupported) {
		t.Fatalf("want ErrReviewUnsupported, got %v", err)
	}
	ai := &seeingAI{reply: "  A green leaf above the word ACME.  "}
	got, err := NewService(nil, ai).DescribeLogo(context.Background(), "ws", "AAAA")
	if err != nil || got != "A green leaf above the word ACME." {
		t.Fatalf("got %q, %v", got, err)
	}
}
