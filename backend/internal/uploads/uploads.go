// Package uploads ports the NestJS uploads module (doc 12): accept a base64
// file, validate it by magic bytes (internal/media, never by extension), store
// it via the storage driver, and record an Asset row. Folders, tags, rename,
// move, filtered search, per-workspace quota, and server-side URL import (with
// an SSRF + DNS-rebinding guard) are all membership-gated.
//
// Deferred vs the Node original: multipart/resumable presigned uploads, the
// ingest pipeline (thumbnails/EXIF/AI tags), asset versions, and signed delivery
// URLs.
package uploads

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"hycanvas/backend/internal/media"
	"hycanvas/backend/internal/storage"
)

const (
	defaultQuotaBytes  int64 = 2 * 1024 * 1024 * 1024 // 2 GiB
	maxImportBytes     int64 = 25 * 1024 * 1024
	maxImportRedirects       = 3
)

// Errors map to RFC 7807 statuses at the HTTP layer.
var (
	ErrForbidden  = errors.New("forbidden")
	ErrNotFound   = errors.New("not found")
	ErrBadRequest = errors.New("bad request")
	ErrQuota      = errors.New("storage quota exceeded")
	ErrUserQuota  = errors.New("your account storage limit is reached")
	ErrImportSize = errors.New("imported file too large")
)

// Access enforces workspace membership (satisfied by *accounts.Service).
type Access interface {
	AssertMember(ctx context.Context, userID, workspaceID, minRole string) error
}

// Service is the uploads module.
type Service struct {
	db        DBTX
	storage   storage.Driver
	access    Access
	publicURL string
	// Direct-upload routing: directToBucket switches S3/MinIO deployments to
	// presigned browser->bucket POSTs (S3_DIRECT_UPLOADS, opt-in because the
	// bucket needs a CORS config first); s3PublicBase optionally rewrites the
	// presigned URL origin when the S3 endpoint is not browser-reachable
	// (S3_PUBLIC_URL). Without the opt-in every driver uses the API's
	// token-authenticated streaming PUT, which needs no storage-side setup.
	directToBucket bool
	s3PublicBase   string
	resolve        func(host string) ([]net.IP, error)                               // overridable for tests
	dial           func(ctx context.Context, network, addr string) (net.Conn, error) // overridable for tests; addr carries the vetted IP
	client         *http.Client
}

