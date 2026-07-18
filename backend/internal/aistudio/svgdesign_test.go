package aistudio

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestExtractSVG(t *testing.T) {
	cases := map[string]string{
		"<svg a=\"1\"><rect/></svg>":                          "<svg a=\"1\"><rect/></svg>",
		"sure! ```svg\n<svg><rect/></svg>\n``` done":          "<svg><rect/></svg>",
		"prose before <svg><text>x</text></svg> and after":   "<svg><text>x</text></svg>",
		"no svg here":                                         "",
	}
	for in, want := range cases {
		if got := extractSVG(in); got != want {
			t.Errorf("extractSVG(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestValidateSVG(t *testing.T) {
	if err := validateSVG(`<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="10" height="10"/><text>Hi</text></svg>`); err != nil {
		t.Fatalf("valid svg rejected: %v", err)
	}
	bad := []string{
		"",                                  // empty
		"<div>not svg</div>",                // wrong root
		"<svg><rect></svg>",                 // malformed (unclosed rect)
		"<svg><g><rect/></svg>",             // malformed (unclosed g)
	}
	for _, b := range bad {
		if err := validateSVG(b); err == nil {
			t.Errorf("validateSVG(%q) should have failed", b)
		}
	}
}

func TestGenerateSvg_RetriesThenSucceeds(t *testing.T) {
	good := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="#111"/><text x="100" y="200" fill="#fff">Launch</text></svg>`
	gen := &stubGen{replies: []string{"here you go: not-svg", "```\n" + good + "\n```"}}
	svc := NewService(nil, gen)
	d, err := svc.GenerateSvg(context.Background(), "ws", "Q3 launch", "presentation", 1920, 1080)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if gen.calls != 2 {
		t.Fatalf("expected 2 attempts, got %d", gen.calls)
	}
	if !strings.HasPrefix(d.SVG, "<svg") || !strings.Contains(d.SVG, "<text") {
		t.Fatalf("unexpected svg: %q", d.SVG)
	}
	if d.Width != 1920 || d.Height != 1080 || d.Title == "" {
		t.Fatalf("bad design meta: %+v", d)
	}
}

func TestGenerateSvg_GivesUp(t *testing.T) {
	gen := &stubGen{replies: []string{"nope", "still nope", "nope again"}}
	svc := NewService(nil, gen)
	if _, err := svc.GenerateSvg(context.Background(), "ws", "x", "poster", 0, 0); !errors.Is(err, ErrInvalidOutput) {
		t.Fatalf("expected ErrInvalidOutput, got %v", err)
	}
}
