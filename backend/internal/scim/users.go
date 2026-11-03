package scim

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
)

// userIn is a User representation from the provider. raw keeps everything it
// sent, so the resource we answer with echoes attributes we do not model:
// Authentik compares its next payload with our last response, and a missing
// attribute would read as a change and re-send every user on every sync.
type userIn struct {
	raw         map[string]any
	UserName    string `json:"userName"`
	ExternalID  string `json:"externalId"`
	DisplayName string `json:"displayName"`
	Name        struct {
		Formatted  string `json:"formatted"`
		GivenName  string `json:"givenName"`
		FamilyName string `json:"familyName"`
	} `json:"name"`
	Emails []struct {
		Value   string `json:"value"`
		Primary bool   `json:"primary"`
	} `json:"emails"`
	Active json.RawMessage `json:"active"`
}

func readUserIn(r *http.Request) (*userIn, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return nil, badRequest("invalidSyntax", "unreadable body")
	}
	var in userIn
	if json.Unmarshal(body, &in) != nil || json.Unmarshal(body, &in.raw) != nil {
		return nil, badRequest("invalidSyntax", "malformed User")
	}
	in.UserName = strings.TrimSpace(in.UserName)
	if in.UserName == "" {
		return nil, badRequest("invalidValue", "userName is required")
	}
	if in.email() == "" {
		return nil, badRequest("invalidValue", "an email address is required (emails, or a userName that is one)")
	}
	delete(in.raw, "password")
	return &in, nil
}

// email: the primary address, else the first, else userName when it is one.
func (in *userIn) email() string {
	for _, e := range in.Emails {
		if e.Primary && strings.Contains(e.Value, "@") {
			return e.Value
		}
	}
	for _, e := range in.Emails {
		if strings.Contains(e.Value, "@") {
			return e.Value
		}
	}
	if strings.Contains(in.UserName, "@") {
		return in.UserName
	}
	return ""
}

func (in *userIn) displayName() string {
	switch {
	case strings.TrimSpace(in.DisplayName) != "":
		return in.DisplayName
	case strings.TrimSpace(in.Name.Formatted) != "":
		return in.Name.Formatted
	case strings.TrimSpace(in.Name.GivenName+in.Name.FamilyName) != "":
		return strings.TrimSpace(in.Name.GivenName + " " + in.Name.FamilyName)
	}
	return in.UserName
}

// active is the requested state: nil when the representation does not say.
func (in *userIn) active() *bool {
	if len(in.Active) == 0 {
		return nil
	}
	if b, ok := flexBool(in.Active); ok {
		return &b
	}
	return nil
}

func optional(s string) *string {
	if s = strings.TrimSpace(s); s == "" {
		return nil
	}
	return &s
}

func (u *userRec) resource() map[string]any {
	out := make(map[string]any, len(u.Attrs)+8)
	for k, v := range u.Attrs {
		out[k] = v
	}
	out["schemas"] = []string{schemaUser}
	out["id"] = u.ID
	out["userName"] = u.UserName
	if u.ExternalID != nil {
		out["externalId"] = *u.ExternalID
	} else {
		delete(out, "externalId")
	}
	out["displayName"] = u.Name
	out["active"] = !u.Deactivated
	if _, ok := out["emails"]; !ok {
		out["emails"] = []map[string]any{{"value": u.Email, "primary": true}}
	}
	out["meta"] = map[string]any{
		"resourceType": "User",
		"created":      u.Created.UTC().Format(time.RFC3339),
		"lastModified": u.Updated.UTC().Format(time.RFC3339),
		"location":     "/scim/v2/Users/" + u.ID,
	}
	return out
}

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	var attr, value string
	if f := r.URL.Query().Get("filter"); f != "" {
		var err error
		if attr, value, err = parseFilter(f, []string{"userName", "externalId", "emails.value"}); err != nil {
			writeError(w, http.StatusBadRequest, "invalidFilter", "supported filters: userName, externalId or emails.value eq \"...\"")
			return
		}
	}
	start, count := paging(r.URL.Query())
	s.run(w, r, func(o *op) (int, any, error) {
		recs, total, err := listUserRecs(o.ctx, o.tx, attr, value, start, count)
		if err != nil {
			return 0, nil, err
		}
		res := make([]any, len(recs))
		for i, u := range recs {
			res[i] = u.resource()
		}
		return http.StatusOK, listResponse(res, total, start), nil
	})
}

