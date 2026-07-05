package uploads

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
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

// fakeAccess satisfies Access for import tests that never reach the DB.
type fakeAccess struct{}

func (fakeAccess) AssertMember(context.Context, string, string, string) error { return nil }

func testServerPort(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	_, port, err := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatalf("split test server addr: %v", err)
	}
	return port
}

// loopbackDial keeps the port of the pinned address but dials loopback, so
// requests for fake public hostnames reach the local httptest servers. It
// records each pinned address it sees.
func loopbackDial(dialed *[]string) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		*dialed = append(*dialed, addr)
		_, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		return (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort("127.0.0.1", port))
	}
}

// newImportService wires a Service for httptest-backed import tests: resolve
// serves the host->IP table and dial rewrites the pinned address to loopback.
func newImportService(hosts map[string]string) (*Service, *[]string) {
	svc := NewService(nil, nil, fakeAccess{})
	dialed := &[]string{}
	svc.resolve = func(host string) ([]net.IP, error) {
		ipStr, ok := hosts[host]
		if !ok {
			return nil, errors.New("unexpected host: " + host)
		}
		return []net.IP{net.ParseIP(ipStr)}, nil
	}
	svc.dial = loopbackDial(dialed)
	return svc, dialed
}

func TestImportFetch_DirectAndRedirect(t *testing.T) {
	ctx := context.Background()
	png := pngBytes()
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(png)
	}))
	defer target.Close()
	targetPort := testServerPort(t, target)

	hop := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "http://img.example.test:"+targetPort+"/pic.png")
		w.WriteHeader(http.StatusFound)
	}))
	defer hop.Close()
	hopPort := testServerPort(t, hop)

	svc, dialed := newImportService(map[string]string{
		"cdn.example.test": "198.51.100.7",
		"img.example.test": "203.0.113.9",
	})

	// Direct fetch (regression).
	buf, err := svc.fetchImage(ctx, "http://img.example.test:"+targetPort+"/pic.png")
	if err != nil || !bytes.Equal(buf, png) {
		t.Fatalf("direct fetch wrong: len=%d err=%v", len(buf), err)
	}

	// One redirect hop to another public-vetted host is followed.
	*dialed = nil
	buf, err = svc.fetchImage(ctx, "http://cdn.example.test:"+hopPort+"/start")
	if err != nil || !bytes.Equal(buf, png) {
		t.Fatalf("redirect fetch wrong: len=%d err=%v", len(buf), err)
	}
	// Both hops dialed their vetted IP (pinning engaged on every hop).
	want := []string{"198.51.100.7:" + hopPort, "203.0.113.9:" + targetPort}
	if len(*dialed) != 2 || (*dialed)[0] != want[0] || (*dialed)[1] != want[1] {
		t.Fatalf("pinned dials wrong: got %v want %v", *dialed, want)
	}
}

func TestImportFromURL_RedirectVetting(t *testing.T) {
	ctx := context.Background()
	png := pngBytes()
	var port string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/to-private":
			w.Header().Set("Location", "http://internal.example.test:"+port+"/x.png")
			w.WriteHeader(http.StatusFound)
		case r.URL.Path == "/to-file":
			w.Header().Set("Location", "file:///etc/passwd")
			w.WriteHeader(http.StatusFound)
		case r.URL.Path == "/no-location":
			w.WriteHeader(http.StatusFound)
		case strings.HasPrefix(r.URL.Path, "/loop/"):
			n, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/loop/"))
			w.Header().Set("Location", "/loop/"+strconv.Itoa(n+1))
			w.WriteHeader(http.StatusFound)
		case strings.HasPrefix(r.URL.Path, "/chain/"):
			n, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/chain/"))
			if n >= 3 {
				w.Header().Set("Content-Type", "image/png")
				_, _ = w.Write(png)
				return
			}
			w.Header().Set("Location", "/chain/"+strconv.Itoa(n+1))
			w.WriteHeader(http.StatusFound)
		case r.URL.Path == "/huge":
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set("Content-Length", strconv.FormatInt(maxImportBytes+1, 10))
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	port = testServerPort(t, srv)

	svc, _ := newImportService(map[string]string{
		"pub.example.test":      "198.51.100.10",
		"internal.example.test": "10.9.8.7",
	})
	base := "http://pub.example.test:" + port

	// Redirect target whose host resolves to a private IP is rejected.
	if _, err := svc.ImportFromURL(ctx, "u1", "w1", base+"/to-private", nil); err != ErrBadRequest {
		t.Fatalf("private redirect target should be BadRequest, got %v", err)
	}
	// Redirect to a non-http(s) scheme is rejected.
	if _, err := svc.ImportFromURL(ctx, "u1", "w1", base+"/to-file", nil); err != ErrBadRequest {
		t.Fatalf("file: redirect target should be BadRequest, got %v", err)
	}
	// A 3xx without a Location is rejected.
	if _, err := svc.ImportFromURL(ctx, "u1", "w1", base+"/no-location", nil); err != ErrBadRequest {
		t.Fatalf("redirect without Location should be BadRequest, got %v", err)
	}
	// More than maxImportRedirects hops is rejected.
	if _, err := svc.ImportFromURL(ctx, "u1", "w1", base+"/loop/0", nil); err != ErrBadRequest {
		t.Fatalf("redirect loop should be BadRequest, got %v", err)
	}
	// Exactly maxImportRedirects relative hops still succeeds.
	if buf, err := svc.fetchImage(ctx, base+"/chain/0"); err != nil || !bytes.Equal(buf, png) {
		t.Fatalf("3-hop chain wrong: len=%d err=%v", len(buf), err)
	}
	// Oversized declared content-length is rejected before the body is read.
	if _, err := svc.ImportFromURL(ctx, "u1", "w1", base+"/huge", nil); err != ErrImportSize {
		t.Fatalf("oversized content-length should be ErrImportSize, got %v", err)
	}
	// A host resolving straight to a private IP is rejected before any dial.
	if _, err := svc.ImportFromURL(ctx, "u1", "w1", "http://internal.example.test:"+port+"/x.png", nil); err != ErrBadRequest {
		t.Fatalf("private direct host should be BadRequest, got %v", err)
	}
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

	// Import end to end: public-vetted host, dial pinned then rewritten to the
	// local test server, one redirect hop, asset stored.
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			w.Header().Set("Location", "/logo-remote.png")
			w.WriteHeader(http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(pngBytes())
	}))
	defer remote.Close()
	rport := testServerPort(t, remote)
	svc.resolve = func(host string) ([]net.IP, error) { return []net.IP{net.ParseIP("203.0.113.20")}, nil }
	svc.dial = loopbackDial(&[]string{})
	imported, err := svc.ImportFromURL(ctx, owner.ID, ws.ID, "http://img.example.test:"+rport+"/start", nil)
	if err != nil {
		t.Fatalf("ImportFromURL: %v", err)
	}
	if imported.Kind != "image" || imported.MimeType == nil || *imported.MimeType != "image/png" {
		t.Fatalf("imported asset wrong: %+v", imported)
	}
	if got, mime, err := svc.Content(ctx, imported.ID); err != nil || mime != "image/png" || string(got) != string(pngBytes()) {
		t.Fatalf("imported content wrong: mime=%s len=%d err=%v", mime, len(got), err)
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
