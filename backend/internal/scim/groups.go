package scim

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// mountGroups registers the Groups endpoint (spec section 6).
func (s *Server) mountGroups(r chi.Router) {
	r.Route("/Groups", func(r chi.Router) {
		r.Get("/", s.listGroups)
		r.Post("/", s.createGroup)
		r.Get("/{id}", s.getGroup)
		r.Put("/{id}", s.replaceGroup)
		r.Patch("/{id}", s.patchGroup)
		r.Delete("/{id}", s.deleteGroup)
	})
}

type groupRec struct {
	ID          string
	DisplayName string
	ExternalID  *string
	Created     time.Time
	Updated     time.Time
	Members     []groupMember
}

type groupMember struct {
	UserID   string // HyCanvas account
	SCIMID   string // the member's SCIM user id, "" if its link was detached
	UserName string
}

func getGroupRec(ctx context.Context, tx pgx.Tx, id string) (*groupRec, error) {
	if _, err := uuid.Parse(id); err != nil {
		return nil, errNotFound
	}
	var g groupRec
	err := tx.QueryRow(ctx, `SELECT id, "display_name", "external_id", "created_at", "updated_at" FROM "scim_groups" WHERE id = $1`, id).
		Scan(&g.ID, &g.DisplayName, &g.ExternalID, &g.Created, &g.Updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	g.Members, err = groupMembers(ctx, tx, g.ID)
	return &g, err
}

func groupMembers(ctx context.Context, tx pgx.Tx, groupID string) ([]groupMember, error) {
	rows, err := tx.Query(ctx, `SELECT m."user_id", COALESCE(su.id::text, ''), COALESCE(su."user_name", '')
		FROM "scim_group_members" m LEFT JOIN "scim_users" su ON su."user_id" = m."user_id" AND su."deleted_at" IS NULL
		WHERE m."group_id" = $1 ORDER BY su."user_name"`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []groupMember
	for rows.Next() {
		var m groupMember
		if err := rows.Scan(&m.UserID, &m.SCIMID, &m.UserName); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (g *groupRec) resource() map[string]any {
	members := []map[string]any{}
	for _, m := range g.Members {
		if m.SCIMID != "" { // a detached link is not a resource the provider can name
			members = append(members, map[string]any{"value": m.SCIMID, "display": m.UserName})
		}
	}
	out := map[string]any{
		"schemas":     []string{schemaGroup},
		"id":          g.ID,
		"displayName": g.DisplayName,
		"members":     members,
		"meta": map[string]any{
			"resourceType": "Group",
			"created":      g.Created.UTC().Format(time.RFC3339),
			"lastModified": g.Updated.UTC().Format(time.RFC3339),
			"location":     "/scim/v2/Groups/" + g.ID,
		},
	}
	if g.ExternalID != nil {
		out["externalId"] = *g.ExternalID
	}
	return out
}

// resolveMembers maps SCIM user ids to HyCanvas accounts. Unknown, detached and
// malformed ids are dropped (logged), never a 400: one stale reference must not
// block every later change to the group (FR-23).
func (s *Server) resolveMembers(o *op, values []string) ([]string, error) {
	var ids []string
	for _, v := range values {
		if _, err := uuid.Parse(v); err == nil {
			ids = append(ids, v)
		} else {
			s.log.Warn("scim: ignoring malformed group member", "value", v)
		}
	}
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := o.tx.Query(o.ctx, `SELECT id::text, "user_id" FROM "scim_users" WHERE id = ANY($1::uuid[]) AND "deleted_at" IS NULL`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	found := map[string]string{}
	for rows.Next() {
		var sid, uid string
		if err := rows.Scan(&sid, &uid); err != nil {
			return nil, err
		}
		found[sid] = uid
	}
	var out []string
	for _, id := range ids {
		if uid, ok := found[id]; ok {
			out = append(out, uid)
		} else {
			s.log.Warn("scim: ignoring unknown group member", "value", id)
		}
	}
	return out, rows.Err()
}

type groupIn struct {
	DisplayName string `json:"displayName"`
	ExternalID  string `json:"externalId"`
	Members     []struct {
		Value string `json:"value"`
	} `json:"members"`
}

func (in *groupIn) memberValues() []string {
	out := make([]string, 0, len(in.Members))
	for _, m := range in.Members {
		out = append(out, m.Value)
	}
	return out
}

func readGroupIn(r *http.Request) (*groupIn, []byte, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return nil, nil, badRequest("invalidSyntax", "unreadable body")
	}
	var in groupIn
	if json.Unmarshal(body, &in) != nil {
		return nil, nil, badRequest("invalidSyntax", "malformed Group")
	}
	in.DisplayName = strings.TrimSpace(in.DisplayName)
	return &in, body, nil
}

func (s *Server) listGroups(w http.ResponseWriter, r *http.Request) {
	where, args := "true", []any{}
	if f := r.URL.Query().Get("filter"); f != "" {
		attr, value, err := parseFilter(f, []string{"displayName", "externalId"})
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalidFilter", "supported filters: displayName or externalId eq \"...\"")
			return
		}
		where, args = map[string]string{"displayName": `"display_name" = $1`, "externalId": `"external_id" = $1`}[attr], []any{value}
	}
	start, count := paging(r.URL.Query())
	s.run(w, r, func(o *op) (int, any, error) {
		var total int
		if err := o.tx.QueryRow(o.ctx, `SELECT count(*) FROM "scim_groups" WHERE `+where, args...).Scan(&total); err != nil {
			return 0, nil, err
		}
		n := len(args)
		rows, err := o.tx.Query(o.ctx, `SELECT id FROM "scim_groups" WHERE `+where+` ORDER BY "created_at", id OFFSET $`+
			strconv.Itoa(n+1)+` LIMIT $`+strconv.Itoa(n+2), append(args, start-1, count)...)
		if err != nil {
			return 0, nil, err
		}
		var ids []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return 0, nil, err
			}
			ids = append(ids, id)
		}
		rows.Close()
		res := make([]any, 0, len(ids))
		for _, id := range ids {
			g, err := getGroupRec(o.ctx, o.tx, id)
			if err != nil {
				return 0, nil, err
			}
			res = append(res, g.resource())
		}
		return http.StatusOK, listResponse(res, total, start), nil
	})
}

