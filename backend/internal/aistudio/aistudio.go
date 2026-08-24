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
	"log/slog"
	"strings"
)

// ErrInvalidOutput is returned when the model fails to produce schema-valid JSON
// after the retry budget is exhausted.
var ErrInvalidOutput = errors.New("model did not return valid structured output")

// TextGenerator is the slice of the AI proxy this package needs. *ai.Service
// satisfies it; tests stub it. TextStructured asks the provider for natively
// schema-constrained output (with the proxy falling back to plain text when
// the provider rejects the parameter); the schema stays restated in the prompt
// and the reply stays validated here, so structured mode raises JSON validity,
// never replaces validation.
type TextGenerator interface {
	Text(ctx context.Context, workspaceID, prompt, system string) (string, error)
	TextStructured(ctx context.Context, workspaceID, prompt, system, schemaJSON string) (string, error)
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

// The validation-repair loop's budgets: up to maxValidationPasses model calls,
// each corrective message carrying at most maxRepairErrors concrete validation
// errors and at most maxRepairJSONChars of the previous invalid output.
const (
	maxValidationPasses = 4
	maxRepairErrors     = 10
	maxRepairJSONChars  = 6000
)

// validationErrorList flattens a validator error into its concrete messages.
// Validators may aggregate with errors.Join; a plain error is one message.
func validationErrorList(err error) []string {
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		var out []string
		for _, e := range joined.Unwrap() {
			out = append(out, e.Error())
		}
		if len(out) > 0 {
			return out
		}
	}
	return []string{err.Error()}
}

// repairMessage rebuilds the user message for a repair pass: the original
// request, the CONCRETE validation errors (capped), and the previous invalid
// output (truncated) so the model can correct rather than regenerate blind.
func repairMessage(user, prev string, verrs []string) string {
	if len(verrs) > maxRepairErrors {
		rest := len(verrs) - maxRepairErrors
		verrs = append(verrs[:maxRepairErrors], fmt.Sprintf("...and %d more validation errors.", rest))
	}
	if len(prev) > maxRepairJSONChars {
		prev = prev[:maxRepairJSONChars] + "\n... (truncated)"
	}
	return user +
		"\n\nThe previous JSON response did not match the required response schema.\nValidation errors:\n- " +
		strings.Join(verrs, "\n- ") +
		"\n\nPrevious invalid JSON:\n```json\n" + prev + "\n```\n\n" +
		"Return corrected JSON only. Make sure it fully matches the required schema."
}

// generateValidated runs the model until the reply unmarshals into T and
// passes validate, or the pass budget is spent (FR-12 retry-on-mismatch).
// A non-empty schemaJSON additionally requests NATIVE schema-constrained
// output from the provider (the proxy falls back to plain text when a
// provider rejects the parameter); the schema stays embedded in the prompt
// and every reply still passes through extractJSON + validate.
//
// Repair shape: a parse failure re-asks with a corrective hint; a VALIDATION
// failure feeds the concrete errors plus the previous invalid output back so
// the model corrects rather than regenerates blind. When tolerateInvalid is
// set, the final pass accepts a parseable-but-invalid value with a warning
// instead of failing hard (an imperfect outline beats no outline; an invalid
// assistant plan stays fail-closed). One structured log line per repair pass.
func generateValidated[T any](ctx context.Context, s *Service, workspaceID, system, user, schemaJSON string, tolerateInvalid bool, validate func(*T) error) (*T, error) {
	msg := user
	var lastErr error
	for pass := 0; pass < maxValidationPasses; pass++ {
		var out string
		var err error
		if schemaJSON != "" {
			out, err = s.ai.TextStructured(ctx, workspaceID, msg, system, schemaJSON)
		} else {
			out, err = s.ai.Text(ctx, workspaceID, msg, system)
		}
		if err != nil {
			return nil, err // provider/policy errors propagate unchanged
		}
		raw := extractJSON(out)
		if raw == nil {
			lastErr = errors.New("no JSON object found in the reply")
			msg = user + "\n\nYour previous reply was rejected: " + lastErr.Error() +
				". Return ONLY a single JSON object that exactly matches the schema, with no prose or code fences."
			slog.Warn("aistudio repair pass", "reason", "no_json", "pass", pass+1, "of", maxValidationPasses)
			continue
		}
		var v T
		if jerr := json.Unmarshal(raw, &v); jerr != nil {
			lastErr = fmt.Errorf("invalid JSON: %v", jerr)
			msg = user + "\n\nYour previous reply was rejected: " + lastErr.Error() +
				". Return ONLY a single JSON object that exactly matches the schema, with no prose or code fences."
			slog.Warn("aistudio repair pass", "reason", "unparseable", "pass", pass+1, "of", maxValidationPasses)
			continue
		}
		verr := validate(&v)
		if verr == nil {
			return &v, nil
		}
		lastErr = verr
		verrs := validationErrorList(verr)
		if pass == maxValidationPasses-1 && tolerateInvalid {
			slog.Warn("aistudio accepting invalid output after max repair passes",
				"errors", strings.Join(verrs, " | "), "passes", maxValidationPasses)
			return &v, nil
		}
		msg = repairMessage(user, string(raw), verrs)
		slog.Warn("aistudio repair pass", "reason", "validation", "pass", pass+1, "of", maxValidationPasses,
			"errors", strings.Join(verrs, " | "))
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
