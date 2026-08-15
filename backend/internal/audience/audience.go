// Live audience interaction for presentations (doc 28): share-link viewers
// (anonymous allowed) ask questions, upvote them, and vote on presenter-run
// polls; the presenter moderates (answer/dismiss), launches polls, and clears
// the board between sessions. Voters are identified by a client-held random
// key, which de-duplicates votes best-effort without demanding an account.
// Vote counts are always computed from the vote tables, never denormalized.
package audience

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DBTX is the query surface (satisfied by *pgxpool.Pool and pgx.Tx).
type DBTX interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

var (
	ErrNotFound = errors.New("not found")
	ErrInvalid  = errors.New("invalid")
)

const (
	maxQuestionLen = 500
	maxNameLen     = 60
	// A voter key is a client-generated UUID used only to dedupe votes. It is
	// stored per vote, so an unbounded one turns every request into kilobytes
	// of row; anything longer than this is not a key we issued.
	maxVoterKeyLen = 100
	// Ceiling on stored questions per design. The routes are anonymous, so
	// without a ceiling a leaked link is an unbounded write into the table;
	// past it, asking fails until the presenter clears the board.
	maxQuestionsPerDesign = 500
	maxPollQLen           = 300
	maxOptionLen          = 120
	maxOptions            = 6
	minOptions            = 2
	iso                   = time.RFC3339
)

// Notifier pushes a live event to the design's presenter(s); nil = no-op.
// The realtime hub satisfies it (broadcast to every connection in the room).
type Notifier interface {
	BroadcastEvent(designID string, payload map[string]any)
}

type Service struct {
	db     DBTX
	notify Notifier
}

func NewService(db DBTX, notify Notifier) *Service {
	return &Service{db: db, notify: notify}
}

// --- models ----------------------------------------------------------------

type Question struct {
	ID         string `json:"id"`
	AuthorName string `json:"authorName"`
	Text       string `json:"text"`
	Votes      int    `json:"votes"`
	Answered   bool   `json:"answered"`
	Dismissed  bool   `json:"dismissed,omitempty"`
	CreatedAt  string `json:"createdAt"`
	// True when the requesting voterKey has upvoted this question.
	Voted bool `json:"voted,omitempty"`
}

type Poll struct {
	ID        string   `json:"id"`
	Question  string   `json:"question"`
	Options   []string `json:"options"`
	Counts    []int    `json:"counts"`
	Open      bool     `json:"open"`
	CreatedAt string   `json:"createdAt"`
	// The requesting voterKey's vote (option index), or -1.
	MyVote int `json:"myVote"`
}

// Live is the presenter's current slide (slide-follow); UpdatedAt lets the
// client age it out (a stale row means nobody is presenting).
type Live struct {
	Slide     int    `json:"slide"`
	UpdatedAt string `json:"updatedAt"`
}

// State is one fetch of everything an audience member (or presenter) needs.
type State struct {
	Questions []Question `json:"questions"`
	Polls     []Poll     `json:"polls"`
	Live      *Live      `json:"live,omitempty"`
}

// --- questions ---------------------------------------------------------------

func (s *Service) AskQuestion(ctx context.Context, designID, authorName, text string) (Question, error) {
	text = strings.TrimSpace(text)
	authorName = strings.TrimSpace(authorName)
	if text == "" || utf8.RuneCountInString(text) > maxQuestionLen || utf8.RuneCountInString(authorName) > maxNameLen {
		return Question{}, fmt.Errorf("%w: question must be 1-%d characters", ErrInvalid, maxQuestionLen)
	}
	var stored int
	if err := s.db.QueryRow(ctx, `SELECT COUNT(*) FROM "audience_questions" WHERE "design_id" = $1`, designID).Scan(&stored); err != nil {
		return Question{}, err
	}
	if stored >= maxQuestionsPerDesign {
		return Question{}, fmt.Errorf("%w: this session already has %d questions; the presenter needs to clear the board", ErrInvalid, maxQuestionsPerDesign)
	}
	id := uuid.NewString()
	row := s.db.QueryRow(ctx,
		`INSERT INTO "audience_questions" (id, "design_id", "author_name", text) VALUES ($1,$2,$3,$4) RETURNING "created_at"`,
		id, designID, authorName, text)
	var created time.Time
	if err := row.Scan(&created); err != nil {
		return Question{}, err
	}
	q := Question{ID: id, AuthorName: authorName, Text: text, CreatedAt: created.UTC().Format(iso)}
	s.emit(designID, map[string]any{"t": "audience", "kind": "question", "question": q})
	return q, nil
}

