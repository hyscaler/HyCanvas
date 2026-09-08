// Chunked direct uploads: the api-put leg split across many small requests.
//
// The single-PUT leg streams a whole file in one request, which is fine behind
// a plain reverse proxy but not behind a CDN. Cloudflare caps a request body at
// 100 MB on its Free, Pro and Business plans, so a 300 MB upload is rejected
// with a 413 that never reaches HyCanvas at all: no server setting can raise a
// limit enforced one hop earlier. Sending the file as a sequence of small
// appends keeps every individual request far below any such cap.
//
// Chunks land in a local spool file rather than going straight to the storage
// key. Object stores have no append, so this is what lets one code path serve
// both drivers; it also keeps a half-written object out of the storage
// namespace, which is what CompleteDirectUpload relies on to tell "the bytes
// never arrived" from "the bytes are here". When the spool reaches the declared
// size it is streamed into storage exactly as the single-PUT leg would, and the
// complete step that follows is unchanged.
//
// Offsets are strictly sequential: a chunk must start where the spool currently
// ends. A mismatch is reported with the offset the server actually holds, so a
// client that lost its connection resumes from there instead of restarting a
// 300 MB upload.
package uploads

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	"github.com/google/uuid"
)

const (
	// maxChunkBytes bounds ONE chunk request. It is deliberately far below the
	// smallest CDN body cap we know of (100 MB) so the default client chunk
	// size can grow later without anyone having to retune a proxy.
	maxChunkBytes int64 = 32 * 1024 * 1024 // 32 MiB
	// spoolDirName is created under the OS temp dir when UPLOAD_SPOOL_DIR is
	// unset. Partial uploads live here and nowhere else.
	spoolDirName = "hycanvas-uploads"
)

// ErrChunkOffset means the chunk did not start where the spool ends. The
// server's current offset travels with the error so the client can resume.
type ErrChunkOffset struct{ Expected int64 }

func (e *ErrChunkOffset) Error() string {
	return fmt.Sprintf("chunk offset mismatch: resume from byte %d", e.Expected)
}

// MaxChunkBytes is the per-chunk ceiling, exported so the HTTP layer can bound
// the request body with the same number.
func MaxChunkBytes() int64 { return maxChunkBytes }

// spoolLocks serializes appends per upload id. Two chunks racing on one spool
// would interleave writes; the offset check alone cannot prevent that, because
// both would read the same size before either wrote.
var spoolLocks sync.Map // id -> *sync.Mutex

func lockSpool(id string) func() {
	v, _ := spoolLocks.LoadOrStore(id, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	return func() {
		mu.Unlock()
		spoolLocks.Delete(id)
	}
}

// spoolDir is where partial uploads accumulate. UPLOAD_SPOOL_DIR lets a
// self-hoster point it at a disk with room for the largest upload they allow.
func spoolDir() string {
	if d := os.Getenv("UPLOAD_SPOOL_DIR"); d != "" {
		return d
	}
	return filepath.Join(os.TempDir(), spoolDirName)
}

// spoolPath is the spool file for one upload id.
//
// The id reaches here from the request PATH, so it is parsed as a UUID and the
// filename is rebuilt from the PARSED value rather than the caller's text. Any
// id that is not a UUID is refused outright, which is what makes traversal
// impossible: the name can only ever be 36 hex-and-dash characters. Being
// confident the ids we mint are UUIDs is not the same as enforcing it, and only
// the second one is a guarantee.
func spoolPath(id string) (string, error) {
	u, err := uuid.Parse(id)
	if err != nil {
		return "", ErrBadRequest
	}
	name := u.String()
	// Belt and braces: uuid.String() cannot produce a separator, so this can
	// only fire if that ever changed under us.
	if name != filepath.Base(name) {
		return "", ErrBadRequest
	}
	return filepath.Join(spoolDir(), name+".part"), nil
}

// spoolSize reports how many bytes of this upload have been received. A missing
// spool means none have.
func spoolSize(id string) (int64, error) {
	path, err := spoolPath(id)
	if err != nil {
		return 0, err
	}
	fi, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return fi.Size(), nil
}

// discardSpool removes a partial upload. Safe to call when none exists.
func discardSpool(id string) {
	path, err := spoolPath(id)
	if err != nil {
		return // not an id we could have written under
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		slog.Warn("direct-upload spool cleanup failed", "id", id, "err", err)
	}
}

// DirectUploadOffset reports how many bytes the server holds for this upload,
// so a client resuming after a dropped connection knows where to continue.
func (s *Service) DirectUploadOffset(ctx context.Context, id, token string) (int64, error) {
	row, err := s.authorizeDirectUpload(ctx, id, token)
	if err != nil {
		return 0, err
	}
	// Once the spool has been flushed into storage the object is the record of
	// what arrived, and the spool is gone; report the stored size so a client
	// that lost the completion response does not re-send the whole file.
	if size, ok, err := s.storage.Stat(row.StorageKey); err == nil && ok {
		return size, nil
	}
	return spoolSize(id)
}

// ReceiveDirectUploadChunk appends one chunk at offset and reports the new
// total. When the total reaches the declared size the spool is streamed into
// storage under the pending key, leaving the upload in exactly the state the
// single-PUT leg would, ready for CompleteDirectUpload.
func (s *Service) ReceiveDirectUploadChunk(ctx context.Context, id, token string, offset int64, body io.Reader) (int64, error) {
	row, err := s.authorizeDirectUpload(ctx, id, token)
	if err != nil {
		return 0, err
	}
	if offset < 0 || offset > row.DeclaredBytes {
		return 0, ErrBadRequest
	}
	unlock := lockSpool(id)
	defer unlock()

	path, err := spoolPath(id)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(spoolDir(), 0o700); err != nil {
		return 0, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return 0, err
	}
	have := fi.Size()
	if offset != have {
		// Not an error the user can fix, and not a lost upload: tell the client
		// where the server actually is and let it resume from there.
		return have, &ErrChunkOffset{Expected: have}
	}
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		return have, err
	}
	// Read one byte past what this upload may still contain: a body that
	// overruns the declared size (the number both quotas were gated on) is
	// rejected and the whole spool discarded, so an under-declared grant cannot
	// park a huge file on the spool disk.
	remaining := row.DeclaredBytes - have
	n, err := io.Copy(f, io.LimitReader(body, remaining+1))
	if err != nil {
		return have + n, err
	}
	if n > remaining {
		discardSpool(id)
		return 0, ErrBadRequest
	}
	total := have + n
	if total < row.DeclaredBytes {
		return total, nil // more chunks to come
	}
	if err := s.flushSpool(id, row, total); err != nil {
		return total, err
	}
	return total, nil
}

// flushSpool streams a completed spool file into storage under the pending key
// and removes it. The bytes never pass through memory in bulk: PutStream reads
// the file, and on S3 the driver's client parts large objects itself.
func (s *Service) flushSpool(id string, row directUploadRow, size int64) error {
	path, err := spoolPath(id)
	if err != nil {
		return err
	}
	rf, err := os.Open(path)
	if err != nil {
		return err
	}
	defer rf.Close()
	if _, err := s.storage.PutStream(row.StorageKey, rf, size); err != nil {
		// Keep the spool: the client can retry the completing chunk (offset
		// still reports the spool size) instead of re-sending the whole file.
		return err
	}
	discardSpool(id)
	return nil
}