// NewService wires the uploads service.
func NewService(db DBTX, store storage.Driver, access Access) *Service {
	return &Service{
		db: db, storage: store, access: access,
		publicURL:      os.Getenv("BACKEND_PUBLIC_URL"),
		directToBucket: truthyEnv(os.Getenv("S3_DIRECT_UPLOADS")),
		s3PublicBase:   os.Getenv("S3_PUBLIC_URL"),
		resolve:        net.LookupIP,
		dial:           (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
		client:         &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}
}

func truthyEnv(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func quotaBytes() int64 {
	if raw := os.Getenv("ASSET_QUOTA_BYTES"); raw != "" {
		if n, err := strconv.ParseInt(raw, 10, 64); err == nil {
			return n
		}
	}
	return defaultQuotaBytes
}

// userQuotaBytes is the GLOBAL per-user upload cap across all workspaces
// (public-instance abuse protection). Unset or 0 means unlimited, so
// self-hosted deployments see no behavior change; the per-workspace
// ASSET_QUOTA_BYTES applies independently.
func userQuotaBytes() int64 {
	if raw := os.Getenv("USER_STORAGE_QUOTA_BYTES"); raw != "" {
		if n, err := strconv.ParseInt(raw, 10, 64); err == nil {
			return n
		}
	}
	return 0
}

// mediaKind -> Prisma AssetKind enum (stored uppercase).
var kindMap = map[media.Kind]string{
	media.KindImage: "IMAGE", media.KindGIF: "IMAGE", media.KindVector: "IMAGE",
	media.KindVideo: "VIDEO", media.KindAudio: "AUDIO", media.KindFont: "FONT",
	media.KindModel3D: "OTHER", media.KindDocument: "OTHER", media.KindSource: "OTHER",
}

// UploadedAsset is the API view of an asset.
type UploadedAsset struct {
	ID          string   `json:"id"`
	WorkspaceID string   `json:"workspaceId"`
	Kind        string   `json:"kind"`
	Filename    *string  `json:"filename"`
	MimeType    *string  `json:"mimeType"`
	ByteSize    *int64   `json:"byteSize"`
	FolderID    *string  `json:"folderId"`
	Tags        []string `json:"tags"`
	URL         string   `json:"url"`
	Thumbnail   *string  `json:"thumbnail"`
	CreatedAt   string   `json:"createdAt"`
}

// FolderView is the API view of an asset folder.
type FolderView struct {
	ID          string  `json:"id"`
	WorkspaceID string  `json:"workspaceId"`
	Name        string  `json:"name"`
	ParentID    *string `json:"parentId"`
	CreatedAt   string  `json:"createdAt"`
}

// UsageView is the workspace storage usage + cap, plus the caller's global
// account usage (userQuotaBytes 0 = unlimited).
type UsageView struct {
	UsedBytes      int64 `json:"usedBytes"`
	QuotaBytes     int64 `json:"quotaBytes"`
	UserUsedBytes  int64 `json:"userUsedBytes"`
	UserQuotaBytes int64 `json:"userQuotaBytes"`
}

func (s *Service) contentURL(id string) string {
	return s.publicURL + "/api/v1/assets/" + id + "/content"
}

func (s *Service) toUploaded(a assetRow) UploadedAsset {
	kind := strings.ToLower(a.Kind)
	if a.MediaKind != "" {
		kind = a.MediaKind
	}
	return UploadedAsset{
		ID: a.ID, WorkspaceID: a.WorkspaceID, Kind: kind, Filename: a.Filename, MimeType: a.MimeType,
		ByteSize: a.ByteSize, FolderID: a.FolderID, Tags: a.Tags, URL: s.contentURL(a.ID),
		Thumbnail: a.Thumbnail, CreatedAt: a.CreatedAt.UTC().Format(isoFmt),
	}
}

// Upload accepts a base64 file, validates + stores it, and records the asset.
func (s *Service) Upload(ctx context.Context, userID, workspaceID, filename, dataBase64 string, folderID *string, thumbnail string) (UploadedAsset, error) {
	if err := s.access.AssertMember(ctx, userID, workspaceID, "member"); err != nil {
		return UploadedAsset{}, ErrForbidden
	}
	buf, err := base64.StdEncoding.DecodeString(dataBase64)
	if err != nil || len(buf) == 0 {
		return UploadedAsset{}, ErrBadRequest
	}
	var fn *string
	if filename != "" {
		fn = &filename
	}
	return s.store(ctx, userID, workspaceID, buf, fn, folderID, thumbnail, false)
}

// store sniffs, quota-checks, stores the bytes, and records the asset row.
func (s *Service) store(ctx context.Context, userID, workspaceID string, buf []byte, filename, folderID *string, thumbnail string, requireImage bool) (UploadedAsset, error) {
	sniff := media.AcceptUpload(buf)
	if !sniff.OK {
		return UploadedAsset{}, ErrBadRequest
	}
	if requireImage && !strings.HasPrefix(sniff.Mime, "image/") {
		return UploadedAsset{}, ErrBadRequest
	}
	used, err := s.usedBytes(ctx, workspaceID)
	if err != nil {
		return UploadedAsset{}, err
	}
	if !media.CanUpload(used, quotaBytes(), int64(len(buf))) {
		return UploadedAsset{}, ErrQuota
	}
	// Global per-user cap across all workspaces, so a public-instance user
	// cannot multiply their budget by creating workspaces.
	if uq := userQuotaBytes(); uq > 0 && userID != "" {
		userUsed, err := s.usedByUser(ctx, userID)
		if err != nil {
			return UploadedAsset{}, err
		}
		if !media.CanUpload(userUsed, uq, int64(len(buf))) {
			return UploadedAsset{}, ErrUserQuota
		}
	}
	fid, err := s.resolveFolder(ctx, workspaceID, folderID)
	if err != nil {
		return UploadedAsset{}, err
	}
	id := uuid.NewString()
	ext := "bin"
	if parts := strings.SplitN(sniff.Mime, "/", 2); len(parts) == 2 {
		ext = strings.SplitN(parts[1], "+", 2)[0]
	}
	key := "assets/" + workspaceID + "/" + id + "." + ext
	if _, err := s.storage.Put(key, buf); err != nil {
		return UploadedAsset{}, err
	}
	var thumb *string
	if thumbnail != "" {
		thumb = &thumbnail
	}
	size := int64(len(buf))
	row, err := s.createAsset(ctx, createAssetInput{
		workspaceID: workspaceID, kind: kindMap[sniff.Kind], storageKey: key, filename: filename,
		mimeType: sniff.Mime, byteSize: size, thumbnail: thumb, folderID: fid,
		uploadedByID: &userID, mediaKind: string(sniff.Kind),
	})
	if err != nil {
		return UploadedAsset{}, err
	}
	return s.toUploaded(row), nil
}

// ImportFromURL imports an image from a remote URL with a per-hop SSRF guard
// (literal authority + resolved-IP re-check against private ranges, FR-12).
// Every hop, including each redirect target, is re-vetted and then fetched
// over a connection pinned to its vetted IP, so a DNS rebind between the
// check and the request cannot reach a private address.
func (s *Service) ImportFromURL(ctx context.Context, userID, workspaceID, rawURL string, folderID *string) (UploadedAsset, error) {
	if err := s.access.AssertMember(ctx, userID, workspaceID, "member"); err != nil {
		return UploadedAsset{}, ErrForbidden
	}
	buf, err := s.fetchImage(ctx, rawURL)
	if err != nil {
		return UploadedAsset{}, err
	}
	fn := filenameFromURL(rawURL)
	return s.store(ctx, userID, workspaceID, buf, &fn, folderID, "", true)
}

// vetImportHop runs the full SSRF policy for one absolute URL: the literal
// authority check, then a resolved-IP re-check. Every resolved IP must be
// public; the first is returned so the fetch can pin its dial to it.
func (s *Service) vetImportHop(rawURL string) (net.IP, error) {
	check := media.ValidateImportURL(rawURL)
	if !check.OK || check.Parsed == nil {
		return nil, ErrBadRequest
	}
	ips, err := s.resolve(check.Parsed.Host)
	if err != nil || len(ips) == 0 {
		return nil, ErrBadRequest
	}
	for _, ip := range ips {
		if media.IsPrivateIP(ip.String()) {
			return nil, ErrBadRequest
		}
	}
	return ips[0], nil
}

// fetchImage fetches an import URL, following at most maxImportRedirects
// redirect hops. Each hop is vetted, then fetched with a pinned dial. A hop
// beyond the limit, a 3xx without a Location, or any vet failure rejects.
func (s *Service) fetchImage(ctx context.Context, rawURL string) ([]byte, error) {
	current := rawURL
	for hop := 0; hop <= maxImportRedirects; hop++ {
		ip, err := s.vetImportHop(current)
		if err != nil {
			return nil, err
		}
		res, err := s.getPinned(ctx, current, ip)
		if err != nil {
			return nil, ErrBadRequest
		}
		if res.StatusCode >= 300 && res.StatusCode < 400 {
			loc := res.Header.Get("location")
			res.Body.Close()
			if loc == "" {
				return nil, ErrBadRequest
			}
			next, ok := resolveRedirect(current, loc)
			if !ok {
				return nil, ErrBadRequest
			}
			current = next
			continue
		}
		return readImageResponse(res)
	}
	return nil, ErrBadRequest
}

// getPinned issues one GET whose connection is dialed to the vetted IP while
// the URL hostname stays in place for TLS SNI/verification and the Host
// header. Redirects are returned to the caller, never auto-followed.
func (s *Service) getPinned(ctx context.Context, rawURL string, ip net.IP) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	pinned := ip.String()
	transport := &http.Transport{
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			_, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			return s.dial(ctx, network, net.JoinHostPort(pinned, port))
		},
	}
	client := &http.Client{
		Timeout:       s.client.Timeout,
		Transport:     transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return client.Do(req)
}

// resolveRedirect resolves a Location header (absolute or relative) against
// the URL of the hop that produced it.
func resolveRedirect(current, location string) (string, bool) {
	base, err := url.Parse(current)
	if err != nil {
		return "", false
	}
	ref, err := url.Parse(strings.TrimSpace(location))
	if err != nil {
		return "", false
	}
	return base.ResolveReference(ref).String(), true
}

// readImageResponse validates a terminal response (status, image content
// type, declared and actual size caps) and reads at most maxImportBytes.
func readImageResponse(res *http.Response) ([]byte, error) {
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, ErrBadRequest
	}
	ct := strings.ToLower(res.Header.Get("content-type"))
	if ct != "" && !strings.HasPrefix(ct, "image/") {
		return nil, ErrBadRequest
	}
	if cl, err := strconv.ParseInt(res.Header.Get("content-length"), 10, 64); err == nil && cl > maxImportBytes {
		return nil, ErrImportSize
	}
	buf, err := io.ReadAll(io.LimitReader(res.Body, maxImportBytes+1))
	if err != nil {
		return nil, ErrBadRequest
	}
	if len(buf) == 0 {
		return nil, ErrBadRequest
	}
	if int64(len(buf)) > maxImportBytes {
		return nil, ErrImportSize
	}
	return buf, nil
}

