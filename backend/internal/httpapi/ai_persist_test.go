package httpapi

import (
	"context"
	"testing"
)

// TestPersistAIImageFallbacks covers the safe-degradation branches: when there
// is no uploads service, no image, or a value that is neither a data: nor an
// http(s) URL, the original value is returned unchanged so image generation
// never breaks on a persistence problem. (The data-URL Upload and URL
// ImportFromURL paths are covered by the uploads package's own tests.)
func TestPersistAIImageFallbacks(t *testing.T) {
	ctx := context.Background()
	cases := []string{
		"",                       // empty
		"data:image/png;base64,", // data URL with empty payload
		"not-a-url",              // neither data: nor http(s)
		"https://mfile.z.ai/x.png",
		"data:image/png;base64,iVBORw0KGgo=",
	}
	for _, in := range cases {
		// nil uploads service => always returns the input unchanged.
		if got := persistAIImage(ctx, nil, "u1", "w1", in); got != in {
			t.Fatalf("nil uploads should pass through %q, got %q", in, got)
		}
	}
}
