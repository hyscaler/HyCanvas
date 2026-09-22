package ai

import "testing"

// A model that reasons before it answers opens its reply with a thinking block
// whose "text" is empty. Reading only the first block turned every such reply
// into an empty string, which a connection test reports as working and a
// generation then fails on.
func TestParseTextResponseSkipsReasoningBlocks(t *testing.T) {
	anthropic := []byte(`{"type":"message","content":[
		{"type":"thinking","thinking":"The user wants one word."},
		{"type":"text","text":"ok"}]}`)
	if got := parseTextResponse(ProviderAnthropic, anthropic); got != "ok" {
		t.Fatalf("anthropic: got %q, want %q", got, "ok")
	}

	bedrock := []byte(`{"output":{"message":{"content":[
		{"reasoningContent":{"reasoningText":{"text":"thinking"}}},
		{"text":"ok"}]}}}`)
	if got := parseTextResponse(ProviderBedrock, bedrock); got != "ok" {
		t.Fatalf("bedrock: got %q, want %q", got, "ok")
	}

	// Several text blocks are one answer, not just its first paragraph.
	multi := []byte(`{"content":[{"type":"text","text":"one"},{"type":"text","text":"two"}]}`)
	if got := parseTextResponse(ProviderAnthropic, multi); got != "one\ntwo" {
		t.Fatalf("multi: got %q", got)
	}

	// The plain single-block reply every other test relies on is unchanged.
	if got := parseTextResponse(ProviderAnthropic, []byte(`{"content":[{"type":"text","text":" hi "}]}`)); got != "hi" {
		t.Fatalf("single: got %q", got)
	}
}
