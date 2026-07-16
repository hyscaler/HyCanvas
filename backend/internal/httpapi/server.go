// HTTP router for the Go API service. Mounts cross-cutting middleware (request
// id, panic recovery, structured access logs) and the /api/v1 surface that
// ported modules attach to. Health/readiness live at the root for the proxy and
// container probes.
package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"hycanvas/backend/internal/accountdata"
	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/ai"
	"hycanvas/backend/internal/aistudio"
	"hycanvas/backend/internal/approvals"
	"hycanvas/backend/internal/brand"
	"hycanvas/backend/internal/bulkcreate"
	"hycanvas/backend/internal/captcha"
	"hycanvas/backend/internal/comments"
	"hycanvas/backend/internal/convert"
	"hycanvas/backend/internal/engagement"
	"hycanvas/backend/internal/home"
	"hycanvas/backend/internal/jobs"
	"hycanvas/backend/internal/oidc"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/platform/config"
	"hycanvas/backend/internal/push"
	"hycanvas/backend/internal/realtime"
	"hycanvas/backend/internal/sharing"
	"hycanvas/backend/internal/stock"
	"hycanvas/backend/internal/storage"
	"hycanvas/backend/internal/templates"
	"hycanvas/backend/internal/uploads"
	"hycanvas/backend/internal/webui"
	"hycanvas/backend/internal/whiteboard"
)

// Deps holds the collaborators handlers need (extended as modules are ported).
type Deps struct {
	DB            *pgxpool.Pool
	Logger        *slog.Logger
	Version       string // build version stamped via -ldflags; "dev" when un-stamped
	Accounts      *accounts.Service
	Persistence   *persistence.Service
	Home          *home.Service
	Sharing       *sharing.Service
	Approvals     *approvals.Service
	Comments      *comments.Service
	Whiteboard    *whiteboard.Service
	Engagement    *engagement.Service
	Brand         *brand.Service
	AI            *ai.Service
	AIStudio      *aistudio.Service
	Uploads       *uploads.Service
	Realtime      *realtime.Hub
	Templates     *templates.Service
	Stock         *stock.Service
	OIDC          *oidc.Service
	Push          *push.Service
	Jobs          *jobs.Registry
	BulkCreate    *bulkcreate.Service
	Convert       *convert.Service
	Storage       storage.Driver
	AccountData   *accountdata.Service
	Secure        bool                 // set Secure on session cookies (production / HTTPS)
	Auth          config.AuthPolicy    // which sign-in methods and signups are enabled
	Captcha       captcha.Verifier     // optional CAPTCHA gate on the auth forms; nil = off
	CaptchaConfig config.CaptchaConfig // public captcha config (provider/site key) for the sign-in page
	PublicDir     string               // exported Next.js frontend to serve; empty = API only
	AnalyticsGAID string               // optional GA4 measurement id injected into served HTML; empty = no analytics
	// AllowOrigin gates CORS: it returns true for cross-origin Origins that may
	// call the API with credentials (dev frontend). Nil disables CORS handling.
	AllowOrigin func(origin string) bool
}

