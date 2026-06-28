// Workspace member + invitation management (the Canva-style "invite people to
// your team" flow). Sits on the accounts Service because it owns WorkspaceMember,
// the role rank, the secrets/token helpers, and the dev mail outbox. Invitations
// are stored token-hash-only (sha256), single-use, and expiring; acceptance
// activates a WorkspaceMember row. The @hc/authz invariants (last-owner
// protection, rank limits, invitation validity) are reimplemented here in Go.
package accounts

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/auth/secrets"
	"hycanvas/backend/internal/platform/brand"
)

// Notifier creates an in-app notification (the dashboard bell). Satisfied by the
// engagement emitter; optional (nil = skip). Decoupled via this interface so the
// low-level accounts package does not import engagement (avoids a cycle).
type Notifier interface {
	Notify(ctx context.Context, actorID, targetUserID, typ, designID string, payload map[string]any)
}

// inviteTTL is how long a workspace invitation stays valid.
const inviteTTL = 7 * 24 * time.Hour

// tsLayout is the millisecond ISO-8601 layout used across the accounts API.
const tsLayout = "2006-01-02T15:04:05.000Z07:00"

var (
	// ErrNotFound: the workspace, member, or invitation does not exist.
	ErrNotFound = errors.New("not found")
	// ErrBadRequest: malformed input (bad email, unknown role).
	ErrBadRequest = errors.New("bad request")
	// ErrAlreadyMember: the invited email already belongs to an active member.
	ErrAlreadyMember = errors.New("already a member of this workspace")
	// ErrLastOwner: the operation would leave the workspace with no active owner.
	ErrLastOwner = errors.New("a workspace must keep at least one owner")
	// ErrInviteInvalid: invitation missing, expired, or already accepted.
	ErrInviteInvalid = errors.New("this invitation is no longer valid")
	// ErrInviteEmailMismatch: the signed-in account's email does not match the invite.
	ErrInviteEmailMismatch = errors.New("this invitation was sent to a different email address")
)

func iso(t time.Time) string { return t.UTC().Format(tsLayout) }

func isoPtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := iso(*t)
	return &s
}

// Member is a workspace member as shown in the roster.
type Member struct {
	UserID    string  `json:"userId"`
	Email     string  `json:"email"`
	Name      string  `json:"name"`
	AvatarURL *string `json:"avatarUrl,omitempty"`
	Role      string  `json:"role"`   // lowercase
	Status    string  `json:"status"` // lowercase
	JoinedAt  *string `json:"joinedAt,omitempty"`
}

// Invitation is a pending (or accepted) workspace invitation.
type Invitation struct {
	ID            string  `json:"id"`
	WorkspaceID   string  `json:"workspaceId"`
	WorkspaceName string  `json:"workspaceName,omitempty"` // populated for the invitee's own view
	Email         string  `json:"email"`
	Role          string  `json:"role"` // lowercase
	InvitedBy     string  `json:"invitedBy"`
	ExpiresAt     string  `json:"expiresAt"`
	AcceptedAt    *string `json:"acceptedAt,omitempty"`
	CreatedAt     string  `json:"createdAt"`
}

// Membership is the activated membership returned on accept.
type Membership struct {
	ID          string  `json:"id"`
	WorkspaceID string  `json:"workspaceId"`
	UserID      string  `json:"userId"`
	Role        string  `json:"role"`   // lowercase
	Status      string  `json:"status"` // lowercase
	JoinedAt    *string `json:"joinedAt,omitempty"`
}

// memberRole returns a user's active workspace role (lowercase) and whether they
// are an active member.
func (s *Service) memberRole(ctx context.Context, userID, workspaceID string) (string, bool) {
	var role string
	err := s.db.QueryRow(ctx,
		`SELECT role FROM "WorkspaceMember" WHERE "workspaceId"=$1 AND "userId"=$2 AND status='ACTIVE'`,
		workspaceID, userID).Scan(&role)
	if err != nil {
		return "", false
	}
	return strings.ToLower(role), true
}

// (the non-locking activeOwnerCount was removed; all owner-invariant checks now
// go through lockActiveOwners inside a transaction to avoid the last-owner race.)

