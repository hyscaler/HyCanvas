package ai

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
)

// Pinned against AWS's published Signature Version 4 example (the "get-vanilla"
// case from the signing test suite). A signer that only agrees with itself
// proves nothing: this is the one test that can tell a correct implementation
// from a self-consistent wrong one.
func TestSignAWSv4MatchesThePublishedExample(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "https://example.amazonaws.com/", nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	at := time.Date(2015, 8, 30, 12, 36, 0, 0, time.UTC)
	signAWSv4(req, nil, awsCreds{
		AccessKeyID: "AKIDEXAMPLE",
		SecretKey:   "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
		Region:      "us-east-1",
		Service:     "service",
	}, at)

	const want = "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
		"SignedHeaders=host;x-amz-date, " +
		"Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
	if got := req.Header.Get("authorization"); got != want {
		t.Fatalf("signature mismatch\n got: %s\nwant: %s", got, want)
	}
}

func TestBedrockRegionFromEndpoint(t *testing.T) {
	cases := map[string]string{
		"https://bedrock-runtime.us-east-1.amazonaws.com":     "us-east-1",
		"https://bedrock-runtime.eu-central-1.amazonaws.com/": "eu-central-1",
		"https://bedrock-runtime.ap-south-1.amazonaws.com/v1": "ap-south-1",
		"https://bedrock.us-west-2.amazonaws.com":             "us-west-2",
		"https://example.com":                                 "",
		"not a url":                                           "",
		"":                                                    "",
	}
	for in, want := range cases {
		if got := bedrockRegionFrom(in); got != want {
			t.Errorf("bedrockRegionFrom(%q) = %q, want %q", in, got, want)
		}
	}
}

// The signature must cover the body: two different payloads to the same URL at
// the same instant must not produce the same signature, or a proxy could swap
// one request's body for another's.
func TestSignatureCoversTheBody(t *testing.T) {
	sign := func(body string) string {
		req, _ := http.NewRequest(http.MethodPost, "https://bedrock-runtime.us-east-1.amazonaws.com/model/x/converse", strings.NewReader(body))
		req.Header.Set("content-type", "application/json")
		signAWSv4(req, []byte(body), awsCreds{
			AccessKeyID: "AKIDEXAMPLE", SecretKey: "secret", Region: "us-east-1", Service: "bedrock",
		}, time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC))
		return req.Header.Get("authorization")
	}
	if sign(`{"a":1}`) == sign(`{"a":2}`) {
		t.Fatal("the signature must change with the body")
	}
	// content-type is part of the signed set when present, so it is covered too.
	if !strings.Contains(sign(`{"a":1}`), "SignedHeaders=content-type;host;x-amz-date") {
		t.Fatalf("content-type should be signed: %s", sign(`{"a":1}`))
	}
}

// The Bedrock dialect shares none of the OpenAI request shape, so these pin the
// pieces that a wrong guess would break silently: the route, the Converse body,
// and the fact that the call is signed rather than carrying a token header.
func TestBedrockRequestShapes(t *testing.T) {
	cfg := CallConfig{
		Provider:  ProviderBedrock,
		APIKey:    "AKIDEXAMPLE",
		APISecret: "secret",
		BaseURL:   "https://bedrock-runtime.eu-west-1.amazonaws.com",
		Model:     "anthropic.claude-sonnet-4-5-20250929-v1:0",
	}

	text := buildTextRequest(cfg, "write a headline", "be terse")
	if !strings.HasSuffix(text.url, "/converse") || !strings.Contains(text.url, "/model/") {
		t.Fatalf("text should go to the Converse route: %s", text.url)
	}
	// The model id contains a colon, which must survive path escaping.
	if !strings.Contains(text.url, "v1%3A0") && !strings.Contains(text.url, "v1:0") {
		t.Fatalf("model id lost in the path: %s", text.url)
	}
	if text.sign == nil || text.sign.Region != "eu-west-1" || text.sign.Service != "bedrock" {
		t.Fatalf("text request must be signed for the endpoint's region: %+v", text.sign)
	}
	if text.headers["authorization"] != "" || text.headers["x-api-key"] != "" {
		t.Fatalf("a signed request must not also carry a token header: %+v", text.headers)
	}
	body, _ := json.Marshal(text.body)
	for _, want := range []string{`"messages"`, `"inferenceConfig"`, `"system"`, `"be terse"`, `"write a headline"`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("converse body missing %s: %s", want, body)
		}
	}

	// Vision rides the same Converse shape, with the format named by extension.
	vis := buildDescribeImageRequest(cfg, DescribeImageInput{ImageBase64: "aGk=", MimeType: "image/jpg", Instruction: "describe"})
	visBody, _ := json.Marshal(vis.body)
	if !strings.Contains(string(visBody), `"format":"jpeg"`) {
		t.Fatalf("jpg should be normalized to jpeg: %s", visBody)
	}
	if !strings.Contains(string(visBody), `"bytes":"aGk="`) {
		t.Fatalf("image bytes should ride in source.bytes: %s", visBody)
	}

	// Image generation is InvokeModel with the model's own payload.
	img := buildImageRequest(CallConfig{
		Provider: ProviderBedrock, APIKey: "k", APISecret: "s",
		BaseURL: cfg.BaseURL, ImageModel: "amazon.nova-canvas-v1:0",
	}, "a dune at dawn", "1536x640")
	if !strings.HasSuffix(img.url, "/invoke") {
		t.Fatalf("image should go to InvokeModel: %s", img.url)
	}
	imgBody, _ := json.Marshal(img.body)
	for _, want := range []string{`"taskType":"TEXT_IMAGE"`, `"width":1536`, `"height":640`} {
		if !strings.Contains(string(imgBody), want) {
			t.Fatalf("image body missing %s: %s", want, imgBody)
		}
	}
	if img.sign == nil {
		t.Fatal("the image call must be signed too")
	}
}

