package uploads

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/storage"
)

// chunkedFixture builds a service plus one workspace, on a temp spool dir so a
// test never touches a real one.
func chunkedFixture(t *testing.T) (context.Context, *Service, string, string) {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping DB integration test")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stripSchema(dsn))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { conn.Close(ctx) })
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	store, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	t.Setenv("UPLOAD_SPOOL_DIR", t.TempDir())
	acct := accounts.NewService(tx, "test-jwt-secret")
	owner, ws, _, err := acct.Signup(ctx, "chunk-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	return ctx, NewService(tx, store, acct), owner.ID, ws.ID
}

// A file arriving as several small appends must end up byte-identical to the
// same file sent in one request. This is the whole point of the chunked leg:
// behind a CDN that caps one request body at 100 MB, many small requests are
// the only way a large file gets through at all.
func TestChunkedUploadAssemblesTheWholeFile_DB(t *testing.T) {
	ctx, svc, userID, wsID := chunkedFixture(t)

	// A PNG header followed by filler, so the completed object still sniffs as
	// a real type: complete() rejects anything it cannot identify.
	file := append(pngBytes(), bytes.Repeat([]byte("hycanvas"), 4096)...)
	grant, err := svc.InitDirectUpload(ctx, userID, wsID, "big.png", int64(len(file)), nil)
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	token := grantToken(t, grant.UploadURL)

	const chunk = 1024
	var sent int64
	for sent < int64(len(file)) {
		end := sent + chunk
		if end > int64(len(file)) {
			end = int64(len(file))
		}
		got, err := svc.ReceiveDirectUploadChunk(ctx, grant.ID, token, sent, bytes.NewReader(file[sent:end]))
		if err != nil {
			t.Fatalf("chunk at %d: %v", sent, err)
		}
		if got != end {
			t.Fatalf("offset after chunk = %d, want %d", got, end)
		}
		sent = end
	}

	asset, err := svc.CompleteDirectUpload(ctx, userID, grant.ID, "")
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if asset.ByteSize == nil || *asset.ByteSize != int64(len(file)) {
		t.Fatalf("stored size = %v, want %d", asset.ByteSize, len(file))
	}
	// The bytes themselves, not just the length.
	var key string
	if err := svc.db.QueryRow(ctx, `SELECT "storage_key" FROM assets WHERE id = $1`, asset.ID).Scan(&key); err != nil {
		t.Fatalf("storage key: %v", err)
	}
	stored, err := svc.storage.Get(key)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !bytes.Equal(stored, file) {
		t.Fatalf("reassembled object differs from the source (%d vs %d bytes)", len(stored), len(file))
	}
	// The spool must not survive a completed upload.
	if n, err := spoolSize(grant.ID); err != nil || n != 0 {
		t.Fatalf("spool left behind: %d bytes (err=%v)", n, err)
	}
}

// A client that lost its connection must be able to ask where the server is and
// carry on. Restarting a 300 MB upload because one chunk was lost is the
// failure this endpoint exists to prevent.
func TestChunkedUploadResumesFromTheServerOffset_DB(t *testing.T) {
	ctx, svc, userID, wsID := chunkedFixture(t)

	file := append(pngBytes(), bytes.Repeat([]byte("resume"), 2048)...)
	grant, err := svc.InitDirectUpload(ctx, userID, wsID, "resume.png", int64(len(file)), nil)
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	token := grantToken(t, grant.UploadURL)

	if _, err := svc.ReceiveDirectUploadChunk(ctx, grant.ID, token, 0, bytes.NewReader(file[:100])); err != nil {
		t.Fatalf("first chunk: %v", err)
	}
	// The client "reconnects" and asks where to continue.
	at, err := svc.DirectUploadOffset(ctx, grant.ID, token)
	if err != nil || at != 100 {
		t.Fatalf("offset = %d (err=%v), want 100", at, err)
	}
	// Re-sending from the wrong place is refused, and says where to go instead
	// rather than corrupting the file with a hole or an overlap.
	_, err = svc.ReceiveDirectUploadChunk(ctx, grant.ID, token, 50, bytes.NewReader(file[50:150]))
	var mismatch *ErrChunkOffset
	if !errors.As(err, &mismatch) {
		t.Fatalf("a wrong offset must be reported as ErrChunkOffset, got %v", err)
	}
	if mismatch.Expected != 100 {
		t.Fatalf("resume point = %d, want 100", mismatch.Expected)
	}
	// Resuming at the reported offset completes the file.
	if _, err := svc.ReceiveDirectUploadChunk(ctx, grant.ID, token, at, bytes.NewReader(file[at:])); err != nil {
		t.Fatalf("resumed chunk: %v", err)
	}
	if _, err := svc.CompleteDirectUpload(ctx, userID, grant.ID, ""); err != nil {
		t.Fatalf("complete after resume: %v", err)
	}
}

// The declared size is what both quotas were gated on at init, so chunks that
// together overrun it must be refused rather than quietly stored.
func TestChunkedUploadRefusesToExceedTheDeclaredSize_DB(t *testing.T) {
	ctx, svc, userID, wsID := chunkedFixture(t)

	file := pngBytes()
	grant, err := svc.InitDirectUpload(ctx, userID, wsID, "small.png", int64(len(file)), nil)
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	token := grantToken(t, grant.UploadURL)

	over := append(append([]byte{}, file...), bytes.Repeat([]byte("x"), 4096)...)
	if _, err := svc.ReceiveDirectUploadChunk(ctx, grant.ID, token, 0, bytes.NewReader(over)); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("overrunning the declared size should be ErrBadRequest, got %v", err)
	}
	// And it must not leave the oversized bytes on the spool disk.
	if n, err := spoolSize(grant.ID); err != nil || n != 0 {
		t.Fatalf("oversized spool retained: %d bytes (err=%v)", n, err)
	}
}

