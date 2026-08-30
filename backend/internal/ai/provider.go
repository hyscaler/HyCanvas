// AI provider adapter (doc 19): bring-your-own-key calls to OpenAI-compatible
// and Anthropic endpoints (and any custom OpenAI-compatible base URL). The
// request builders + response parsers are pure; the generate* functions add the
// network call. The SSRF guard (isSafeBaseURL) restricts custom base URLs to
// public https hosts.
package ai

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Provider is the configured AI vendor.
type Provider string

const (
	ProviderOpenAI      Provider = "openai"
	ProviderAnthropic   Provider = "anthropic"
	ProviderDeepSeek    Provider = "deepseek"
	ProviderZhipu       Provider = "zhipu"
	ProviderAzureOpenAI Provider = "azure-openai"
	ProviderCustom      Provider = "custom"
)

// azureAPIVersion is the GA Azure OpenAI REST api-version sent on every call.
const azureAPIVersion = "2024-06-01"

// azureURL builds the Azure OpenAI path for one operation. Azure differs from
// the plain OpenAI dialect in two ways this transport must honor: requests are
// routed per DEPLOYMENT (we use the configured model name as the deployment
// name) under /openai/deployments/{deployment}/, and a required api-version
// query parameter is appended. Authentication uses an "api-key" header instead
// of a bearer token (see openAICompatEndpoint).
func azureURL(base, deployment, op string) string {
	return strings.TrimRight(base, "/") + "/openai/deployments/" + url.PathEscape(deployment) + "/" + op + "?api-version=" + azureAPIVersion
}

// openAICompatEndpoint resolves the URL + auth headers for one OpenAI-shaped
// operation (op like "chat/completions"), handling the Azure dialect. The
// deployment is the model that would be sent in the body (Azure routes by it).
func openAICompatEndpoint(cfg CallConfig, deployment, op string) (string, map[string]string) {
	if cfg.Provider == ProviderAzureOpenAI {
		return azureURL(cfg.BaseURL, deployment, op),
			map[string]string{"content-type": "application/json", "api-key": cfg.APIKey}
	}
	return orDefault(cfg.BaseURL, "https://api.openai.com/v1") + "/" + op,
		map[string]string{"content-type": "application/json", "authorization": "Bearer " + cfg.APIKey}
}

// CallConfig is the resolved per-call provider config (key already decrypted).
type CallConfig struct {
	Provider   Provider
	APIKey     string
	BaseURL    string
	Model      string
	ImageModel string
}

const maxResponseBytes = 25 * 1024 * 1024 // cap inline image/base64 responses

// httpRequest is a built JSON request.
type httpRequest struct {
	url     string
	headers map[string]string
	body    any
}

