package httpapi

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/stock"
)

// mountStock attaches the stock catalog surface (doc 13). Search/get/collections
// are auth-guarded (favorited flags need the caller); favorites/recents are
// per-user. The image proxy is public (the bytes are allowlisted stock images).
func mountStock(api chi.Router, st *stock.Service, acct *accounts.Service) {
	api.Group(func(r chi.Router) {
		r.Use(requireAuth(acct))
		r.Get("/stock/search", stockSearchHandler(st))
		r.Get("/stock/collections", stockCollectionsHandler(st))
		r.Get("/stock/favorites", stockFavoritesHandler(st))
		r.Post("/stock/favorites/{id}", stockToggleFavoriteHandler(st))
		r.Get("/stock/recent", stockRecentsHandler(st))
		r.Post("/stock/recent/{id}", stockRecordRecentHandler(st))
		r.Get("/stock/{id}", stockGetHandler(st))
	})
	api.Get("/stock/proxy", stockProxyHandler(st))
}

func stockProblem(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, stock.ErrNotFound):
		Problem(w, r, http.StatusNotFound, "Not Found", "stock asset not found")
	case errors.Is(err, stock.ErrBadRequest):
		Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid request")
	default:
		Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed")
	}
}

func stockSearchHandler(st *stock.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		offset, _ := strconv.Atoi(q.Get("offset"))
		query := stock.Query{
			Text: q.Get("q"), Kind: q.Get("kind"), Orientation: q.Get("orientation"),
			Color: q.Get("color"), Category: q.Get("category"), Style: q.Get("style"),
			CollectionID: q.Get("collection"), Limit: limit, Offset: offset,
		}
		u := userFrom(r.Context())
		res, err := st.Search(r.Context(), query, u.ID)
		if err != nil {
			stockProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, res)
	}
}

func stockGetHandler(st *stock.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a, err := st.Get(chi.URLParam(r, "id"))
		if err != nil {
			stockProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, a)
	}
}

func stockCollectionsHandler(st *stock.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, st.Collections())
	}
}

func stockFavoritesHandler(st *stock.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		favs, err := st.ListFavorites(r.Context(), u.ID)
		if err != nil {
			stockProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, favs)
	}
}

func stockToggleFavoriteHandler(st *stock.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		favorited, err := st.ToggleFavorite(r.Context(), u.ID, chi.URLParam(r, "id"))
		if err != nil {
			stockProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"favorited": favorited})
	}
}

func stockRecentsHandler(st *stock.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		recents, err := st.ListRecents(r.Context(), u.ID)
		if err != nil {
			stockProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, recents)
	}
}

func stockRecordRecentHandler(st *stock.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if err := st.RecordRecent(r.Context(), u.ID, chi.URLParam(r, "id")); err != nil {
			stockProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func stockProxyHandler(st *stock.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw := r.URL.Query().Get("url")
		if raw == "" {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "missing url")
			return
		}
		bytes, mime, err := st.Proxy(raw)
		if err != nil {
			stockProblem(w, r, err)
			return
		}
		w.Header().Set("Content-Type", mime)
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(bytes)
	}
}
