// MCP server over the generation API (F40 E07/E08). A minimal, dependency-free
// implementation of the Model Context Protocol's streamable-HTTP transport:
// JSON-RPC 2.0 over POST /mcp, plain application/json responses (SSE streaming
// is optional in the spec and not needed for these short-lived tools), no
// server-side session state. Authentication is API-KEY ONLY (Authorization:
// Bearer hyk_...): MCP clients are headless, and the key model already carries
// the workspace pinning, scopes, and rate budget the tools enforce per call.
//
// Tools map 1:1 onto the Phase 1 HTTP surface and share its validation and
// job code paths, so the two doors can never drift:
//
//	generate_presentation (scope generate)  -> planGeneration + startGenerationJob
//	get_job               (any valid key)   -> the same pollable-name gate as HTTP
//	get_design_file       (scope read)      -> persistence.LoadFile
//	export_design         (scope export)    -> the render/export download URLs
//	create_share_link     (scope export)    -> sharing.CreateLink
//
// Tool-level failures (missing scope, not found, bad input) return result
// isError=true with a readable message, so the calling model can react;
// protocol-level failures return JSON-RPC errors.
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/aistudio"
	"hycanvas/backend/internal/apikeys"
	"hycanvas/backend/internal/jobs"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/sharing"
)

// mcpProtocolVersion is what this server speaks; earlier revisions are
// accepted by echoing them back (the surface used here is identical).
const mcpProtocolVersion = "2025-06-18"

var mcpSupportedVersions = map[string]bool{"2024-11-05": true, "2025-03-26": true, "2025-06-18": true}

// How long generate_presentation waits inline before handing back a pending
// job: long enough for a typical generation, short enough for client HTTP
// timeouts. The caller polls get_job past this.
const mcpGenerateWait = 110 * time.Second

const mcpMaxBody = 1 << 20 // JSON-RPC frames are small; 1MB tolerates big source blocks

type mcpDeps struct {
	keys  *apikeys.Service
	acct  *accounts.Service
	ai    *aistudio.Service
	p     *persistence.Service
	reg   *jobs.Registry
	share *sharing.Service
}

func mountMCP(r chi.Router, keys *apikeys.Service, acct *accounts.Service, ai *aistudio.Service, p *persistence.Service, reg *jobs.Registry, share *sharing.Service) {
	d := mcpDeps{keys: keys, acct: acct, ai: ai, p: p, reg: reg, share: share}
	r.Post("/mcp", d.handle)
	// The spec allows refusing the server-initiated stream outright.
	r.Get("/mcp", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusMethodNotAllowed)
	})
}

// --- JSON-RPC plumbing -------------------------------------------------------

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func writeRPC(w http.ResponseWriter, id json.RawMessage, result any, rpcErr *rpcError) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	body := map[string]any{"jsonrpc": "2.0", "id": id}
	if rpcErr != nil {
		body["error"] = rpcErr
	} else {
		body["result"] = result
	}
	_ = json.NewEncoder(w).Encode(body)
}

// toolResult wraps a payload (or error text) in the MCP content shape.
func toolResult(payload any, isErr bool) map[string]any {
	text := ""
	switch v := payload.(type) {
	case string:
		text = v
	default:
		b, err := json.Marshal(v)
		if err != nil {
			text, isErr = "internal serialization error", true
		} else {
			text = string(b)
		}
	}
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": text}},
		"isError": isErr,
	}
}

