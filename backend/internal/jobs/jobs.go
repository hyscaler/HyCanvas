// Package jobs is an in-memory, owner-scoped job registry. The Go backend runs
// long work (export, convert, bulk create) inline in the request rather than on
// a Redis/BullMQ queue, so by the time a POST returns the work is already done
// and the job is recorded as completed or failed. Clients still poll
// GET /api/v1/jobs/:id (the unchanged frontend contract), which returns the
// recorded status immediately. A job may carry a stored blob reference so a
// separate download route can stream the result (video/doc export).
//
// State is process-local: it does not survive a restart and is not shared across
// instances. That matches the single-binary deploy; a multi-instance deploy that
// needs durable cross-node job status would reintroduce a shared store.
package jobs

import (
	"sync"
	"time"

	"github.com/google/uuid"
)

// Status mirrors the SDK JobStatusView status union.
type Status string

const (
	StatusQueued    Status = "queued"
	StatusActive    Status = "active"
	StatusCompleted Status = "completed"
	StatusFailed    Status = "failed"
)

// Blob references a stored result a download route can stream.
type Blob struct {
	Key         string // storage key
	ContentType string
	Filename    string
}

// Job is a single tracked unit of work, scoped to the user that created it.
type Job struct {
	ID          string
	Name        string
	OwnerID     string
	Status      Status
	Result      any
	Error       string
	Attempts    int
	MaxAttempts int
	CreatedAt   time.Time
	UpdatedAt   time.Time
	Blob        *Blob
}

// View is the public JSON shape (matches the SDK JobStatusView).
type View struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Status      Status `json:"status"`
	Result      any    `json:"result,omitempty"`
	Error       string `json:"error,omitempty"`
	Attempts    int    `json:"attempts"`
	MaxAttempts int    `json:"maxAttempts"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z07:00") }

// View renders the job for the API.
func (j *Job) View() View {
	return View{
		ID: j.ID, Name: j.Name, Status: j.Status, Result: j.Result, Error: j.Error,
		Attempts: j.Attempts, MaxAttempts: j.MaxAttempts,
		CreatedAt: iso(j.CreatedAt), UpdatedAt: iso(j.UpdatedAt),
	}
}

// Registry holds jobs in memory, guarded by a mutex.
type Registry struct {
	mu sync.RWMutex
	m  map[string]*Job
}

func NewRegistry() *Registry { return &Registry{m: map[string]*Job{}} }

// Start creates an active job owned by userID and returns it.
func (r *Registry) Start(userID, name string) *Job {
	now := time.Now()
	j := &Job{
		ID: uuid.NewString(), Name: name, OwnerID: userID, Status: StatusActive,
		Attempts: 1, MaxAttempts: 1, CreatedAt: now, UpdatedAt: now,
	}
	r.mu.Lock()
	r.m[j.ID] = j
	r.mu.Unlock()
	return j
}

// Complete marks a job done with a result and optional downloadable blob.
func (r *Registry) Complete(id string, result any, blob *Blob) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if j := r.m[id]; j != nil {
		j.Status = StatusCompleted
		j.Result = result
		j.Blob = blob
		j.UpdatedAt = time.Now()
	}
}

// Fail marks a job failed with a message.
func (r *Registry) Fail(id, msg string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if j := r.m[id]; j != nil {
		j.Status = StatusFailed
		j.Error = msg
		j.UpdatedAt = time.Now()
	}
}

// Get returns the job if it exists and belongs to userID. The ok=false result
// is used for both missing and not-owned, so the endpoint is not an existence
// oracle and never leaks another tenant's job payload.
func (r *Registry) Get(userID, id string) (*Job, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	j := r.m[id]
	if j == nil || j.OwnerID != userID {
		return nil, false
	}
	return j, true
}
