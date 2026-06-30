package aistudio

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
)

func TestExtractJSON(t *testing.T) {
	cases := []struct{ in, want string }{
		{`{"a":1}`, `{"a":1}`},
		{"```json\n{\"a\":1}\n```", `{"a":1}`},
		{"sure, here:\n```\n{\"a\":{\"b\":2}}\n```\nhope that helps", `{"a":{"b":2}}`},
		{`prose {"a":"}"} trailing`, `{"a":"}"}`}, // brace inside string ignored
		{"```json\n{\"a\":\"```fence inside value```\"}\n```", "{\"a\":\"```fence inside value```\"}"}, // backticks in a string value must not be stripped
		{"no json here", ""},
	}
	for _, c := range cases {
		got := string(extractJSON(c.in))
		if got != c.want {
			t.Errorf("extractJSON(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestValidateOutline(t *testing.T) {
	o := &DesignOutline{Pages: []OutlineItem{
		{Title: "", Points: nil},
		{Title: "Keep", Points: []string{"a", " ", "b"}, VisualRole: "weird"},
		{Title: "", Points: []string{"pts only"}, VisualRole: "data"},
	}}
	if err := validateOutline(o); err != nil {
		t.Fatal(err)
	}
	if len(o.Pages) != 2 {
		t.Fatalf("want 2 pages, got %d", len(o.Pages))
	}
	if o.Pages[0].VisualRole != "content" {
		t.Errorf("unknown role should default to content, got %q", o.Pages[0].VisualRole)
	}
	if len(o.Pages[0].Points) != 2 {
		t.Errorf("blank points should be dropped, got %v", o.Pages[0].Points)
	}
	if o.Title != "Untitled" {
		t.Errorf("missing title should default")
	}
	empty := &DesignOutline{Pages: []OutlineItem{{Title: "", Points: nil}}}
	if err := validateOutline(empty); err == nil {
		t.Error("empty outline should error")
	}
}

func TestValidateChart(t *testing.T) {
	c := &ChartSpec{ChartType: "spiral", Categories: []string{"Q1", "Q2", "Q3"}, Series: []ChartSeries{{Name: "", Values: []float64{1, 2}}}}
	if err := validateChart(c); err != nil {
		t.Fatal(err)
	}
	if c.ChartType != "bar" {
		t.Errorf("unknown type should default to bar")
	}
	if len(c.Series[0].Values) != 3 || c.Series[0].Values[2] != 0 {
		t.Errorf("values should align 1:1 to categories (pad 0), got %v", c.Series[0].Values)
	}
	if c.Series[0].Name != "Series" {
		t.Errorf("blank series name should default")
	}
	if err := validateChart(&ChartSpec{ChartType: "bar", Categories: nil, Series: nil}); err == nil {
		t.Error("no categories should error")
	}
}

func TestValidateAssistant(t *testing.T) {
	v := validateAssistant(assistantCatalog)
	a := &AssistantReply{Plan: []PlanStep{{Action: "addPage"}, {Action: "frobnicate"}, {Action: "setPageBackground", Args: map[string]any{"color": "#fff"}}}}
	if err := v(a); err != nil {
		t.Fatal(err)
	}
	if len(a.Plan) != 2 {
		t.Errorf("unknown actions should be dropped, got %v", a.Plan)
	}
	clar := &AssistantReply{Clarify: "Which page?", Plan: []PlanStep{{Action: "addPage"}}}
	_ = v(clar)
	if len(clar.Plan) != 0 {
		t.Errorf("clarify should clear the plan")
	}
}

func TestValidateStyleProfile(t *testing.T) {
	p := &StyleProfile{Palette: []string{"#ff0000", "nope", "#0a0"}}
	if err := validateStyleProfile(p); err != nil {
		t.Fatal(err)
	}
	if len(p.Palette) != 2 {
		t.Errorf("non-hex should be filtered, got %v", p.Palette)
	}
	if err := validateStyleProfile(&StyleProfile{Palette: []string{"bad"}}); err == nil {
		t.Error("no valid colors should error")
	}
}

// stubGen returns a scripted sequence of replies to exercise retry-on-mismatch.
type stubGen struct {
	replies []string
	calls   int
}

func (s *stubGen) Text(_ context.Context, _, _, _ string) (string, error) {
	if s.calls >= len(s.replies) {
		return "", errors.New("no more replies")
	}
	r := s.replies[s.calls]
	s.calls++
	return r, nil
}

func TestGenerateValidated_RetriesOnMismatch(t *testing.T) {
	gen := &stubGen{replies: []string{
		"not json at all",
		`{"chartType":"bar","categories":[],"series":[]}`, // invalid: no categories
		`{"chartType":"line","categories":["a"],"series":[{"name":"s","values":[1]}]}`,
	}}
	svc := NewService(nil, gen)
	spec, err := svc.Chart(context.Background(), "ws", "some data")
	if err != nil {
		t.Fatalf("expected success after retries, got %v", err)
	}
	if gen.calls != 3 {
		t.Errorf("expected 3 attempts, got %d", gen.calls)
	}
	if spec.ChartType != "line" {
		t.Errorf("got %q", spec.ChartType)
	}
}

func TestGenerateValidated_GivesUp(t *testing.T) {
	gen := &stubGen{replies: []string{"junk", "junk", "junk"}}
	svc := NewService(nil, gen)
	if _, err := svc.Chart(context.Background(), "ws", "x"); !errors.Is(err, ErrInvalidOutput) {
		t.Errorf("expected ErrInvalidOutput, got %v", err)
	}
}

func stripSchema(dsn string) string {
	if i := strings.Index(dsn, "?"); i >= 0 {
		return dsn[:i]
	}
	return dsn
}

// TestAIStudio_DB exercises session/turn persistence + workspace isolation in a
// rolled-back transaction. Skips without DATABASE_URL.
func TestAIStudio_DB(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping DB test")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stripSchema(dsn))
	if err != nil {
		t.Skipf("cannot connect: %v", err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	acct := accounts.NewService(tx, "test-jwt-secret")
	_, wsView, _, err := acct.Signup(ctx, "studio@test.dev", "pw-123456", "Studio Tester")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	ws := wsView.ID

	// Seed a Design row (FK target) directly.
	var designID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO "designs" ("id","workspace_id","title","updated_at") VALUES (gen_random_uuid(),$1,'T',CURRENT_TIMESTAMP) RETURNING "id"`,
		ws).Scan(&designID); err != nil {
		t.Fatalf("seed design: %v", err)
	}

	svc := NewService(tx, &stubGen{})
	sess, err := svc.CreateSession(ctx, ws, designID)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if _, err := svc.AppendTurn(ctx, ws, designID, AiTurn{SessionID: sess.ID, Role: "user", Text: "hi"}); err != nil {
		t.Fatalf("append turn: %v", err)
	}
	if _, err := svc.AppendTurn(ctx, ws, designID, AiTurn{SessionID: sess.ID, Role: "assistant", Text: "done", Plan: []byte(`[{"action":"addPage"}]`)}); err != nil {
		t.Fatalf("append turn 2: %v", err)
	}
	turns, err := svc.ListTurns(ctx, ws, designID, sess.ID)
	if err != nil || len(turns) != 2 {
		t.Fatalf("list turns: %v (n=%d)", err, len(turns))
	}
	if turns[0].Role != "user" || string(turns[1].Plan) == "" {
		t.Errorf("turn ordering/plan persistence wrong: %+v", turns)
	}
	// Workspace isolation: another workspace must not see this session.
	if _, err := svc.ListTurns(ctx, "00000000-0000-0000-0000-000000000000", designID, sess.ID); !errors.Is(err, ErrNoStore) {
		t.Errorf("cross-workspace access should be denied, got %v", err)
	}
	// Design isolation: the right workspace but a different design must not see it.
	if _, err := svc.ListTurns(ctx, ws, "00000000-0000-0000-0000-000000000000", sess.ID); !errors.Is(err, ErrNoStore) {
		t.Errorf("cross-design access should be denied, got %v", err)
	}
	sessions, err := svc.ListSessions(ctx, ws, designID)
	if err != nil || len(sessions) != 1 {
		t.Fatalf("list sessions: %v (n=%d)", err, len(sessions))
	}
}