// NewRouter builds the full handler tree.
func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	if d.AllowOrigin != nil {
		r.Use(corsMiddleware(d.AllowOrigin))
	}
	r.Use(accessLog(d.Logger))

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": d.Version})
	})
	r.Get("/readyz", func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), 3*time.Second)
		defer cancel()
		if err := d.DB.Ping(ctx); err != nil {
			Problem(w, req, http.StatusServiceUnavailable, "Not Ready", "database unavailable")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})

	// Realtime collaboration WebSocket at /realtime (root, matching the NestJS
	// gateway upgrade path), not under /api/v1.
	if d.Realtime != nil && d.Accounts != nil && d.Sharing != nil && d.Persistence != nil {
		mountRealtime(r, d.Realtime, d.Accounts, d.Sharing, d.Persistence, d.Secure)
	}

	// The /api/v1 surface. Ported modules register their routes here; until a
	// route exists in Go, the reverse proxy keeps sending it to the Node API.
	r.Route("/api/v1", func(api chi.Router) {
		api.Get("/_go/health", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"service": "hycanvas", "ok": true, "version": d.Version})
		})
		// Ported: auth + accounts (login / logout / me). Other modules mount here
		// as they are migrated; the reverse proxy keeps unported routes on Node.
		if d.Accounts != nil {
			mountAuth(api, d.Accounts, d.Secure, d.Auth, d.Captcha)
			mountWorkspaces(api, d.Accounts)
			mountMembers(api, d.Accounts)
		}
		if d.Accounts != nil && d.AccountData != nil {
			mountAccount(api, d.AccountData, d.Accounts, d.Secure)
		}
		if d.Accounts != nil && d.OIDC != nil {
			mountOIDC(api, d.OIDC, d.Accounts, d.Secure, d.Auth, d.CaptchaConfig)
		}
		if d.Accounts != nil && d.Persistence != nil {
			mountPersistence(api, d.Persistence, d.Accounts, d.Sharing)
			mountRender(api, d.Persistence, d.Accounts, d.Uploads)
		}
		if d.Accounts != nil && d.Home != nil {
			mountHome(api, d.Home, d.Accounts)
		}
		if d.Accounts != nil {
			mountApps(api, d.Accounts)
		}
		if d.Accounts != nil && d.Jobs != nil {
			mountJobs(api, d.Jobs, d.Accounts)
		}
		if d.Accounts != nil && d.BulkCreate != nil {
			mountBulkCreate(api, d.BulkCreate, d.Accounts)
		}
		if d.Accounts != nil && d.Convert != nil && d.Jobs != nil {
			mountConvert(api, d.Convert, d.Jobs, d.Accounts)
		}
		if d.Accounts != nil && d.Persistence != nil && d.Storage != nil && d.Jobs != nil {
			mountExport(api, d.Persistence, d.Storage, d.Jobs, d.Accounts)
		}
		if d.Accounts != nil && d.Sharing != nil {
			mountSharing(api, d.Sharing, d.Accounts)
		}
		if d.Accounts != nil && d.Approvals != nil {
			mountApprovals(api, d.Approvals, d.Accounts)
		}
		if d.Accounts != nil && d.Comments != nil {
			mountComments(api, d.Comments, d.Accounts)
		}
		if d.Accounts != nil && d.Whiteboard != nil {
			mountWhiteboard(api, d.Whiteboard, d.Accounts)
		}
		if d.Accounts != nil && d.Engagement != nil {
			mountEngagement(api, d.Engagement, d.Accounts)
		}
		if d.Accounts != nil && d.Brand != nil {
			mountBrand(api, d.Brand, d.Accounts)
		}
		if d.Accounts != nil && d.Brand != nil && d.Persistence != nil {
			mountSnapshots(api, d.Persistence, d.Brand, d.Accounts)
		}
		if d.Accounts != nil && d.AIStudio != nil && d.Persistence != nil && d.Jobs != nil {
			mountAIStudio(api, d.AIStudio, d.Accounts, d.Persistence, d.Jobs)
		}
		if d.Accounts != nil && d.AI != nil {
			mountAI(api, d.AI, d.Accounts, d.Uploads)
		}
		if d.Accounts != nil && d.Uploads != nil {
			mountUploads(api, d.Uploads, d.Accounts)
		}
		if d.Accounts != nil && d.Templates != nil {
			mountTemplates(api, d.Templates, d.Accounts)
		}
		if d.Accounts != nil && d.Stock != nil {
			mountStock(api, d.Stock, d.Accounts)
		}
		if d.Accounts != nil && d.Push != nil {
			mountPush(api, d.Push, d.Accounts)
		}
	})

	// Serve the exported Next.js frontend for everything the API/realtime routes
	// did not claim (registered as the NotFound handler, so it runs last). Prefer
	// the frontend embedded in the binary (single-file production build); fall
	// back to a PUBLIC_DIR directory when no UI was embedded.
	switch {
	case webui.HasContent():
		mountStaticFS(r, http.FS(webui.FS()), d.AnalyticsGAID)
		d.Logger.Info("serving embedded frontend")
	case d.PublicDir != "":
		if info, err := os.Stat(d.PublicDir); err == nil && info.IsDir() {
			mountStatic(r, d.PublicDir, d.AnalyticsGAID)
			d.Logger.Info("serving frontend", "dir", d.PublicDir)
		} else {
			d.Logger.Warn("PUBLIC_DIR not found; serving API only", "dir", d.PublicDir)
			mountAPIOnlyNotice(r)
		}
	default:
		d.Logger.Info("no frontend embedded and PUBLIC_DIR unset; serving API only")
		mountAPIOnlyNotice(r)
	}

	return r
}

// accessLog emits one structured line per request.
func accessLog(l *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, req.ProtoMajor)
			next.ServeHTTP(ww, req)
			l.Info("request",
				"method", req.Method,
				"path", req.URL.Path,
				"status", ww.Status(),
				"bytes", ww.BytesWritten(),
				"dur_ms", time.Since(start).Milliseconds(),
				"reqid", middleware.GetReqID(req.Context()),
			)
		})
	}
}