func filenameFromURL(rawURL string) string {
	path := rawURL
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}
	segs := strings.Split(path, "/")
	last := ""
	for i := len(segs) - 1; i >= 0; i-- {
		if segs[i] != "" {
			last = segs[i]
			break
		}
	}
	name := strings.TrimSpace(last)
	if name == "" || len(name) > 255 {
		return "import"
	}
	return name
}

// List returns assets, optionally filtered by folder/tag/text (FR-9).
func (s *Service) List(ctx context.Context, userID, workspaceID string, folderID *string, folderSet bool, tag, text string) ([]UploadedAsset, error) {
	if err := s.access.AssertMember(ctx, userID, workspaceID, "viewer"); err != nil {
		return nil, ErrForbidden
	}
	rows, err := s.listByWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	out := []UploadedAsset{}
	needle := strings.ToLower(text)
	tagNeedle := strings.ToLower(tag)
	for _, a := range rows {
		if folderSet {
			af := ""
			if a.FolderID != nil {
				af = *a.FolderID
			}
			want := ""
			if folderID != nil {
				want = *folderID
			}
			if af != want {
				continue
			}
		}
		if needle != "" && !assetMatchesText(a, needle) {
			continue
		}
		if tagNeedle != "" && !hasTag(a.Tags, tagNeedle) {
			continue
		}
		out = append(out, s.toUploaded(a))
	}
	return out, nil
}