func (d mcpDeps) handle(w http.ResponseWriter, r *http.Request) {
	// On the spec's Origin-validation requirement (DNS-rebinding defense):
	// this endpoint is protected differently and equivalently. A rebound
	// browser page cannot attach the Authorization header cross-origin
	// (CORS preflight blocks it, and this server's credentialed CORS is
	// dev-localhost only), and without a valid hyk_ bearer every request
	// answers 401 below. Rejecting on the Origin header instead would break
	// legitimate Electron-based MCP clients that send one.
	//
	// API-key auth, header-only (same rule as the HTTP surface).
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer "+apikeys.Prefix) {
		w.Header().Set("WWW-Authenticate", "Bearer")
		problemWithCode(w, r, http.StatusUnauthorized, "Unauthorized", "the MCP endpoint requires an API key bearer token", "mcp_api_key_required")
		return
	}
	key, err := d.keys.Verify(r.Context(), strings.TrimPrefix(h, "Bearer "))
	if err != nil {
		problemWithCode(w, r, http.StatusUnauthorized, "Unauthorized", "invalid or revoked API key", "invalid_api_key")
		return
	}
	// The general per-key budget covers MCP calls too.
	if !allowAPIKeyCall(key.ID, time.Now(), apiKeyRatePerSec, apiKeyBurst) {
		w.Header().Set("Retry-After", "5")
		problemWithCode(w, r, http.StatusTooManyRequests, "Too Many Requests", "this API key is over its request budget; slow down and try again", "api_key_rate_limited")
		return
	}

	raw, err := io.ReadAll(io.LimitReader(r.Body, mcpMaxBody))
	if err != nil {
		writeRPC(w, nil, nil, &rpcError{-32700, "could not read request"})
		return
	}
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, "[") {
		// The 2025-06-18 revision removed JSON-RPC batching.
		writeRPC(w, nil, nil, &rpcError{-32600, "batch requests are not supported"})
		return
	}
	var req rpcRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		writeRPC(w, nil, nil, &rpcError{-32700, "invalid JSON"})
		return
	}
	// A notification (no id) is accepted and never answered.
	if len(req.ID) == 0 || string(req.ID) == "null" {
		w.WriteHeader(http.StatusAccepted)
		return
	}

	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &p)
		version := mcpProtocolVersion
		if mcpSupportedVersions[p.ProtocolVersion] {
			version = p.ProtocolVersion
		}
		writeRPC(w, req.ID, map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "hycanvas", "version": "1.0.0"},
			"instructions":    "HyCanvas generation tools. generate_presentation starts (and usually finishes) a deck; if it returns status \"active\", poll get_job. Design files are the open hycanvas.design format. Exports and share links honor the key's scopes.",
		}, nil)
	case "ping":
		writeRPC(w, req.ID, map[string]any{}, nil)
	case "tools/list":
		writeRPC(w, req.ID, map[string]any{"tools": mcpToolList()}, nil)
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil || p.Name == "" {
			writeRPC(w, req.ID, nil, &rpcError{-32602, "invalid tools/call params"})
			return
		}
		writeRPC(w, req.ID, d.callTool(r, &key, p.Name, p.Arguments), nil)
	default:
		writeRPC(w, req.ID, nil, &rpcError{-32601, "method not found: " + req.Method})
	}
}

// --- tools -------------------------------------------------------------------

