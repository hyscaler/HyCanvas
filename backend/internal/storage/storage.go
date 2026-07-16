// Package storage is the doc-01 storage abstraction: one driver interface with
// interchangeable backends. Two drivers ship: a zero-config local-filesystem
// driver (the default; objects written under a base directory keyed by their
// opaque key) and an S3-compatible driver (AWS S3, MinIO, or any S3-API store).
// The backend is chosen from the environment by NewFromEnv; callers only ever
// see the Driver interface, so the rest of the app is unaffected by the choice.
package storage

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// PutResult mirrors the Node PutResult (doc 01 FR-5).
type PutResult struct {
	Key      string
	URL      string
	Size     int64
	Checksum string
}

// Driver is the storage port. Callers build opaque keys and never depend on the
// active backend.
type Driver interface {
	Kind() string
	Put(key string, data []byte) (PutResult, error)
	Get(key string) ([]byte, error) // returns (nil, nil) on a missing key
	Delete(key string) error
	Exists(key string) (bool, error)
	// PutStream writes from a reader without buffering the whole object in
	// memory (direct uploads stream request bodies through this). size is the
	// expected byte count when known, or -1 to read until EOF.
	PutStream(key string, r io.Reader, size int64) (PutResult, error)
	// Stat returns the stored object's size; ok=false on a missing key.
	Stat(key string) (size int64, ok bool, err error)
	// GetRange returns up to n leading bytes of the object (type sniffing after
	// a direct upload); (nil, nil) on a missing key.
	GetRange(key string, n int64) ([]byte, error)
	// Rename moves an object to a new key without the bytes passing through
	// the caller (os.Rename locally; server-side copy + delete on S3).
	Rename(from, to string) error
}

// PresignedPost is a browser-usable direct-upload grant: an HTTP POST to URL
// with Fields as multipart form values plus the file. Only the S3 driver can
// mint one; the local driver uploads through the API's streaming endpoint.
type PresignedPost struct {
	URL    string            `json:"url"`
	Fields map[string]string `json:"fields"`
}

// Presigner is the optional direct-to-bucket capability. Callers probe for it
// with a type assertion and fall back to streaming through the API.
type Presigner interface {
	// PresignPost mints a POST-policy grant for one key, capped to maxBytes and
	// valid for expiry. publicURL (when non-empty) replaces the endpoint origin
	// in the returned URL for deployments whose S3 endpoint is internal-only.
	PresignPost(key string, maxBytes int64, expiry time.Duration, publicURL string) (PresignedPost, error)
}

// Local is the local-filesystem driver.
type Local struct{ base string }

// NewLocal builds a local driver rooted at an absolute base path.
func NewLocal(basePath string) (*Local, error) {
	abs, err := filepath.Abs(basePath)
	if err != nil {
		return nil, err
	}
	return &Local{base: abs}, nil
}

// NewFromEnv selects the driver from the environment: STORAGE_DRIVER pins the
// choice ("s3" or "local"); when unset, S3 is auto-detected if the core S3_*
// credentials are present, otherwise local. The S3 constructor validates its
// config and connectivity, so a misconfigured S3 fails loudly at boot.
func NewFromEnv() (Driver, error) {
	driver := os.Getenv("STORAGE_DRIVER")
	cfg := s3ConfigFromEnv()
	s3Configured := cfg.Endpoint != "" && cfg.AccessKey != "" && cfg.SecretKey != ""
	if driver == "s3" || (driver == "" && s3Configured) {
		return NewS3(cfg)
	}
	path := os.Getenv("LOCAL_STORAGE_PATH")
	if path == "" {
		path = ".data/storage"
	}
	return NewLocal(path)
}

func (l *Local) Kind() string { return "local" }

// pathFor resolves a key to an absolute path, refusing anything that escapes the
// base or is itself absolute (mirrors the Node driver's guard).
func (l *Local) pathFor(key string) (string, error) {
	if filepath.IsAbs(key) {
		return "", errors.New("storage key must be relative: " + key)
	}
	clean := strings.TrimLeft(filepath.Clean(key), string(filepath.Separator))
	full := filepath.Join(l.base, clean)
	if full != l.base && !strings.HasPrefix(full, l.base+string(filepath.Separator)) {
		return "", errors.New("invalid storage key escapes base: " + key)
	}
	return full, nil
}

func (l *Local) Put(key string, data []byte) (PutResult, error) {
	full, err := l.pathFor(key)
	if err != nil {
		return PutResult{}, err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return PutResult{}, err
	}
	if err := os.WriteFile(full, data, 0o644); err != nil {
		return PutResult{}, err
	}
	sum := sha256.Sum256(data)
	return PutResult{Key: key, URL: "local:" + key, Size: int64(len(data)), Checksum: hex.EncodeToString(sum[:])}, nil
}

func (l *Local) Get(key string) ([]byte, error) {
	full, err := l.pathFor(key)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(full)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return b, err
}

func (l *Local) Delete(key string) error {
	full, err := l.pathFor(key)
	if err != nil {
		return err
	}
	err = os.Remove(full)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (l *Local) Exists(key string) (bool, error) {
	full, err := l.pathFor(key)
	if err != nil {
		return false, err
	}
	_, err = os.Stat(full)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// PutStream copies the reader to a temp file in the destination directory and
// renames it into place, so a client that aborts mid-upload never leaves a
// half-written object under the final key.
func (l *Local) PutStream(key string, r io.Reader, size int64) (PutResult, error) {
	full, err := l.pathFor(key)
	if err != nil {
		return PutResult{}, err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return PutResult{}, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(full), ".upload-*")
	if err != nil {
		return PutResult{}, err
	}
	h := sha256.New()
	n, err := io.Copy(tmp, io.TeeReader(r, h))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil && size >= 0 && n != size {
		err = errors.New("storage: short write: got fewer bytes than declared")
	}
	if err == nil {
		err = os.Rename(tmp.Name(), full)
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
		return PutResult{}, err
	}
	return PutResult{Key: key, URL: "local:" + key, Size: n, Checksum: hex.EncodeToString(h.Sum(nil))}, nil
}

func (l *Local) Stat(key string) (int64, bool, error) {
	full, err := l.pathFor(key)
	if err != nil {
		return 0, false, err
	}
	fi, err := os.Stat(full)
	if errors.Is(err, os.ErrNotExist) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return fi.Size(), true, nil
}

// Rename moves an object; the same-filesystem os.Rename is atomic and free.
func (l *Local) Rename(from, to string) error {
	src, err := l.pathFor(from)
	if err != nil {
		return err
	}
	dst, err := l.pathFor(to)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return os.Rename(src, dst)
}

// GetRange returns up to n leading bytes; (nil, nil) on a missing key.
func (l *Local) GetRange(key string, n int64) ([]byte, error) {
	full, err := l.pathFor(key)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(full)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	buf := make([]byte, n)
	read, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return buf[:read], nil
}
