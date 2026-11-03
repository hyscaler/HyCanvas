package scim

import (
	"context"
	"crypto/subtle"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hycanvas/backend/internal/accounts"
)

// Server serves /scim/v2. Each request runs in one database transaction, with
// an accounts.Service bound to it, so account changes, SCIM links and
// membership changes commit or roll back together.
type Server struct {
	cfg        *Config
	db         accounts.DBTX
	jwtSecret  string
	disconnect func(userID string)
	log        *slog.Logger
	// workspaceHook sets up a newly created workspace (the starter brand kit),
	// as accounts.Service.WithWorkspaceHook does for every other new account.
	workspaceHook func(ctx context.Context, workspaceID, ownerID string)
}

// WithWorkspaceHook runs fn, after commit, for the personal workspace of each
// account SCIM creates.
func (s *Server) WithWorkspaceHook(fn func(ctx context.Context, workspaceID, ownerID string)) *Server {
	s.workspaceHook = fn
	return s
}

// NewServer builds the SCIM server. A nil cfg (SCIM_TOKEN unset) gives a handler
// that answers 404 on every path. disconnect closes a person's realtime sockets
// (realtime.Hub.DisconnectUser); it is called only after the deactivating
// transaction commits, so a rolled-back request never kicks anyone.
func NewServer(cfg *Config, db accounts.DBTX, jwtSecret string, disconnect func(userID string), log *slog.Logger) *Server {
	if disconnect == nil {
		disconnect = func(string) {}
	}
	return &Server{cfg: cfg, db: db, jwtSecret: jwtSecret, disconnect: disconnect, log: log}
}

// Handler routes the SCIM endpoints. It is mounted even when SCIM is off: the
// frontend's catch-all would otherwise answer unknown paths with the app shell
// and a 200, which reads to a provider as "SCIM is here".
func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.NotFound(func(w http.ResponseWriter, _ *http.Request) { writeError(w, http.StatusNotFound, "", "not found") })
	r.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusMethodNotAllowed, "", "method not allowed")
	})
	if s.cfg == nil {
		return r
	}
	r.Use(s.requireToken)
	r.Get("/ServiceProviderConfig", serviceProviderConfig)
	r.Get("/ResourceTypes", resourceTypes)
	r.Get("/Schemas", schemas)
	r.Route("/Users", func(r chi.Router) {
		r.Get("/", s.listUsers)
		r.Post("/", s.createUser)
		r.Get("/{id}", s.getUser)
		r.Put("/{id}", s.replaceUser)
		r.Patch("/{id}", s.patchUser)
		r.Delete("/{id}", s.deleteUser)
	})
	s.mountGroups(r)
	return r
}

// requireToken accepts only `Authorization: Bearer <SCIM_TOKEN>`, compared in
// constant time. Session cookies and API keys mean nothing here.
func (s *Server) requireToken(next http.Handler) http.Handler {
	want := []byte(s.cfg.Token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || subtle.ConstantTimeCompare([]byte(got), want) != 1 {
			writeError(w, http.StatusUnauthorized, "", "a valid SCIM bearer token is required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// scimErr is a failure to report to the provider.
type scimErr struct {
	status   int
	scimType string
	detail   string
}

func (e *scimErr) Error() string { return e.detail }

func badRequest(scimType, detail string) *scimErr {
	return &scimErr{http.StatusBadRequest, scimType, detail}
}
func conflict(detail string) *scimErr {
	return &scimErr{http.StatusConflict, "uniqueness", detail}
}

var errNotFound = &scimErr{http.StatusNotFound, "", "not found"}

// op is one request's unit of work.
type op struct {
	ctx        context.Context
	tx         pgx.Tx
	acct       *accounts.Service
	disconnect []string    // user ids whose sockets to close after commit
	audits     [][]any     // audit lines to write after commit
	created    [][2]string // {workspace id, owner id} of new personal workspaces
}

// audit queues the structured line every SCIM write leaves (FR-28). It is
// written only once the request commits: a rolled-back request did nothing,
// and its log must not say otherwise.
func (o *op) audit(event string, attrs ...any) {
	o.audits = append(o.audits, append([]any{"actor", "scim", "op", event}, attrs...))
}

// run executes fn in a transaction and writes its result. A *scimErr (or any
// other error) rolls back; success commits, then closes the sockets fn queued,
// then writes status and body (no body for 204).
func (s *Server) run(w http.ResponseWriter, r *http.Request, fn func(o *op) (int, any, error)) {
	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		s.fail(w, err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	o := &op{ctx: ctx, tx: tx, acct: accounts.NewService(tx, s.jwtSecret)}
	status, body, err := fn(o)
	if err != nil {
		s.fail(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		s.fail(w, err)
		return
	}
	for _, a := range o.audits {
		s.log.Info("scim", a...)
	}
	for _, id := range o.disconnect {
		s.disconnect(id)
	}
	if s.workspaceHook != nil {
		for _, c := range o.created {
			s.workspaceHook(ctx, c[0], c[1])
		}
	}
	if status == http.StatusNoContent {
		w.WriteHeader(status)
		return
	}
	writeJSON(w, status, body)
}

func (s *Server) fail(w http.ResponseWriter, err error) {
	var se *scimErr
	var pg *pgconn.PgError
	switch {
	case errors.As(err, &se):
		writeError(w, se.status, se.scimType, se.detail)
	case errors.As(err, &pg) && pg.Code == "23505":
		// A unique index caught a race the explicit checks could not.
		writeError(w, http.StatusConflict, "uniqueness", "a resource with these unique attributes already exists")
	default:
		s.log.Error("scim request failed", "err", err)
		writeError(w, http.StatusInternalServerError, "", "internal error")
	}
}