func (s *Server) getGroup(w http.ResponseWriter, r *http.Request) {
	s.run(w, r, func(o *op) (int, any, error) {
		g, err := getGroupRec(o.ctx, o.tx, chi.URLParam(r, "id"))
		if err != nil {
			return 0, nil, err
		}
		return http.StatusOK, g.resource(), nil
	})
}

func (s *Server) createGroup(w http.ResponseWriter, r *http.Request) {
	in, _, err := readGroupIn(r)
	if err != nil {
		s.fail(w, err)
		return
	}
	if in.DisplayName == "" {
		s.fail(w, badRequest("invalidValue", "displayName is required"))
		return
	}
	s.run(w, r, func(o *op) (int, any, error) {
		var exists bool
		if err := o.tx.QueryRow(o.ctx, `SELECT EXISTS (SELECT 1 FROM "scim_groups" WHERE "display_name" = $1)`, in.DisplayName).Scan(&exists); err != nil {
			return 0, nil, err
		}
		if exists {
			return 0, nil, conflict("a group with this displayName already exists")
		}
		id := uuid.NewString()
		if _, err := o.tx.Exec(o.ctx, `INSERT INTO "scim_groups" (id, "display_name", "external_id") VALUES ($1, $2, $3)`,
			id, in.DisplayName, optional(in.ExternalID)); err != nil {
			return 0, nil, err
		}
		members, err := s.resolveMembers(o, in.memberValues())
		if err != nil {
			return 0, nil, err
		}
		if err := setGroupMembers(o, id, members); err != nil {
			return 0, nil, err
		}
		o.audit("group.create", "scim_id", id, "display_name", in.DisplayName, "members", len(members))
		if err := s.reconcile(o, members...); err != nil {
			return 0, nil, err
		}
		g, err := getGroupRec(o.ctx, o.tx, id)
		if err != nil {
			return 0, nil, err
		}
		return http.StatusCreated, g.resource(), nil
	})
}

