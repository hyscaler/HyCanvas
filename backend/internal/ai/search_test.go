package ai

import "testing"

// The allocation cap comes from a request body, so cleanResults clamps it
// itself rather than trusting whichever caller reached it. Search clamps too,
// which is why nothing arrives unbounded today; the point is that the guard
// now lives in the function that allocates.
func TestCleanResultsClampsItsOwnAllocation(t *testing.T) {
	in := make([]SearchResult, 0, 40)
	for i := 0; i < 40; i++ {
		in = append(in, SearchResult{Title: "t", URL: "https://example.com", Content: "c"})
	}
	if got := len(cleanResults(in, 1<<40)); got != maxSearchResults {
		t.Fatalf("an absurd cap should collapse to %d, got %d", maxSearchResults, got)
	}
	// A negative cap would panic make; it must not, and must not silently
	// become one result either.
	if got := len(cleanResults(in, -1)); got != 0 {
		t.Fatalf("a negative cap should yield nothing, got %d", got)
	}
	// Zero still means zero: the guard is against negatives, not a redefinition.
	if got := len(cleanResults(in, 0)); got != 0 {
		t.Fatalf("a zero cap should yield nothing, got %d", got)
	}
	if got := len(cleanResults(in, 3)); got != 3 {
		t.Fatalf("an ordinary cap should be honored, got %d", got)
	}
}
