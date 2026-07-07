// Package setup implements the first-run installation wizard. When the binary
// boots without a DATABASE_URL, main runs this server instead of exiting: it
// serves the exported frontend's /installation/* pages, exposes a small
// /api/setup surface to validate answers (Postgres, storage, SMTP), writes the
// resulting .env, runs migrations, and then hands control back so the normal
// server boots in the same process. Everything mutating is gated by a
// one-time access secret shown on the operator's terminal.
package setup

import (
	"context"
	"crypto/subtle"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/smtp"
	"net/url"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/httpapi"
	"hycanvas/backend/internal/migrations"
	"hycanvas/backend/internal/platform/db"
	"hycanvas/backend/internal/storage"
)

// Options configures the setup-mode server.
type Options struct {
	Logger  *slog.Logger
	Version string
	Port    string
	// Secret is the wizard access secret (from HYCANVAS_SETUP_SECRET or
	// freshly generated); the caller shows it on the terminal.
	Secret string
	// WebFS serves the exported frontend (embedded UI or PUBLIC_DIR).
	WebFS http.FileSystem
}

// Install phases reported via GET /api/setup/status.
const (
	phaseCollecting = "collecting"
	phaseValidating = "validating"
	phaseWriting    = "writing"
	phaseMigrating  = "migrating"
	phaseStarting   = "starting"
	phaseError      = "error"
)

type server struct {
	opts Options

	mu        sync.Mutex
	phase     string
	errDetail string
	// verify rate limiting
	fails     int
	lockUntil time.Time

	done chan struct{} // closed when install succeeded; Run shuts down
}

// Run serves the wizard on :port and blocks until setup completes (returns
// nil; the written .env is in the working directory, ready for a config
// reload) or ctx is cancelled (returns ctx.Err()).
func Run(ctx context.Context, opts Options) error {
	s := &server{opts: opts, phase: phaseCollecting, done: make(chan struct{})}

	httpSrv := &http.Server{
		Addr:              ":" + opts.Port,
		Handler:           s.router(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	opts.Logger.Warn("no configuration found; entering first-run setup mode")
	opts.Logger.Info("setup wizard ready",
		"url", fmt.Sprintf("http://localhost:%s/installation/step-1", opts.Port))
	// Human-readable banner alongside the JSON logs: this is what the operator
	// needs to proceed, on the terminal for `start` and in the logfile for
	// `service log`.
	fmt.Printf("\n==> First-run setup: open http://localhost:%s/installation/step-1\n", opts.Port)
	fmt.Printf("==> Wizard access secret: %s\n\n", opts.Secret)

	errCh := make(chan error, 1)
	go func() {
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case <-s.done:
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
		opts.Logger.Info("setup complete; starting the server")
		return nil
	case err := <-errCh:
		return fmt.Errorf("setup server: %w", err)
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
		return ctx.Err()
	}
}

func (s *server) router() http.Handler {
	r := chi.NewRouter()

	// Dev CORS: the wizard pages may run on the Next dev server (:3000)
	// against this API. Production serves same-origin, so this never fires.
	if os.Getenv("NODE_ENV") != "production" {
		r.Use(httpapi.CORSMiddleware(func(origin string) bool {
			return strings.HasPrefix(origin, "http://localhost:") ||
				strings.HasPrefix(origin, "http://127.0.0.1:")
		}))
	}

	// Every page navigation lands on the wizard until setup completes.
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			p := req.URL.Path
			if req.Method == http.MethodGet &&
				!strings.HasPrefix(p, "/installation") &&
				!strings.HasPrefix(p, "/_next") &&
				!strings.HasPrefix(p, "/api") &&
				p != "/healthz" &&
				!strings.Contains(path.Base(p), ".") {
				http.Redirect(w, req, "/installation/step-1/", http.StatusFound)
				return
			}
			next.ServeHTTP(w, req)
		})
	})

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "setup", "version": s.opts.Version})
	})

	r.Route("/api/setup", func(r chi.Router) {
		r.Get("/status", s.handleStatus)
		r.Post("/verify", s.handleVerify)
		r.Group(func(r chi.Router) {
			r.Use(s.requireSecret)
			r.Post("/db/test", s.handleDBTest)
			r.Post("/smtp/test", s.handleSMTPTest)
			r.Post("/s3/test", s.handleS3Test)
			r.Post("/complete", s.handleComplete)
		})
	})

	httpapi.MountStaticFS(r, s.opts.WebFS)
	return r
}