func (s *Server) replaceGroup(w http.ResponseWriter, r *http.Request) {
	in, _, err := readGroupIn(r)
	if err != nil {
		s.fail(w, err)
		return
	}
	s.run(w, r, func(o *op) (int, any, error) {
		g, err := getGroupRec(o.ctx, o.tx, chi.URLParam(r, "id"))
		if err != nil {
			return 0, nil, err
		}
		members, err := s.resolveMembers(o, in.memberValues())
		if err != nil {
			return 0, nil, err
		}
		name := g.DisplayName
		if in.DisplayName != "" {
			name = in.DisplayName
		}
		if err := s.writeGroup(o, g, name, optional(in.ExternalID), members); err != nil {
			return 0, nil, err
		}
		g, err = getGroupRec(o.ctx, o.tx, g.ID)
		if err != nil {
			return 0, nil, err
		}
		return http.StatusOK, g.resource(), nil
	})
}

// writeGroup sets a group's name, externalId and members, then reconciles
// everyone who was or is a member (a rename can change what every member gets).
func (s *Server) writeGroup(o *op, g *groupRec, name string, ext *string, members []string) error {
	if name != g.DisplayName {
		var taken bool
		if err := o.tx.QueryRow(o.ctx, `SELECT EXISTS (SELECT 1 FROM "scim_groups" WHERE "display_name" = $1 AND id <> $2)`, name, g.ID).Scan(&taken); err != nil {
			return err
		}
		if taken {
			return conflict("a group with this displayName already exists")
		}
	}
	if _, err := o.tx.Exec(o.ctx, `UPDATE "scim_groups" SET "display_name" = $2, "external_id" = COALESCE($3, "external_id"), "updated_at" = now() WHERE id = $1`,
		g.ID, name, ext); err != nil {
		return err
	}
	if err := setGroupMembers(o, g.ID, members); err != nil {
		return err
	}
	o.audit("group.update", "scim_id", g.ID, "display_name", name, "members", len(members))
	affected := members
	for _, m := range g.Members {
		affected = append(affected, m.UserID)
	}
	return s.reconcile(o, affected...)
}

func setGroupMembers(o *op, groupID string, userIDs []string) error {
	if _, err := o.tx.Exec(o.ctx, `DELETE FROM "scim_group_members" WHERE "group_id" = $1`, groupID); err != nil {
		return err
	}
	if len(userIDs) == 0 {
		return nil
	}
	_, err := o.tx.Exec(o.ctx, `INSERT INTO "scim_group_members" ("group_id", "user_id")
		SELECT $1, u FROM unnest($2::uuid[]) AS u ON CONFLICT DO NOTHING`, groupID, userIDs)
	return err
}