func TestBedrockImageSizeRejectsWhatTheModelsRefuse(t *testing.T) {
	cases := map[string][2]int{
		"1024x1024": {1024, 1024},
		"1536x640":  {1536, 640},
		"":          {1024, 1024},
		"1023x1024": {1024, 1024}, // not a multiple of 64
		"99999x64":  {1024, 1024}, // out of range
		"wide":      {1024, 1024},
	}
	for in, want := range cases {
		w, h := bedrockImageSize(in)
		if w != want[0] || h != want[1] {
			t.Errorf("bedrockImageSize(%q) = %dx%d, want %dx%d", in, w, h, want[0], want[1])
		}
	}
}

// Converse and the image models answer in shapes nothing else in the catalog
// uses, so a parser that quietly returns "" would look like an empty reply.
func TestBedrockResponseParsing(t *testing.T) {
	txt := parseTextResponse(ProviderBedrock, []byte(`{"output":{"message":{"role":"assistant","content":[{"text":"  a headline  "}]}}}`))
	if txt != "a headline" {
		t.Fatalf("converse reply = %q", txt)
	}
	if got := parseStructuredResponse(ProviderBedrock, []byte(`{"output":{"message":{"content":[{"text":"{\"a\":1}"}]}}}`)); got != `{"a":1}` {
		t.Fatalf("structured reply = %q", got)
	}
	img := parseImageResponse([]byte(`{"images":["aW1n"]}`))
	if img != "data:image/png;base64,aW1n" {
		t.Fatalf("image reply = %q", img)
	}
	// The OpenAI shape must still parse: the branch is additive.
	if got := parseImageResponse([]byte(`{"data":[{"b64_json":"b3Blbg=="}]}`)); !strings.Contains(got, "b3Blbg==") {
		t.Fatalf("openai image reply regressed: %q", got)
	}
}

