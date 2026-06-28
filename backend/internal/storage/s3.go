// S3-compatible object-storage driver (AWS S3, MinIO, and any S3-API store).
// Uses the MinIO Go client so a self-hoster can point STORAGE at MinIO via
// S3_ENDPOINT (+ S3_FORCE_PATH_STYLE) or at AWS S3 with the same config. Blobs
// are the same opaque, key-addressed objects the local driver writes, so the
// rest of the app is unchanged by the backend choice.
package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// s3OpTimeout bounds each object operation so a wedged endpoint can't hang the
// request that triggered it.
const s3OpTimeout = 30 * time.Second

// S3 is the S3-compatible storage driver.
type S3 struct {
	client *minio.Client
	bucket string
}

// S3Config carries the resolved S3 settings.
type S3Config struct {
	Endpoint       string // host[:port], with or without an http(s):// scheme
	Region         string
	Bucket         string
	AccessKey      string
	SecretKey      string
	ForcePathStyle bool // path-style addressing (required by most MinIO setups)
}

// s3ConfigFromEnv reads the S3_* environment into an S3Config.
func s3ConfigFromEnv() S3Config {
	return S3Config{
		Endpoint:       os.Getenv("S3_ENDPOINT"),
		Region:         os.Getenv("S3_REGION"),
		Bucket:         os.Getenv("S3_BUCKET"),
		AccessKey:      os.Getenv("S3_ACCESS_KEY_ID"),
		SecretKey:      os.Getenv("S3_SECRET_ACCESS_KEY"),
		ForcePathStyle: truthy(os.Getenv("S3_FORCE_PATH_STYLE")),
	}
}

func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// parseS3Endpoint splits an endpoint into the bare host[:port] + TLS flag the
// MinIO client expects. A scheme-less endpoint defaults to TLS (AWS-style); use
// an explicit http:// for a plaintext MinIO.
func parseS3Endpoint(endpoint string) (host string, secure bool, err error) {
	if strings.Contains(endpoint, "://") {
		u, e := url.Parse(endpoint)
		if e != nil {
			return "", false, fmt.Errorf("invalid S3_ENDPOINT: %w", e)
		}
		return u.Host, u.Scheme != "http", nil
	}
	return endpoint, true, nil
}

// NewS3 builds an S3 driver, verifying the bucket is reachable and creating it
// when missing (so a fresh MinIO works out of the box). It fails loudly on a
// misconfiguration so blobs are never silently dropped.
func NewS3(cfg S3Config) (*S3, error) {
	if cfg.Endpoint == "" || cfg.AccessKey == "" || cfg.SecretKey == "" || cfg.Bucket == "" {
		return nil, errors.New("S3 storage requires S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, and S3_BUCKET")
	}
	host, secure, err := parseS3Endpoint(cfg.Endpoint)
	if err != nil {
		return nil, err
	}
	lookup := minio.BucketLookupAuto
	if cfg.ForcePathStyle {
		lookup = minio.BucketLookupPath
	}
	client, err := minio.New(host, &minio.Options{
		Creds:        credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure:       secure,
		Region:       cfg.Region,
		BucketLookup: lookup,
	})
	if err != nil {
		return nil, fmt.Errorf("S3 client: %w", err)
	}

	s3 := &S3{client: client, bucket: cfg.Bucket}
	ctx, cancel := context.WithTimeout(context.Background(), s3OpTimeout)
	defer cancel()
	exists, err := client.BucketExists(ctx, cfg.Bucket)
	switch {
	case err != nil:
		// A 403 means object-scoped credentials with no HeadBucket permission (the
		// recommended hardened AWS posture): the bucket almost certainly exists and
		// object ops will work, so proceed. Any other error (unreachable endpoint,
		// etc.) is a real misconfiguration worth failing loudly at boot.
		if minio.ToErrorResponse(err).StatusCode == http.StatusForbidden {
			slog.Warn("s3: no permission to verify bucket; assuming it exists", "bucket", cfg.Bucket)
			return s3, nil
		}
		return nil, fmt.Errorf("S3 bucket check (%s): %w", cfg.Bucket, err)
	case !exists:
		if err := client.MakeBucket(ctx, cfg.Bucket, minio.MakeBucketOptions{Region: cfg.Region}); err != nil {
			// A concurrent instance (same owner) may have created it first; that is
			// success, not failure, so multi-instance cold starts converge.
			if code := minio.ToErrorResponse(err).Code; code != "BucketAlreadyOwnedByYou" && code != "BucketAlreadyExists" {
				return nil, fmt.Errorf("S3 create bucket (%s): %w", cfg.Bucket, err)
			}
		}
	}
	return s3, nil
}

func (s *S3) Kind() string { return "s3" }

// normalizeKey mirrors the local driver's key rules so a key behaves identically
// on every backend: relative, no leading slash, no ".." escape. Keys are opaque,
// forward-slash, app-generated; this guards a future caller from diverging.
func normalizeKey(key string) (string, error) {
	if key == "" || strings.HasPrefix(key, "/") {
		return "", errors.New("storage key must be a non-empty relative path: " + key)
	}
	for _, seg := range strings.Split(key, "/") {
		if seg == ".." {
			return "", errors.New("storage key must not escape with '..': " + key)
		}
	}
	return key, nil
}

func (s *S3) Put(key string, data []byte) (PutResult, error) {
	key, err := normalizeKey(key)
	if err != nil {
		return PutResult{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), s3OpTimeout)
	defer cancel()
	if _, err := s.client.PutObject(ctx, s.bucket, key, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{}); err != nil {
		return PutResult{}, err
	}
	sum := sha256.Sum256(data)
	return PutResult{Key: key, URL: "s3://" + s.bucket + "/" + key, Size: int64(len(data)), Checksum: hex.EncodeToString(sum[:])}, nil
}

// Get returns (nil, nil) on a missing key, matching the local driver.
func (s *S3) Get(key string) ([]byte, error) {
	key, err := normalizeKey(key)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), s3OpTimeout)
	defer cancel()
	obj, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = obj.Close() }()
	data, err := io.ReadAll(obj)
	if err != nil {
		if minio.ToErrorResponse(err).Code == "NoSuchKey" {
			return nil, nil
		}
		return nil, err
	}
	return data, nil
}

// Delete is idempotent: removing a missing key is not an error.
func (s *S3) Delete(key string) error {
	key, err := normalizeKey(key)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), s3OpTimeout)
	defer cancel()
	return s.client.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
}

func (s *S3) Exists(key string) (bool, error) {
	key, err := normalizeKey(key)
	if err != nil {
		return false, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), s3OpTimeout)
	defer cancel()
	if _, err := s.client.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{}); err != nil {
		if minio.ToErrorResponse(err).Code == "NoSuchKey" {
			return false, nil
		}
		return false, err
	}
	return true, nil
}