// VoteQuestion upvotes once per voter key (idempotent).
func (s *Service) VoteQuestion(ctx context.Context, designID, questionID, voterKey string) error {
	if voterKey == "" || len(voterKey) > maxVoterKeyLen {
		return fmt.Errorf("%w: missing or oversized voter key", ErrInvalid)
	}
	// Scope the write to the design so a token for design A can't vote on B.
	res, err := s.db.Exec(ctx,
		`INSERT INTO "audience_question_votes" ("question_id", "voter_key")
		 SELECT q.id, $3 FROM "audience_questions" q WHERE q.id = $1 AND q."design_id" = $2
		 ON CONFLICT DO NOTHING`,
		questionID, designID, voterKey)
	if err != nil {
		return err
	}
	if res.RowsAffected() > 0 {
		s.emit(designID, map[string]any{"t": "audience", "kind": "qa-changed"})
	}
	return nil
}

// ModerateQuestion sets answered/dismissed (presenter only; enforced above).
func (s *Service) ModerateQuestion(ctx context.Context, designID, questionID string, answered, dismissed *bool) error {
	sets := []string{}
	args := []any{questionID, designID}
	if answered != nil {
		args = append(args, *answered)
		sets = append(sets, fmt.Sprintf("answered = $%d", len(args)))
	}
	if dismissed != nil {
		args = append(args, *dismissed)
		sets = append(sets, fmt.Sprintf("dismissed = $%d", len(args)))
	}
	if len(sets) == 0 {
		return nil
	}
	res, err := s.db.Exec(ctx,
		`UPDATE "audience_questions" SET `+strings.Join(sets, ", ")+` WHERE id = $1 AND "design_id" = $2`, args...)
	if err != nil {
		return err
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	s.emit(designID, map[string]any{"t": "audience", "kind": "qa-changed"})
	return nil
}

// --- polls -------------------------------------------------------------------

func (s *Service) CreatePoll(ctx context.Context, designID, question string, options []string) (Poll, error) {
	question = strings.TrimSpace(question)
	clean := make([]string, 0, len(options))
	for _, o := range options {
		if o = strings.TrimSpace(o); o != "" {
			if utf8.RuneCountInString(o) > maxOptionLen {
				o = string([]rune(o)[:maxOptionLen])
			}
			clean = append(clean, o)
		}
	}
	if question == "" || utf8.RuneCountInString(question) > maxPollQLen || len(clean) < minOptions || len(clean) > maxOptions {
		return Poll{}, fmt.Errorf("%w: a poll needs a question and %d-%d options", ErrInvalid, minOptions, maxOptions)
	}
	raw, _ := json.Marshal(clean)
	id := uuid.NewString()
	var created time.Time
	if err := s.db.QueryRow(ctx,
		`INSERT INTO "audience_polls" (id, "design_id", question, options) VALUES ($1,$2,$3,$4) RETURNING "created_at"`,
		id, designID, question, raw).Scan(&created); err != nil {
		return Poll{}, err
	}
	p := Poll{ID: id, Question: question, Options: clean, Counts: make([]int, len(clean)), Open: true, CreatedAt: created.UTC().Format(iso), MyVote: -1}
	s.emit(designID, map[string]any{"t": "audience", "kind": "poll", "poll": p})
	return p, nil
}

func (s *Service) SetPollOpen(ctx context.Context, designID, pollID string, open bool) error {
	res, err := s.db.Exec(ctx, `UPDATE "audience_polls" SET open = $3 WHERE id = $1 AND "design_id" = $2`, pollID, designID, open)
	if err != nil {
		return err
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	s.emit(designID, map[string]any{"t": "audience", "kind": "poll-changed"})
	return nil
}

// VotePoll records (or changes) the voter's choice while the poll is open.
func (s *Service) VotePoll(ctx context.Context, designID, pollID, voterKey string, optionIdx int) error {
	if voterKey == "" || len(voterKey) > maxVoterKeyLen || optionIdx < 0 {
		return fmt.Errorf("%w: missing voter key or option", ErrInvalid)
	}
	// Validate poll + open + option bounds in one read, design-scoped.
	var open bool
	var raw []byte
	err := s.db.QueryRow(ctx, `SELECT open, options FROM "audience_polls" WHERE id = $1 AND "design_id" = $2`, pollID, designID).Scan(&open, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	var opts []string
	_ = json.Unmarshal(raw, &opts)
	if !open {
		return fmt.Errorf("%w: this poll is closed", ErrInvalid)
	}
	if optionIdx >= len(opts) {
		return fmt.Errorf("%w: no such option", ErrInvalid)
	}
	_, err = s.db.Exec(ctx,
		`INSERT INTO "audience_poll_votes" ("poll_id", "voter_key", "option_idx") VALUES ($1,$2,$3)
		 ON CONFLICT ("poll_id", "voter_key") DO UPDATE SET "option_idx" = EXCLUDED."option_idx"`,
		pollID, voterKey, optionIdx)
	if err != nil {
		return err
	}
	s.emit(designID, map[string]any{"t": "audience", "kind": "poll-changed"})
	return nil
}

// --- reads -------------------------------------------------------------------

// GetState returns questions + polls with computed counts. includeHidden shows
// dismissed questions (presenter view); voterKey personalizes Voted/MyVote.
func (s *Service) GetState(ctx context.Context, designID, voterKey string, includeHidden bool) (State, error) {
	st := State{Questions: []Question{}, Polls: []Poll{}}
	// A key longer than one we issue cannot match a stored vote; treat it as
	// absent rather than shipping kilobytes into every comparison. Same cap the
	// vote paths enforce, so the read and write sides agree.
	if len(voterKey) > maxVoterKeyLen {
		voterKey = ""
	}

	qrows, err := s.db.Query(ctx, `
		SELECT q.id, q."author_name", q.text, q.answered, q.dismissed, q."created_at",
		       (SELECT COUNT(*) FROM "audience_question_votes" v WHERE v."question_id" = q.id) AS votes,
		       EXISTS(SELECT 1 FROM "audience_question_votes" v WHERE v."question_id" = q.id AND v."voter_key" = $2) AS voted
		FROM "audience_questions" q
		WHERE q."design_id" = $1 AND ($3 OR NOT q.dismissed)
		ORDER BY votes DESC, q."created_at" ASC`, designID, voterKey, includeHidden)
	if err != nil {
		return st, err
	}
	defer qrows.Close()
	for qrows.Next() {
		var q Question
		var created time.Time
		if err := qrows.Scan(&q.ID, &q.AuthorName, &q.Text, &q.Answered, &q.Dismissed, &created, &q.Votes, &q.Voted); err != nil {
			return st, err
		}
		q.CreatedAt = created.UTC().Format(iso)
		st.Questions = append(st.Questions, q)
	}
	if err := qrows.Err(); err != nil {
		return st, err
	}

	prows, err := s.db.Query(ctx, `
		SELECT p.id, p.question, p.options, p.open, p."created_at",
		       COALESCE((SELECT v."option_idx" FROM "audience_poll_votes" v WHERE v."poll_id" = p.id AND v."voter_key" = $2), -1) AS my_vote
		FROM "audience_polls" p
		WHERE p."design_id" = $1
		ORDER BY p."created_at" DESC`, designID, voterKey)
	if err != nil {
		return st, err
	}
	defer prows.Close()
	polls := []Poll{}
	for prows.Next() {
		var p Poll
		var raw []byte
		var created time.Time
		if err := prows.Scan(&p.ID, &p.Question, &raw, &p.Open, &created, &p.MyVote); err != nil {
			return st, err
		}
		_ = json.Unmarshal(raw, &p.Options)
		p.Counts = make([]int, len(p.Options))
		p.CreatedAt = created.UTC().Format(iso)
		polls = append(polls, p)
	}
	if err := prows.Err(); err != nil {
		return st, err
	}
	// Fill per-option counts (one query across all the design's polls).
	crows, err := s.db.Query(ctx, `
		SELECT v."poll_id", v."option_idx", COUNT(*)
		FROM "audience_poll_votes" v
		JOIN "audience_polls" p ON p.id = v."poll_id"
		WHERE p."design_id" = $1
		GROUP BY v."poll_id", v."option_idx"`, designID)
	if err != nil {
		return st, err
	}
	defer crows.Close()
	byID := map[string]*Poll{}
	for i := range polls {
		byID[polls[i].ID] = &polls[i]
	}
	for crows.Next() {
		var pid string
		var idx, n int
		if err := crows.Scan(&pid, &idx, &n); err != nil {
			return st, err
		}
		if p := byID[pid]; p != nil && idx >= 0 && idx < len(p.Counts) {
			p.Counts[idx] = n
		}
	}
	if err := crows.Err(); err != nil {
		return st, err
	}
	st.Polls = polls

	// Presenter live position (slide-follow), when one is recorded.
	var slide int
	var at time.Time
	err = s.db.QueryRow(ctx, `SELECT "slide_index", "updated_at" FROM "audience_live" WHERE "design_id" = $1`, designID).Scan(&slide, &at)
	if err == nil {
		st.Live = &Live{Slide: slide, UpdatedAt: at.UTC().Format(iso)}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return st, err
	}
	return st, nil
}

// SetLivePosition records the presenter's current slide (-1 clears: the
// presentation ended). Fanned out so connected peers hear it instantly; the
// anonymous audience picks it up on its next state poll.
// maxSlideIndex bounds the published position: the column is INT, and a value
// past its range would surface as a 500 instead of a clean rejection.
const maxSlideIndex = 100_000

func (s *Service) SetLivePosition(ctx context.Context, designID string, slide int) error {
	if slide > maxSlideIndex {
		return fmt.Errorf("%w: slide index out of range", ErrInvalid)
	}
	if slide < -1 {
		return fmt.Errorf("%w: slide index out of range", ErrInvalid)
	}
	if slide < 0 { // exactly -1: the presenter left
		if _, err := s.db.Exec(ctx, `DELETE FROM "audience_live" WHERE "design_id" = $1`, designID); err != nil {
			return err
		}
		s.emit(designID, map[string]any{"t": "audience", "kind": "live", "slide": -1})
		return nil
	}
	_, err := s.db.Exec(ctx,
		`INSERT INTO "audience_live" ("design_id", "slide_index", "updated_at") VALUES ($1, $2, now())
		 ON CONFLICT ("design_id") DO UPDATE SET "slide_index" = EXCLUDED."slide_index", "updated_at" = now()`,
		designID, slide)
	if err != nil {
		return err
	}
	s.emit(designID, map[string]any{"t": "audience", "kind": "live", "slide": slide})
	return nil
}

// Clear wipes the design's audience board (presenter, between sessions).
func (s *Service) Clear(ctx context.Context, designID string) error {
	// One statement: a half-cleared board (questions gone, polls still up) is a
	// confusing state to hand a presenter mid-session.
	if _, err := s.db.Exec(ctx,
		`WITH q AS (DELETE FROM "audience_questions" WHERE "design_id" = $1)
		 DELETE FROM "audience_polls" WHERE "design_id" = $1`, designID); err != nil {
		return err
	}
	s.emit(designID, map[string]any{"t": "audience", "kind": "cleared"})
	return nil
}

// React fans an ephemeral emoji straight to the room (never stored).
func (s *Service) React(designID, emoji string) error {
	// A tight allowlist keeps the overlay predictable and injection-free.
	allowed := map[string]bool{"👏": true, "❤️": true, "😂": true, "🎉": true, "🤯": true, "👍": true}
	if !allowed[emoji] {
		return fmt.Errorf("%w: unsupported reaction", ErrInvalid)
	}
	s.emit(designID, map[string]any{"t": "audience", "kind": "reaction", "emoji": emoji})
	return nil
}

func (s *Service) emit(designID string, payload map[string]any) {
	if s.notify != nil {
		s.notify.BroadcastEvent(designID, payload)
	}
}