func (s *Server) patchGroup(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		s.fail(w, badRequest("invalidSyntax", "unreadable body"))
		return
	}
	ops, err := parsePatch(body)
	if err != nil {
		s.fail(w, badRequest("invalidSyntax", err.Error()))
		return
	}
	s.run(w, r, func(o *op) (int, any, error) {
		g, err := getGroupRec(o.ctx, o.tx, chi.URLParam(r, "id"))
		if err != nil {
			return 0, nil, err
		}
		// Work on SCIM ids, the provider's vocabulary, then resolve once.
		set := map[string]bool{}
		for _, m := range g.Members {
			if m.SCIMID != "" {
				set[m.SCIMID] = true
			}
		}
		name, ext := g.DisplayName, (*string)(nil)
		for _, p := range ops {
			path := strings.ToLower(strings.TrimSpace(p.Path))
			switch {
			case path == "members":
				vals := memberValuesOf(p.Value)
				switch p.Op {
				case "add":
					for _, v := range vals {
						set[v] = true
					}
				case "replace":
					set = map[string]bool{}
					for _, v := range vals {
						set[v] = true
					}
				case "remove":
					if len(vals) == 0 {
						set = map[string]bool{} // remove with no value empties the list
					}
					for _, v := range vals {
						delete(set, v)
					}
				}
			case strings.HasPrefix(path, "members[") && p.Op == "remove":
				// members[value eq "<id>"]
				if _, v, err := parseFilter(strings.TrimSuffix(p.Path[len("members["):], "]"), []string{"value"}); err == nil {
					delete(set, v)
				} else {
					return 0, nil, badRequest("invalidPath", "unsupported members filter")
				}
			case path == "displayname":
				var v string
				_ = json.Unmarshal(p.Value, &v)
				if strings.TrimSpace(v) != "" {
					name = strings.TrimSpace(v)
				}
			case path == "externalid":
				var v string
				_ = json.Unmarshal(p.Value, &v)
				ext = optional(v)
			case path == "":
				// Path-less replace: an object of attributes.
				var obj struct {
					DisplayName string          `json:"displayName"`
					ExternalID  string          `json:"externalId"`
					Members     json.RawMessage `json:"members"`
				}
				_ = json.Unmarshal(p.Value, &obj)
				if strings.TrimSpace(obj.DisplayName) != "" {
					name = strings.TrimSpace(obj.DisplayName)
				}
				if obj.ExternalID != "" {
					ext = optional(obj.ExternalID)
				}
				if len(obj.Members) > 0 {
					vals := memberValuesOf(obj.Members)
					if p.Op == "replace" {
						set = map[string]bool{}
					}
					for _, v := range vals {
						set[v] = true
					}
				}
			}
		}
		values := make([]string, 0, len(set))
		for v := range set {
			values = append(values, v)
		}
		members, err := s.resolveMembers(o, values)
		if err != nil {
			return 0, nil, err
		}
		if err := s.writeGroup(o, g, name, ext, members); err != nil {
			return 0, nil, err
		}
		g, err = getGroupRec(o.ctx, o.tx, g.ID)
		if err != nil {
			return 0, nil, err
		}
		return http.StatusOK, g.resource(), nil
	})
}

func memberValuesOf(raw json.RawMessage) []string {
	var ms []struct {
		Value string `json:"value"`
	}
	_ = json.Unmarshal(raw, &ms)
	out := make([]string, 0, len(ms))
	for _, m := range ms {
		if m.Value != "" {
			out = append(out, m.Value)
		}
	}
	return out
}

// deleteGroup always answers 204 for a group that exists, mapped or not (FR-22):
// Authentik's sync treats a 409 on group delete as fatal and re-enqueues the
// whole sync forever. Former members are reconciled.
func (s *Server) deleteGroup(w http.ResponseWriter, r *http.Request) {
	s.run(w, r, func(o *op) (int, any, error) {
		g, err := getGroupRec(o.ctx, o.tx, chi.URLParam(r, "id"))
		if err != nil {
			return 0, nil, err
		}
		if _, err := o.tx.Exec(o.ctx, `DELETE FROM "scim_groups" WHERE id = $1`, g.ID); err != nil {
			return 0, nil, err
		}
		o.audit("group.delete", "scim_id", g.ID, "display_name", g.DisplayName)
		affected := make([]string, 0, len(g.Members))
		for _, m := range g.Members {
			affected = append(affected, m.UserID)
		}
		if err := s.reconcile(o, affected...); err != nil {
			return 0, nil, err
		}
		return http.StatusNoContent, nil, nil
	})
}
