// HyCanvas backend (Go). The single service owns config, the Postgres pool and
// its SQL migrations, the chi router with problem+json, structured logging,
// health/readiness, the /api/v1 surface, the /realtime WebSocket, and serving the
// statically-exported Next.js frontend. It replaces the former NestJS backend
// outright; there is no Node API in the runtime.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"syscall"
	"time"

	"hycanvas/backend/internal/accountdata"
	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/ai"
	"hycanvas/backend/internal/aistudio"
	"hycanvas/backend/internal/approvals"
	"hycanvas/backend/internal/brand"
	"hycanvas/backend/internal/bulkcreate"
	"hycanvas/backend/internal/comments"
	"hycanvas/backend/internal/convert"
	"hycanvas/backend/internal/daemon"
	"hycanvas/backend/internal/engagement"
	"hycanvas/backend/internal/home"
	"hycanvas/backend/internal/httpapi"
	"hycanvas/backend/internal/jobs"
	"hycanvas/backend/internal/migrations"
	"hycanvas/backend/internal/oidc"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/platform/config"
	"hycanvas/backend/internal/platform/db"
	"hycanvas/backend/internal/push"
	"hycanvas/backend/internal/realtime"
	"hycanvas/backend/internal/sharing"
	"hycanvas/backend/internal/stock"
	"hycanvas/backend/internal/storage"
	"hycanvas/backend/internal/templates"
	"hycanvas/backend/internal/uploads"
	"hycanvas/backend/internal/whiteboard"
)

// localhostOriginRE matches http(s)://localhost or 127.0.0.1 with an optional
// port, for dev-only credentialed CORS.
var localhostOriginRE = regexp.MustCompile(`^https?://(localhost|127\.0\.0\.1)(:\d+)?$`)

// version is stamped at build time via -ldflags "-X main.version=...". It is
// "dev" for un-stamped builds (go run, plain go build). Logged on boot and
// surfaced at /healthz and /api/v1/_go/health for deployment debugging.
var version = "dev"