func assetMatchesText(a assetRow, needle string) bool {
	if a.Filename != nil && strings.Contains(strings.ToLower(*a.Filename), needle) {
		return true
	}
	return hasTagContains(a.Tags, needle)
}

func hasTag(tags []string, needle string) bool {
	for _, t := range tags {
		if strings.ToLower(t) == needle {
			return true
		}
	}
	return false
}

func hasTagContains(tags []string, needle string) bool {
	for _, t := range tags {
		if strings.Contains(strings.ToLower(t), needle) {
			return true
		}
	}
	return false
}

// UsageView reports the workspace storage usage + cap (FR-11).
func (s *Service) UsageView(ctx context.Context, userID, workspaceID string) (UsageView, error) {
	if err := s.access.AssertMember(ctx, userID, workspaceID, "viewer"); err != nil {
		return UsageView{}, ErrForbidden
	}
	used, err := s.usedBytes(ctx, workspaceID)
	if err != nil {
		return UsageView{}, err
	}
	userUsed, err := s.usedByUser(ctx, userID)
	if err != nil {
		return UsageView{}, err
	}
	return UsageView{
		UsedBytes: used, QuotaBytes: quotaBytes(),
		UserUsedBytes: userUsed, UserQuotaBytes: userQuotaBytes(),
	}, nil
}

