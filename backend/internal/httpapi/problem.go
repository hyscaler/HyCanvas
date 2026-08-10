// RFC 7807 problem+json responses, matching the NestJS backend's error shape so
// the frontend/@hc/sdk sees identical error bodies across the strangler split.
package httpapi

import (
	"encoding/json"
	"net/http"
)

type problemDoc struct {
	Type     string `json:"type"`
	Title    string `json:"title"`
	Status   int    `json:"status"`
	Detail   string `json:"detail,omitempty"`
	Instance string `json:"instance,omitempty"`
	Code     string `json:"code,omitempty"`
}

// ProblemCode writes a problem+json response carrying a stable machine code
// (e.g. link_password_required).
//
// The code, not the detail, is the contract. `detail` stays English on purpose:
// it is what lands in logs and what a developer greps for. The CLIENT localizes,
// by looking up `errors.api_<code>` and falling back to the English detail when
// a code has no catalog entry, so adding a code is always safe and translating
// it later is additive. That is why this is the only correct way to add a new
// error response: an uncoded one can never be localized, and a test enforces it
// (see problem_code_test.go).
//
// Exported because the installation wizard (internal/setup) writes problems too
// and is outside this package.
//
// There is deliberately NO uncoded variant. One existed and 268 call sites used
// it, which is how the API ended up able to emit only English. Deleting it makes
// the rule structural rather than a convention: an uncoded error response is now
// unrepresentable, instead of merely discouraged.
func ProblemCode(w http.ResponseWriter, r *http.Request, status int, title, detail, code string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(problemDoc{
		Type:     "about:blank",
		Title:    title,
		Status:   status,
		Detail:   detail,
		Instance: r.URL.Path,
		Code:     code,
	})
}

// problemWithCode is the in-package spelling of ProblemCode.
func problemWithCode(w http.ResponseWriter, r *http.Request, status int, title, detail, code string) {
	ProblemCode(w, r, status, title, detail, code)
}

// writeJSON writes a normal JSON success response.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
