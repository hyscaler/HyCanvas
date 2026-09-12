// AI provider adapter (doc 19): bring-your-own-key calls to OpenAI-compatible
// and Anthropic endpoints (and any custom OpenAI-compatible base URL). The
// request builders + response parsers are pure; the generate* functions add the
// network call. The SSRF guard (isSafeBaseURL) restricts custom base URLs to
// public https hosts.
package ai

import (
	"bytes"
	"context"
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
	ProviderOpenRouter  Provider = "openrouter"
	ProviderAzureOpenAI Provider = "azure-openai"
	ProviderBedrock     Provider = "bedrock"
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
	Provider Provider
	APIKey   string
	// APISecret is the second credential, set only for providers that need one.
	// For Bedrock it is the AWS secret access key, and APIKey is the access key
	// ID; the pair signs each request rather than riding in a header.
	APISecret  string
	BaseURL    string
	Model      string
	ImageModel string
}

const maxResponseBytes = 25 * 1024 * 1024 // cap inline image/base64 responses

// httpRequest is a built JSON request. timeout is the per-operation deadline;
// zero means providerTimeout.
type httpRequest struct {
	url     string
	headers map[string]string
	body    any
	timeout time.Duration
	// sign, when set, signs the request after the body is marshalled. Bedrock's
	// signature covers the exact bytes, so it cannot be precomputed into a
	// header the way every other provider's auth is.
	sign *awsCreds
}