func (s *Server) getUser(w http.ResponseWriter, r *http.Request) {
	s.run(w, r, func(o *op) (int, any, error) {
		u, err := getUserRec(o.ctx, o.tx, chi.URLParam(r, "id"))
		if err != nil {
			return 0, nil, err
		}
		return http.StatusOK, u.resource(), nil
	})
}

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	in, err := readUserIn(r)
	if err != nil {
		s.fail(w, err)
		return
	}
	s.run(w, r, func(o *op) (int, any, error) {
		ext := optional(in.ExternalID)
		if clash, err := liveLinkConflict(o.ctx, o.tx, in.UserName, ext, ""); err != nil {
			return 0, nil, err
		} else if clash {
			return 0, nil, conflict("a user with this userName or externalId is already provisioned")
		}

		userID, how, err := s.accountFor(o, in, ext)
		if err != nil {
			return 0, nil, err
		}
		if linked, err := liveLinkForAccount(o.ctx, o.tx, userID); err != nil {
			return 0, nil, err
		} else if linked != "" {
			return 0, nil, conflict("this account is already provisioned under another userName")
		}
		id, err := upsertLink(o.ctx, o.tx, userID, in.UserName, ext, in.raw)
		if err != nil {
			return 0, nil, err
		}
		want := true
		if a := in.active(); a != nil {
			want = *a
		}
		if err := s.setActive(o, userID, want); err != nil {
			return 0, nil, err
		}
		o.audit("user.create", "scim_id", id, "user_id", userID, "account", how, "active", want)
		u, err := getUserRec(o.ctx, o.tx, id)
		if err != nil {
			return 0, nil, err
		}
		return http.StatusCreated, u.resource(), nil
	})
}

// accountFor finds or creates the account a create request is about: the one a
// SCIM DELETE detached (same externalId), else a new provisioned account, else
// an existing account adopted under the SSO linking rules.
func (s *Server) accountFor(o *op, in *userIn, ext *string) (userID, how string, err error) {
	subject := ""
	if ext != nil {
		subject = *ext
		_, prev, err := deletedLinkByExternalID(o.ctx, o.tx, subject)
		if err != nil {
			return "", "", err
		}
		if prev != "" {
			if err := o.acct.UpdateProvisionedUser(o.ctx, prev, in.email(), in.displayName()); err != nil {
				return "", "", accountErr(err)
			}
			return prev, "relinked", nil
		}
	}
	userID, err = o.acct.CreateProvisionedUser(o.ctx, in.email(), in.displayName(), subject)
	if err == nil {
		return userID, "created", nil
	}
	if !errors.Is(err, accounts.ErrEmailTaken) {
		return "", "", accountErr(err)
	}
	userID, err = o.acct.AdoptForProvisioning(o.ctx, in.email(), subject)
	if err != nil {
		return "", "", accountErr(err)
	}
	return userID, "adopted", nil
}

func accountErr(err error) error {
	switch {
	case errors.Is(err, accounts.ErrEmailTaken):
		return conflict("an account with this email exists and may not be linked to the identity provider")
	case errors.Is(err, accounts.ErrSubjectTaken):
		return conflict("this externalId is already linked to another account")
	case errors.Is(err, accounts.ErrBadRequest):
		return badRequest("invalidValue", "invalid email address")
	case errors.Is(err, accounts.ErrNotFound):
		return errNotFound
	}
	return err
}

// setActive brings the account to the requested state. Deactivation queues the
// person's sockets to close after commit; reactivation re-derives their group
// memberships, which may have changed while they were away.
func (s *Server) setActive(o *op, userID string, want bool) error {
	var deactivated bool
	if err := o.tx.QueryRow(o.ctx, `SELECT "deactivated_at" IS NOT NULL FROM "users" WHERE id = $1`, userID).Scan(&deactivated); err != nil {
		return err
	}
	switch {
	case !want && !deactivated:
		if err := o.acct.DeactivateUser(o.ctx, userID); err != nil {
			return err
		}
		o.disconnect = append(o.disconnect, userID)
		o.audit("user.deactivate", "user_id", userID)
	case want && deactivated:
		if err := o.acct.ReactivateUser(o.ctx, userID); err != nil {
			return err
		}
		o.audit("user.reactivate", "user_id", userID)
	}
	return s.reconcile(o, userID)
}

func (s *Server) replaceUser(w http.ResponseWriter, r *http.Request) {
	in, err := readUserIn(r)
	if err != nil {
		s.fail(w, err)
		return
	}
	s.run(w, r, func(o *op) (int, any, error) {
		u, err := getUserRec(o.ctx, o.tx, chi.URLParam(r, "id"))
		if err != nil {
			return 0, nil, err
		}
		ext := optional(in.ExternalID)
		if err := s.applyUser(o, u, in.UserName, ext, in.email(), in.displayName(), in.raw, in.active()); err != nil {
			return 0, nil, err
		}
		u, err = getUserRec(o.ctx, o.tx, u.ID)
		if err != nil {
			return 0, nil, err
		}
		return http.StatusOK, u.resource(), nil
	})
}

// applyUser writes a user's new state: identity attributes, the account's email
// and name, the stored representation, and the active flag (nil leaves it).
func (s *Server) applyUser(o *op, u *userRec, userName string, ext *string, email, name string, attrs map[string]any, active *bool) error {
	if clash, err := liveLinkConflict(o.ctx, o.tx, userName, ext, u.ID); err != nil {
		return err
	} else if clash {
		return conflict("another user already has this userName or externalId")
	}
	if err := o.acct.UpdateProvisionedUser(o.ctx, u.UserID, email, name); err != nil {
		return accountErr(err)
	}
	if err := updateLink(o.ctx, o.tx, u.ID, userName, ext, attrs); err != nil {
		return err
	}
	o.audit("user.update", "scim_id", u.ID, "user_id", u.UserID)
	if active != nil {
		return s.setActive(o, u.UserID, *active)
	}
	return nil
}