func orDefault(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

// buildTextRequest builds the text-completion request for the provider.
func buildTextRequest(cfg CallConfig, prompt, system string) httpRequest {
	if cfg.Provider == ProviderAnthropic {
		body := map[string]any{
			"model":      orDefault(cfg.Model, "claude-opus-4-8"),
			"max_tokens": 1024,
			"messages":   []any{map[string]any{"role": "user", "content": prompt}},
		}
		if system != "" {
			body["system"] = system
		}
		return httpRequest{
			url: orDefault(cfg.BaseURL, "https://api.anthropic.com") + "/v1/messages",
			headers: map[string]string{
				"content-type": "application/json", "x-api-key": cfg.APIKey, "anthropic-version": "2023-06-01",
			},
			body: body,
		}
	}
	messages := []any{}
	if system != "" {
		messages = append(messages, map[string]any{"role": "system", "content": system})
	}
	messages = append(messages, map[string]any{"role": "user", "content": prompt})
	model := orDefault(cfg.Model, "gpt-4o-mini")
	u, headers := openAICompatEndpoint(cfg, model, "chat/completions")
	return httpRequest{
		url:     u,
		headers: headers,
		body:    map[string]any{"model": model, "messages": messages},
	}
}

// structuredToolName is the forced tool the Anthropic dialect uses to obtain
// schema-constrained output (their structured-output idiom: one tool whose
// input schema IS the target schema, with tool_choice forcing it).
const structuredToolName = "emit_result"

// buildStructuredTextRequest builds a text request that asks the provider for
// SCHEMA-CONSTRAINED output natively: the OpenAI-compatible dialect sends
// response_format json_schema (strict:false, matching the widest provider
// support), the Anthropic dialect forces a single tool whose input schema is
// the schema. The schema is ALSO restated in the caller's prompt, so a
// provider that rejects the parameter still gets prompt-level guidance (the
// caller retries once without the parameter on a negotiable 4xx). An
// unparseable schemaJSON falls back to the plain request - the prompt
// embedding is then the only constraint, never a hard failure.
func buildStructuredTextRequest(cfg CallConfig, prompt, system, schemaJSON string) httpRequest {
	var schema any
	if err := json.Unmarshal([]byte(schemaJSON), &schema); err != nil || schema == nil {
		return buildTextRequest(cfg, prompt, system)
	}
	if cfg.Provider == ProviderAnthropic {
		body := map[string]any{
			// A larger cap than plain Text: structured payloads (a whole deck
			// outline) routinely exceed the 1024-token conversational default.
			"model":      orDefault(cfg.Model, "claude-opus-4-8"),
			"max_tokens": 4096,
			"messages":   []any{map[string]any{"role": "user", "content": prompt}},
			"tools": []any{map[string]any{
				"name":         structuredToolName,
				"description":  "Return the structured result matching the schema exactly.",
				"input_schema": schema,
			}},
			"tool_choice": map[string]any{"type": "tool", "name": structuredToolName},
		}
		if system != "" {
			body["system"] = system
		}
		return httpRequest{
			url: orDefault(cfg.BaseURL, "https://api.anthropic.com") + "/v1/messages",
			headers: map[string]string{
				"content-type": "application/json", "x-api-key": cfg.APIKey, "anthropic-version": "2023-06-01",
			},
			body: body,
		}
	}
	messages := []any{}
	if system != "" {
		messages = append(messages, map[string]any{"role": "system", "content": system})
	}
	messages = append(messages, map[string]any{"role": "user", "content": prompt})
	model := orDefault(cfg.Model, "gpt-4o-mini")
	u, headers := openAICompatEndpoint(cfg, model, "chat/completions")
	return httpRequest{
		url:     u,
		headers: headers,
		body: map[string]any{
			"model":    model,
			"messages": messages,
			"response_format": map[string]any{
				"type": "json_schema",
				"json_schema": map[string]any{
					"name":   "result",
					"schema": schema,
					"strict": false,
				},
			},
		},
	}
}

// parseStructuredResponse extracts the structured payload: the Anthropic
// dialect returns it as the forced tool call's input (serialized back to JSON
// so every caller sees one shape), falling back to a plain text block; the
// OpenAI-compatible dialect returns ordinary message content.
func parseStructuredResponse(provider Provider, raw []byte) string {
	if provider == ProviderAnthropic {
		var j struct {
			Content []struct {
				Type  string          `json:"type"`
				Text  string          `json:"text"`
				Input json.RawMessage `json:"input"`
			} `json:"content"`
		}
		_ = json.Unmarshal(raw, &j)
		for _, c := range j.Content {
			if c.Type == "tool_use" && len(c.Input) > 0 {
				return strings.TrimSpace(string(c.Input))
			}
		}
		for _, c := range j.Content {
			if c.Text != "" {
				return strings.TrimSpace(c.Text)
			}
		}
		return ""
	}
	return parseTextResponse(provider, raw)
}

// DescribeImageInput is a describe-image (alt-text/vision) call.
type DescribeImageInput struct {
	ImageBase64 string
	Instruction string
	MimeType    string
}

func buildDescribeImageRequest(cfg CallConfig, in DescribeImageInput) httpRequest {
	mime := orDefault(in.MimeType, "image/png")
	if cfg.Provider == ProviderAnthropic {
		return httpRequest{
			url: orDefault(cfg.BaseURL, "https://api.anthropic.com") + "/v1/messages",
			headers: map[string]string{
				"content-type": "application/json", "x-api-key": cfg.APIKey, "anthropic-version": "2023-06-01",
			},
			body: map[string]any{
				"model": orDefault(cfg.Model, "claude-opus-4-8"), "max_tokens": 300,
				"messages": []any{map[string]any{"role": "user", "content": []any{
					map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": mime, "data": in.ImageBase64}},
					map[string]any{"type": "text", "text": in.Instruction},
				}}},
			},
		}
	}
	model := orDefault(cfg.Model, "gpt-4o-mini")
	u, headers := openAICompatEndpoint(cfg, model, "chat/completions")
	return httpRequest{
		url:     u,
		headers: headers,
		body: map[string]any{
			"model": model, "max_tokens": 300,
			"messages": []any{map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "text", "text": in.Instruction},
				map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:" + mime + ";base64," + in.ImageBase64}},
			}}},
		},
	}
}

func parseTextResponse(provider Provider, raw []byte) string {
	if provider == ProviderAnthropic {
		var j struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		}
		_ = json.Unmarshal(raw, &j)
		if len(j.Content) > 0 {
			return strings.TrimSpace(j.Content[0].Text)
		}
		return ""
	}
	var j struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	_ = json.Unmarshal(raw, &j)
	if len(j.Choices) > 0 {
		return strings.TrimSpace(j.Choices[0].Message.Content)
	}
	return ""
}