// requireSecret gates mutating setup endpoints on the wizard access secret.
func (s *server) requireSecret(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		got := req.Header.Get("X-Setup-Secret")
		if subtle.ConstantTimeCompare([]byte(got), []byte(s.opts.Secret)) != 1 {
			httpapi.Problem(w, req, http.StatusForbidden, "Forbidden", "missing or wrong setup secret")
			return
		}
		next.ServeHTTP(w, req)
	})
}

func (s *server) handleStatus(w http.ResponseWriter, req *http.Request) {
	s.mu.Lock()
	phase, detail := s.phase, s.errDetail
	s.mu.Unlock()
	cwd, _ := os.Getwd()
	resp := map[string]any{
		"state":   "setup",
		"phase":   phase,
		"version": s.opts.Version,
		"defaults": map[string]string{
			"port":        s.opts.Port,
			"storagePath": path.Join(cwd, ".data", "storage"),
		},
	}
	if detail != "" {
		resp["error"] = detail
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *server) handleVerify(w http.ResponseWriter, req *http.Request) {
	var body struct {
		Secret string `json:"secret"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		httpapi.Problem(w, req, http.StatusBadRequest, "Bad Request", "invalid JSON body")
		return
	}

	s.mu.Lock()
	locked := time.Now().Before(s.lockUntil)
	s.mu.Unlock()
	if locked {
		httpapi.Problem(w, req, http.StatusTooManyRequests, "Too Many Attempts", "too many wrong secrets; wait 30 seconds")
		return
	}

	if subtle.ConstantTimeCompare([]byte(body.Secret), []byte(s.opts.Secret)) != 1 {
		s.mu.Lock()
		s.fails++
		if s.fails >= 5 {
			s.lockUntil = time.Now().Add(30 * time.Second)
			s.fails = 0
		}
		s.mu.Unlock()
		s.opts.Logger.Warn("setup: wrong wizard access secret")
		time.Sleep(500 * time.Millisecond) // slow brute force
		httpapi.Problem(w, req, http.StatusForbidden, "Forbidden", "wrong setup secret; it is printed on the server's terminal or in `hycanvas service log`")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// dbRequest is a database answer: either a full URL or discrete fields.
type dbRequest struct {
	URL      string `json:"url"`
	Host     string `json:"host"`
	Port     string `json:"port"`
	User     string `json:"user"`
	Password string `json:"password"`
	Name     string `json:"name"`
}

// dsn resolves the request into a Postgres connection string.
func (d dbRequest) dsn() (string, error) {
	if strings.TrimSpace(d.URL) != "" {
		return strings.TrimSpace(d.URL), nil
	}
	if d.Host == "" || d.User == "" || d.Name == "" {
		return "", errors.New("host, user, and database name are required")
	}
	port := d.Port
	if port == "" {
		port = "5432"
	}
	u := &url.URL{
		Scheme: "postgresql",
		User:   url.UserPassword(d.User, d.Password),
		Host:   net.JoinHostPort(d.Host, port),
		Path:   "/" + d.Name,
	}
	return u.String(), nil
}

// testDB validates connectivity; db.Connect pings with its own 5s timeout.
func testDB(ctx context.Context, dsn string) error {
	pool, err := db.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	pool.Close()
	return nil
}

func (s *server) handleDBTest(w http.ResponseWriter, req *http.Request) {
	var body dbRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		httpapi.Problem(w, req, http.StatusBadRequest, "Bad Request", "invalid JSON body")
		return
	}
	dsn, err := body.dsn()
	if err != nil {
		httpapi.Problem(w, req, http.StatusBadRequest, "Invalid Database Settings", err.Error())
		return
	}
	if err := testDB(req.Context(), dsn); err != nil {
		httpapi.Problem(w, req, http.StatusBadRequest, "Connection Failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type smtpRequest struct {
	Host     string `json:"host"`
	Port     string `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// testSMTP mirrors the semantics of accounts' sender: implicit TLS on 465,
// STARTTLS when offered otherwise, AUTH only when credentials are given.
func testSMTP(cfg smtpRequest) error {
	if cfg.Host == "" {
		return errors.New("SMTP host is required")
	}
	port := cfg.Port
	if port == "" {
		port = "587"
	}
	addr := net.JoinHostPort(cfg.Host, port)
	dialer := net.Dialer{Timeout: 8 * time.Second}

	var client *smtp.Client
	if port == "465" {
		conn, err := tls.DialWithDialer(&dialer, "tcp", addr, &tls.Config{ServerName: cfg.Host})
		if err != nil {
			return fmt.Errorf("TLS connect: %w", err)
		}
		client, err = smtp.NewClient(conn, cfg.Host)
		if err != nil {
			return fmt.Errorf("SMTP handshake: %w", err)
		}
	} else {
		conn, err := dialer.Dial("tcp", addr)
		if err != nil {
			return fmt.Errorf("connect: %w", err)
		}
		client, err = smtp.NewClient(conn, cfg.Host)
		if err != nil {
			return fmt.Errorf("SMTP handshake: %w", err)
		}
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(&tls.Config{ServerName: cfg.Host}); err != nil {
				return fmt.Errorf("STARTTLS: %w", err)
			}
		}
	}
	defer client.Close()
	if cfg.Username != "" {
		if err := client.Auth(smtp.PlainAuth("", cfg.Username, cfg.Password, cfg.Host)); err != nil {
			return fmt.Errorf("authentication: %w", err)
		}
	}
	return client.Quit()
}

func (s *server) handleSMTPTest(w http.ResponseWriter, req *http.Request) {
	var body smtpRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		httpapi.Problem(w, req, http.StatusBadRequest, "Bad Request", "invalid JSON body")
		return
	}
	if err := testSMTP(body); err != nil {
		httpapi.Problem(w, req, http.StatusBadRequest, "SMTP Check Failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type s3Request struct {
	Endpoint       string `json:"endpoint"`
	Region         string `json:"region"`
	Bucket         string `json:"bucket"`
	AccessKey      string `json:"accessKey"`
	SecretKey      string `json:"secretKey"`
	ForcePathStyle bool   `json:"forcePathStyle"`
}

func (s *server) handleS3Test(w http.ResponseWriter, req *http.Request) {
	var body s3Request
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		httpapi.Problem(w, req, http.StatusBadRequest, "Bad Request", "invalid JSON body")
		return
	}
	_, err := storage.NewS3(storage.S3Config{
		Endpoint:       body.Endpoint,
		Region:         body.Region,
		Bucket:         body.Bucket,
		AccessKey:      body.AccessKey,
		SecretKey:      body.SecretKey,
		ForcePathStyle: body.ForcePathStyle,
	})
	if err != nil {
		httpapi.Problem(w, req, http.StatusBadRequest, "S3 Check Failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// completeRequest is the full wizard answer set.
type completeRequest struct {
	AppURL  string    `json:"appUrl"`
	Port    string    `json:"port"`
	DB      dbRequest `json:"db"`
	Storage struct {
		Driver    string    `json:"driver"` // "local" or "s3"
		LocalPath string    `json:"localPath"`
		S3        s3Request `json:"s3"`
	} `json:"storage"`
	SMTP struct {
		Enabled  bool   `json:"enabled"`
		Host     string `json:"host"`
		Port     string `json:"port"`
		Username string `json:"username"`
		Password string `json:"password"`
		From     string `json:"from"`
		FromName string `json:"fromName"`
	} `json:"smtp"`
}

func (s *server) handleComplete(w http.ResponseWriter, req *http.Request) {
	var body completeRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		httpapi.Problem(w, req, http.StatusBadRequest, "Bad Request", "invalid JSON body")
		return
	}
	dsn, err := body.DB.dsn()
	if err != nil {
		httpapi.Problem(w, req, http.StatusBadRequest, "Invalid Database Settings", err.Error())
		return
	}

	s.mu.Lock()
	if s.phase != phaseCollecting && s.phase != phaseError {
		s.mu.Unlock()
		httpapi.Problem(w, req, http.StatusConflict, "Install In Progress", "an install is already running")
		return
	}
	s.phase, s.errDetail = phaseValidating, ""
	s.mu.Unlock()

	go s.install(body, dsn)
	writeJSON(w, http.StatusAccepted, map[string]string{"phase": phaseValidating})
}

// install runs the phases the wizard renders as progress; on failure it parks
// in the error phase so the operator can adjust answers and retry.
func (s *server) install(body completeRequest, dsn string) {
	fail := func(stage string, err error) {
		s.opts.Logger.Error("setup install failed", "stage", stage, "err", err)
		s.mu.Lock()
		s.phase, s.errDetail = phaseError, stage+": "+err.Error()
		s.mu.Unlock()
	}
	setPhase := func(p string) {
		s.mu.Lock()
		s.phase = p
		s.mu.Unlock()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	pool, err := db.Connect(ctx, dsn)
	if err != nil {
		fail("database validation", err)
		return
	}
	defer pool.Close()

	setPhase(phaseWriting)
	content := renderEnv(body, dsn, GenerateToken(), GenerateToken())
	if err := writeEnvFile(".env", content); err != nil {
		fail("writing .env", err)
		return
	}

	setPhase(phaseMigrating)
	if err := db.Migrate(ctx, pool, migrations.FS); err != nil {
		fail("database migration", err)
		return
	}

	setPhase(phaseStarting)
	close(s.done)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
