package storage

import (
	"bytes"
	"os"
	"strings"
	"testing"
	"time"
)

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

// TestS3_RoundTrip_Integration exercises the live S3/MinIO driver end to end.
// Skipped unless S3_TEST_ENDPOINT is set (the CI/local harness points this at a
// throwaway MinIO).
func TestS3_RoundTrip_Integration(t *testing.T) {
	endpoint := os.Getenv("S3_TEST_ENDPOINT")
	if endpoint == "" {
		t.Skip("S3_TEST_ENDPOINT not set; skipping live S3/MinIO integration test")
	}
	drv, err := NewS3(S3Config{
		Endpoint:       endpoint,
		Region:         "us-east-1",
		Bucket:         envOr("S3_TEST_BUCKET", "octest"),
		AccessKey:      os.Getenv("S3_TEST_ACCESS_KEY"),
		SecretKey:      os.Getenv("S3_TEST_SECRET_KEY"),
		ForcePathStyle: true,
	})
	if err != nil {
		t.Fatalf("NewS3: %v", err)
	}
	if drv.Kind() != "s3" {
		t.Fatalf("Kind = %q", drv.Kind())
	}

	const key = "test/roundtrip.bin"
	payload := []byte("hello minio round trip")

	res, err := drv.Put(key, payload)
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if res.Size != int64(len(payload)) || res.Checksum == "" || res.Key != key {
		t.Fatalf("PutResult wrong: %+v", res)
	}

	if ok, err := drv.Exists(key); err != nil || !ok {
		t.Fatalf("Exists after put = %v, %v", ok, err)
	}
	got, err := drv.Get(key)
	if err != nil || string(got) != string(payload) {
		t.Fatalf("Get = %q, %v", got, err)
	}

	// A missing key reads as (nil, nil) and Exists false (matches the local driver).
	if miss, err := drv.Get("test/missing"); err != nil || miss != nil {
		t.Fatalf("missing Get = %v, %v; want nil, nil", miss, err)
	}
	if ex, err := drv.Exists("test/missing"); err != nil || ex {
		t.Fatalf("missing Exists = %v, %v; want false, nil", ex, err)
	}

	if err := drv.Delete(key); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := drv.Delete(key); err != nil {
		t.Fatalf("Delete (idempotent on missing): %v", err)
	}
	if ok, _ := drv.Exists(key); ok {
		t.Fatal("Exists after delete should be false")
	}

	// Direct-upload surface: PutStream (the api-put leg), Stat, GetRange (the
	// complete-time sniff), and Rename (pending/ -> assets/ promotion).
	const pendingKey = "test/direct-pending.bin"
	const finalKey = "test/direct-final.bin"
	stream := []byte("streamed direct upload payload with a head worth sniffing")
	sres, err := drv.PutStream(pendingKey, bytes.NewReader(stream), -1)
	if err != nil {
		t.Fatalf("PutStream: %v", err)
	}
	if sres.Size != int64(len(stream)) || sres.Checksum == "" {
		t.Fatalf("PutStream result wrong: %+v", sres)
	}
	size, ok, err := drv.Stat(pendingKey)
	if err != nil || !ok || size != int64(len(stream)) {
		t.Fatalf("Stat = %d, %v, %v", size, ok, err)
	}
	if _, ok, _ := drv.Stat("test/missing"); ok {
		t.Fatal("Stat on missing key should be ok=false")
	}
	head, err := drv.GetRange(pendingKey, 8)
	if err != nil || string(head) != string(stream[:8]) {
		t.Fatalf("GetRange = %q, %v", head, err)
	}
	// A range longer than the object returns the whole object.
	all, err := drv.GetRange(pendingKey, int64(len(stream))+100)
	if err != nil || string(all) != string(stream) {
		t.Fatalf("GetRange past end = %d bytes, %v", len(all), err)
	}
	if err := drv.Rename(pendingKey, finalKey); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if ok, _ := drv.Exists(pendingKey); ok {
		t.Fatal("source should be gone after Rename")
	}
	got, err = drv.Get(finalKey)
	if err != nil || string(got) != string(stream) {
		t.Fatalf("Get after Rename = %d bytes, %v", len(got), err)
	}
	if err := drv.Delete(finalKey); err != nil {
		t.Fatalf("Delete final: %v", err)
	}

	// PresignPost mints a policy for the exact key; the URL must target the
	// endpoint (or the public rewrite) and carry the signed fields.
	post, err := drv.PresignPost("test/presigned.bin", 1024, time.Minute, "")
	if err != nil {
		t.Fatalf("PresignPost: %v", err)
	}
	if post.URL == "" || post.Fields["key"] != "test/presigned.bin" || post.Fields["policy"] == "" {
		t.Fatalf("PresignPost grant wrong: url=%q fields=%v", post.URL, post.Fields)
	}
	rew, err := drv.PresignPost("test/presigned.bin", 1024, time.Minute, "https://cdn.example.com/s3")
	if err != nil {
		t.Fatalf("PresignPost rewrite: %v", err)
	}
	if !strings.HasPrefix(rew.URL, "https://cdn.example.com/s3/") {
		t.Fatalf("public URL rewrite wrong: %q", rew.URL)
	}
}

func TestParseS3Endpoint(t *testing.T) {
	cases := []struct {
		in     string
		host   string
		secure bool
	}{
		{"https://s3.amazonaws.com", "s3.amazonaws.com", true},
		{"https://s3.us-west-2.amazonaws.com", "s3.us-west-2.amazonaws.com", true},
		{"http://localhost:9000", "localhost:9000", false},
		{"https://minio.example.com:9000", "minio.example.com:9000", true},
		{"minio.internal:9000", "minio.internal:9000", true}, // bare host defaults to TLS
		{"play.min.io", "play.min.io", true},
	}
	for _, c := range cases {
		host, secure, err := parseS3Endpoint(c.in)
		if err != nil {
			t.Fatalf("parseS3Endpoint(%q): unexpected error %v", c.in, err)
		}
		if host != c.host || secure != c.secure {
			t.Errorf("parseS3Endpoint(%q) = (%q, %v); want (%q, %v)", c.in, host, secure, c.host, c.secure)
		}
	}
}

func TestTruthy(t *testing.T) {
	for _, v := range []string{"1", "true", "TRUE", "yes", "on", " true "} {
		if !truthy(v) {
			t.Errorf("truthy(%q) = false; want true", v)
		}
	}
	for _, v := range []string{"", "0", "false", "no", "off", "nope"} {
		if truthy(v) {
			t.Errorf("truthy(%q) = true; want false", v)
		}
	}
}

func TestNormalizeKey(t *testing.T) {
	ok := []string{"designs/a/snap.ocd", "assets/ws-1/uuid.png", "single", "a/b/c/d"}
	for _, k := range ok {
		if got, err := normalizeKey(k); err != nil || got != k {
			t.Errorf("normalizeKey(%q) = (%q, %v); want (%q, nil)", k, got, err, k)
		}
	}
	bad := []string{"", "/absolute", "a/../../etc/passwd", "..", "../x", "x/../../../y"}
	for _, k := range bad {
		if _, err := normalizeKey(k); err == nil {
			t.Errorf("normalizeKey(%q) should error", k)
		}
	}
}

func TestNewS3_MissingConfig(t *testing.T) {
	// An incomplete config must fail fast (no client, no silent local fallback).
	if _, err := NewS3(S3Config{Endpoint: "https://s3.amazonaws.com"}); err == nil {
		t.Fatal("NewS3 with missing credentials/bucket should error")
	}
}