func (s *Server) patchUser(w http.ResponseWriter, r *http.Request) {
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
		u, err := getUserRec(o.ctx, o.tx, chi.URLParam(r, "id"))
		if err != nil {
			return 0, nil, err
		}
		st := patchState{userName: u.UserName, ext: u.ExternalID, email: u.Email, name: u.Name, attrs: u.Attrs}
		for _, p := range ops {
			if p.Op == "remove" {
				continue // nothing a provider removes from a user changes its account
			}
			if err := st.apply(p); err != nil {
				return 0, nil, err
			}
		}
		if err := s.applyUser(o, u, st.userName, st.ext, st.email, st.name, st.attrs, st.active); err != nil {
			return 0, nil, err
		}
		u, err = getUserRec(o.ctx, o.tx, u.ID)
		if err != nil {
			return 0, nil, err
		}
		return http.StatusOK, u.resource(), nil
	})
}

// patchState accumulates add/replace operations on a user.
type patchState struct {
	userName string
	ext      *string
	email    string
	name     string
	attrs    map[string]any
	active   *bool
}

func (st *patchState) apply(p patchOp) error {
	if p.Path == "" {
		// Entra ID style: the change is an object of attribute: value.
		var obj map[string]json.RawMessage
		if json.Unmarshal(p.Value, &obj) != nil {
			return badRequest("invalidValue", "a PATCH without a path needs an object value")
		}
		for k, v := range obj {
			if err := st.set(k, v); err != nil {
				return err
			}
		}
		return nil
	}
	return st.set(p.Path, p.Value)
}

func (st *patchState) set(path string, v json.RawMessage) error {
	var str string
	_ = json.Unmarshal(v, &str)
	lp := strings.ToLower(path)
	var anyv any
	_ = json.Unmarshal(v, &anyv)
	switch {
	case lp == "active":
		b, ok := flexBool(v)
		if !ok {
			return badRequest("invalidValue", "active must be a boolean")
		}
		st.active = &b
		st.attrs["active"] = b
	case lp == "username":
		if strings.TrimSpace(str) == "" {
			return badRequest("invalidValue", "userName cannot be empty")
		}
		st.userName = strings.TrimSpace(str)
		st.attrs["userName"] = st.userName
	case lp == "externalid":
		st.ext = optional(str)
	case lp == "displayname", lp == "name.formatted":
		if strings.TrimSpace(str) != "" {
			st.name = strings.TrimSpace(str)
		}
		st.attrs[path] = anyv
	case lp == "name":
		var n struct{ Formatted, GivenName, FamilyName string }
		_ = json.Unmarshal(v, &n)
		in := userIn{UserName: st.userName}
		in.Name.Formatted, in.Name.GivenName, in.Name.FamilyName = n.Formatted, n.GivenName, n.FamilyName
		if dn := in.displayName(); dn != st.userName {
			st.name = dn
		}
		st.attrs["name"] = anyv
	case lp == "emails":
		var es []struct {
			Value   string
			Primary bool
		}
		_ = json.Unmarshal(v, &es)
		in := userIn{}
		for _, e := range es {
			in.Emails = append(in.Emails, struct {
				Value   string `json:"value"`
				Primary bool   `json:"primary"`
			}{e.Value, e.Primary})
		}
		if e := in.email(); e != "" {
			st.email = e
		}
		st.attrs["emails"] = anyv
	case strings.HasPrefix(lp, "emails[") && strings.HasSuffix(lp, "].value"):
		// Entra ID: emails[type eq "work"].value
		if strings.Contains(str, "@") {
			st.email = str
			st.attrs["emails"] = []map[string]any{{"value": str, "primary": true}}
		}
	default:
		// Attributes we do not model are accepted and kept for the echo.
		st.attrs[path] = anyv
	}
	return nil
}

func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request) {
	s.run(w, r, func(o *op) (int, any, error) {
		u, err := getUserRec(o.ctx, o.tx, chi.URLParam(r, "id"))
		if err != nil {
			return 0, nil, err
		}
		// DELETE deactivates and detaches; the account and everything in it stay.
		if err := s.setActive(o, u.UserID, false); err != nil {
			return 0, nil, err
		}
		if _, err := o.tx.Exec(o.ctx, `UPDATE "scim_users" SET "deleted_at" = now(), "updated_at" = now() WHERE id = $1`, u.ID); err != nil {
			return 0, nil, err
		}
		o.audit("user.delete", "scim_id", u.ID, "user_id", u.UserID)
		return http.StatusNoContent, nil, nil
	})
}