// UpdateAsset renames / moves-to-folder / sets-tags an asset.
func (s *Service) UpdateAsset(ctx context.Context, userID, id string, filename *string, folderID *string, folderSet bool, tags *[]string) (UploadedAsset, error) {
	rec, err := s.getAsset(ctx, id)
	if err != nil {
		return UploadedAsset{}, err
	}
	if err := s.access.AssertMember(ctx, userID, rec.WorkspaceID, "member"); err != nil {
		return UploadedAsset{}, ErrForbidden
	}
	patch := assetPatch{filename: filename}
	if tags != nil {
		patch.tags = normalizeTags(*tags)
		patch.tagsSet = true
	}
	if folderSet {
		fid, err := s.resolveFolder(ctx, rec.WorkspaceID, folderID)
		if err != nil {
			return UploadedAsset{}, err
		}
		patch.folderID = fid
		patch.folderSet = true
	}
	row, err := s.updateAsset(ctx, id, patch)
	if err != nil {
		return UploadedAsset{}, err
	}
	return s.toUploaded(row), nil
}

func normalizeTags(tags []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, t := range tags {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		k := strings.ToLower(t)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, t)
	}
	return out
}

// Remove deletes an asset (blob + row).
func (s *Service) Remove(ctx context.Context, userID, id string) error {
	rec, err := s.getAsset(ctx, id)
	if err != nil {
		return err
	}
	if err := s.access.AssertMember(ctx, userID, rec.WorkspaceID, "member"); err != nil {
		return ErrForbidden
	}
	_ = s.storage.Delete(rec.StorageKey)
	return s.deleteAsset(ctx, id)
}

// --- folders (FR-8) ------------------------------------------------------

