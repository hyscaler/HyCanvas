package aistudio

import (
	"context"
	"strings"
	"testing"
)

// The assistant tool catalog is defined once in assistant_tools.json and shared
// with the client (packages/aistudio/src/assistant.ts toolCatalog(); a vitest
// test asserts the TS catalog deep-equals the manifest). These tests pin the Go
// side of that contract: the manifest is well-formed, every tool is reachable
// through validateAssistant, and the system prompt actually offers every tool.

var validParamTypes = map[string]bool{
	"string": true, "number": true, "color": true, "stringArray": true, "series": true,
}

func TestAssistantToolManifestWellFormed(t *testing.T) {
	if len(assistantToolSpecs) < 18 {
		t.Fatalf("suspiciously small manifest: %d tools", len(assistantToolSpecs))
	}
	seen := map[string]bool{}
	for _, spec := range assistantToolSpecs {
		if strings.TrimSpace(spec.Name) == "" {
			t.Fatal("tool with empty name")
		}
		if seen[spec.Name] {
			t.Fatalf("duplicate tool %q", spec.Name)
		}
		seen[spec.Name] = true
		if strings.TrimSpace(spec.Description) == "" {
			t.Errorf("tool %q has no description", spec.Name)
		}
		for _, p := range spec.Params {
			if strings.TrimSpace(p.Name) == "" {
				t.Errorf("tool %q has a param with an empty name", spec.Name)
			}
			if !validParamTypes[p.Type] {
				t.Errorf("tool %q param %q has unknown type %q", spec.Name, p.Name, p.Type)
			}
		}
	}
}

func TestAssistantCatalogMatchesManifest(t *testing.T) {
	if len(assistantCatalog) != len(assistantToolSpecs) {
		t.Fatalf("catalog has %d names, manifest has %d tools", len(assistantCatalog), len(assistantToolSpecs))
	}
	for _, spec := range assistantToolSpecs {
		if !assistantCatalog[spec.Name] {
			t.Errorf("manifest tool %q missing from assistantCatalog", spec.Name)
		}
	}
	// The five tools that were once client-only must stay reachable server-side.
	for _, name := range []string{"translateDeck", "generateSpeakerNotes", "generateDiagram", "clusterStickies", "summarizeStickies"} {
		if !assistantCatalog[name] {
			t.Errorf("tool %q is not in the server catalog (client-only regression)", name)
		}
	}
}

func TestAssistantPromptOffersEveryTool(t *testing.T) {
	text := assistantToolCatalogText()
	for _, spec := range assistantToolSpecs {
		if !strings.Contains(text, "- "+spec.Name+"(") {
			t.Errorf("system prompt tool list is missing %q", spec.Name)
		}
		for _, p := range spec.Params {
			if !strings.Contains(text, p.Name+":"+p.Type) {
				t.Errorf("system prompt tool list is missing param %q of %q", p.Name, spec.Name)
			}
		}
	}
}

// capturingGen records the system prompt and returns one scripted reply, so a
// test can assert both what the model was offered and what survives validation.
type capturingGen struct {
	system string
	reply  string
}

func (c *capturingGen) Text(_ context.Context, _, _, system string) (string, error) {
	c.system = system
	return c.reply, nil
}

// The server assistant path must offer the once-missing tools to the model and
// pass their plan steps through: the exact end-to-end flow of "translate this
// deck to German" via POST /v1/ai/assistant.
func TestAssistantServerPathKeepsOnceMissingTools(t *testing.T) {
	gen := &capturingGen{reply: `{"reply":"Translating the deck to German.","plan":[{"action":"translateDeck","args":{"language":"German"}},{"action":"generateSpeakerNotes","args":{}}]}`}
	svc := NewService(nil, gen)
	got, err := svc.Assistant(context.Background(), "ws1", "Pages: 3", "", "translate this deck to German and add speaker notes")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Plan) != 2 || got.Plan[0].Action != "translateDeck" || got.Plan[1].Action != "generateSpeakerNotes" {
		t.Fatalf("plan steps dropped or reordered: %+v", got.Plan)
	}
	for _, name := range []string{"translateDeck", "generateSpeakerNotes", "generateDiagram", "clusterStickies", "summarizeStickies"} {
		if !strings.Contains(gen.system, "- "+name+"(") {
			t.Errorf("system prompt sent to the model does not offer %q", name)
		}
	}
}

// validateAssistant must keep a plan built from any manifest tool: this is the
// exact failure mode that made translateDeck & co. unreachable before.
func TestValidateAssistantAcceptsEveryManifestTool(t *testing.T) {
	for _, spec := range assistantToolSpecs {
		reply := &AssistantReply{Reply: "ok", Plan: []PlanStep{{Action: spec.Name}}}
		if err := validateAssistant(assistantCatalog)(reply); err != nil {
			t.Fatalf("plan with %q rejected: %v", spec.Name, err)
		}
		if len(reply.Plan) != 1 {
			t.Errorf("plan step %q was dropped by validateAssistant", spec.Name)
		}
	}
}
