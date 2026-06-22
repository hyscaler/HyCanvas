// Package storage ports the doc-01 storage abstraction: one driver interface
// with interchangeable backends. The local-filesystem driver is the zero-config
// default (objects written under a base directory keyed by their opaque key),
// matching the NestJS LocalStorageDriver byte-for-byte so the Go service reads
// and writes the SAME content-addressed blobs as the Node service (shared
// storage across the strangler split).
//
// S3 is deferred: when STORAGE_DRIVER=s3 (or S3_* is configured) the constructor
// fails loudly rather than silently dropping blobs, exactly like the Node side.
package storage

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
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

// NewFromEnv selects the driver from the environment, matching the Node
// resolveStorageDriver logic: STORAGE_DRIVER pins the choice; otherwise S3 is
// auto-detected when fully configured, else local. S3 is not yet implemented.
func NewFromEnv() (Driver, error) {
	driver := os.Getenv("STORAGE_DRIVER")
	s3Configured := os.Getenv("S3_ENDPOINT") != "" && os.Getenv("S3_ACCESS_KEY_ID") != "" && os.Getenv("S3_SECRET_ACCESS_KEY") != ""
	if driver == "s3" || (driver == "" && s3Configured) {
		return nil, errors.New("S3 storage driver is not yet implemented in the Go service; run with local storage (STORAGE_DRIVER=local or leave S3_* unset)")
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
