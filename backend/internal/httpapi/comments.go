package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/comments"
)

var commentFilters = map[string]bool{"open": true, "resolved": true, "mine": true, "assigned": true, "all": true}

// mountComments attaches the comments + tasks surface (doc 17 slice B), all
// JWT-guarded; capability checks are delegated to the service.
func mountComments(api chi.Router, cm *comments.Service, acct *accounts.Service) {
	api.Group(func(r chi.Router) {
		r.Use(requireAuth(acct))
		r.Get("/designs/{id}/comments", commentListHandler(cm))
		r.Post("/designs/{id}/comments", commentCreateHandler(cm))
		r.Get("/designs/{id}/mentionable", commentMentionableHandler(cm))
		r.Post("/comments/{cid}/replies", commentReplyHandler(cm))
		r.Patch("/comments/{cid}", commentEditHandler(cm))
		r.Post("/comments/{cid}/resolve", commentResolveHandler(cm))
		r.Delete("/comments/{cid}", commentDeleteHandler(cm))
		r.Post("/comments/{cid}/reactions", commentReactHandler(cm))
		r.Put("/comments/{cid}/task", commentTaskHandler(cm))
		r.Get("/me/tasks", commentMyTasksHandler(cm))
		r.Get("/me/mentions", commentMyMentionsHandler(cm))
	})
}

func commentProblem(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, comments.ErrForbidden):
		problemWithCode(w, r, http.StatusForbidden, "Forbidden", "you do not have permission for this action", "forbidden_action")
	case errors.Is(err, comments.ErrNotFound):
		problemWithCode(w, r, http.StatusNotFound, "Not Found", "not found", "not_found")
	case errors.Is(err, comments.ErrBadRequest):
		problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid request", "invalid_request")
	default:
		problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed", "request_failed")
	}
}

func commentListHandler(cm *comments.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		filter := r.URL.Query().Get("filter")
		if !commentFilters[filter] {
			filter = "all"
		}
		u := userFrom(r.Context())
		threads, err := cm.ListThreads(r.Context(), chi.URLParam(r, "id"), u.ID, filter)
		if err != nil {
			commentProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, threads)
	}
}

func commentCreateHandler(cm *comments.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Anchor   comments.Anchor `json:"anchor"`
			Body     string          `json:"body"`
			Mentions []string        `json:"mentions"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		u := userFrom(r.Context())
		v, err := cm.CreateComment(r.Context(), chi.URLParam(r, "id"), u.ID, comments.CreateInput{Anchor: body.Anchor, Body: body.Body, Mentions: body.Mentions})
		if err != nil {
			commentProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, v)
	}
}

func commentMentionableHandler(cm *comments.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		people, err := cm.ListMentionable(r.Context(), chi.URLParam(r, "id"), u.ID)
		if err != nil {
			commentProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, people)
	}
}

func commentReplyHandler(cm *comments.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Body     string   `json:"body"`
			Mentions []string `json:"mentions"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		u := userFrom(r.Context())
		v, err := cm.Reply(r.Context(), chi.URLParam(r, "cid"), u.ID, comments.ReplyInput{Body: body.Body, Mentions: body.Mentions})
		if err != nil {
			commentProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, v)
	}
}

func commentEditHandler(cm *comments.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var raw map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		in := comments.EditInput{}
		if v, ok := raw["body"]; ok {
			_ = json.Unmarshal(v, &in.Body)
		}
		if v, ok := raw["mentions"]; ok {
			in.MentionsSet = true
			_ = json.Unmarshal(v, &in.Mentions)
		}
		u := userFrom(r.Context())
		view, err := cm.EditBody(r.Context(), chi.URLParam(r, "cid"), u.ID, in)
		if err != nil {
			commentProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, view)
	}
}

func commentResolveHandler(cm *comments.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Resolved bool `json:"resolved"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		u := userFrom(r.Context())
		v, err := cm.SetResolved(r.Context(), chi.URLParam(r, "cid"), u.ID, body.Resolved)
		if err != nil {
			commentProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}

func commentDeleteHandler(cm *comments.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if err := cm.DeleteComment(r.Context(), chi.URLParam(r, "cid"), u.ID); err != nil {
			commentProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func commentReactHandler(cm *comments.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Emoji string `json:"emoji"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		u := userFrom(r.Context())
		v, err := cm.ToggleReaction(r.Context(), chi.URLParam(r, "cid"), u.ID, body.Emoji)
		if err != nil {
			commentProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}

func commentTaskHandler(cm *comments.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var raw map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		in := comments.TaskInput{}
		if v, ok := raw["assigneeId"]; ok {
			in.AssigneeIDSet = true
			_ = json.Unmarshal(v, &in.AssigneeID)
		}
		if v, ok := raw["status"]; ok {
			in.StatusSet = true
			_ = json.Unmarshal(v, &in.Status)
		}
		if v, ok := raw["dueAt"]; ok {
			in.DueAtSet = true
			_ = json.Unmarshal(v, &in.DueAt)
		}
		u := userFrom(r.Context())
		view, err := cm.SetTask(r.Context(), chi.URLParam(r, "cid"), u.ID, in)
		if err != nil {
			commentProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, view)
	}
}

func commentMyTasksHandler(cm *comments.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		tasks, err := cm.MyTasks(r.Context(), u.ID, r.URL.Query().Get("status"))
		if err != nil {
			commentProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, tasks)
	}
}

func commentMyMentionsHandler(cm *comments.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		mentions, err := cm.MyMentions(r.Context(), u.ID)
		if err != nil {
			commentProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, mentions)
	}
}