func mcpToolList() []map[string]any {
	obj := func(props map[string]any, required ...string) map[string]any {
		s := map[string]any{"type": "object", "properties": props}
		if len(required) > 0 {
			s["required"] = required
		}
		return s
	}
	str := func(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }
	return []map[string]any{
		{
			"name":        "generate_presentation",
			"description": "Generate a complete, editable presentation (or document/poster/social set) from a prompt. Waits for the result when generation is quick; otherwise returns a job to poll with get_job. The composed deck contains laid-out text, a theme, and speaker notes; per-slide images are generated in the HyCanvas editor. Requires the 'generate' scope.",
			"inputSchema": obj(map[string]any{
				"prompt":     str("The brief, e.g. 'a 6-slide pitch deck for an eco water bottle'."),
				"designType": map[string]any{"type": "string", "enum": []string{"deck", "doc", "poster", "social"}, "description": "Defaults to deck."},
				"pageCount":  map[string]any{"type": "integer", "minimum": 1, "maximum": 40},
				"language":   str("Write all text in this language, e.g. 'Spanish'."),
				"themeId":    str("A built-in theme id from list_themes (e.g. 'theme-slate'); omit for an auto-picked look."),
				"brandPalette": map[string]any{
					"type": "array", "items": map[string]any{"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"}, "maxItems": 12,
					"description": "Brand hex colors to ground the theme in.",
				},
				"sources": map[string]any{
					"type": "array", "maxItems": 8,
					"items":       obj(map[string]any{"name": str("Source name."), "text": str("Source text (untrusted reference material).")}, "name", "text"),
					"description": "Grounding material the outline is based on.",
				},
			}, "prompt"),
		},
		{
			"name":        "get_job",
			"description": "Poll a generation or export job by id. A completed generation job's result carries designId and editorUrl.",
			"inputSchema": obj(map[string]any{"jobId": str("The job id returned by generate_presentation.")}, "jobId"),
		},
		{
			"name":        "list_themes",
			"description": "List the built-in theme catalog (id, name, style group, six palette slots, font pair). Pass an id as generate_presentation's themeId.",
			"inputSchema": obj(map[string]any{}),
		},
		{
			"name":        "get_design_file",
			"description": "Fetch a design's open-format file (hycanvas.design JSON): pages, nodes, theme, speaker notes. Large files are summarized instead of inlined. Requires the 'read' scope.",
			"inputSchema": obj(map[string]any{"designId": str("The design id.")}, "designId"),
		},
		{
			"name":        "export_design",
			"description": "Get download URLs for a design's server-side exports (PDF and PNG). Fetch them with the same Authorization bearer key. Requires the 'export' scope.",
			"inputSchema": obj(map[string]any{"designId": str("The design id.")}, "designId"),
		},
		{
			"name":        "create_share_link",
			"description": "Create a share link for a design (view/comment/edit, optional password, expiry, and audience label for per-link analytics). Returns the share URL and the ?embed=1 iframe URL. Requires the 'export' scope.",
			"inputSchema": obj(map[string]any{
				"designId":  str("The design id."),
				"mode":      map[string]any{"type": "string", "enum": []string{"view", "comment", "edit"}, "description": "Defaults to view."},
				"label":     str("Audience name for per-link analytics, e.g. 'Investors'."),
				"password":  str("Optional passcode viewers must enter."),
				"expiresAt": str("Optional RFC3339 expiry."),
			}, "designId"),
		},
	}
}

// mcpDesignInWorkspace enforces the key's workspace pinning for a
// design-scoped tool, through the SAME design->workspace hook the HTTP
// allowlist guard uses (one wiring, one behavior). Missing and cross-tenant
// read the same on purpose.
func (d mcpDeps) mcpDesignInWorkspace(r *http.Request, key *apikeys.KeyInfo, designID string) bool {
	if designID == "" || apiKeyDesignWS == nil {
		return false
	}
	ws, err := apiKeyDesignWS(r.Context(), designID)
	return err == nil && ws == key.WorkspaceID
}