func main() {
	// `hycanvas service ...` manages the OS service (systemd/launchd) and must
	// not boot the server, so it dispatches before any config or logger setup.
	if len(os.Args) > 1 && os.Args[1] == "service" {
		os.Exit(daemon.Run(os.Args[2:], os.Stdout, os.Stderr))
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)
	logger.Info("starting", "service", "hycanvas", "version", version)

	cfg, err := config.Load()
	if err != nil {
		logger.Error("config load failed", "err", err)
		os.Exit(1)
	}

	// JWT_SECRET signs session tokens (and, via AISecret fallback, encrypts stored
	// provider keys). An empty value would make tokens trivially forgeable, so the
	// API refuses to start without it. (cmd/migrate does not require it.)
	if cfg.JWTSecret == "" {
		logger.Error("JWT_SECRET is required: set a strong, random value (e.g. `openssl rand -hex 32`)")
		os.Exit(1)
	}

	pool, err := db.Connect(context.Background(), cfg.DatabaseURL)
	if err != nil {
		logger.Error("database connect failed", "err", err)
		os.Exit(1)
	}
	defer pool.Close()
	logger.Info("database connected")

	if cfg.AutoMigrate {
		if err := db.Migrate(context.Background(), pool, migrations.FS); err != nil {
			logger.Error("database migration failed", "err", err)
			os.Exit(1)
		}
		logger.Info("database migrations up to date")
	}

	store, err := storage.NewFromEnv()
	if err != nil {
		logger.Error("storage init failed", "err", err)
		os.Exit(1)
	}
	logger.Info("storage ready", "kind", store.Kind())

	// The MFA TOTP secret is encrypted with AI_SECRET (falling back to
	// JWT_SECRET), matching the Node ai/crypto resolution.
	mfaSecret := cfg.AISecret
	if mfaSecret == "" {
		mfaSecret = cfg.JWTSecret
	}
	acct := accounts.NewService(pool, cfg.JWTSecret).WithMFASecret(mfaSecret)
	persist := persistence.NewService(pool).WithStorage(store)
	titles := commentsPersist{persist}
	homeSvc := home.NewService(pool, persist, acct)
	// The engagement emitter (write side: activity log + notifications) depends
	// only on the DB, account lookup, and title lookup - never on sharing - so
	// the mutation services can hold it without forming a construction cycle.
	pushSvc := push.NewService(pool)
	emitter := engagement.NewEmitter(pool, acct, titles).WithPush(pushAdapter{pushSvc})
	// Wire the emitter back into accounts so a workspace invite raises an in-app
	// notification (the dashboard bell) for an invitee who already has an account.
	acct.WithNotifier(emitter)
	// The lock checker derives approval-lock state from the Approval table with
	// no service dependency, so wiring it into sharing forms no import cycle.
	lockChecker := approvals.NewLockChecker(pool)
	sharingSvc := sharing.NewService(pool, persist, emitter, lockChecker).WithFiles(titles).WithMailer(acct)
	// Realtime collaboration relay (opaque Yjs blob broadcast + presence + locks);
	// it journals editor updates to the DesignUpdateLog via persistence. The role
	// resolver lets the hub live-downgrade editors when an approval lock engages.
	rtHub := realtime.NewHub(persist).WithRoleResolver(
		func(ctx context.Context, designID, userID string) (string, error) {
			return sharingSvc.ResolveGatewayRole(ctx, designID, userID, nil)
		})
	// Approvals push a live role refresh to connected clients on lock/unlock via
	// the realtime hub (F16 AC-9).
	approvalsSvc := approvals.NewService(pool, sharingSvc, acct, rtHub, emitter)
	// Horizontal scaling (optional): when REDIS_URL is set, fan relay/awareness
	// frames out across gateway instances via Redis pub/sub so clients on
	// different instances converge (roadmap doc 16, section 8). Unset = single
	// instance, in-memory only. A set-but-unreachable Redis fails loudly rather
	// than silently degrading to a split brain.
	if redisURL := os.Getenv("REDIS_URL"); redisURL != "" {
		coord, err := realtime.NewRedisCoordinator(context.Background(), redisURL)
		if err != nil {
			slog.Error("realtime: redis coordinator init failed", "err", err)
			os.Exit(1)
		}
		rtHub = rtHub.WithCoordinator(coord)
		// Cross-instance lock authority (FR-8): the same Redis backs a compare-and-
		// swap lock store so two instances cannot grant the same node and a crashed
		// instance's locks auto-expire. Without it locks stay instance-local.
		lockStore, err := realtime.NewRedisLockStore(context.Background(), redisURL)
		if err != nil {
			slog.Error("realtime: redis lock store init failed", "err", err)
			os.Exit(1)
		}
		rtHub = rtHub.WithLockStore(lockStore)
		slog.Info("realtime: horizontal fan-out + cross-instance lock authority enabled (redis)")
	}
	// Background lifecycle for the realtime fan-out pumps + lock sweeper; cancelled
	// on shutdown so the goroutines (and any Redis subscription) tear down cleanly.
	rtCtx, rtCancel := context.WithCancel(context.Background())
	defer rtCancel()
	rtHub.StartCoordinator(rtCtx)
	// Periodically release collaborative locks held by stalled/zombie sockets
	// (FR-8 heartbeat timeout), so a node never stays locked by a dead client.
	rtHub.StartSweeper(rtCtx)
	// Comments: the realtime hub broadcasts comment-changed signals; the emitter
	// records activity + notifications. The persistence-titles adapter exposes lookups.
	commentsSvc := comments.NewService(pool, sharingSvc, acct, titles, rtHub, emitter).WithFiles(titles)
	// Server-authoritative whiteboard voting (F30 FR-19): sharing resolves the
	// caller's design access; the realtime hub broadcasts vote-changed so clients
	// refetch the tally over REST.
	whiteboardSvc := whiteboard.NewService(whiteboard.NewRepo(pool), sharingSvc, rtHub)
	// Engagement read side (activity feed, notifications, insights). The version
	// loader folds version-history edits into the activity feed (FR-12).
	engagementSvc := engagement.NewService(pool, sharingSvc, acct, titles).WithVersions(titles)
	// Brand: kit-management (CRUD, versioning, default) plus the design-scoped
	// half (assign/resolve/pin/reviewed/locked-regions) over the persistence
	// brand-meta accessors + sharing manage-brand. Lint + the pre-export gate
	// stay on the Node service (they need the @hc/brandkit linter).
	brandSvc := brand.NewService(pool).WithDesignScope(sharingSvc, persist)
	// AI proxy: per-workspace provider config (key encrypted at rest) + BYO calls.
	// The key secret mirrors Node: AI_SECRET, else JWT_SECRET. Localhost http base
	// URLs are allowed only outside production.
	aiSecret := cfg.AISecret
	if aiSecret == "" {
		aiSecret = cfg.JWTSecret
	}
	aiSvc := ai.NewService(pool, aiSecret, os.Getenv("NODE_ENV") != "production")
	// AI Creative Studio (F39): server-side orchestration on top of the AI proxy
	// (schema validation + retry) plus persisted assistant sessions/provenance.
	aiStudioSvc := aistudio.NewService(pool, aiSvc)
	// Uploads: base64 upload + magic-byte sniff + quota + folders, over the same
	// storage driver as Node (shared blobs).
	uploadsSvc := uploads.NewService(pool, store, acct)
	// Templates: catalog (embedded seed + DB), apply (deep-copy -> new design),
	// save-as-template, collections. The adapter bridges the persistence service.
	templatesSvc := templates.NewService(pool, acct, templatesPersist{persist})
	// Stock: embedded catalog search + favorites/recents + allowlisted proxy.
	stockSvc := stock.NewService(pool)
	// Bulk create / autofill: data merge over a template or design's fillable
	// fields, producing one design per row (capped, synchronous).
	bulkSvc := bulkcreate.NewService(persist, acct, templatesSvc)
	// Whiteboard -> deck conversion (inline; result design id polled via /jobs/:id).
	convertSvc := convert.NewService(persist, acct)
	// Account data portability: self-serve export + re-authenticated deletion.
	accountDataSvc := accountdata.NewService(pool, acct, persist)
	// OIDC SSO (env-configured): provider list + authorization-code/PKCE flow.
	oidcSvc := oidc.NewService(cfg.JWTSecret)
	// In-memory job registry for inline export/convert/bulk work (no Redis queue).
	jobRegistry := jobs.NewRegistry()
	// Session cookies are Secure in production by default. COOKIE_SECURE overrides
	// that explicitly: a production self-host served over plain http (e.g. a
	// localhost/LAN/VPS quick start before TLS is set up) must set it "false" or
	// the browser drops the Secure cookie and login silently fails. Behind a TLS
	// reverse proxy, leave it on (or set "true").
	secureCookies := os.Getenv("NODE_ENV") == "production"
	if v := os.Getenv("COOKIE_SECURE"); v != "" {
		secureCookies = v == "true" || v == "1"
	}

	// CORS: allow the configured frontend origin always, and any localhost origin
	// outside production (dev runs the frontend on :3000 against the API on :8005
	// with cookies). In production the frontend is served same-origin, so no
	// Origin is sent and this never fires. Mirrors the former NestJS enableCors.
	frontendURL := strings.TrimRight(os.Getenv("FRONTEND_URL"), "/")
	isProd := os.Getenv("NODE_ENV") == "production"
	allowOrigin := func(origin string) bool {
		if origin == "" {
			return false
		}
		if frontendURL != "" && origin == frontendURL {
			return true
		}
		return !isProd && localhostOriginRE.MatchString(origin)
	}

	srv := &http.Server{
		Addr: ":" + cfg.Port,
		Handler: httpapi.NewRouter(httpapi.Deps{
			DB:          pool,
			Logger:      logger,
			Version:     version,
			Accounts:    acct,
			Persistence: persist,
			Home:        homeSvc,
			Sharing:     sharingSvc,
			Approvals:   approvalsSvc,
			Comments:    commentsSvc,
			Whiteboard:  whiteboardSvc,
			Engagement:  engagementSvc,
			Brand:       brandSvc,
			AI:          aiSvc,
			AIStudio:    aiStudioSvc,
			Uploads:     uploadsSvc,
			Realtime:    rtHub,
			Templates:   templatesSvc,
			Stock:       stockSvc,
			OIDC:        oidcSvc,
			Push:        pushSvc,
			Jobs:        jobRegistry,
			BulkCreate:  bulkSvc,
			Convert:     convertSvc,
			Storage:     store,
			AccountData: accountDataSvc,
			Secure:      secureCookies,
			PublicDir:   cfg.PublicDir,
			AllowOrigin: allowOrigin,
		}),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		logger.Info("api listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	logger.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown error", "err", err)
	}
	// Tear down the realtime fan-out pumps + sweeper, then release the coordinator
	// (closes the Redis pool; no-op for the single-instance default).
	rtCancel()
	if err := rtHub.CloseCoordinator(); err != nil {
		logger.Error("realtime coordinator close error", "err", err)
	}
	if err := rtHub.CloseLockStore(); err != nil {
		logger.Error("realtime lock store close error", "err", err)
	}
}

