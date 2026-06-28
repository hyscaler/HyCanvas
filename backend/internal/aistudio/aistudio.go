// Package aistudio is the server-side orchestrator for F39 (AI Creative Studio).
// It reuses the AI proxy (routing, BYO keys, policy, metering) for every model
// call and adds what the spec asks of an orchestrator: it constrains generation
// with embedded JSON Schemas, validates every model reply against the schema,
// and retries on mismatch (FR-12), returning clean typed objects. It never calls
// a provider SDK directly and introduces no new key storage.
//
// The deterministic layout engine stays in @hc/aistudio (TypeScript), so these
// endpoints return validated specs/outlines/plans and the client composes the
// final scene graph - avoiding a duplicate Go layout engine.
package aistudio

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// ErrInvalidOutput is returned when the model fails to produce schema-valid JSON
// after the retry budget is exhausted.
var ErrInvalidOutput = errors.New("model did not return valid structured output")

// TextGenerator is the slice of the AI proxy this package needs. *ai.Service
// satisfies it; tests stub it.
type TextGenerator interface {
	Text(ctx context.Context, workspaceID, prompt, system string) (string, error)
}

// Service orchestrates studio generation on top of the AI proxy + a DB for
// session/turn history and provenance.
type Service struct {
	ai    TextGenerator
	store *sessionStore
}

// NewService builds the orchestrator. db may be nil to disable session history
// (the stateless generators still work).
func NewService(db DBTX, ai TextGenerator) *Service {
	var st *sessionStore
	if db != nil {
		st = &sessionStore{db: db}
	}
	return &Service{ai: ai, store: st}
}

const maxRetries = 3

// generateValidated runs the model with a schema-constrained prompt and retries
// (with a corrective hint) until the reply unmarshals into T and passes
// validate, or the retry budget is spent (FR-12 retry-on-mismatch).
func generateValidated[T any](ctx context.Context, s *Service, workspaceID, system, user string, validate func(*T) error) (*T, error) {
	msg := user
	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		out, err := s.ai.Text(ctx, workspaceID, msg, system)
		if err != nil {
			return nil, err // provider/policy errors propagate unchanged
		}
		raw := extractJSON(out)
		if raw == nil {
			lastErr = errors.New("no JSON object found in the reply")
		} else {
			var v T
			if jerr := json.Unmarshal(raw, &v); jerr != nil {
				lastErr = fmt.Errorf("invalid JSON: %v", jerr)
			} else if verr := validate(&v); verr != nil {
				lastErr = verr
			} else {
				return &v, nil
			}
		}
		msg = user + "\n\nYour previous reply was rejected: " + lastErr.Error() +
			". Return ONLY a single JSON object that exactly matches the schema, with no prose or code fences."
	}
	return nil, fmt.Errorf("%w: %v", ErrInvalidOutput, lastErr)
}

// extractJSON pulls the first balanced {...} object out of a model reply. The
// scan is string-aware (it ignores braces, backticks, and fences that appear
// inside string values), and because it starts at the first '{' it naturally
// skips any leading ```json fence and trailing fence without a separate
// stripping pass - a separate fence strip would corrupt a value that legitimately
// contains triple-backticks. If the extracted slice is slightly off, the caller's
// json.Unmarshal + validate + retry loop catches it.
func extractJSON(s string) []byte {
	s = strings.TrimSpace(s)
	start := strings.IndexByte(s, '{')
	if start < 0 {
		return nil
	}
	depth := 0
	inStr := false
	esc := false
	for i := start; i < len(s); i++ {
		c := s[i]
		if inStr {
			switch {
			case esc:
				esc = false
			case c == '\\':
				esc = true
			case c == '"':
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return []byte(s[start : i+1])
			}
		}
	}
	return nil
}
