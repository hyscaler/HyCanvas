package uploads

import (
	"context"
	"encoding/base64"
	"net"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/storage"
)

func stripSchema(dsn string) string {
	for _, sep := range []string{"?schema=", "&schema="} {
		if i := strings.Index(dsn, sep); i >= 0 {
			return dsn[:i]
		}
	}
	return dsn
}

// pngBytes is a minimal valid-by-magic-bytes PNG payload.
func pngBytes() []byte {
	return append([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}, []byte("dummy-png-body")...)
}

func TestUploads_DB(t *testing.T) {
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
	owner, ws, _, err := acct.Signup(ctx, "up-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	outsider, _, _, err := acct.Signup(ctx, "up-out+"+uuid.NewString()+"@example.com", "a-strong-password", "Outsider")
	if err != nil {
		t.Fatalf("signup outsider: %v", err)
	}

	svc := NewService(tx, store, acct)
	png := base64.StdEncoding.EncodeToString(pngBytes())

	// Outsider cannot upload.
	if _, err := svc.Upload(ctx, outsider.ID, ws.ID, "x.png", png, nil, ""); err != ErrForbidden {
		t.Fatalf("outsider upload should be Forbidden, got %v", err)
	}
	// Unsupported content is rejected by magic-byte sniff (not extension).
	bad := base64.StdEncoding.EncodeToString([]byte("this is not a known file"))
	if _, err := svc.Upload(ctx, owner.ID, ws.ID, "evil.png", bad, nil, ""); err != ErrBadRequest {
		t.Fatalf("unsupported upload should be BadRequest, got %v", err)
	}

	// Upload a PNG.
	asset, err := svc.Upload(ctx, owner.ID, ws.ID, "logo.png", png, nil, "")
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if asset.Kind != "image" || asset.MimeType == nil || *asset.MimeType != "image/png" {
		t.Fatalf("uploaded asset wrong: %+v", asset)
	}
	if !strings.HasSuffix(asset.URL, "/api/v1/assets/"+asset.ID+"/content") {
		t.Fatalf("content url wrong: %s", asset.URL)
	}

	// Content delivery returns the stored bytes + mime.
	bytes, mime, err := svc.Content(ctx, asset.ID)
	if err != nil || mime != "image/png" || len(bytes) == 0 {
		t.Fatalf("content wrong: mime=%s len=%d err=%v", mime, len(bytes), err)
	}

	// Usage reflects the uploaded size.
	usage, err := svc.UsageView(ctx, owner.ID, ws.ID)
	if err != nil || usage.UsedBytes != int64(len(pngBytes())) {
		t.Fatalf("usage wrong: %+v err=%v", usage, err)
	}

	// Folders: create, list, move the asset into it, list filtered by folder.
	folder, err := svc.CreateFolder(ctx, owner.ID, ws.ID, "Logos", nil)
	if err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	sub, err := svc.CreateFolder(ctx, owner.ID, ws.ID, "Sub", &folder.ID)
	if err != nil {
		t.Fatalf("CreateFolder sub: %v", err)
	}
	moved, err := svc.UpdateAsset(ctx, owner.ID, asset.ID, nil, &sub.ID, true, &[]string{"brand", "Brand", "  "})
	if err != nil {
		t.Fatalf("UpdateAsset: %v", err)
	}
	if moved.FolderID == nil || *moved.FolderID != sub.ID {
		t.Fatalf("asset not moved: %+v", moved.FolderID)
	}
	// Tags normalized (trim + de-dupe case-insensitive) -> ["brand"].
	if len(moved.Tags) != 1 || moved.Tags[0] != "brand" {
		t.Fatalf("tags not normalized: %v", moved.Tags)
	}
	// List filtered to the sub folder finds it; filtered to root does not.
	inSub, _ := svc.List(ctx, owner.ID, ws.ID, &sub.ID, true, "", "")
	if len(inSub) != 1 || inSub[0].ID != asset.ID {
		t.Fatalf("folder filter wrong: %+v", inSub)
	}
	atRoot, _ := svc.List(ctx, owner.ID, ws.ID, nil, true, "", "")
	if len(atRoot) != 0 {
		t.Fatalf("root filter should be empty: %+v", atRoot)
	}
	// Text + tag filters.
	byText, _ := svc.List(ctx, owner.ID, ws.ID, nil, false, "", "logo")
	if len(byText) != 1 {
		t.Fatalf("text filter wrong: %+v", byText)
	}
	byTag, _ := svc.List(ctx, owner.ID, ws.ID, nil, false, "brand", "")
	if len(byTag) != 1 {
		t.Fatalf("tag filter wrong: %+v", byTag)
	}

	// Delete the parent folder: subtree removed, asset reparented to root.
	if err := svc.DeleteFolder(ctx, owner.ID, folder.ID); err != nil {
		t.Fatalf("DeleteFolder: %v", err)
	}
	folders, _ := svc.ListFolders(ctx, owner.ID, ws.ID)
	if len(folders) != 0 {
		t.Fatalf("folders should be gone: %+v", folders)
	}
	reparented, _, err := svc.Content(ctx, asset.ID) // still exists
	if err != nil || len(reparented) == 0 {
		t.Fatalf("asset should survive folder delete: err=%v", err)
	}
	rootAfter, _ := svc.List(ctx, owner.ID, ws.ID, nil, true, "", "")
	if len(rootAfter) != 1 {
		t.Fatalf("asset should be reparented to root: %+v", rootAfter)
	}

	// SSRF: a private literal URL and a host that resolves to a private IP are
	// both rejected (the DNS-rebind re-check).
	if _, err := svc.ImportFromURL(ctx, owner.ID, ws.ID, "http://10.0.0.1/x.png", nil); err != ErrBadRequest {
		t.Fatalf("private URL import should be BadRequest, got %v", err)
	}
	svc.resolve = func(host string) ([]net.IP, error) { return []net.IP{net.ParseIP("10.1.2.3")}, nil }
	if _, err := svc.ImportFromURL(ctx, owner.ID, ws.ID, "https://example.com/x.png", nil); err != ErrBadRequest {
		t.Fatalf("DNS-rebind to private IP should be BadRequest, got %v", err)
	}

	// Quota: a tiny cap rejects the next upload.
	t.Setenv("ASSET_QUOTA_BYTES", "1")
	if _, err := svc.Upload(ctx, owner.ID, ws.ID, "big.png", png, nil, ""); err != ErrQuota {
		t.Fatalf("over-quota upload should be ErrQuota, got %v", err)
	}
	t.Setenv("ASSET_QUOTA_BYTES", "")

	// Remove deletes the blob + row.
	if err := svc.Remove(ctx, owner.ID, asset.ID); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, _, err := svc.Content(ctx, asset.ID); err != ErrNotFound {
		t.Fatalf("removed asset should be NotFound, got %v", err)
	}
}
