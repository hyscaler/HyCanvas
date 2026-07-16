// Direct (presigned) uploads: file bytes go straight to object storage instead
// of through a base64 JSON body, so uploads cost no base64 overhead, never
// buffer whole files in API memory, and (on S3/MinIO) bypass the API and its
// reverse proxy entirely. Three steps:
//
//  1. Init: authenticated + quota-gated; records a pending direct_uploads row
//     and returns either a presigned S3 POST (direct to bucket) or a one-time
//     token for the API's streaming PUT (local driver, or S3 without a
//     browser-reachable endpoint).
//  2. The client uploads the raw bytes.
//  3. Complete: the server stats the stored object (real size, not the
//     client's claim), sniffs its leading bytes (magic numbers, never the
//     extension), re-checks both quotas, and only then records the asset row.
//
// Rows that never complete expire; SweepExpired removes them and their
// objects, so an abandoned upload cannot leak storage or count toward quota.

package uploads

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/media"
	"hycanvas/backend/internal/storage"
)

const (
	// directUploadTTL bounds the init->complete window; a grant that old is
	// abandoned and its object (if any) is garbage.
	directUploadTTL = 2 * time.Hour
	// maxDirectUploadBytes is the absolute per-file ceiling, independent of
	// quota (which caps the total, not one file).
	maxDirectUploadBytes int64 = 2 * 1024 * 1024 * 1024 // 2 GiB
	// sniffBytes is how much of the stored object complete() reads back to
	// type-sniff; every magic number the sniffer knows sits well inside it.
	sniffBytes int64 = 8 * 1024
)

// ErrUploadIncomplete distinguishes "no object arrived yet" from a bad request.
var ErrUploadIncomplete = errors.New("no uploaded file found for this upload")

// MaxDirectUploadBytes is the absolute per-file ceiling, exported so the HTTP
// layer can bound the streaming body reader with the same number.
func MaxDirectUploadBytes() int64 { return maxDirectUploadBytes }

// DirectUploadGrant is Init's answer: where and how to send the bytes.
type DirectUploadGrant struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"` // "s3-post" (direct to bucket) or "api-put" (streaming PUT to UploadURL)
	UploadURL string `json:"uploadUrl,omitempty"`
	// Fields are the multipart form fields for an s3-post grant; the file field
	// must be appended last.
	Fields    map[string]string `json:"fields,omitempty"`
	MaxBytes  int64             `json:"maxBytes"`
	ExpiresAt string            `json:"expiresAt"`
}

type directUploadRow struct {
	ID            string
	WorkspaceID   string
	UserID        string
	Filename      *string
	FolderID      *string
	DeclaredBytes int64
	StorageKey    string
	TokenHash     string
	ExpiresAt     time.Time
}

// s3PublicURL is the browser-facing origin for the S3 endpoint, for
// deployments where S3_ENDPOINT is internal-only (compose networks, proxied
// MinIO). Empty means the endpoint itself is browser-reachable.
func (s *Service) s3PublicURL() string { return s.s3PublicBase }

