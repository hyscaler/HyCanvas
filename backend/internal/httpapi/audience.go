// Live audience HTTP surface (doc 28). Two sides of one feature:
//
//	Audience (share link, anonymous allowed): everything hangs off the link
//	token - `/links/{token}/audience/...` - resolved through the sharing
//	service exactly like the shared viewer's file fetch (password links pass
//	the password in the body). Viewers ask/upvote questions, vote on open
//	polls, and send allowlisted emoji reactions.
//
//	Presenter (member auth on the design): moderates questions, launches and
//	closes polls, clears the board between sessions.
//
// Every mutation fans out over the realtime hub so the presenter sees it live;
// the audience UI polls its state (viewers hold no socket).
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/audience"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/sharing"
)

func mountAudience(api chi.Router, aud *audience.Service, sh *sharing.Service, p *persistence.Service, acct *accounts.Service) {
	// Audience side: token-scoped, no account required. Each handler resolves
	// the token fresh (revoked/expired links stop working immediately).
	// Anonymous and unauthenticated: every one of these is rate-limited per
	// (client, token). See audience_guard.go.
	api.Post("/links/{token}/audience/questions", audienceWriteLimit(audienceAskHandler(aud, sh, acct)))
	api.Post("/links/{token}/audience/questions/{qid}/vote", audienceWriteLimit(audienceVoteQuestionHandler(aud, sh, acct)))
	api.Post("/links/{token}/audience/polls/{pid}/vote", audienceWriteLimit(audienceVotePollHandler(aud, sh, acct)))
	api.Post("/links/{token}/audience/react", audienceWriteLimit(audienceReactHandler(aud, sh, acct)))
	// The state POST is a READ (viewers poll it for slide-follow and the board),
	// so it gets the read budget.
	api.Post("/links/{token}/audience/state", audienceReadLimit(audienceStateHandler(aud, sh, acct)))

	// Presenter side: member-gated design routes.
	api.With(requireAuth(acct)).Get("/designs/{id}/audience/state", presenterStateHandler(aud, p, acct))
	api.With(requireAuth(acct)).Post("/designs/{id}/audience/questions/{qid}/moderate", presenterModerateHandler(aud, p, acct))
	api.With(requireAuth(acct)).Post("/designs/{id}/audience/polls", presenterCreatePollHandler(aud, p, acct))
	api.With(requireAuth(acct)).Post("/designs/{id}/audience/polls/{pid}/open", presenterPollOpenHandler(aud, p, acct))
	api.With(requireAuth(acct)).Post("/designs/{id}/audience/clear", presenterClearHandler(aud, p, acct))
	api.With(requireAuth(acct)).Post("/designs/{id}/audience/live", presenterLiveHandler(aud, p, acct))
}

func audienceProblem(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, audience.ErrNotFound):
		Problem(w, r, http.StatusNotFound, "Not Found", "not found")
	case errors.Is(err, audience.ErrInvalid):
		Problem(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", err.Error())
	default:
		Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed")
	}
}

// resolveAudienceDesign authenticates a link token (+ optional password /
// signed-in user) to the design it shares. Any resolvable role may interact:
// audience participation is a VIEW-level capability.
func resolveAudienceDesign(r *http.Request, sh *sharing.Service, acct *accounts.Service, password string) (string, error) {
	token := chi.URLParam(r, "token")
	// Password links verify with scrypt, and viewers poll this every few
	// seconds; a recent success for this exact token+password is reused rather
	// than re-deriving. Only successes are cached, so a wrong password still
	// pays full price every attempt.
	now := time.Now()
	if designID, ok := cachedResolve(token, password, now); ok {
		return designID, nil
	}
	userID := optionalUserID(r, acct)
	resolved, err := sh.ResolveLink(r.Context(), token, sharing.ResolveLinkOpts{Password: password, UserID: userID})
	if err != nil {
		return "", err
	}
	// Only memoize the anonymous case: a resolution that depended on WHO is
	// signed in must not be handed to the next caller.
	if userID == "" {
		rememberResolve(token, password, resolved.DesignID, now)
	}
	return resolved.DesignID, nil
}