// End to end against a real database and a stub that VERIFIES the signature it
// receives by recomputing it from the canonical request. The published-vector
// test above proves the algorithm; this proves the plumbing around it, which is
// where the credential pair could go wrong: stored, encrypted, decrypted, and
// handed to the signer with the region taken from the endpoint.
func TestBedrockEndToEnd_DB(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping DB integration test")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stripSchema(dsn))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	acct := accounts.NewService(tx, "test-jwt-secret")
	_, ws, _, err := acct.Signup(ctx, "bedrock+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}

	const accessKey, secretKey = "AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
	var lastAuth, lastPath string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lastAuth, lastPath = r.Header.Get("authorization"), r.URL.Path
		body, _ := io.ReadAll(r.Body)

		// Recompute the signature over what actually arrived. A signer that
		// signs one thing and sends another fails here and nowhere else.
		probe, _ := http.NewRequest(r.Method, "https://"+r.Host+r.URL.RequestURI(), nil)
		if ct := r.Header.Get("content-type"); ct != "" {
			probe.Header.Set("content-type", ct)
		}
		at, perr := time.Parse("20060102T150405Z", r.Header.Get("x-amz-date"))
		if perr != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		signAWSv4(probe, body, awsCreds{
			AccessKeyID: accessKey, SecretKey: secretKey,
			Region: bedrockRegionFrom("https://" + r.Host), Service: "bedrock",
		}, at)
		if probe.Header.Get("authorization") != lastAuth {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"output": map[string]any{"message": map[string]any{
				"content": []any{map[string]any{"text": "signed and served"}},
			}},
		})
	}))
	defer srv.Close()

	svc := NewService(tx, "test-ai-secret", true)
	// Point every hostname at the stub while leaving the URL and Host header
	// alone, so the request is signed for the real regional host and the stub
	// can verify it against that same host.
	stubAddr := strings.TrimPrefix(srv.URL, "https://")
	svc.client = &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, stubAddr)
		},
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // the stub's self-signed cert
	}}

	// An endpoint with no region in the host cannot be signed, and is refused
	// rather than stored to fail later.
	if _, err := svc.SetConfig(ctx, ws.ID, ConfigInput{
		Provider: "bedrock", BaseURL: strp(srv.URL), APIKey: accessKey, APISecret: secretKey,
	}); err != ErrBaseURLRequired {
		t.Fatalf("a region-less endpoint should be refused, got %v", err)
	}
	// Half a credential is not a credential.
	regional := "https://bedrock-runtime.us-east-1.amazonaws.com"
	if _, err := svc.SetConfig(ctx, ws.ID, ConfigInput{
		Provider: "bedrock", BaseURL: strp(regional), APIKey: accessKey,
	}); err != ErrSecretRequired {
		t.Fatalf("a key without its secret should be refused, got %v", err)
	}

	if _, err := svc.SetConfig(ctx, ws.ID, ConfigInput{
		Provider: "bedrock", BaseURL: strp(regional), APIKey: accessKey, APISecret: secretKey,
	}); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}

	// The real call: signed, served, and parsed out of the Converse shape. The
	// stub returns 403 unless the signature it recomputes matches the one that
	// arrived, so reaching this line is the assertion.
	out, err := svc.Text(ctx, ws.ID, "write a headline", "be terse")
	if err != nil {
		t.Fatalf("bedrock text call: %v", err)
	}
	if out != "signed and served" {
		t.Fatalf("converse reply not parsed: %q", out)
	}
	if !strings.HasSuffix(lastPath, "/converse") {
		t.Fatalf("wrong route: %s", lastPath)
	}
	if !strings.HasPrefix(lastAuth, "AWS4-HMAC-SHA256 Credential="+accessKey+"/") ||
		!strings.Contains(lastAuth, "/us-east-1/bedrock/aws4_request") {
		t.Fatalf("authorization header wrong: %s", lastAuth)
	}

	// Both halves are encrypted at rest, not just the key.
	var keyCipher, secretCipher *string
	if err := tx.QueryRow(ctx, `SELECT "key_cipher","secret_cipher" FROM "ai_configs" WHERE "workspace_id" = $1`, ws.ID).
		Scan(&keyCipher, &secretCipher); err != nil {
		t.Fatalf("read ciphers: %v", err)
	}
	if secretCipher == nil || strings.Contains(*secretCipher, secretKey) || strings.Contains(*keyCipher, accessKey) {
		t.Fatal("both credentials must be encrypted at rest")
	}

	// A secret can be rotated on its own: same access key ID, new secret. Saving
	// it only alongside a new key meant this reported success and changed
	// nothing, which is the worst shape a credential update can take.
	before := *secretCipher
	if _, err := svc.SetConfig(ctx, ws.ID, ConfigInput{
		Provider: "bedrock", BaseURL: strp(regional), APISecret: "a-rotated-secret",
	}); err != nil {
		t.Fatalf("rotate the secret: %v", err)
	}
	if err := tx.QueryRow(ctx, `SELECT "secret_cipher","key_cipher" FROM "ai_configs" WHERE "workspace_id" = $1`, ws.ID).
		Scan(&secretCipher, &keyCipher); err != nil {
		t.Fatalf("re-read after rotation: %v", err)
	}
	if secretCipher == nil || *secretCipher == before {
		t.Fatal("rotating the secret alone must actually change it")
	}
	if keyCipher == nil {
		t.Fatal("rotating the secret must leave the key in place")
	}
	// The view says a secret is stored, so the form can show that instead of an
	// empty box that reveals nothing.
	view, err := svc.GetConfig(ctx, ws.ID)
	if err != nil || view == nil || !view.HasSecret || !view.HasKey {
		t.Fatalf("view should report both credentials stored: %+v err=%v", view, err)
	}

	// Switching to a provider with no secret must not leave the AWS one behind.
	if _, err := svc.SetConfig(ctx, ws.ID, ConfigInput{Provider: "openai", APIKey: "sk-openai"}); err != nil {
		t.Fatalf("switch away: %v", err)
	}
	if err := tx.QueryRow(ctx, `SELECT "secret_cipher" FROM "ai_configs" WHERE "workspace_id" = $1`, ws.ID).Scan(&secretCipher); err != nil {
		t.Fatalf("re-read secret: %v", err)
	}
	if secretCipher != nil {
		t.Fatal("a new key must not keep the previous provider's secret")
	}
}