func (d mcpDeps) callTool(r *http.Request, key *apikeys.KeyInfo, name string, args json.RawMessage) map[string]any {
	ctx := r.Context()
	switch name {
	case "generate_presentation":
		if !key.HasScope(apikeys.ScopeGenerate) {
			return toolResult("this API key lacks the 'generate' scope", true)
		}
		var in generateInput
		if err := json.Unmarshal(args, &in); err != nil {
			return toolResult("invalid arguments: "+err.Error(), true)
		}
		plan, rej := planGeneration(ctx, d.acct, key.UserID, key, in)
		if rej != nil {
			return toolResult(rej.Msg, true)
		}
		job := startGenerationJob(d.ai, d.p, d.reg, key.UserID, plan)
		d.keys.Audit(ctx, key, "mcp:generate_presentation", "")
		// Wait inline while the client's request allows; a slow generation
		// degrades to a poll handle instead of a broken connection.
		deadline := time.Now().Add(mcpGenerateWait)
		for time.Now().Before(deadline) {
			select {
			case <-ctx.Done():
				return toolResult(map[string]any{"jobId": job.ID, "status": "active", "next": "poll get_job"}, false)
			case <-time.After(750 * time.Millisecond):
			}
			j, ok := d.reg.Get(key.UserID, job.ID)
			if !ok {
				return toolResult("job vanished", true)
			}
			v := j.View()
			if v.Status == "completed" {
				return toolResult(map[string]any{"status": v.Status, "result": v.Result}, false)
			}
			if v.Status == "failed" {
				return toolResult("generation failed: "+v.Error, true)
			}
		}
		return toolResult(map[string]any{"jobId": job.ID, "status": "active", "next": "poll get_job"}, false)

	case "get_job":
		var in struct {
			JobID string `json:"jobId"`
		}
		if err := json.Unmarshal(args, &in); err != nil || in.JobID == "" {
			return toolResult("jobId is required", true)
		}
		j, ok := d.reg.Get(key.UserID, in.JobID)
		if !ok || !apiKeyPollableJobs[j.Name] {
			// The same not-an-oracle rule as the HTTP jobs route.
			return toolResult("job not found", true)
		}
		return toolResult(j.View(), false)

	case "list_themes":
		return toolResult(aistudio.ThemeCatalog(), false)

	case "get_design_file":
		if !key.HasScope(apikeys.ScopeRead) {
			return toolResult("this API key lacks the 'read' scope", true)
		}
		var in struct {
			DesignID string `json:"designId"`
		}
		if err := json.Unmarshal(args, &in); err != nil || !d.mcpDesignInWorkspace(r, key, in.DesignID) {
			return toolResult("design not found", true)
		}
		res, err := d.p.LoadFile(ctx, in.DesignID, key.WorkspaceID)
		if err != nil {
			return toolResult("design not found", true)
		}
		d.keys.Audit(ctx, key, "mcp:get_design_file", in.DesignID)
		b, err := json.Marshal(res.File)
		if err != nil {
			return toolResult("could not serialize the file", true)
		}
		// Compact results by contract: a giant file (embedded images and the
		// like) is summarized, with the HTTP route as the full-fat door.
		if len(b) > 256<<10 {
			pages, _ := res.File["pages"].([]any)
			return toolResult(map[string]any{
				"designId":  in.DesignID,
				"title":     res.Record.Title,
				"pageCount": len(pages),
				"note":      fmt.Sprintf("file is %d bytes; fetch GET /api/v1/designs/%s/file with the same bearer key for the full JSON", len(b), in.DesignID),
			}, false)
		}
		return toolResult(json.RawMessage(b), false)

	case "export_design":
		if !key.HasScope(apikeys.ScopeExport) {
			return toolResult("this API key lacks the 'export' scope", true)
		}
		var in struct {
			DesignID string `json:"designId"`
		}
		if err := json.Unmarshal(args, &in); err != nil || !d.mcpDesignInWorkspace(r, key, in.DesignID) {
			return toolResult("design not found", true)
		}
		d.keys.Audit(ctx, key, "mcp:export_design", in.DesignID)
		return toolResult(map[string]any{
			"pdf":  "/api/v1/designs/" + in.DesignID + "/render.pdf",
			"png":  "/api/v1/designs/" + in.DesignID + "/render.png",
			"note": "GET these paths with the same Authorization bearer key; PPTX export runs in the editor today",
		}, false)

	case "create_share_link":
		if !key.HasScope(apikeys.ScopeExport) {
			return toolResult("this API key lacks the 'export' scope", true)
		}
		var in struct {
			DesignID  string `json:"designId"`
			Mode      string `json:"mode"`
			Label     string `json:"label"`
			Password  string `json:"password"`
			ExpiresAt string `json:"expiresAt"`
		}
		if err := json.Unmarshal(args, &in); err != nil || !d.mcpDesignInWorkspace(r, key, in.DesignID) {
			return toolResult("design not found", true)
		}
		if in.Mode == "" {
			in.Mode = "view"
		}
		link, err := d.share.CreateLink(ctx, in.DesignID, key.UserID, sharing.CreateLinkInput{
			Mode: in.Mode, Password: in.Password, ExpiresAt: in.ExpiresAt, Label: in.Label,
		})
		if err != nil {
			if errors.Is(err, sharing.ErrBadRequest) {
				return toolResult("invalid link input (mode must be view, comment, or edit; expiresAt must be RFC3339)", true)
			}
			if errors.Is(err, sharing.ErrForbidden) {
				return toolResult("the key's user cannot share this design", true)
			}
			return toolResult("could not create the share link", true)
		}
		d.keys.Audit(ctx, key, "mcp:create_share_link", in.DesignID)
		return toolResult(map[string]any{
			"token":    link.Token,
			"shareUrl": "/shared/" + link.Token + "/",
			"embedUrl": "/shared/" + link.Token + "/?embed=1",
			"mode":     link.Mode,
			"label":    link.Label,
		}, false)

	default:
		return toolResult("unknown tool: "+name, true)
	}
}