// The token is the only credential on this leg, so a wrong one must not be able
// to append to somebody else's upload.
func TestChunkedUploadRejectsABadToken_DB(t *testing.T) {
	ctx, svc, userID, wsID := chunkedFixture(t)

	file := pngBytes()
	grant, err := svc.InitDirectUpload(ctx, userID, wsID, "guard.png", int64(len(file)), nil)
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if _, err := svc.ReceiveDirectUploadChunk(ctx, grant.ID, "not-the-token", 0, bytes.NewReader(file)); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a bad token should be ErrForbidden, got %v", err)
	}
	if _, err := svc.DirectUploadOffset(ctx, grant.ID, "not-the-token"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("offset with a bad token should be ErrForbidden, got %v", err)
	}
}

// An upload abandoned midway leaves a spool file; the janitor has to reclaim it
// or the disk fills with partial uploads nobody will ever complete.
func TestSweepReclaimsAbandonedSpools_DB(t *testing.T) {
	ctx, svc, userID, wsID := chunkedFixture(t)

	file := append(pngBytes(), bytes.Repeat([]byte("abandoned"), 512)...)
	grant, err := svc.InitDirectUpload(ctx, userID, wsID, "gone.png", int64(len(file)), nil)
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	token := grantToken(t, grant.UploadURL)
	if _, err := svc.ReceiveDirectUploadChunk(ctx, grant.ID, token, 0, bytes.NewReader(file[:64])); err != nil {
		t.Fatalf("partial chunk: %v", err)
	}
	if n, _ := spoolSize(grant.ID); n != 64 {
		t.Fatalf("spool size = %d, want 64", n)
	}
	// Expire the grant, then sweep.
	if _, err := svc.db.Exec(ctx, `UPDATE "direct_uploads" SET "expires_at" = now() - interval '1 hour' WHERE id = $1`, grant.ID); err != nil {
		t.Fatalf("expire: %v", err)
	}
	if _, err := svc.SweepExpiredDirectUploads(ctx); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if n, err := spoolSize(grant.ID); err != nil || n != 0 {
		t.Fatalf("spool survived the sweep: %d bytes (err=%v)", n, err)
	}
}