func buildImageRequest(cfg CallConfig, prompt, size string) httpRequest {
	model := orDefault(cfg.ImageModel, "gpt-image-1")
	u, headers := openAICompatEndpoint(cfg, model, "images/generations")
	return httpRequest{
		url:     u,
		headers: headers,
		body:    map[string]any{"model": model, "prompt": prompt, "size": orDefault(size, "1024x1024"), "n": 1},
	}
}

// EditImageInput is an image edit / outpaint call.
type EditImageInput struct {
	ImageBase64 string
	Prompt      string
	MaskBase64  string
	Size        string
}

func parseImageResponse(raw []byte) string {
	var j struct {
		Data []struct {
			B64JSON string `json:"b64_json"`
			URL     string `json:"url"`
		} `json:"data"`
	}
	_ = json.Unmarshal(raw, &j)
	if len(j.Data) == 0 {
		return ""
	}
	if j.Data[0].B64JSON != "" {
		return "data:image/png;base64," + j.Data[0].B64JSON
	}
	return j.Data[0].URL
}

var ipv4Re = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)\.(\d+)$`)

// isSafeBaseURL reports whether a custom provider base URL is safe to fetch
// server-side: https only (http localhost allowed in dev), rejecting loopback,
// link-local, and RFC1918 private ranges to limit SSRF.
func isSafeBaseURL(raw string, allowLocalhostHTTP bool) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	isLocal := host == "localhost" || host == "127.0.0.1" || host == "::1"
	if u.Scheme != "https" && !(allowLocalhostHTTP && u.Scheme == "http" && isLocal) {
		return false
	}
	if isLocal {
		return allowLocalhostHTTP
	}
	if host == "0.0.0.0" || strings.HasSuffix(host, ".local") {
		return false
	}
	if m := ipv4Re.FindStringSubmatch(host); m != nil {
		a, _ := strconv.Atoi(m[1])
		b, _ := strconv.Atoi(m[2])
		if a == 10 || a == 127 || (a == 169 && b == 254) || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) {
			return false
		}
	}
	if strings.Contains(host, ":") && (strings.HasPrefix(host, "fc") || strings.HasPrefix(host, "fd") || strings.HasPrefix(host, "fe80")) {
		return false
	}
	return true
}

// errProviderFailed is returned for any provider transport / non-2xx / oversize
// response (the service maps it to a friendly 502 without echoing the body).
var errProviderFailed = errors.New("provider request failed")

// httpStatusError carries the provider's HTTP status so a caller can decide
// whether a failure is negotiable (a 4xx rejecting an unsupported request
// parameter) without ever echoing the provider's body. It IS an
// errProviderFailed for every existing errors.Is check.
type httpStatusError struct{ status int }

func (e *httpStatusError) Error() string { return fmt.Sprintf("provider request failed (%d)", e.status) }
func (e *httpStatusError) Is(target error) bool { return target == errProviderFailed }

// isNegotiable4xx reports whether a provider rejection plausibly means "this
// request parameter is unsupported" - worth one retry WITHOUT the parameter.
// Auth and rate-limit statuses are excluded: retrying cannot help those.
func isNegotiable4xx(err error) bool {
	var se *httpStatusError
	if !errors.As(err, &se) {
		return false
	}
	switch se.status {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusTooManyRequests:
		return false
	}
	return se.status >= 400 && se.status < 500
}

// newHTTPClient builds the outbound client for every provider call.
//
// CheckRedirect re-applies the SSRF gate to each hop. isSafeBaseURL judges the
// URL an admin CONFIGURED, and nothing was judging where that URL sent us next:
// an endpoint answering 302 to http://169.254.169.254/ was followed, which is
// precisely the request the gate exists to prevent. Go already strips the
// Authorization header across hosts, so the key did not travel, but the request
// still left the box and its body still came back to be parsed.
//
// A workspace admin is not necessarily the person who runs the instance, so
// this is a privilege boundary and not merely a footgun.
func newHTTPClient(allowLocalHTTP bool) *http.Client {
	return &http.Client{
		Timeout: 60 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			if !isSafeBaseURL(req.URL.String(), allowLocalHTTP) {
				return errors.New("redirect to a disallowed host")
			}
			return nil
		},
	}
}

func (s *Service) postJSON(req httpRequest) ([]byte, error) {
	raw, _ := json.Marshal(req.body)
	httpReq, err := http.NewRequest(http.MethodPost, req.url, bytes.NewReader(raw))
	if err != nil {
		return nil, errProviderFailed
	}
	for k, v := range req.headers {
		httpReq.Header.Set(k, v)
	}
	return s.do(httpReq)
}

func (s *Service) do(httpReq *http.Request) ([]byte, error) {
	res, err := s.client.Do(httpReq)
	if err != nil {
		return nil, errProviderFailed
	}
	defer res.Body.Close()
	// Do not echo the provider's error body to the client (may leak internals);
	// the status alone travels so callers can negotiate unsupported parameters.
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, &httpStatusError{status: res.StatusCode}
	}
	if cl, err := strconv.ParseInt(res.Header.Get("content-length"), 10, 64); err == nil && cl > maxResponseBytes {
		return nil, errProviderFailed
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes+1))
	if err != nil || int64(len(body)) > maxResponseBytes {
		return nil, errProviderFailed
	}
	return body, nil
}

func (s *Service) generateText(cfg CallConfig, prompt, system string) (string, error) {
	raw, err := s.postJSON(buildTextRequest(cfg, prompt, system))
	if err != nil {
		return "", err
	}
	return parseTextResponse(cfg.Provider, raw), nil
}

// generateStructuredText asks for native schema-constrained output, and on a
// negotiable 4xx (the provider rejecting the response_format / forced-tool
// parameter) retries ONCE as a plain text call - the schema restated in the
// caller's prompt still applies, so the fallback degrades quality, not
// correctness (the caller's validators are the final gate).
func (s *Service) generateStructuredText(cfg CallConfig, prompt, system, schemaJSON string) (string, error) {
	raw, err := s.postJSON(buildStructuredTextRequest(cfg, prompt, system, schemaJSON))
	if err != nil {
		if !isNegotiable4xx(err) {
			return "", err
		}
		plain := buildTextRequest(cfg, prompt, system)
		// Keep the structured-scale output budget on the fallback: the plain
		// builder's conversational 1024-token Anthropic cap would truncate a
		// whole-deck outline into unparseable JSON on every retry.
		if cfg.Provider == ProviderAnthropic {
			if body, ok := plain.body.(map[string]any); ok {
				body["max_tokens"] = 4096
			}
		}
		if raw, err = s.postJSON(plain); err != nil {
			return "", err
		}
		return parseTextResponse(cfg.Provider, raw), nil
	}
	return parseStructuredResponse(cfg.Provider, raw), nil
}

func (s *Service) describeImageCall(cfg CallConfig, in DescribeImageInput) (string, error) {
	raw, err := s.postJSON(buildDescribeImageRequest(cfg, in))
	if err != nil {
		return "", err
	}
	return parseTextResponse(cfg.Provider, raw), nil
}

func (s *Service) generateImage(cfg CallConfig, prompt, size string) (string, error) {
	raw, err := s.postJSON(buildImageRequest(cfg, prompt, size))
	if err != nil {
		return "", err
	}
	return parseImageResponse(raw), nil
}

// editImageCall assembles the OpenAI-compatible images/edits multipart request
// and parses the same b64/url shape as generateImage.
func (s *Service) editImageCall(cfg CallConfig, in EditImageInput) (string, error) {
	imageBytes, err := base64.StdEncoding.DecodeString(in.ImageBase64)
	if err != nil {
		return "", errProviderFailed
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	addFile := func(field, filename string, data []byte) error {
		fw, err := mw.CreateFormFile(field, filename)
		if err != nil {
			return err
		}
		_, err = fw.Write(data)
		return err
	}
	if err := addFile("image", "image.png", imageBytes); err != nil {
		return "", errProviderFailed
	}
	_ = mw.WriteField("prompt", in.Prompt)
	_ = mw.WriteField("model", orDefault(cfg.ImageModel, "gpt-image-1"))
	_ = mw.WriteField("n", "1")
	_ = mw.WriteField("size", orDefault(in.Size, "1024x1024"))
	if in.MaskBase64 != "" {
		maskBytes, err := base64.StdEncoding.DecodeString(in.MaskBase64)
		if err != nil {
			return "", errProviderFailed
		}
		if err := addFile("mask", "mask.png", maskBytes); err != nil {
			return "", errProviderFailed
		}
	}
	if err := mw.Close(); err != nil {
		return "", errProviderFailed
	}
	editURL, editHeaders := openAICompatEndpoint(cfg, orDefault(cfg.ImageModel, "gpt-image-1"), "images/edits")
	httpReq, err := http.NewRequest(http.MethodPost, editURL, &buf)
	if err != nil {
		return "", errProviderFailed
	}
	for k, v := range editHeaders {
		httpReq.Header.Set(k, v)
	}
	httpReq.Header.Set("content-type", mw.FormDataContentType()) // multipart, not JSON
	raw, err := s.do(httpReq)
	if err != nil {
		return "", err
	}
	return parseImageResponse(raw), nil
}
