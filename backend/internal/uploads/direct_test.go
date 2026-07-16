package uploads

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/storage"
)

// grantToken extracts the one-time token from an api-put grant URL.
func grantToken(t *testing.T, uploadURL string) string {
	t.Helper()
	i := strings.Index(uploadURL, "token=")
	if i < 0 {
		t.Fatalf("no token in grant url: %s", uploadURL)
	}
	return uploadURL[i+len("token="):]
}

func TestDirectUploads_DB(t *testing.T) {
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

	store, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	acct := accounts.NewService(tx, "test-jwt-secret")
	owner, ws, _, err := acct.Signup(ctx, "dup-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	outsider, _, _, err := acct.Signup(ctx, "dup-out+"+uuid.NewString()+"@example.com", "a-strong-password", "Outsider")
	if err != nil {
		t.Fatalf("signup outsider: %v", err)
	}
	svc := NewService(tx, store, acct)
	png := pngBytes()

	// Outsider cannot init; nonsense sizes are rejected.
	if _, err := svc.InitDirectUpload(ctx, outsider.ID, ws.ID, "a.png", 10, nil); err != ErrForbidden {
		t.Fatalf("outsider init should be Forbidden, got %v", err)
	}
	if _, err := svc.InitDirectUpload(ctx, owner.ID, ws.ID, "a.png", 0, nil); err != ErrBadRequest {
		t.Fatalf("zero-size init should be BadRequest, got %v", err)
	}

	// Happy path: init -> receive (token-authenticated) -> complete.
	grant, err := svc.InitDirectUpload(ctx, owner.ID, ws.ID, "logo.png", int64(len(png)), nil)
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if grant.Kind != "api-put" || grant.UploadURL == "" {
		t.Fatalf("local driver should grant api-put, got %+v", grant)
	}
	token := grantToken(t, grant.UploadURL)
	if err := svc.ReceiveDirectUpload(ctx, grant.ID, "wrong-token", bytes.NewReader(png)); err != ErrForbidden {
		t.Fatalf("bad token should be Forbidden, got %v", err)
	}
	if err := svc.ReceiveDirectUpload(ctx, grant.ID, token, bytes.NewReader(png)); err != nil {
		t.Fatalf("receive: %v", err)
	}
	if _, err := svc.CompleteDirectUpload(ctx, outsider.ID, grant.ID, ""); err != ErrForbidden {
		t.Fatalf("someone else's complete should be Forbidden, got %v", err)
	}
	asset, err := svc.CompleteDirectUpload(ctx, owner.ID, grant.ID, "")
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if asset.Kind != "image" || asset.MimeType == nil || *asset.MimeType != "image/png" || asset.ByteSize == nil || *asset.ByteSize != int64(len(png)) {
		t.Fatalf("asset wrong: %+v", asset)
	}
	// The object moved out of pending/ and the handshake row is gone.
	if ok, _ := store.Exists("pending/" + ws.ID + "/" + grant.ID); ok {
		t.Fatal("pending object should be moved away")
	}
	if data, _, err := svc.Content(ctx, asset.ID); err != nil || !bytes.Equal(data, png) {
		t.Fatalf("stored content wrong: len=%d err=%v", len(data), err)
	}
	if _, err := svc.getDirectUpload(ctx, grant.ID); err != ErrNotFound {
		t.Fatalf("handshake row should be deleted, got %v", err)
	}
	// Completing twice cannot double-create.
	if _, err := svc.CompleteDirectUpload(ctx, owner.ID, grant.ID, ""); err != ErrNotFound {
		t.Fatalf("second complete should be NotFound, got %v", err)
	}

	// Complete before any bytes arrived -> conflict, retryable.
	g2, err := svc.InitDirectUpload(ctx, owner.ID, ws.ID, "later.png", 10, nil)
	if err != nil {
		t.Fatalf("init g2: %v", err)
	}
	if _, err := svc.CompleteDirectUpload(ctx, owner.ID, g2.ID, ""); err != ErrUploadIncomplete {
		t.Fatalf("complete without bytes should be UploadIncomplete, got %v", err)
	}

	// Unsniffable content is rejected at complete, and the pending object plus
	// the row are cleaned up.
	g3, err := svc.InitDirectUpload(ctx, owner.ID, ws.ID, "evil.png", 64, nil)
	if err != nil {
		t.Fatalf("init g3: %v", err)
	}
	if err := svc.ReceiveDirectUpload(ctx, g3.ID, grantToken(t, g3.UploadURL), strings.NewReader("not a known file type at all")); err != nil {
		t.Fatalf("receive g3: %v", err)
	}
	if _, err := svc.CompleteDirectUpload(ctx, owner.ID, g3.ID, ""); err != ErrBadRequest {
		t.Fatalf("garbage complete should be BadRequest, got %v", err)
	}
	if ok, _ := store.Exists("pending/" + ws.ID + "/" + g3.ID); ok {
		t.Fatal("rejected object should be deleted")
	}

	// A body larger than the declared size is rejected AT RECEIVE (the quota
	// gated the declared number, so more bytes must not land), and the partial
	// object is removed.
	g4, err := svc.InitDirectUpload(ctx, owner.ID, ws.ID, "big.png", 4, nil)
	if err != nil {
		t.Fatalf("init g4: %v", err)
	}
	if err := svc.ReceiveDirectUpload(ctx, g4.ID, grantToken(t, g4.UploadURL), bytes.NewReader(png)); err != ErrBadRequest {
		t.Fatalf("oversized receive should be BadRequest, got %v", err)
	}
	if ok, _ := store.Exists("pending/" + ws.ID + "/" + g4.ID); ok {
		t.Fatal("oversized object should be deleted at receive")
	}
	// Belt: an oversized object that lands anyway (the s3-post leg, where the
	// bucket enforces the policy upstream of us) is still rejected at complete.
	if _, err := store.Put("pending/"+ws.ID+"/"+g4.ID, png); err != nil {
		t.Fatalf("seed oversized object: %v", err)
	}
	if _, err := svc.CompleteDirectUpload(ctx, owner.ID, g4.ID, ""); err != ErrBadRequest {
		t.Fatalf("oversized complete should be BadRequest, got %v", err)
	}
	if ok, _ := store.Exists("pending/" + ws.ID + "/" + g4.ID); ok {
		t.Fatal("oversized object should be deleted at complete")
	}

	// Workspace quota gates init on the declared size.
	t.Setenv("ASSET_QUOTA_BYTES", "10")
	if _, err := svc.InitDirectUpload(ctx, owner.ID, ws.ID, "big.png", 1000, nil); err != ErrQuota {
		t.Fatalf("over-quota init should be ErrQuota, got %v", err)
	}
	t.Setenv("ASSET_QUOTA_BYTES", "")

	// Janitor: an expired grant's object and row are swept.
	g5, err := svc.InitDirectUpload(ctx, owner.ID, ws.ID, "stale.png", int64(len(png)), nil)
	if err != nil {
		t.Fatalf("init g5: %v", err)
	}
	if err := svc.ReceiveDirectUpload(ctx, g5.ID, grantToken(t, g5.UploadURL), bytes.NewReader(png)); err != nil {
		t.Fatalf("receive g5: %v", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE "direct_uploads" SET "expires_at" = $1 WHERE id = $2`, time.Now().UTC().Add(-time.Hour), g5.ID); err != nil {
		t.Fatalf("age row: %v", err)
	}
	n, err := svc.SweepExpiredDirectUploads(ctx)
	if err != nil || n != 1 {
		t.Fatalf("sweep: n=%d err=%v", n, err)
	}
	if ok, _ := store.Exists("pending/" + ws.ID + "/" + g5.ID); ok {
		t.Fatal("swept object should be deleted")
	}
	if _, err := svc.getDirectUpload(ctx, g5.ID); err != ErrNotFound {
		t.Fatalf("swept row should be gone, got %v", err)
	}
	// An expired grant also refuses late receive/complete.
	g6, err := svc.InitDirectUpload(ctx, owner.ID, ws.ID, "late.png", int64(len(png)), nil)
	if err != nil {
		t.Fatalf("init g6: %v", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE "direct_uploads" SET "expires_at" = $1 WHERE id = $2`, time.Now().UTC().Add(-time.Minute), g6.ID); err != nil {
		t.Fatalf("age row: %v", err)
	}
	if err := svc.ReceiveDirectUpload(ctx, g6.ID, grantToken(t, g6.UploadURL), bytes.NewReader(png)); err != ErrNotFound {
		t.Fatalf("expired receive should be NotFound, got %v", err)
	}
	if _, err := svc.CompleteDirectUpload(ctx, owner.ID, g6.ID, ""); err != ErrNotFound {
		t.Fatalf("expired complete should be NotFound, got %v", err)
	}
}
