package scim

import (
	"errors"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// reconcile brings people's memberships in every mapped workspace to what their
// mapped groups grant (spec section 4). In an authoritative workspace everyone
// currently in it is reconciled too, so a member no mapped group wants is
// removed even if no SCIM change named them.
func (s *Server) reconcile(o *op, userIDs ...string) error {
	if len(s.cfg.Groups) == 0 {
		return nil
	}
	for _, slug := range s.cfg.Workspaces() {
		var wsID string
		err := o.tx.QueryRow(o.ctx, `SELECT id FROM "workspaces" WHERE slug = $1`, slug).Scan(&wsID)
		if errors.Is(err, pgx.ErrNoRows) {
			s.log.Warn("scim: mapped workspace does not exist; skipping", "workspace", slug)
			continue
		}
		if err != nil {
			return err
		}
		mode := s.cfg.ModeFor(slug)
		people := map[string]bool{}
		for _, id := range userIDs {
			people[id] = true
		}
		if mode == ModeAuthoritative {
			rows, err := o.tx.Query(o.ctx, `SELECT "user_id"::text FROM "workspace_members" WHERE "workspace_id" = $1`, wsID)
			if err != nil {
				return err
			}
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					rows.Close()
					return err
				}
				people[id] = true
			}
			rows.Close()
		}
		ids := make([]string, 0, len(people))
		for id := range people {
			ids = append(ids, id)
		}
		sort.Strings(ids) // deterministic order, so the last-owner guard is too
		for _, id := range ids {
			if err := s.reconcileOne(o, wsID, slug, mode, id); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Server) reconcileOne(o *op, wsID, slug string, mode Mode, userID string) error {
	var deactivated bool
	if err := o.tx.QueryRow(o.ctx, `SELECT "deactivated_at" IS NOT NULL FROM "users" WHERE id = $1`, userID).Scan(&deactivated); err != nil {
		return err
	}
	if deactivated {
		return nil // deactivation suspended their memberships; reactivation decides (FR-9)
	}
	desired, err := s.desiredRole(o, userID, slug)
	if err != nil {
		return err
	}
	var role, status string
	var managed bool
	err = o.tx.QueryRow(o.ctx, `SELECT role::text, status::text, "managed_by_scim" FROM "workspace_members" WHERE "workspace_id" = $1 AND "user_id" = $2`,
		wsID, userID).Scan(&role, &status, &managed)
	exists := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	log := func(change string, extra ...any) {
		s.audit("membership."+change, append([]any{"workspace", slug, "user_id", userID, "mode", string(mode)}, extra...)...)
	}
	if exists && !managed && mode == ModeAdditive {
		if desired != "" {
			log("skip", "reason", "created outside SCIM; additive mode leaves it alone", "role", role)
		}
		return nil
	}
	want := strings.ToUpper(string(desired))
	switch {
	case desired == "" && !exists:
		return nil
	case desired == "" && exists:
		if last, err := s.isLastOwner(o, wsID, userID, role, status); err != nil || last {
			if last {
				log("skip", "reason", "last owner of the workspace", "change", "remove")
			}
			return err
		}
		if _, err := o.tx.Exec(o.ctx, `DELETE FROM "workspace_members" WHERE "workspace_id" = $1 AND "user_id" = $2`, wsID, userID); err != nil {
			return err
		}
		log("remove", "role", role)
	case !exists:
		if _, err := o.tx.Exec(o.ctx,
			`INSERT INTO "workspace_members" (id, "workspace_id", "user_id", role, status, "joined_at", "updated_at", "managed_by_scim")
			 VALUES ($1, $2, $3, $4::"Role", 'ACTIVE', now(), now(), true)`,
			uuid.NewString(), wsID, userID, want); err != nil {
			return err
		}
		log("add", "role", want)
	case role != want || !managed:
		if role == "OWNER" && want != "OWNER" {
			if last, err := s.isLastOwner(o, wsID, userID, role, status); err != nil || last {
				if last {
					log("skip", "reason", "last owner of the workspace", "change", "demote to "+want)
				}
				return err
			}
		}
		// A pending invitation the provider now grants becomes active; any other
		// status (an admin's suspension) is the admin's to change.
		if _, err := o.tx.Exec(o.ctx,
			`UPDATE "workspace_members" SET role = $3::"Role", "managed_by_scim" = true,
			   status = CASE WHEN status = 'INVITED' THEN 'ACTIVE'::"MembershipStatus" ELSE status END,
			   "joined_at" = COALESCE("joined_at", now()), "updated_at" = now()
			 WHERE "workspace_id" = $1 AND "user_id" = $2`, wsID, userID, want); err != nil {
			return err
		}
		log("set-role", "from", role, "to", want)
	}
	return nil
}

// desiredRole is the highest role the person's mapped groups grant in the
// workspace, or "" for none.
func (s *Server) desiredRole(o *op, userID, slug string) (Role, error) {
	rows, err := o.tx.Query(o.ctx, `SELECT g."display_name" FROM "scim_group_members" m JOIN "scim_groups" g ON g.id = m."group_id" WHERE m."user_id" = $1`, userID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var best Role
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return "", err
		}
		for _, g := range s.cfg.Groups[name] {
			if g.Workspace == slug && rank[g.Role] > rank[best] {
				best = g.Role
			}
		}
	}
	return best, rows.Err()
}

// isLastOwner reports whether removing or demoting this membership would leave
// the workspace with no active owner (FR-7).
func (s *Server) isLastOwner(o *op, wsID, userID, role, status string) (bool, error) {
	if role != "OWNER" || status != "ACTIVE" {
		return false, nil
	}
	var others int
	err := o.tx.QueryRow(o.ctx, `SELECT count(*) FROM "workspace_members" WHERE "workspace_id" = $1 AND "user_id" <> $2 AND role = 'OWNER' AND status = 'ACTIVE'`,
		wsID, userID).Scan(&others)
	return others == 0, err
}