// The same chunked flow against a real S3-compatible bucket. Object stores have
// no append, which is exactly why chunks spool locally and are streamed into
// storage once whole; this proves that assembly survives the round trip and
// that the promoted object is byte-identical to the source.
//
// Skipped unless S3_TEST_ENDPOINT is set.
func TestChunkedUploadToS3_Integration(t *testing.T) {
	endpoint := os.Getenv("S3_TEST_ENDPOINT")
	if endpoint == "" {
		t.Skip("S3_TEST_ENDPOINT not set; skipping live S3 chunked-upload test")
	}
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

	store, err := storage.NewS3(storage.S3Config{
		Endpoint:       endpoint,
		Region:         "us-east-1",
		Bucket:         os.Getenv("S3_TEST_BUCKET"),
		AccessKey:      os.Getenv("S3_TEST_ACCESS_KEY"),
		SecretKey:      os.Getenv("S3_TEST_SECRET_KEY"),
		ForcePathStyle: true,
	})
	if err != nil {
		t.Fatalf("NewS3: %v", err)
	}
	t.Setenv("UPLOAD_SPOOL_DIR", t.TempDir())
	acct := accounts.NewService(tx, "test-jwt-secret")
	owner, ws, _, err := acct.Signup(ctx, "chunk-s3+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	svc := NewService(tx, store, acct)

	// Big enough to cross several chunks and to make a silent truncation obvious.
	file := append(pngBytes(), bytes.Repeat([]byte("s3-chunked-payload"), 60000)...)
	grant, err := svc.InitDirectUpload(ctx, owner.ID, ws.ID, "big-s3.png", int64(len(file)), nil)
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if grant.Kind != "api-put" {
		t.Fatalf("expected the api-put leg without S3_DIRECT_UPLOADS, got %q", grant.Kind)
	}
	token := grantToken(t, grant.UploadURL)

	const chunk = 64 * 1024
	var sent int64
	for sent < int64(len(file)) {
		end := sent + chunk
		if end > int64(len(file)) {
			end = int64(len(file))
		}
		if _, err := svc.ReceiveDirectUploadChunk(ctx, grant.ID, token, sent, bytes.NewReader(file[sent:end])); err != nil {
			t.Fatalf("chunk at %d: %v", sent, err)
		}
		sent = end
	}

	asset, err := svc.CompleteDirectUpload(ctx, owner.ID, grant.ID, "")
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	var key string
	if err := svc.db.QueryRow(ctx, `SELECT "storage_key" FROM assets WHERE id = $1`, asset.ID).Scan(&key); err != nil {
		t.Fatalf("storage key: %v", err)
	}
	t.Cleanup(func() { _ = store.Delete(key) })

	stored, err := store.Get(key)
	if err != nil {
		t.Fatalf("read back from S3: %v", err)
	}
	if !bytes.Equal(stored, file) {
		t.Fatalf("object in the bucket differs from the source (%d vs %d bytes)", len(stored), len(file))
	}
	if asset.ByteSize == nil || *asset.ByteSize != int64(len(file)) {
		t.Fatalf("recorded size = %v, want %d", asset.ByteSize, len(file))
	}
	t.Logf("chunked %d bytes into %s in %d chunks", len(file), key, (len(file)+chunk-1)/chunk)
}

// The direct-to-bucket leg: with S3_DIRECT_UPLOADS on, init hands back a
// presigned POST and the browser sends the file straight to the bucket, never
// touching the API or the CDN in front of it. This drives that POST for real
// against the configured bucket, so a policy the store would reject cannot pass
// as working.
//
// Skipped unless S3_TEST_ENDPOINT is set.
func TestDirectToBucketUploadToS3_Integration(t *testing.T) {
	endpoint := os.Getenv("S3_TEST_ENDPOINT")
	if endpoint == "" {
		t.Skip("S3_TEST_ENDPOINT not set; skipping live S3 direct-to-bucket test")
	}
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

	store, err := storage.NewS3(storage.S3Config{
		Endpoint:       endpoint,
		Region:         "us-east-1",
		Bucket:         os.Getenv("S3_TEST_BUCKET"),
		AccessKey:      os.Getenv("S3_TEST_ACCESS_KEY"),
		SecretKey:      os.Getenv("S3_TEST_SECRET_KEY"),
		ForcePathStyle: true,
	})
	if err != nil {
		t.Fatalf("NewS3: %v", err)
	}
	// The opt-in is read by NewService, so it has to be set before construction.
	t.Setenv("S3_DIRECT_UPLOADS", "true")
	acct := accounts.NewService(tx, "test-jwt-secret")
	owner, ws, _, err := acct.Signup(ctx, "s3-direct+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	svc := NewService(tx, store, acct)

	file := append(pngBytes(), bytes.Repeat([]byte("direct-to-bucket"), 1024)...)
	grant, err := svc.InitDirectUpload(ctx, owner.ID, ws.ID, "direct.png", int64(len(file)), nil)
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if grant.Kind != "s3-post" {
		t.Fatalf("expected an s3-post grant with S3_DIRECT_UPLOADS=true, got %q", grant.Kind)
	}

	// Exactly what the browser does: signed fields first, the file part LAST.
	var form bytes.Buffer
	mw := multipart.NewWriter(&form)
	for k, v := range grant.Fields {
		if err := mw.WriteField(k, v); err != nil {
			t.Fatalf("form field %s: %v", k, err)
		}
	}
	fw, err := mw.CreateFormFile("file", "direct.png")
	if err != nil {
		t.Fatalf("file part: %v", err)
	}
	if _, err := fw.Write(file); err != nil {
		t.Fatalf("write file part: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close form: %v", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, grant.UploadURL, &form)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST to bucket: %v", err)
	}
	body, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
	res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		t.Fatalf("bucket rejected the presigned POST (%d): %s", res.StatusCode, string(body))
	}

	asset, err := svc.CompleteDirectUpload(ctx, owner.ID, grant.ID, "")
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	var key string
	if err := svc.db.QueryRow(ctx, `SELECT "storage_key" FROM assets WHERE id = $1`, asset.ID).Scan(&key); err != nil {
		t.Fatalf("storage key: %v", err)
	}
	t.Cleanup(func() { _ = store.Delete(key) })
	stored, err := store.Get(key)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !bytes.Equal(stored, file) {
		t.Fatalf("object differs from the source (%d vs %d bytes)", len(stored), len(file))
	}
	t.Logf("browser->bucket POST accepted; %d bytes promoted to %s", len(file), key)
}
