package scim

import "github.com/go-chi/chi/v5"

// mountGroups registers the Groups endpoint.
func (s *Server) mountGroups(chi.Router) {}

// reconcile brings the given people's workspace memberships to what their
// mapped groups grant.
func (s *Server) reconcile(*op, ...string) error { return nil }
