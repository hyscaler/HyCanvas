package scim

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const (
	schemaUser      = "urn:ietf:params:scim:schemas:core:2.0:User"
	schemaGroup     = "urn:ietf:params:scim:schemas:core:2.0:Group"
	schemaList      = "urn:ietf:params:scim:api:messages:2.0:ListResponse"
	schemaError     = "urn:ietf:params:scim:api:messages:2.0:Error"
	schemaPatch     = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
	schemaSPC       = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"
	schemaResType   = "urn:ietf:params:scim:schemas:core:2.0:ResourceType"
	schemaSchema    = "urn:ietf:params:scim:schemas:core:2.0:Schema"
	contentTypeSCIM = "application/scim+json"
	maxPageSize     = 100
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", contentTypeSCIM)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError answers in the SCIM error schema (RFC 7644 section 3.12), which the
// protocol requires; it is the one surface that does not use problem+json.
// scimType is "" where the RFC defines none.
func writeError(w http.ResponseWriter, status int, scimType, detail string) {
	body := map[string]any{"schemas": []string{schemaError}, "status": strconv.Itoa(status), "detail": detail}
	if scimType != "" {
		body["scimType"] = scimType
	}
	writeJSON(w, status, body)
}

func listResponse(resources []any, total, start int) map[string]any {
	if resources == nil {
		resources = []any{}
	}
	return map[string]any{
		"schemas":      []string{schemaList},
		"totalResults": total,
		"startIndex":   start,
		"itemsPerPage": len(resources),
		"Resources":    resources,
	}
}

// paging reads startIndex (1-based) and count, clamped to 1.. and 0..100.
func paging(q url.Values) (start, count int) {
	start, count = 1, maxPageSize
	if v, err := strconv.Atoi(q.Get("startIndex")); err == nil && v > 1 {
		start = v
	}
	if v, err := strconv.Atoi(q.Get("count")); err == nil {
		count = min(max(v, 0), maxPageSize)
	}
	return start, count
}

var errInvalidFilter = errors.New("invalid filter")

// parseFilter accepts exactly `<attribute> eq "<value>"` for one of the allowed
// attributes, which is every filter the target identity providers send to find
// an existing resource. Attribute names compare case-insensitively (RFC 7644
// section 3.10); the canonical spelling from allowed is returned.
func parseFilter(filter string, allowed []string) (attr, value string, err error) {
	f := strings.TrimSpace(filter)
	attrPart, rest, ok := strings.Cut(f, " ")
	if !ok {
		return "", "", errInvalidFilter
	}
	rest = strings.TrimSpace(rest)
	op, quoted, ok := strings.Cut(rest, " ")
	if !ok || !strings.EqualFold(op, "eq") {
		return "", "", errInvalidFilter
	}
	value, err = strconv.Unquote(strings.TrimSpace(quoted))
	if err != nil || !strings.HasPrefix(strings.TrimSpace(quoted), `"`) {
		return "", "", errInvalidFilter
	}
	for _, a := range allowed {
		if strings.EqualFold(a, attrPart) {
			return a, value, nil
		}
	}
	return "", "", errInvalidFilter
}

// patchOp is one PATCH operation (RFC 7644 section 3.5.2). Op is lower-cased:
// Entra ID sends "Replace", Authentik and Okta "replace".
type patchOp struct {
	Op    string          `json:"op"`
	Path  string          `json:"path"`
	Value json.RawMessage `json:"value"`
}

func parsePatch(body []byte) ([]patchOp, error) {
	var req struct {
		Operations []patchOp `json:"Operations"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, errors.New("malformed PATCH body")
	}
	if len(req.Operations) == 0 {
		return nil, errors.New("PATCH has no Operations")
	}
	for i := range req.Operations {
		op := strings.ToLower(req.Operations[i].Op)
		if op != "add" && op != "remove" && op != "replace" {
			return nil, errors.New("unsupported PATCH op " + strconv.Quote(req.Operations[i].Op))
		}
		req.Operations[i].Op = op
	}
	return req.Operations, nil
}

// flexBool reads a SCIM boolean that some providers send as a string
// (Entra ID: "False").
func flexBool(raw json.RawMessage) (bool, bool) {
	var b bool
	if json.Unmarshal(raw, &b) == nil {
		return b, true
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		switch strings.ToLower(s) {
		case "true":
			return true, true
		case "false":
			return false, true
		}
	}
	return false, false
}
