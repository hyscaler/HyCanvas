package storage

import (
	"os"
	"testing"
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
