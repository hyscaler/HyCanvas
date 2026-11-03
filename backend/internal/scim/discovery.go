package scim

import "net/http"

// serviceProviderConfig advertises exactly what is implemented (RFC 7643
// section 5). Authentik reads patch.supported and filter.supported to decide
// how to send group membership and whether it can look up an existing user
// after a 409, so these flags are behaviour, not documentation.
func serviceProviderConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"schemas":        []string{schemaSPC},
		"patch":          map[string]any{"supported": true},
		"bulk":           map[string]any{"supported": false, "maxOperations": 0, "maxPayloadSize": 0},
		"filter":         map[string]any{"supported": true, "maxResults": maxPageSize},
		"changePassword": map[string]any{"supported": false},
		"sort":           map[string]any{"supported": false},
		"etag":           map[string]any{"supported": false},
		"authenticationSchemes": []map[string]any{{
			"type": "oauthbearertoken", "name": "Bearer token", "description": "The SCIM_TOKEN configured on the server", "primary": true,
		}},
	})
}

func resourceTypes(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, listResponse([]any{
		map[string]any{"schemas": []string{schemaResType}, "id": "User", "name": "User", "endpoint": "/Users", "schema": schemaUser},
		map[string]any{"schemas": []string{schemaResType}, "id": "Group", "name": "Group", "endpoint": "/Groups", "schema": schemaGroup},
	}, 2, 1))
}

func schemas(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, listResponse([]any{
		map[string]any{"schemas": []string{schemaSchema}, "id": schemaUser, "name": "User", "attributes": []any{}},
		map[string]any{"schemas": []string{schemaSchema}, "id": schemaGroup, "name": "Group", "attributes": []any{}},
	}, 2, 1))
}