// commentsPersist adapts the persistence service to the lookups the higher-level
// modules need: comments.PersistenceTitles + comments.Files (orphan detection),
// engagement.Titles + engagement.Versions (activity-feed fold), and
// sharing.Files (public link-file route). One adapter satisfies all of them.
type commentsPersist struct{ p *persistence.Service }

func (c commentsPersist) GetWorkspaceID(ctx context.Context, designID string) (string, error) {
	return c.p.GetWorkspaceID(ctx, designID)
}

func (c commentsPersist) GetTitle(ctx context.Context, designID string) (string, error) {
	rec, err := c.p.GetRecord(ctx, designID)
	if err != nil {
		return "", err
	}
	return rec.Title, nil
}

// NodeIDs loads the design's live node-id set for comment orphan detection.
func (c commentsPersist) NodeIDs(ctx context.Context, designID, workspaceID string) (map[string]bool, error) {
	file, err := c.p.FileFor(ctx, designID, workspaceID)
	if err != nil {
		return nil, err
	}
	return persistence.CollectNodeIDs(file), nil
}

// VersionEdits maps the design's recent version history to engagement edit items.
func (c commentsPersist) VersionEdits(ctx context.Context, designID string, limit int) ([]engagement.VersionEdit, error) {
	ws, err := c.p.GetWorkspaceID(ctx, designID)
	if err != nil {
		return nil, err
	}
	page, err := c.p.ListVersions(ctx, designID, ws, "")
	if err != nil {
		return nil, err
	}
	out := make([]engagement.VersionEdit, 0, len(page.Items))
	for i, v := range page.Items {
		if i >= limit {
			break
		}
		var name *string
		if v.Author != nil {
			n := v.Author.Name
			name = &n
		}
		out = append(out, engagement.VersionEdit{
			ID: v.ID, AuthorID: v.AuthorID, AuthorName: name, Label: v.Label,
			Kind: string(v.Kind), CreatedAt: v.CreatedAt,
		})
	}
	return out, nil
}