// lockedRole reads a user's active workspace role (lowercase) with their
// membership row locked FOR UPDATE inside tx, returning whether they are an
// active member. Used for the AUTHORITATIVE authorization re-check in
// ChangeMemberRole/RemoveMember: locking the caller's own row serializes against
// a concurrent change to that role, so a just-demoted caller cannot slip an
// action through on a stale (higher) role read.
func lockedRole(ctx context.Context, tx pgx.Tx, userID, workspaceID string) (string, bool) {
	var role string
	err := tx.QueryRow(ctx,
		`SELECT role FROM "WorkspaceMember" WHERE "workspaceId"=$1 AND "userId"=$2 AND status='ACTIVE' FOR UPDATE`,
		workspaceID, userID).Scan(&role)
	if err != nil {
		return "", false
	}
	return strings.ToLower(role), true
}

// lockActiveOwners counts a workspace's active owners with their rows locked FOR
// UPDATE inside tx. This SERIALIZES concurrent owner demotions/removals: a second
// transaction touching the owner set blocks until the first commits, then sees
// the reduced count - closing the last-owner TOCTOU (two concurrent demotions
// each reading count=2 and both proceeding to 0 owners). count(*) cannot combine
// with FOR UPDATE, so we lock the rows and count them.
func lockActiveOwners(ctx context.Context, tx pgx.Tx, workspaceID string) (int, error) {
	rows, err := tx.Query(ctx,
		`SELECT 1 FROM "WorkspaceMember" WHERE "workspaceId"=$1 AND role='OWNER' AND status='ACTIVE' FOR UPDATE`,
		workspaceID)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		n++
	}
	return n, rows.Err()
}

// workspaceMeta returns a workspace's kind (lowercase) and display name, or
// ErrNotFound.
func (s *Service) workspaceMeta(ctx context.Context, workspaceID string) (kind, name string, err error) {
	if e := s.db.QueryRow(ctx, `SELECT kind, name FROM "Workspace" WHERE id=$1`, workspaceID).Scan(&kind, &name); e != nil {
		return "", "", ErrNotFound
	}
	return strings.ToLower(kind), name, nil
}