func audienceAskHandler(aud *audience.Service, sh *sharing.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Password string `json:"password"`
			Name     string `json:"name"`
			Text     string `json:"text"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		designID, err := resolveAudienceDesign(r, sh, acct, body.Password)
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		q, err := aud.AskQuestion(r.Context(), designID, body.Name, body.Text)
		if err != nil {
			audienceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, q)
	}
}

func audienceVoteQuestionHandler(aud *audience.Service, sh *sharing.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Password string `json:"password"`
			VoterKey string `json:"voterKey"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		designID, err := resolveAudienceDesign(r, sh, acct, body.Password)
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		if err := aud.VoteQuestion(r.Context(), designID, chi.URLParam(r, "qid"), body.VoterKey); err != nil {
			audienceProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func audienceVotePollHandler(aud *audience.Service, sh *sharing.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Password string `json:"password"`
			VoterKey string `json:"voterKey"`
			Option   int    `json:"option"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		designID, err := resolveAudienceDesign(r, sh, acct, body.Password)
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		if err := aud.VotePoll(r.Context(), designID, chi.URLParam(r, "pid"), body.VoterKey, body.Option); err != nil {
			audienceProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func audienceReactHandler(aud *audience.Service, sh *sharing.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Password string `json:"password"`
			Emoji    string `json:"emoji"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		designID, err := resolveAudienceDesign(r, sh, acct, body.Password)
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		if err := aud.React(designID, body.Emoji); err != nil {
			audienceProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// audienceStateHandler is a POST (the password must not ride a URL); it
// returns the visible questions + polls personalized by voterKey.
func audienceStateHandler(aud *audience.Service, sh *sharing.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Password string `json:"password"`
			VoterKey string `json:"voterKey"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		designID, err := resolveAudienceDesign(r, sh, acct, body.Password)
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		st, err := aud.GetState(r.Context(), designID, body.VoterKey, false)
		if err != nil {
			audienceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, st)
	}
}

// --- presenter ---------------------------------------------------------------

func presenterStateHandler(aud *audience.Service, p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if _, err := authorizeDesign(r, p, acct, id, "member"); err != nil {
			authProblem(w, r, err)
			return
		}
		st, err := aud.GetState(r.Context(), id, "", true)
		if err != nil {
			audienceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, st)
	}
}

func presenterModerateHandler(aud *audience.Service, p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if _, err := authorizeDesign(r, p, acct, id, "member"); err != nil {
			authProblem(w, r, err)
			return
		}
		var body struct {
			Answered  *bool `json:"answered"`
			Dismissed *bool `json:"dismissed"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		if err := aud.ModerateQuestion(r.Context(), id, chi.URLParam(r, "qid"), body.Answered, body.Dismissed); err != nil {
			audienceProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func presenterCreatePollHandler(aud *audience.Service, p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if _, err := authorizeDesign(r, p, acct, id, "member"); err != nil {
			authProblem(w, r, err)
			return
		}
		var body struct {
			Question string   `json:"question"`
			Options  []string `json:"options"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		poll, err := aud.CreatePoll(r.Context(), id, body.Question, body.Options)
		if err != nil {
			audienceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, poll)
	}
}

func presenterPollOpenHandler(aud *audience.Service, p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if _, err := authorizeDesign(r, p, acct, id, "member"); err != nil {
			authProblem(w, r, err)
			return
		}
		var body struct {
			Open bool `json:"open"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		if err := aud.SetPollOpen(r.Context(), id, chi.URLParam(r, "pid"), body.Open); err != nil {
			audienceProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// presenterLiveHandler records the presenter's current slide for slide-follow
// (-1 clears when the presentation ends).
func presenterLiveHandler(aud *audience.Service, p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if _, err := authorizeDesign(r, p, acct, id, "member"); err != nil {
			authProblem(w, r, err)
			return
		}
		var body struct {
			Slide int `json:"slide"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		if err := aud.SetLivePosition(r.Context(), id, body.Slide); err != nil {
			audienceProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func presenterClearHandler(aud *audience.Service, p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if _, err := authorizeDesign(r, p, acct, id, "member"); err != nil {
			authProblem(w, r, err)
			return
		}
		if err := aud.Clear(r.Context(), id); err != nil {
			audienceProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