func orDefault(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

// buildTextRequest builds the text-completion request for the provider.
// bedrockCreds resolves the signing material for a Bedrock call. An endpoint
// whose host carries no region cannot be signed, and the empty Region makes the
// signature fail loudly at the provider rather than silently signing for the
// wrong scope.
func bedrockCreds(cfg CallConfig) *awsCreds {
	return &awsCreds{
		AccessKeyID: cfg.APIKey,
		SecretKey:   cfg.APISecret,
		Region:      bedrockRegionFrom(cfg.BaseURL),
		Service:     "bedrock",
	}
}

// bedrockConverse builds a Converse request. Converse is the reason this stays
// small: one request and response shape across every model family Bedrock
// hosts, so Claude, Llama and Nova all read the same here.
func bedrockConverse(cfg CallConfig, model string, content []any, system string, maxTokens int) httpRequest {
	body := map[string]any{
		"messages":        []any{map[string]any{"role": "user", "content": content}},
		"inferenceConfig": map[string]any{"maxTokens": maxTokens},
	}
	if system != "" {
		body["system"] = []any{map[string]any{"text": system}}
	}
	return httpRequest{
		url:     strings.TrimRight(cfg.BaseURL, "/") + "/model/" + url.PathEscape(model) + "/converse",
		headers: map[string]string{"content-type": "application/json"},
		body:    body,
		sign:    bedrockCreds(cfg),
	}
}

func buildTextRequest(cfg CallConfig, prompt, system string) httpRequest {
	if cfg.Provider == ProviderBedrock {
		return bedrockConverse(cfg, orDefault(cfg.Model, "anthropic.claude-sonnet-4-5-20250929-v1:0"),
			[]any{map[string]any{"text": prompt}}, system, 1024)
	}
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
	// Bedrock's Converse API has no response_format parameter, and its tool
	// shape differs per model family. The caller always restates the schema in
	// the prompt and validates with repair passes, so the plain request is the
	// honest fallback rather than sending a parameter that would 400.
	if cfg.Provider == ProviderBedrock {
		return buildTextRequest(cfg, prompt, system)
	}
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
	if cfg.Provider == ProviderBedrock {
		// Converse names the format by extension ("png", "jpeg"), not by mime
		// type, and carries the bytes base64 in source.bytes.
		format := strings.TrimPrefix(mime, "image/")
		if format == "jpg" {
			format = "jpeg"
		}
		return bedrockConverse(cfg, orDefault(cfg.Model, "anthropic.claude-sonnet-4-5-20250929-v1:0"), []any{
			map[string]any{"image": map[string]any{"format": format, "source": map[string]any{"bytes": in.ImageBase64}}},
			map[string]any{"text": in.Instruction},
		}, "", 300)
	}
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
	if provider == ProviderBedrock {
		var j struct {
			Output struct {
				Message struct {
					Content []struct {
						Text string `json:"text"`
					} `json:"content"`
				} `json:"message"`
			} `json:"output"`
		}
		_ = json.Unmarshal(raw, &j)
		if c := j.Output.Message.Content; len(c) > 0 {
			return strings.TrimSpace(c[0].Text)
		}
		return ""
	}
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

// imageGenerationOp is the path segment for text-to-image on this provider.
//
// OpenRouter is the odd one out: its unified image API is served at /images,
// and it has no /images/generations route at all, so the OpenAI-shaped path
// every other preset uses 404s there. The body is the same shape either way
// (model + prompt, with "size" accepted as a shorthand for the resolution), so
// only the path needs to branch.
func imageGenerationOp(cfg CallConfig) string {
	if cfg.Provider == ProviderOpenRouter {
		return "images"
	}
	return "images/generations"
}

// credentialProbeOp is the cheapest authenticated GET that proves a key and a
// base URL are good without generating anything (see VerifyImageConfig).
//
// "models" is the OpenAI-compatible convention and is authenticated on every
// other preset, so a bad key comes back 401 and the probe can say so. OpenRouter
// is the exception: it serves its model catalog PUBLICLY, answering 200 for a
// missing key and an invalid one alike, so probing /models there would report
// any typo as verified and send the user off to debug a generation instead. Its
// /key route does authenticate (401 without a valid credential), so that is
// what OpenRouter probes.
func credentialProbeOp(cfg CallConfig) string {
	if cfg.Provider == ProviderOpenRouter {
		return "key"
	}
	return "models"
}

// bedrockImageSize splits "1024x1024" into the width and height Nova Canvas
// and Titan Image take as separate numbers. Both require multiples of 64, so an
// unparseable or odd size falls back to a square the models accept rather than
// being passed through to a 400.
func bedrockImageSize(size string) (int, int) {
	w, h := 1024, 1024
	if parts := strings.SplitN(strings.ToLower(strings.TrimSpace(size)), "x", 2); len(parts) == 2 {
		pw, errW := strconv.Atoi(parts[0])
		ph, errH := strconv.Atoi(parts[1])
		if errW == nil && errH == nil && pw >= 320 && ph >= 320 && pw <= 4096 && ph <= 4096 && pw%64 == 0 && ph%64 == 0 {
			w, h = pw, ph
		}
	}
	return w, h
}

func buildImageRequest(cfg CallConfig, prompt, size string) httpRequest {
	if cfg.Provider == ProviderBedrock {
		model := orDefault(cfg.ImageModel, "amazon.nova-canvas-v1:0")
		w, h := bedrockImageSize(size)
		// InvokeModel, not Converse: Converse is a conversation API and has no
		// image-generation shape. The body is the MODEL's own, which is why
		// this one is not portable the way the text path is.
		return httpRequest{
			url:     strings.TrimRight(cfg.BaseURL, "/") + "/model/" + url.PathEscape(model) + "/invoke",
			headers: map[string]string{"content-type": "application/json"},
			body: map[string]any{
				"taskType":              "TEXT_IMAGE",
				"textToImageParams":     map[string]any{"text": prompt},
				"imageGenerationConfig": map[string]any{"numberOfImages": 1, "width": w, "height": h},
			},
			timeout: imageTimeout,
			sign:    bedrockCreds(cfg),
		}
	}
	model := orDefault(cfg.ImageModel, "gpt-image-1")
	u, headers := openAICompatEndpoint(cfg, model, imageGenerationOp(cfg))
	return httpRequest{
		url:     u,
		headers: headers,
		body:    map[string]any{"model": model, "prompt": prompt, "size": orDefault(size, "1024x1024"), "n": 1},
		timeout: imageTimeout,
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
	// Bedrock's image models answer {"images":["<base64>"]}, with no envelope
	// and no mime type. Checked first because the OpenAI shape below would
	// silently return "" for it.
	var bedrock struct {
		Images []string `json:"images"`
	}
	if err := json.Unmarshal(raw, &bedrock); err == nil && len(bedrock.Images) > 0 && bedrock.Images[0] != "" {
		return "data:image/png;base64," + bedrock.Images[0]
	}
	var j struct {
		Data []struct {
			B64JSON   string `json:"b64_json"`
			URL       string `json:"url"`
			MediaType string `json:"media_type"`
		} `json:"data"`
	}
	_ = json.Unmarshal(raw, &j)
	if len(j.Data) == 0 {
		return ""
	}
	if j.Data[0].B64JSON != "" {
		// OpenRouter reports the encoding per image and its models do not all
		// emit PNG (webp and image/svg+xml both occur). Labelling a webp as
		// image/png yields a data URL the browser will not decode, so the
		// declared type wins when the provider sends one. Providers that omit
		// it keep the historical PNG assumption.
		return "data:" + orDefault(j.Data[0].MediaType, "image/png") + ";base64," + j.Data[0].B64JSON
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

func (e *httpStatusError) Error() string {
	return fmt.Sprintf("provider request failed (%d)", e.status)
}
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

// Outbound deadlines are per operation, not per client.
//
// Image generation is genuinely slower than a chat completion: a diffusion
// model is doing real work, and a large model can sit well past a minute before
// the first byte. Raising the shared client ceiling to cover that would apply
// the same tolerance to text and vision calls, doubling the worst case a user
// waits on a request that should have failed fast. So the client carries only a
// backstop and each request states its own deadline.
const (
	providerTimeout = 60 * time.Second
	imageTimeout    = 180 * time.Second
)

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
		// A backstop only: the real deadline travels with each request's
		// context, so a caller that omits one still cannot hang forever.
		Timeout: imageTimeout,
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
	// Signed last: the signature covers the headers set above and the body
	// bytes marshalled here, so nothing may change after this point.
	if req.sign != nil {
		signAWSv4(httpReq, raw, *req.sign, time.Now())
	}
	return s.do(httpReq, req.timeout)
}

// do sends the request under a per-operation deadline. A zero timeout means the
// default; callers that need longer (image generation) say so explicitly.
func (s *Service) do(httpReq *http.Request, timeout time.Duration) ([]byte, error) {
	if timeout <= 0 {
		timeout = providerTimeout
	}
	ctx, cancel := context.WithTimeout(httpReq.Context(), timeout)
	defer cancel()
	res, err := s.client.Do(httpReq.WithContext(ctx))
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
	raw, err := s.do(httpReq, imageTimeout)
	if err != nil {
		return "", err
	}
	return parseImageResponse(raw), nil
}