func (s *Service) ListFolders(ctx context.Context, userID, workspaceID string) ([]FolderView, error) {
	if err := s.access.AssertMember(ctx, userID, workspaceID, "viewer"); err != nil {
		return nil, ErrForbidden
	}
	rows, err := s.listFolders(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	out := make([]FolderView, 0, len(rows))
	for _, f := range rows {
		out = append(out, toFolderView(f))
	}
	return out, nil
}

func (s *Service) CreateFolder(ctx context.Context, userID, workspaceID, name string, parentID *string) (FolderView, error) {
	if err := s.access.AssertMember(ctx, userID, workspaceID, "member"); err != nil {
		return FolderView{}, ErrForbidden
	}
	pid, err := s.resolveFolder(ctx, workspaceID, parentID)
	if err != nil {
		return FolderView{}, err
	}
	f, err := s.createFolder(ctx, workspaceID, strings.TrimSpace(name), pid)
	if err != nil {
		return FolderView{}, err
	}
	return toFolderView(f), nil
}

func (s *Service) RenameFolder(ctx context.Context, userID, id, name string) (FolderView, error) {
	f, err := s.getFolder(ctx, id)
	if err != nil {
		return FolderView{}, err
	}
	if err := s.access.AssertMember(ctx, userID, f.WorkspaceID, "member"); err != nil {
		return FolderView{}, ErrForbidden
	}
	updated, err := s.renameFolder(ctx, id, strings.TrimSpace(name))
	if err != nil {
		return FolderView{}, err
	}
	return toFolderView(updated), nil
}

// DeleteFolder deletes a folder + subfolders, reparenting affected assets to
// root so none are orphaned (FR-8).
func (s *Service) DeleteFolder(ctx context.Context, userID, id string) error {
	f, err := s.getFolder(ctx, id)
	if err != nil {
		return err
	}
	if err := s.access.AssertMember(ctx, userID, f.WorkspaceID, "member"); err != nil {
		return ErrForbidden
	}
	folders, err := s.listFolders(ctx, f.WorkspaceID)
	if err != nil {
		return err
	}
	assets, err := s.listByWorkspace(ctx, f.WorkspaceID)
	if err != nil {
		return err
	}
	folderLites := make([]media.FolderLite, len(folders))
	depth := map[string]int{}
	byID := map[string]folderRow{}
	for i, x := range folders {
		folderLites[i] = media.FolderLite{ID: x.ID, ParentID: x.ParentID}
		byID[x.ID] = x
	}
	assetLites := make([]media.AssetLite, len(assets))
	for i, a := range assets {
		assetLites[i] = media.AssetLite{ID: a.ID, FolderID: a.FolderID}
	}
	cascade := media.FolderDeleteCascade(folderLites, id, assetLites)
	for _, assetID := range cascade.AssetIDs {
		if _, err := s.updateAsset(ctx, assetID, assetPatch{folderID: nil, folderSet: true}); err != nil {
			return err
		}
	}
	// Delete deepest folders first so a parent delete never strands a child.
	for id := range byID {
		depth[id] = folderDepth(byID, id)
	}
	ordered := append([]string(nil), cascade.FolderIDs...)
	sortByDepthDesc(ordered, depth)
	for _, folderID := range ordered {
		if err := s.deleteFolder(ctx, folderID); err != nil {
			return err
		}
	}
	return nil
}

func folderDepth(byID map[string]folderRow, id string) int {
	depth := 0
	seen := map[string]bool{}
	cur, ok := byID[id]
	for ok && cur.ParentID != nil && !seen[cur.ID] {
		seen[cur.ID] = true
		depth++
		cur, ok = byID[*cur.ParentID]
	}
	return depth
}

func sortByDepthDesc(ids []string, depth map[string]int) {
	for i := 1; i < len(ids); i++ {
		for j := i; j > 0 && depth[ids[j-1]] < depth[ids[j]]; j-- {
			ids[j-1], ids[j] = ids[j], ids[j-1]
		}
	}
}

// resolveFolder validates a folder id belongs to the workspace; nil = root.
func (s *Service) resolveFolder(ctx context.Context, workspaceID string, folderID *string) (*string, error) {
	if folderID == nil {
		return nil, nil
	}
	f, err := s.getFolder(ctx, *folderID)
	if err != nil || f.WorkspaceID != workspaceID {
		return nil, ErrBadRequest
	}
	return &f.ID, nil
}

// Content returns the raw bytes + mime for an asset (public delivery route).
func (s *Service) Content(ctx context.Context, id string) ([]byte, string, error) {
	rec, err := s.getAsset(ctx, id)
	if err != nil {
		return nil, "", err
	}
	bytes, err := s.storage.Get(rec.StorageKey)
	if err != nil || bytes == nil {
		return nil, "", ErrNotFound
	}
	mime := "application/octet-stream"
	if rec.MimeType != nil {
		mime = *rec.MimeType
	}
	return bytes, mime, nil
}

func toFolderView(f folderRow) FolderView {
	return FolderView{ID: f.ID, WorkspaceID: f.WorkspaceID, Name: f.Name, ParentID: f.ParentID, CreatedAt: f.CreatedAt.UTC().Format(isoFmt)}
}
