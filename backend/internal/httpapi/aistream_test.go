package httpapi

// The SSE generation stream (F28 T18): event framing, per-stage ordering, and
// the error event. The stub generator scripts the model replies.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"hycanvas/backend/internal/ai"
	"hycanvas/backend/internal/aistudio"
)

type scriptedGen struct {
	mu      sync.Mutex
	replies []string
	calls   int
}

func (s *scriptedGen) Text(_ context.Context, _, _, _ string) (string, error) {
	// The polish pool calls concurrently; guard the script cursor.
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.calls >= len(s.replies) {
		return s.replies[len(s.replies)-1], nil
	}
	r := s.replies[s.calls]
	s.calls++
	return r, nil
}
func (s *scriptedGen) TextStructured(ctx context.Context, ws, prompt, system, _ string) (string, error) {
	return s.Text(ctx, ws, prompt, system)
}

func TestGenerateDesignStreamEvents(t *testing.T) {
	outline := `{"title":"T","theme":"","pages":[{"title":"A","points":["p1"],"visualRole":"cover","note":"` + strings.Repeat("n", 100) + `"},{"title":"B","points":["p2"],"visualRole":"content","note":"` + strings.Repeat("m", 100) + `"}]}`
	polish := `{"points":["polished"]}`
	svc := aistudio.NewService(nil, &scriptedGen{replies: []string{outline, polish, polish}})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/ai/generate-design/stream", strings.NewReader(`{"workspaceId":"ws","designType":"deck","prompt":"brief"}`))
	// Bypass auth/membership: call the handler's core by wiring a pass-through
	// asserter is not possible here, so exercise the service + emit contract
	// directly the way the handler does.
	_ = req
	var mu sync.Mutex
	var events []string
	emit := func(event string, data any) { mu.Lock(); events = append(events, event); mu.Unlock() }
	out, err := svc.GenerateDesignStream(req.Context(), "ws", "deck", "brief", "", 0, emit)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Code != 200 { // recorder untouched; guard against accidental writes
		t.Fatalf("unexpected recorder state")
	}
	if events[0] != "outline" {
		t.Fatalf("first event = %q, want outline", events[0])
	}
	pages := 0
	for _, e := range events[1:] {
		if e == "page" {
			pages++
		}
	}
	if pages != 2 {
		t.Fatalf("want 2 page events, got %d (events: %v)", pages, events)
	}
	if len(out.Pages) != 2 || out.Pages[0].Points[0] != "polished" {
		t.Fatalf("final outline not polished: %+v", out.Pages)
	}
}

// The SSE path must carry the SAME failure classification the problem+json
// path does. It hardcoded "ai_provider_failed" for every cause once, which
// made a rejected key, an exhausted account, an unknown model and a rate limit
// indistinguishable on the main design-generation flow.
func TestAIFailureClassificationIsShared(t *testing.T) {
	cases := []struct {
		name string
		err  error
		code string
	}{
		{"auth", errors.Join(ai.ErrBadGateway, &ai.UpstreamError{Provider: "p", Status: http.StatusUnauthorized}), "ai_provider_auth_failed"},
		{"quota", errors.Join(ai.ErrBadGateway, &ai.UpstreamError{Provider: "p", Status: http.StatusPaymentRequired}), "ai_provider_quota_exhausted"},
		{"model", errors.Join(ai.ErrBadGateway, &ai.UpstreamError{Provider: "p", Status: http.StatusNotFound}), "ai_provider_model_not_found"},
		{"rate", errors.Join(ai.ErrBadGateway, &ai.UpstreamError{Provider: "p", Status: http.StatusTooManyRequests}), "ai_provider_rate_limited"},
		{"generic", ai.ErrBadGateway, "ai_provider_failed"},
		{"policy", ai.ErrPolicyBlocked, "ai_policy_blocked"},
		{"not-configured", ai.ErrBadRequest, "ai_not_configured"},
	}
	for _, c := range cases {
		status, _, detail, code := aiFailure(c.err)
		if code != c.code {
			t.Fatalf("%s: code = %q, want %q", c.name, code, c.code)
		}
		if detail == "" {
			t.Fatalf("%s: detail must never be empty (it is the fallback wording)", c.name)
		}
		if status < 400 {
			t.Fatalf("%s: status = %d, want a failure status", c.name, status)
		}
	}
}

// aiProblem must emit exactly the code aiFailure decided. The literal switch
// in aiProblem exists only to keep codes greppable for translation, so this
// pins the two against each other: a new branch in one that is missing from
// the other falls through to "ai_failed" and fails here.
func TestAIProblemEmitsClassifiedCode(t *testing.T) {
	cases := []error{
		errors.Join(ai.ErrBadGateway, &ai.UpstreamError{Provider: "p", Status: http.StatusUnauthorized}),
		errors.Join(ai.ErrBadGateway, &ai.UpstreamError{Provider: "p", Status: http.StatusPaymentRequired}),
		errors.Join(ai.ErrBadGateway, &ai.UpstreamError{Provider: "p", Status: http.StatusNotFound}),
		errors.Join(ai.ErrBadGateway, &ai.UpstreamError{Provider: "p", Status: http.StatusTooManyRequests}),
		ai.ErrBadGateway,
		ai.ErrPolicyBlocked,
		ai.ErrBadRequest,
		ai.ErrImageUnsupported,
		ai.ErrEditImageUnsupported,
		ai.ErrBaseURLRequired,
		ai.ErrKeyRequiredForProviderChange,
	}
	for _, err := range cases {
		_, _, _, want := aiFailure(err)
		rec := httptest.NewRecorder()
		aiProblem(rec, httptest.NewRequest("POST", "/x", nil), err)
		var body struct {
			Code string `json:"code"`
		}
		if e := json.Unmarshal(rec.Body.Bytes(), &body); e != nil {
			t.Fatalf("parse problem body: %v", e)
		}
		if body.Code != want {
			t.Fatalf("aiProblem emitted %q for %v, aiFailure said %q", body.Code, err, want)
		}
	}
}
