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

// Problem writes an application/problem+json error response.
func Problem(w http.ResponseWriter, r *http.Request, status int, title, detail string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(problemDoc{
		Type:     "about:blank",
		Title:    title,
		Status:   status,
		Detail:   detail,
		Instance: r.URL.Path,
	})
}

// problemWithCode writes a problem+json response carrying a stable machine code
// (e.g. link_password_required) so clients can branch without parsing prose.
func problemWithCode(w http.ResponseWriter, r *http.Request, status int, title, detail, code string) {
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

// writeJSON writes a normal JSON success response.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