// InitDirectUpload starts the handshake: quota-gates the declared size,
// records the pending row, and hands back the upload grant.
func (s *Service) InitDirectUpload(ctx context.Context, userID, workspaceID, filename string, declaredBytes int64, folderID *string) (DirectUploadGrant, error) {
	if err := s.access.AssertMember(ctx, userID, workspaceID, "member"); err != nil {
		return DirectUploadGrant{}, ErrForbidden
	}
	if declaredBytes <= 0 || declaredBytes > maxDirectUploadBytes {
		return DirectUploadGrant{}, ErrBadRequest
	}
	// Quota gates on the declared size now; complete() re-checks with the
	// actual stored size, so lying here only wastes the uploader's bandwidth.
	used, err := s.usedBytes(ctx, workspaceID)
	if err != nil {
		return DirectUploadGrant{}, err
	}
	if !media.CanUpload(used, quotaBytes(), declaredBytes) {
		return DirectUploadGrant{}, ErrQuota
	}
	if uq := userQuotaBytes(); uq > 0 && userID != "" {
		userUsed, err := s.usedByUser(ctx, userID)
		if err != nil {
			return DirectUploadGrant{}, err
		}
		if !media.CanUpload(userUsed, uq, declaredBytes) {
			return DirectUploadGrant{}, ErrUserQuota
		}
	}

	id := uuid.NewString()
	// The object lands under pending/ until complete() validates it; the final
	// assets/ key is minted at complete time (its extension needs the sniffed
	// type). The janitor only ever deletes under pending/.
	key := "pending/" + workspaceID + "/" + id
	expires := time.Now().UTC().Add(directUploadTTL)
	grant := DirectUploadGrant{ID: id, MaxBytes: declaredBytes, ExpiresAt: expires.Format(isoFmt)}

	tokenHash := ""
	if p, ok := s.storage.(storage.Presigner); ok && s.directToBucket {
		post, err := p.PresignPost(key, declaredBytes, directUploadTTL, s.s3PublicURL())
		if err != nil {
			return DirectUploadGrant{}, err
		}
		grant.Kind = "s3-post"
		grant.UploadURL = post.URL
		grant.Fields = post.Fields
	} else {
		// Streaming PUT through the API, authenticated by a one-time token (no
		// cookie needed, mirroring presigned semantics). Only its hash persists.
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			return DirectUploadGrant{}, err
		}
		token := hex.EncodeToString(raw)
		sum := sha256.Sum256([]byte(token))
		tokenHash = hex.EncodeToString(sum[:])
		grant.Kind = "api-put"
		grant.UploadURL = s.publicURL + "/api/v1/uploads/direct/" + id + "?token=" + token
	}

	var fn *string
	if filename != "" {
		fn = &filename
	}
	_, err = s.db.Exec(ctx, `INSERT INTO "direct_uploads"
		(id,"workspace_id","user_id",filename,"folder_id","declared_bytes","storage_key","token_hash","expires_at")
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		id, workspaceID, userID, fn, folderID, declaredBytes, key, tokenHash, expires)
	if err != nil {
		return DirectUploadGrant{}, err
	}
	return grant, nil
}

func (s *Service) getDirectUpload(ctx context.Context, id string) (directUploadRow, error) {
	var r directUploadRow
	err := s.db.QueryRow(ctx, `SELECT id,"workspace_id","user_id",filename,"folder_id","declared_bytes","storage_key","token_hash","expires_at"
		FROM "direct_uploads" WHERE id = $1`, id).
		Scan(&r.ID, &r.WorkspaceID, &r.UserID, &r.Filename, &r.FolderID, &r.DeclaredBytes, &r.StorageKey, &r.TokenHash, &r.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return directUploadRow{}, ErrNotFound
	}
	return r, err
}

// ReceiveDirectUpload is the api-put path: stream the raw request body into
// storage under the pending key. Token-authenticated (constant-time compare
// against the stored hash), so it works without a session cookie, like a
// presigned URL. The size cap is enforced by the bounded reader the handler
// wraps around the body AND re-checked at complete.
func (s *Service) ReceiveDirectUpload(ctx context.Context, id, token string, body io.Reader) error {
	row, err := s.getDirectUpload(ctx, id)
	if err != nil {
		return err
	}
	if time.Now().UTC().After(row.ExpiresAt) {
		return ErrNotFound
	}
	if row.TokenHash == "" {
		return ErrForbidden // an s3-post grant never uploads through the API
	}
	sum := sha256.Sum256([]byte(token))
	if subtle.ConstantTimeCompare([]byte(hex.EncodeToString(sum[:])), []byte(row.TokenHash)) != 1 {
		return ErrForbidden
	}
	// Stream to storage: size -1 (read to EOF) because clients may not send
	// Content-Length. The read is bounded to the grant's DECLARED size (the
	// number the quota gated) plus one sentinel byte: a body that exceeds it is
	// rejected and its object removed, so a small grant can never park a huge
	// object in pending/ until the janitor runs. This mirrors the S3 leg, where
	// the POST policy's content-length-range enforces the same cap.
	res, err := s.storage.PutStream(row.StorageKey, io.LimitReader(body, row.DeclaredBytes+1), -1)
	if err != nil {
		return err
	}
	if res.Size > row.DeclaredBytes {
		_ = s.storage.Delete(row.StorageKey)
		return ErrBadRequest
	}
	return nil
}

// CompleteDirectUpload validates the stored object and promotes it to a real
// asset: true size from storage, magic-byte sniff of its head, quota re-check,
// then the assets row. The pending object moves under the canonical assets/
// key layout via a storage-level copy-and-delete.
func (s *Service) CompleteDirectUpload(ctx context.Context, userID, id, thumbnail string) (UploadedAsset, error) {
	row, err := s.getDirectUpload(ctx, id)
	if err != nil {
		return UploadedAsset{}, err
	}
	// Only the initiating member may complete; membership may have been revoked
	// mid-upload, so re-assert rather than trusting the row.
	if row.UserID != userID {
		return UploadedAsset{}, ErrForbidden
	}
	if err := s.access.AssertMember(ctx, userID, row.WorkspaceID, "member"); err != nil {
		return UploadedAsset{}, ErrForbidden
	}
	if time.Now().UTC().After(row.ExpiresAt) {
		return UploadedAsset{}, ErrNotFound
	}

	size, ok, err := s.storage.Stat(row.StorageKey)
	if err != nil {
		return UploadedAsset{}, err
	}
	if !ok || size <= 0 {
		return UploadedAsset{}, ErrUploadIncomplete
	}
	reject := func(cause error) (UploadedAsset, error) {
		// Invalid object: remove it and the row so nothing lingers half-done.
		_ = s.storage.Delete(row.StorageKey)
		_, _ = s.db.Exec(ctx, `DELETE FROM "direct_uploads" WHERE id = $1`, row.ID)
		return UploadedAsset{}, cause
	}
	// The real size is what quota accounting will carry; a client that
	// under-declared is caught here (S3 POST policies also cap it upstream).
	if size > row.DeclaredBytes || size > maxDirectUploadBytes {
		return reject(ErrBadRequest)
	}
	head, err := s.storage.GetRange(row.StorageKey, sniffBytes)
	if err != nil {
		return UploadedAsset{}, err
	}
	sniff := media.AcceptUpload(head)
	if !sniff.OK {
		return reject(ErrBadRequest)
	}
	used, err := s.usedBytes(ctx, row.WorkspaceID)
	if err != nil {
		return UploadedAsset{}, err
	}
	if !media.CanUpload(used, quotaBytes(), size) {
		return reject(ErrQuota)
	}
	if uq := userQuotaBytes(); uq > 0 {
		userUsed, err := s.usedByUser(ctx, row.UserID)
		if err != nil {
			return UploadedAsset{}, err
		}
		if !media.CanUpload(userUsed, uq, size) {
			return reject(ErrUserQuota)
		}
	}
	fid, err := s.resolveFolder(ctx, row.WorkspaceID, row.FolderID)
	if err != nil {
		return UploadedAsset{}, err
	}

	// Move pending/<ws>/<id> to the canonical assets key. Rename is native on
	// both drivers (os.Rename locally, server-side CopyObject on S3), so no
	// object bytes ever pass back through the API.
	ext := "bin"
	if parts := strings.SplitN(sniff.Mime, "/", 2); len(parts) == 2 {
		ext = strings.SplitN(parts[1], "+", 2)[0]
	}
	finalKey := "assets/" + row.WorkspaceID + "/" + row.ID + "." + ext
	if err := s.storage.Rename(row.StorageKey, finalKey); err != nil {
		return UploadedAsset{}, err
	}

	var thumb *string
	if thumbnail != "" {
		thumb = &thumbnail
	}
	asset, err := s.createAsset(ctx, createAssetInput{
		workspaceID: row.WorkspaceID, kind: kindMap[sniff.Kind], storageKey: finalKey, filename: row.Filename,
		mimeType: sniff.Mime, byteSize: size, thumbnail: thumb, folderID: fid,
		uploadedByID: &row.UserID, mediaKind: string(sniff.Kind),
	})
	if err != nil {
		// The object is already at its final key; better to keep it and fail the
		// request (retryable) than delete user bytes on a transient DB error.
		return UploadedAsset{}, err
	}
	_, _ = s.db.Exec(ctx, `DELETE FROM "direct_uploads" WHERE id = $1`, row.ID)
	return s.toUploaded(asset), nil
}

// SweepExpiredDirectUploads deletes expired pending rows and their objects.
// Run periodically; each pass is bounded and idempotent.
func (s *Service) SweepExpiredDirectUploads(ctx context.Context) (int, error) {
	rows, err := s.db.Query(ctx, `SELECT id,"storage_key" FROM "direct_uploads" WHERE "expires_at" < now() LIMIT 200`)
	if err != nil {
		return 0, err
	}
	type stale struct{ id, key string }
	var expired []stale
	for rows.Next() {
		var e stale
		if err := rows.Scan(&e.id, &e.key); err != nil {
			rows.Close()
			return 0, err
		}
		expired = append(expired, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	n := 0
	for _, e := range expired {
		// Storage first: if the delete fails the row stays and the next sweep
		// retries, so an object can never outlive its row unnoticed.
		if err := s.storage.Delete(e.key); err != nil {
			slog.Warn("direct-upload sweep: object delete failed", "key", e.key, "err", err)
			continue
		}
		if _, err := s.db.Exec(ctx, `DELETE FROM "direct_uploads" WHERE id = $1`, e.id); err != nil {
			slog.Warn("direct-upload sweep: row delete failed", "id", e.id, "err", err)
			continue
		}
		n++
	}
	return n, nil
}

// StartDirectUploadJanitor sweeps on an interval until ctx is done.
func (s *Service) StartDirectUploadJanitor(ctx context.Context, every time.Duration) {
	go func() {
		ticker := time.NewTicker(every)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if n, err := s.SweepExpiredDirectUploads(ctx); err != nil {
					slog.Warn("direct-upload sweep failed", "err", err)
				} else if n > 0 {
					slog.Info("direct-upload sweep", "removed", n)
				}
			}
		}
	}()
}