// LoadFileForDesign loads a design's current file for the public link-file route.
func (c commentsPersist) LoadFileForDesign(ctx context.Context, designID string) (any, error) {
	ws, err := c.p.GetWorkspaceID(ctx, designID)
	if err != nil {
		return nil, err
	}
	loaded, err := c.p.LoadFile(ctx, designID, ws)
	if err != nil {
		return nil, err
	}
	return loaded.File, nil
}

// templatesPersist adapts the persistence service to templates.Persistence
// (apply -> create design; save-as -> load a design's file).
type templatesPersist struct{ p *persistence.Service }

func (t templatesPersist) CreateDesign(ctx context.Context, workspaceID, title string, from map[string]any, authorID *string) (string, error) {
	rec, err := t.p.Create(ctx, workspaceID, title, persistence.DesignFile(from), authorID)
	if err != nil {
		return "", err
	}
	return rec.ID, nil
}

func (t templatesPersist) GetWorkspaceID(ctx context.Context, designID string) (string, error) {
	return t.p.GetWorkspaceID(ctx, designID)
}

func (t templatesPersist) LoadDesignFile(ctx context.Context, designID, workspaceID string) (map[string]any, error) {
	loaded, err := t.p.LoadFile(ctx, designID, workspaceID)
	if err != nil {
		return nil, err
	}
	return loaded.File, nil
}

// pushAdapter bridges the push service to the engagement emitter's Pusher hook.
type pushAdapter struct{ p *push.Service }

func (a pushAdapter) Send(ctx context.Context, userID, title, body, url string) {
	a.p.Send(ctx, userID, push.Payload{Title: title, Body: body, URL: url})
}
