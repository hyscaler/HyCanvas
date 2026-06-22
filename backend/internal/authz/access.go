// Package authz ports the @hc/authz per-design access + capability model
// (doc 17): given a caller's workspace role, per-design grants, share-link mode,
// custom roles, and approval-lock state, it resolves the effective AccessMode and
// the capability set checked at every gate. Pure logic, no I/O - the security
// keystone reused by sharing, comments, approvals, and the realtime gateway.
package authz

import "sort"

type AccessMode string

const (
	ModeView    AccessMode = "view"
	ModeComment AccessMode = "comment"
	ModeEdit    AccessMode = "edit"
)

type Capability string

const (
	CapView        Capability = "view"
	CapComment     Capability = "comment"
	CapEdit        Capability = "edit"
	CapShare       Capability = "share"
	CapApprove     Capability = "approve"
	CapManageRoles Capability = "manage-roles"
	CapManageBrand Capability = "manage-brand"
	CapDelete      Capability = "delete"
)

// WorkspaceRole values are lowercase ("owner"|"admin"|"member"|"viewer"); DB
// roles (OWNER/...) must be lowercased before calling.
type WorkspaceRole string

var modeRank = map[AccessMode]int{ModeView: 1, ModeComment: 2, ModeEdit: 3}

var modeCapabilities = map[AccessMode][]Capability{
	ModeView:    {CapView},
	ModeComment: {CapView, CapComment},
	ModeEdit:    {CapView, CapComment, CapEdit},
}

var builtinRoleCapabilities = map[WorkspaceRole][]Capability{
	"owner":  {CapView, CapComment, CapEdit, CapShare, CapApprove, CapManageRoles, CapManageBrand, CapDelete},
	"admin":  {CapView, CapComment, CapEdit, CapShare, CapApprove, CapManageRoles, CapManageBrand, CapDelete},
	"member": {CapView, CapComment, CapEdit, CapShare},
	"viewer": {CapView, CapComment},
}

var roleBaseMode = map[WorkspaceRole]AccessMode{
	"owner": ModeEdit, "admin": ModeEdit, "member": ModeEdit, "viewer": ModeView,
}

// LockPolicy: how an approval lock caps access ("comment" keeps review going,
// "view" is stricter).
type LockPolicy string

type CustomRole struct {
	ID           string
	Name         string
	Capabilities []Capability
}

type ResolveInput struct {
	WorkspaceRole  WorkspaceRole // "" when not a member
	Grants         []AccessMode
	Link           AccessMode // "" when none
	CustomRoles    []CustomRole
	ApprovalLocked bool
	LockPolicy     LockPolicy
}

type DesignAccess struct {
	Mode         AccessMode   `json:"mode"`
	Capabilities []Capability `json:"capabilities"`
}

func maxMode(a, b AccessMode) AccessMode {
	if modeRank[a] >= modeRank[b] {
		return a
	}
	return b
}

func capMode(mode, ceiling AccessMode) AccessMode {
	if modeRank[mode] <= modeRank[ceiling] {
		return mode
	}
	return ceiling
}

// Resolve computes the caller's effective mode + capabilities for one design.
func Resolve(in ResolveInput) DesignAccess {
	var sources []AccessMode
	if in.WorkspaceRole != "" {
		sources = append(sources, roleBaseMode[in.WorkspaceRole])
	}
	sources = append(sources, in.Grants...)
	if in.Link != "" {
		sources = append(sources, in.Link)
	}

	hasAccess := len(sources) > 0
	mode := ModeView
	if hasAccess {
		mode = sources[0]
		for _, m := range sources[1:] {
			mode = maxMode(mode, m)
		}
	}

	if in.ApprovalLocked {
		ceiling := ModeComment
		if in.LockPolicy == "view" {
			ceiling = ModeView
		}
		mode = capMode(mode, ceiling)
	}

	caps := map[Capability]bool{}
	if hasAccess {
		modeAllowsEdit := contains(modeCapabilities[mode], CapEdit)
		for _, c := range modeCapabilities[mode] {
			caps[c] = true
		}
		add := func(list []Capability) {
			for _, c := range list {
				if c == CapEdit && !modeAllowsEdit {
					continue
				}
				caps[c] = true
			}
		}
		if in.WorkspaceRole != "" {
			add(builtinRoleCapabilities[in.WorkspaceRole])
		}
		for _, r := range in.CustomRoles {
			add(r.Capabilities)
		}
	}

	out := make([]Capability, 0, len(caps))
	for c := range caps {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return DesignAccess{Mode: mode, Capabilities: out}
}

// Has reports whether the access grants a capability.
func (a DesignAccess) Has(c Capability) bool { return contains(a.Capabilities, c) }

func contains(list []Capability, c Capability) bool {
	for _, x := range list {
		if x == c {
			return true
		}
	}
	return false
}
