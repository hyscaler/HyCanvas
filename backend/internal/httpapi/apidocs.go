// Embedded API documentation (F40 E06): GET /api/docs serves a
// self-contained reference page for the generation API, and
// GET /api/docs/openapi.json serves the machine-readable OpenAPI 3.1
// document. No auth: the docs describe the API, they do not expose data.
package httpapi

import (
	_ "embed"
	"net/http"

	"github.com/go-chi/chi/v5"
)

//go:embed apidocs/openapi.json
var openapiJSON []byte

func mountAPIDocs(r chi.Router) {
	r.Get("/api/docs/openapi.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write(openapiJSON)
	})
	r.Get("/api/docs", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(apiDocsHTML))
	})
}

// A hand-authored, dependency-free reference page (self-host friendly: no
// CDN, no external viewer). The OpenAPI document is the machine contract;
// this page is the two-minute human on-ramp.
const apiDocsHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HyCanvas Generation API</title>
<style>
  body { font: 15px/1.6 system-ui, -apple-system, sans-serif; color: #1f2937; max-width: 46rem; margin: 2rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; }
  pre { background: #f6f7f9; border: 1px solid #e5e7eb; border-radius: 8px; padding: 0.9rem; overflow-x: auto; }
  code { background: #f3f4f6; border-radius: 4px; padding: 0.1em 0.35em; }
  pre code { background: none; padding: 0; }
  .pill { display: inline-block; background: #eef2ff; color: #3730a3; border-radius: 999px; padding: 0.05rem 0.6rem; font-size: 0.75rem; font-weight: 600; margin-right: 0.3rem; }
  a { color: #4338ca; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  td, th { border: 1px solid #e5e7eb; padding: 0.35rem 0.6rem; text-align: left; }
</style>
</head>
<body>
<h1>HyCanvas Generation API</h1>
<p>Generate complete, editable presentations programmatically. Machine contract: <a href="/api/docs/openapi.json">openapi.json</a>.</p>

<h2>Authentication</h2>
<p>A workspace admin mints an API key in <b>Dashboard &gt; Members &gt; API keys</b>. The key is shown once. Send it as a bearer token:</p>
<pre><code>Authorization: Bearer hyk_...</code></pre>
<p>Keys are pinned to one workspace and carry scopes:</p>
<table>
<tr><th>Scope</th><th>Grants</th></tr>
<tr><td><code>generate</code></td><td>POST /api/v1/generate/presentation</td></tr>
<tr><td><code>read</code></td><td>GET design record + open-format file</td></tr>
<tr><td><code>export</code></td><td>PDF/PNG renders, document export, share-link creation</td></tr>
</table>
<p>Any valid key can poll <code>GET /api/v1/jobs/{id}</code> for jobs the API itself started (generation and document export). Everything else is session-only. Errors are RFC 7807 problem+json with a stable <code>code</code>.</p>

<h2>Generate a deck</h2>
<pre><code>curl -sS -X POST "$HYCANVAS/api/v1/generate/presentation" \
  -H "Authorization: Bearer $HYK" -H "Content-Type: application/json" \
  -d '{"prompt": "a 6-slide pitch deck for an eco water bottle", "pageCount": 6}'
# =&gt; { "jobId": "...", "poll": "/api/v1/jobs/..." }</code></pre>
<p>Poll the job until it completes; the result carries the new design:</p>
<pre><code>curl -sS "$HYCANVAS/api/v1/jobs/$JOB" -H "Authorization: Bearer $HYK"
# =&gt; { "status": "completed", "result": { "designId": "...", "editorUrl": "/editor?id=...", ... } }</code></pre>
<p>The composed deck contains laid-out text, a theme, and speaker notes. Per-slide images are generated in the editor (open <code>editorUrl</code>).</p>

<h2>Fetch, render, share</h2>
<pre><code># The open-format file (fully editable, forward-migratable)
curl -sS "$HYCANVAS/api/v1/designs/$ID/file" -H "Authorization: Bearer $HYK" &gt; deck.hyc.json

# A server-rendered PDF
curl -sS "$HYCANVAS/api/v1/designs/$ID/render.pdf" -H "Authorization: Bearer $HYK" -o deck.pdf

# A share link (the token forms /shared/{token}/ ; add ?embed=1 for the iframe player)
curl -sS -X POST "$HYCANVAS/api/v1/designs/$ID/links" \
  -H "Authorization: Bearer $HYK" -H "Content-Type: application/json" \
  -d '{"mode": "view", "label": "Investors"}'</code></pre>
<p><span class="pill">Note</span> PPTX export runs client-side in the editor today; the API's export formats are PDF and PNG.</p>

<h2>Grounding sources</h2>
<p>Attach up to 8 text sources; the outline is grounded strictly in them (their content is treated as untrusted reference material):</p>
<pre><code>-d '{"prompt": "quarterly review deck", "sources": [{"name": "Q3 notes", "text": "..."}]}'</code></pre>

<h2>Budgets</h2>
<p>Per key: 5 requests/second (burst 20) across the surface, and about 3 generations/minute on the generate endpoint. Over-budget calls return 429 with <code>Retry-After</code>.</p>
</body>
</html>
`