// Invite creates a workspace invitation for `email` at `role` and captures the
// accept link in the dev outbox. The caller must be an admin or owner of a
// non-personal workspace, and may not invite at a role above their own. Returns
// the invitation and the raw (unhashed) token.
func (s *Service) Invite(ctx context.Context, callerID, workspaceID, email, role string) (Invitation, string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if !emailRe.MatchString(email) {
		return Invitation{}, "", ErrBadRequest
	}
	role = strings.ToLower(strings.TrimSpace(role))
	if role == "" {
		role = "member"
	}
	if _, ok := roleRank[role]; !ok {
		return Invitation{}, "", ErrBadRequest
	}
	if err := s.AssertMember(ctx, callerID, workspaceID, "admin"); err != nil {
		return Invitation{}, "", err
	}
	callerRole, _ := s.memberRole(ctx, callerID, workspaceID)
	if roleRank[role] > roleRank[callerRole] {
		return Invitation{}, "", ErrForbidden // cannot invite above your own role
	}
	kind, wsName, err := s.workspaceMeta(ctx, workspaceID)
	if err != nil {
		return Invitation{}, "", err
	}
	if kind == "personal" {
		return Invitation{}, "", ErrForbidden // personal workspaces are single-user
	}
	// If the email already belongs to an account, capture it: an active member is
	// rejected, otherwise we notify them in-app (the bell) after the invite.
	existing, _ := s.findUserByEmail(ctx, email)
	if existing != nil {
		if _, active := s.memberRole(ctx, existing.ID, workspaceID); active {
			return Invitation{}, "", ErrAlreadyMember
		}
	}
	// Supersede any prior pending invite for the same email (single live token).
	if _, err := s.db.Exec(ctx,
		`DELETE FROM "Invitation" WHERE "workspaceId"=$1 AND lower(email)=$2 AND "acceptedAt" IS NULL`,
		workspaceID, email); err != nil {
		return Invitation{}, "", err
	}
	raw := uuid.NewString() + "." + uuid.NewString()
	id := uuid.NewString()
	expires := time.Now().Add(inviteTTL)
	if _, err := s.db.Exec(ctx,
		`INSERT INTO "Invitation" (id, "workspaceId", email, role, "tokenHash", "invitedById", "expiresAt")
		 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		id, workspaceID, email, strings.ToUpper(role), secrets.HashToken(raw), callerID, expires); err != nil {
		return Invitation{}, "", err
	}
	s.sendInvitationEmail(email, raw, wsName, role)
	// In-app dashboard notification (the bell) for an invitee who already has an
	// account; a brand-new email only gets the invite email. Best-effort, nil-safe.
	if existing != nil && s.notifier != nil {
		s.notifier.Notify(ctx, callerID, existing.ID, "workspace_invite", "", map[string]any{
			"workspaceId": workspaceID, "workspaceName": wsName, "role": role,
		})
	}
	return Invitation{
		ID: id, WorkspaceID: workspaceID, Email: email, Role: role,
		InvitedBy: callerID, ExpiresAt: iso(expires), CreatedAt: iso(time.Now()),
	}, raw, nil
}

// sendInvitationEmail sends (or, with no SMTP, captures) the branded workspace
// invitation, personalized with the workspace name and granted role.
func (s *Service) sendInvitationEmail(email, raw, wsName, role string) {
	link := s.appURL() + "/accept-invite?token=" + raw
	ws := strings.TrimSpace(wsName)
	if ws == "" {
		ws = "a workspace"
	}
	intro := fmt.Sprintf("You've been invited to collaborate in %s on %s", ws, brand.Name)
	if r := strings.ToLower(strings.TrimSpace(role)); r != "" {
		intro += fmt.Sprintf(" as %s", r)
	}
	intro += ". Accept the invitation to start working together."
	s.deliver(OutboxMessage{
		To:        email,
		Subject:   "You've been invited to a " + brand.Name + " workspace",
		Link:      link,
		Heading:   "You're invited to collaborate",
		Intro:     intro,
		CTALabel:  "Accept invitation",
		Preheader: fmt.Sprintf("Join %s on %s.", ws, brand.Name),
		Footnote:  "If you weren't expecting this invitation, you can safely ignore this email.",
	})
}

// SendDesignShare sends (or captures) the branded "a design was shared with you"
// email (satisfies sharing.Mailer). The invitee signs in with this email address
// to gain the granted access. Best-effort.
func (s *Service) SendDesignShare(email, designID string) {
	email = strings.ToLower(strings.TrimSpace(email))
	if !emailRe.MatchString(email) {
		return
	}
	link := s.appURL() + "/editor?id=" + designID
	s.deliver(OutboxMessage{
		To:        email,
		Subject:   "A design was shared with you on " + brand.Name,
		Link:      link,
		Heading:   "A design was shared with you",
		Intro:     "Someone shared a design with you on " + brand.Name + ". Open it to view or edit; sign in with this email address to access it.",
		CTALabel:  "Open design",
		Preheader: "You now have access to a shared design on " + brand.Name + ".",
		Footnote:  "If you don't recognize this, you can ignore this email; the design stays private.",
	})
}

// AcceptInvitation validates a raw invitation token for the signed-in caller and
// activates their membership. The caller's account email must match the invite.
func (s *Service) AcceptInvitation(ctx context.Context, callerID, raw string) (Membership, error) {
	if strings.TrimSpace(raw) == "" {
		return Membership{}, ErrInviteInvalid
	}
	inv, err := s.loadInvitationBy(ctx, `"tokenHash"=$1`, secrets.HashToken(raw))
	if err != nil {
		return Membership{}, err
	}
	return s.activateInvitation(ctx, callerID, inv)
}

// invRow is the columns we need to validate + activate an invitation.
type invRow struct {
	id, workspaceID, email, role, invitedBy string
	acceptedAt                              *time.Time
	expiresAt                               time.Time
}

// loadInvitationBy fetches one invitation by a single-column predicate ("id=$1"
// or `"tokenHash"=$1`). A missing row is reported as ErrInviteInvalid.
func (s *Service) loadInvitationBy(ctx context.Context, pred string, arg any) (invRow, error) {
	var r invRow
	err := s.db.QueryRow(ctx,
		`SELECT id, "workspaceId", email, role, "invitedById", "acceptedAt", "expiresAt" FROM "Invitation" WHERE `+pred,
		arg).Scan(&r.id, &r.workspaceID, &r.email, &r.role, &r.invitedBy, &r.acceptedAt, &r.expiresAt)
	if err != nil {
		return invRow{}, ErrInviteInvalid
	}
	return r, nil
}

// activateInvitation validates an invitation for the signed-in caller (email
// match, unexpired, unaccepted) and activates their membership single-use. Shared
// by the token-link (AcceptInvitation) and in-app (RespondToInvitation) paths.
func (s *Service) activateInvitation(ctx context.Context, callerID string, inv invRow) (Membership, error) {
	if inv.acceptedAt != nil || !time.Now().Before(inv.expiresAt) {
		return Membership{}, ErrInviteInvalid
	}
	u, err := s.GetUserByID(ctx, callerID)
	if err != nil {
		return Membership{}, err
	}
	if strings.ToLower(strings.TrimSpace(u.Email)) != strings.ToLower(strings.TrimSpace(inv.email)) {
		return Membership{}, ErrInviteEmailMismatch
	}
	role := strings.ToUpper(inv.role)

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Membership{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Atomically claim the invitation single-use: the conditional update wins for
	// exactly one of any concurrent accepts (acceptedAt flips once). A loser sees
	// 0 rows and is rejected, so the invite can never be consumed twice.
	claim, err := tx.Exec(ctx, `UPDATE "Invitation" SET "acceptedAt"=now() WHERE id=$1 AND "acceptedAt" IS NULL`, inv.id)
	if err != nil {
		return Membership{}, err
	}
	if claim.RowsAffected() == 0 {
		return Membership{}, ErrInviteInvalid
	}
	memberID := uuid.NewString()
	if err := tx.QueryRow(ctx,
		`INSERT INTO "WorkspaceMember" (id, "workspaceId", "userId", role, status, "invitedById", "joinedAt", "updatedAt")
		 VALUES ($1,$2,$3,$4,'ACTIVE',$5, now(), now())
		 ON CONFLICT ("workspaceId","userId") DO UPDATE
		   SET role=EXCLUDED.role, status='ACTIVE',
		       "joinedAt"=COALESCE("WorkspaceMember"."joinedAt", now()), "updatedAt"=now()
		 RETURNING id`,
		memberID, inv.workspaceID, callerID, role, inv.invitedBy).Scan(&memberID); err != nil {
		return Membership{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Membership{}, err
	}
	now := iso(time.Now())
	return Membership{
		ID: memberID, WorkspaceID: inv.workspaceID, UserID: callerID,
		Role: strings.ToLower(role), Status: "active", JoinedAt: &now,
	}, nil
}

// MyInvitations lists the pending (unaccepted, unexpired) invitations addressed
// to the signed-in user's own email, each carrying its workspace name for
// display. Powers the in-app accept/decline surface reached from the bell.
func (s *Service) MyInvitations(ctx context.Context, userID string) ([]Invitation, error) {
	u, err := s.GetUserByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	email := strings.ToLower(strings.TrimSpace(u.Email))
	rows, err := s.db.Query(ctx,
		`SELECT i.id, i."workspaceId", i.email, i.role, i."invitedById", i."expiresAt", i."acceptedAt", i."createdAt", w.name
		 FROM "Invitation" i JOIN "Workspace" w ON w.id = i."workspaceId"
		 WHERE lower(i.email)=$1 AND i."acceptedAt" IS NULL AND i."expiresAt" > now()
		 ORDER BY i."createdAt" DESC`, email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Invitation{}
	for rows.Next() {
		var inv Invitation
		var expires, created time.Time
		var accepted *time.Time
		if err := rows.Scan(&inv.ID, &inv.WorkspaceID, &inv.Email, &inv.Role, &inv.InvitedBy, &expires, &accepted, &created, &inv.WorkspaceName); err != nil {
			return nil, err
		}
		inv.Role = strings.ToLower(inv.Role)
		inv.ExpiresAt = iso(expires)
		inv.AcceptedAt = isoPtr(accepted)
		inv.CreatedAt = iso(created)
		out = append(out, inv)
	}
	return out, rows.Err()
}

// RespondToInvitation accepts or declines an invitation BY ID for the signed-in
// caller (the in-app flow; no token needed). The caller's account email must
// match the invitation. Accept activates the membership; decline deletes the
// pending invitation. Returns the new membership on accept (zero value on
// decline).
func (s *Service) RespondToInvitation(ctx context.Context, callerID, invitationID string, accept bool) (Membership, error) {
	inv, err := s.loadInvitationBy(ctx, "id=$1", invitationID)
	if err != nil {
		return Membership{}, err
	}
	// Both paths require the caller's email to match the invite.
	u, err := s.GetUserByID(ctx, callerID)
	if err != nil {
		return Membership{}, err
	}
	if strings.ToLower(strings.TrimSpace(u.Email)) != strings.ToLower(strings.TrimSpace(inv.email)) {
		return Membership{}, ErrInviteEmailMismatch
	}
	if accept {
		return s.activateInvitation(ctx, callerID, inv)
	}
	// Decline: drop the pending invitation (idempotent; already-accepted is left).
	if _, err := s.db.Exec(ctx, `DELETE FROM "Invitation" WHERE id=$1 AND "acceptedAt" IS NULL`, inv.id); err != nil {
		return Membership{}, err
	}
	return Membership{}, nil
}

// ListMembers returns a workspace's roster (any active member may view it).
func (s *Service) ListMembers(ctx context.Context, callerID, workspaceID string) ([]Member, error) {
	if err := s.AssertMember(ctx, callerID, workspaceID, "viewer"); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx,
		`SELECT u.id, u.email, u.name, u."avatarUrl", m.role, m.status, m."joinedAt"
		 FROM "WorkspaceMember" m JOIN "User" u ON u.id=m."userId"
		 WHERE m."workspaceId"=$1 ORDER BY m."createdAt" ASC`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Member{}
	for rows.Next() {
		var m Member
		var joined *time.Time
		if err := rows.Scan(&m.UserID, &m.Email, &m.Name, &m.AvatarURL, &m.Role, &m.Status, &joined); err != nil {
			return nil, err
		}
		m.Role = strings.ToLower(m.Role)
		m.Status = strings.ToLower(m.Status)
		m.JoinedAt = isoPtr(joined)
		out = append(out, m)
	}
	return out, rows.Err()
}

// ListInvitations returns the pending (unaccepted) invitations for a workspace.
// Admin or owner only.
func (s *Service) ListInvitations(ctx context.Context, callerID, workspaceID string) ([]Invitation, error) {
	if err := s.AssertMember(ctx, callerID, workspaceID, "admin"); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx,
		`SELECT id, "workspaceId", email, role, "invitedById", "expiresAt", "acceptedAt", "createdAt"
		 FROM "Invitation" WHERE "workspaceId"=$1 AND "acceptedAt" IS NULL ORDER BY "createdAt" DESC`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Invitation{}
	for rows.Next() {
		var inv Invitation
		var expires, created time.Time
		var accepted *time.Time
		if err := rows.Scan(&inv.ID, &inv.WorkspaceID, &inv.Email, &inv.Role, &inv.InvitedBy, &expires, &accepted, &created); err != nil {
			return nil, err
		}
		inv.Role = strings.ToLower(inv.Role)
		inv.ExpiresAt = iso(expires)
		inv.AcceptedAt = isoPtr(accepted)
		inv.CreatedAt = iso(created)
		out = append(out, inv)
	}
	return out, rows.Err()
}

// RevokeInvitation cancels a pending invitation. Admin or owner only.
func (s *Service) RevokeInvitation(ctx context.Context, callerID, workspaceID, invitationID string) error {
	if err := s.AssertMember(ctx, callerID, workspaceID, "admin"); err != nil {
		return err
	}
	ct, err := s.db.Exec(ctx,
		`DELETE FROM "Invitation" WHERE id=$1 AND "workspaceId"=$2 AND "acceptedAt" IS NULL`,
		invitationID, workspaceID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ChangeMemberRole changes a member's workspace role, enforcing: caller is
// admin+, cannot set a role above their own, only an owner may touch (or grant)
// the owner role, and the last owner can never be demoted.
func (s *Service) ChangeMemberRole(ctx context.Context, callerID, workspaceID, targetUserID, newRole string) error {
	newRole = strings.ToLower(strings.TrimSpace(newRole))
	if _, ok := roleRank[newRole]; !ok {
		return ErrBadRequest
	}
	// Fast fail for obvious non-members (non-authoritative; the binding check is
	// re-done under a row lock inside the tx below).
	if err := s.AssertMember(ctx, callerID, workspaceID, "admin"); err != nil {
		return err
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Authoritative authorization INSIDE the tx with the caller's row locked, so a
	// concurrent demotion of the caller cannot be bypassed by a stale role read.
	callerRole, ok := lockedRole(ctx, tx, callerID, workspaceID)
	if !ok || roleRank[callerRole] < roleRank["admin"] {
		return ErrForbidden
	}
	targetRole, ok := s.memberRole(ctx, targetUserID, workspaceID)
	if !ok {
		return ErrNotFound
	}
	if roleRank[newRole] > roleRank[callerRole] {
		return ErrForbidden // cannot grant a role above your own
	}
	if (targetRole == "owner" || newRole == "owner") && callerRole != "owner" {
		return ErrForbidden // only an owner may manage owners
	}
	// Demoting an owner: lock the active-owner set and re-check the count inside
	// the tx so concurrent demotions can't both pass and orphan the workspace.
	if targetRole == "owner" && roleRank[newRole] < roleRank["owner"] {
		n, err := lockActiveOwners(ctx, tx, workspaceID)
		if err != nil {
			return err
		}
		if n <= 1 {
			return ErrLastOwner
		}
	}
	ct, err := tx.Exec(ctx,
		`UPDATE "WorkspaceMember" SET role=$1, "updatedAt"=now()
		 WHERE "workspaceId"=$2 AND "userId"=$3 AND status='ACTIVE'`,
		strings.ToUpper(newRole), workspaceID, targetUserID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// RemoveMember removes a member from a workspace. A member may always remove
// themselves (leave); removing someone else requires admin+ and a role at least
// as high as the target's. The last owner can never be removed.
func (s *Service) RemoveMember(ctx context.Context, callerID, workspaceID, targetUserID string) error {
	// Fast fail for a non-self caller who is obviously not an admin (the binding
	// check is re-done under a row lock inside the tx).
	if callerID != targetUserID {
		if err := s.AssertMember(ctx, callerID, workspaceID, "admin"); err != nil {
			return err
		}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	targetRole, ok := s.memberRole(ctx, targetUserID, workspaceID)
	if !ok {
		return ErrNotFound
	}
	// Authoritative authorization INSIDE the tx with the caller's row locked: a
	// concurrent demotion of the caller can't be bypassed by a stale role read.
	if callerID != targetUserID {
		callerRole, ok := lockedRole(ctx, tx, callerID, workspaceID)
		if !ok || roleRank[callerRole] < roleRank["admin"] {
			return ErrForbidden
		}
		if roleRank[targetRole] > roleRank[callerRole] {
			return ErrForbidden // cannot remove someone with a higher role
		}
		if targetRole == "owner" && callerRole != "owner" {
			return ErrForbidden
		}
	}
	// Removing an owner: lock the active-owner set and re-check inside the tx so
	// concurrent removals can't both pass and leave the workspace ownerless.
	if targetRole == "owner" {
		n, err := lockActiveOwners(ctx, tx, workspaceID)
		if err != nil {
			return err
		}
		if n <= 1 {
			return ErrLastOwner
		}
	}
	ct, err := tx.Exec(ctx,
		`DELETE FROM "WorkspaceMember" WHERE "workspaceId"=$1 AND "userId"=$2`,
		workspaceID, targetUserID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// InvitationsForUser returns invitations sent to and pending/accepted by a
// user's email (for account data export). Read-only, by the caller's own email.
func (s *Service) InvitationsForUser(ctx context.Context, email string) ([]Invitation, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	rows, err := s.db.Query(ctx,
		`SELECT id, "workspaceId", email, role, "invitedById", "expiresAt", "acceptedAt", "createdAt"
		 FROM "Invitation" WHERE lower(email)=$1 ORDER BY "createdAt" DESC`, email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Invitation{}
	for rows.Next() {
		var inv Invitation
		var expires, created time.Time
		var accepted *time.Time
		if err := rows.Scan(&inv.ID, &inv.WorkspaceID, &inv.Email, &inv.Role, &inv.InvitedBy, &expires, &accepted, &created); err != nil {
			return nil, err
		}
		inv.Role = strings.ToLower(inv.Role)
		inv.ExpiresAt = iso(expires)
		inv.AcceptedAt = isoPtr(accepted)
		inv.CreatedAt = iso(created)
		out = append(out, inv)
	}
	return out, rows.Err()
}
