// Whose provider serves a call (#47).
//
// A provider config belongs to an Owner: a workspace (the shared provider its
// owners and admins manage) or a user (a personal bring-your-own key, set in
// user settings). Both are stored the same way, in twin tables, and every
// config rule (PATCH semantics, provider-change key guard, encryption) applies
// to both through the same code.
//
// Precedence keeps workspace admins in control of what their workspace spends
// and sends: a workspace's own provider always wins, and a personal one serves
// a call only when the workspace has none and its policy allows personal keys.
// The workspace policy (allow list, block list, monthly cap) governs the call
// either way.

package ai

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Owner names whose provider config is meant.
type Owner struct {
	user bool
	ID   string
}

// WorkspaceOwner is a workspace's shared provider.
func WorkspaceOwner(workspaceID string) Owner { return Owner{ID: workspaceID} }

// UserOwner is a user's personal provider.
func UserOwner(userID string) Owner { return Owner{user: true, ID: userID} }

// Personal reports whether this is a user's own provider.
func (o Owner) Personal() bool { return o.user }

// The table and column names are fixed identifiers chosen here, never input,
// so formatting them into SQL is safe.
func (o Owner) configTable() string {
	if o.user {
		return `"user_ai_configs"`
	}
	return `"ai_configs"`
}

func (o Owner) imageTable() string {
	if o.user {
		return `"user_ai_image_configs"`
	}
	return `"ai_image_configs"`
}

func (o Owner) idColumn() string {
	if o.user {
		return `"user_id"`
	}
	return `"workspace_id"`
}

// sqlFor fills the owner's table and id column into a query written for the
// workspace tables, so each statement is written once for both owners.
func (o Owner) sqlFor(q string) string {
	return strings.NewReplacer(
		`"ai_image_configs"`, o.imageTable(),
		`"ai_configs"`, o.configTable(),
		`"workspace_id"`, o.idColumn(),
	).Replace(q)
}

type userCtxKey struct{}

// WithUser records the signed-in user on the context, so a call inside a
// workspace without a provider can fall back to that user's personal one. The
// HTTP auth layer sets it for every authenticated request; a background job
// that outlives its request sets it again on its own context.
func WithUser(ctx context.Context, userID string) context.Context {
	if userID == "" {
		return ctx
	}
	return context.WithValue(ctx, userCtxKey{}, userID)
}

func userFrom(ctx context.Context) string {
	v, _ := ctx.Value(userCtxKey{}).(string)
	return v
}

// hasProvider reports whether the owner has a usable credential stored for
// either its main or its image provider.
func (s *Service) hasProvider(ctx context.Context, o Owner) (bool, error) {
	q := o.sqlFor(`SELECT
		EXISTS (SELECT 1 FROM "ai_configs" WHERE "workspace_id" = $1 AND "key_cipher" IS NOT NULL)
		OR EXISTS (SELECT 1 FROM "ai_image_configs" WHERE "workspace_id" = $1 AND "key_cipher" IS NOT NULL)`)
	var has bool
	if err := s.db.QueryRow(ctx, q, o.ID).Scan(&has); err != nil {
		return false, err
	}
	return has, nil
}

// personalKeysAllowed reports whether the workspace lets members use their own
// keys. A workspace with no policy row allows them.
func (s *Service) personalKeysAllowed(ctx context.Context, workspaceID string) (bool, error) {
	var allowed bool
	err := s.db.QueryRow(ctx, `SELECT "allow_personal_keys" FROM "ai_policies" WHERE "workspace_id" = $1`, workspaceID).Scan(&allowed)
	if errors.Is(err, pgx.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return allowed, nil
}

// effectiveOwner picks whose provider serves a call in the workspace: its own
// when it has one, else the signed-in user's when the workspace allows that and
// the user has one, else the workspace (whose missing config then produces the
// usual "no provider" error).
func (s *Service) effectiveOwner(ctx context.Context, workspaceID string) (Owner, error) {
	ws := WorkspaceOwner(workspaceID)
	has, err := s.hasProvider(ctx, ws)
	if err != nil || has {
		return ws, err
	}
	uid := userFrom(ctx)
	if uid == "" {
		return ws, nil
	}
	allowed, err := s.personalKeysAllowed(ctx, workspaceID)
	if err != nil || !allowed {
		return ws, err
	}
	mine := UserOwner(uid)
	hasMine, err := s.hasProvider(ctx, mine)
	if err != nil || !hasMine {
		return ws, err
	}
	return mine, nil
}

// EffectiveView tells a client which provider is in effect for the signed-in
// user in a workspace, so the editor and dashboard can say "Workspace
// provider" or "Your provider". The configs are the public views (never a
// key), and the personal ones are the caller's own.
type EffectiveView struct {
	// Source is "workspace", "personal" or "none".
	Source      string           `json:"source"`
	Config      *ConfigView      `json:"config"`
	ImageConfig *ImageConfigView `json:"imageConfig"`
	// PersonalKeysAllowed reports the workspace's switch, so the UI can say
	// why a personal provider is not being used.
	PersonalKeysAllowed bool `json:"personalKeysAllowed"`
	// HasPersonal reports whether the caller has a personal provider at all.
	HasPersonal bool `json:"hasPersonal"`
}

// Effective resolves the provider in effect for the context's user.
func (s *Service) Effective(ctx context.Context, workspaceID string) (EffectiveView, error) {
	var v EffectiveView
	allowed, err := s.personalKeysAllowed(ctx, workspaceID)
	if err != nil {
		return v, err
	}
	v.PersonalKeysAllowed = allowed
	if uid := userFrom(ctx); uid != "" {
		if v.HasPersonal, err = s.hasProvider(ctx, UserOwner(uid)); err != nil {
			return v, err
		}
	}
	o, err := s.effectiveOwner(ctx, workspaceID)
	if err != nil {
		return v, err
	}
	if v.Config, err = s.getConfig(ctx, o); err != nil {
		return v, err
	}
	if v.ImageConfig, err = s.getImageConfig(ctx, o); err != nil {
		return v, err
	}
	switch {
	case v.Config == nil && v.ImageConfig == nil:
		v.Source = "none"
	case o.Personal():
		v.Source = "personal"
	default:
		v.Source = "workspace"
	}
	return v, nil
}

// errNoUser guards the personal endpoints against a context without a user.
var errNoUser = fmt.Errorf("%w: no signed-in user", ErrBadRequest)
