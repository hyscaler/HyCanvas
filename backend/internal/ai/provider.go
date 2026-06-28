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
	ProviderOpenAI    Provider = "openai"
	ProviderAnthropic Provider = "anthropic"
	ProviderDeepSeek  Provider = "deepseek"
	ProviderCustom    Provider = "custom"
)

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
	return httpRequest{
		url:     orDefault(cfg.BaseURL, "https://api.openai.com/v1") + "/chat/completions",
		headers: map[string]string{"content-type": "application/json", "authorization": "Bearer " + cfg.APIKey},
		body:    map[string]any{"model": orDefault(cfg.Model, "gpt-4o-mini"), "messages": messages},
	}
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
	return httpRequest{
		url:     orDefault(cfg.BaseURL, "https://api.openai.com/v1") + "/chat/completions",
		headers: map[string]string{"content-type": "application/json", "authorization": "Bearer " + cfg.APIKey},
		body: map[string]any{
			"model": orDefault(cfg.Model, "gpt-4o-mini"), "max_tokens": 300,
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
	return httpRequest{
		url:     orDefault(cfg.BaseURL, "https://api.openai.com/v1") + "/images/generations",
		headers: map[string]string{"content-type": "application/json", "authorization": "Bearer " + cfg.APIKey},
		body:    map[string]any{"model": orDefault(cfg.ImageModel, "gpt-image-1"), "prompt": prompt, "size": orDefault(size, "1024x1024"), "n": 1},
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

func newHTTPClient() *http.Client { return &http.Client{Timeout: 60 * time.Second} }

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
	// Do not echo the provider's error body to the client (may leak internals).
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, errProviderFailed
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
	httpReq, err := http.NewRequest(http.MethodPost, orDefault(cfg.BaseURL, "https://api.openai.com/v1")+"/images/edits", &buf)
	if err != nil {
		return "", errProviderFailed
	}
	httpReq.Header.Set("authorization", "Bearer "+cfg.APIKey)
	httpReq.Header.Set("content-type", mw.FormDataContentType())
	raw, err := s.do(httpReq)
	if err != nil {
		return "", err
	}
	return parseImageResponse(raw), nil
}
