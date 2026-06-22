package authz

import "testing"

func TestResolve_Stranger(t *testing.T) {
	a := Resolve(ResolveInput{}) // no role, no grant, no link
	if a.Mode != ModeView {
		t.Fatalf("mode=%s", a.Mode)
	}
	if len(a.Capabilities) != 0 {
		t.Fatalf("stranger must have no capabilities, got %v", a.Capabilities)
	}
}

func TestResolve_MemberCanShareAndEdit(t *testing.T) {
	a := Resolve(ResolveInput{WorkspaceRole: "member"})
	if a.Mode != ModeEdit {
		t.Fatalf("member base mode should be edit, got %s", a.Mode)
	}
	if !a.Has(CapEdit) || !a.Has(CapShare) {
		t.Fatalf("member should have edit+share: %v", a.Capabilities)
	}
	if a.Has(CapManageRoles) || a.Has(CapDelete) {
		t.Fatalf("member must not manage-roles/delete: %v", a.Capabilities)
	}
}

func TestResolve_ViewerFloorButGrantRaises(t *testing.T) {
	// A viewer with an explicit edit grant resolves to edit.
	a := Resolve(ResolveInput{WorkspaceRole: "viewer", Grants: []AccessMode{ModeEdit}})
	if a.Mode != ModeEdit || !a.Has(CapEdit) {
		t.Fatalf("grant should raise viewer to edit: %+v", a)
	}
	// Plain viewer: view+comment only, no edit/share.
	v := Resolve(ResolveInput{WorkspaceRole: "viewer"})
	if v.Mode != ModeView || v.Has(CapEdit) || v.Has(CapShare) {
		t.Fatalf("viewer should be view-only without edit/share: %+v", v)
	}
}

func TestResolve_LinkOnlyVisitor(t *testing.T) {
	a := Resolve(ResolveInput{Link: ModeComment})
	if a.Mode != ModeComment || !a.Has(CapComment) || a.Has(CapEdit) || a.Has(CapShare) {
		t.Fatalf("comment link should grant comment only: %+v", a)
	}
}

func TestResolve_ApprovalLockCapsEditEvenForAdmin(t *testing.T) {
	// Default lock policy (comment): admin keeps management caps but loses edit.
	a := Resolve(ResolveInput{WorkspaceRole: "admin", ApprovalLocked: true})
	if a.Mode != ModeComment {
		t.Fatalf("approval lock should cap mode to comment, got %s", a.Mode)
	}
	if a.Has(CapEdit) {
		t.Fatalf("edit must be removed under approval lock even for admin: %v", a.Capabilities)
	}
	if !a.Has(CapApprove) || !a.Has(CapManageRoles) {
		t.Fatalf("admin keeps non-edit management caps under lock: %v", a.Capabilities)
	}
	// "view" policy caps to view.
	v := Resolve(ResolveInput{WorkspaceRole: "admin", ApprovalLocked: true, LockPolicy: "view"})
	if v.Mode != ModeView {
		t.Fatalf("view lock policy should cap to view, got %s", v.Mode)
	}
}

func TestResolve_CustomRoleAddsCapability(t *testing.T) {
	a := Resolve(ResolveInput{
		WorkspaceRole: "viewer",
		CustomRoles:   []CustomRole{{ID: "r1", Name: "Approver", Capabilities: []Capability{CapApprove}}},
	})
	if !a.Has(CapApprove) {
		t.Fatalf("custom role should add approve: %v", a.Capabilities)
	}
	// But edit stays gated by the resolved mode (viewer floor -> no edit).
	if a.Has(CapEdit) {
		t.Fatalf("custom role must not grant edit beyond the resolved mode: %v", a.Capabilities)
	}
}
