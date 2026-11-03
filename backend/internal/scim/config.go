// Package scim is a SCIM 2.0 service provider (RFC 7643, RFC 7644) so an
// identity provider can create, update and deactivate accounts and drive
// workspace membership from its groups (F38 FR-13,
// docs/roadmap/38-scim-provisioning.md). It is off unless SCIM_TOKEN is set.
package scim

import (
	"fmt"
	"sort"
	"strings"
)

// Role is a workspace role a mapped group grants.
type Role string

const (
	RoleOwner  Role = "owner"
	RoleAdmin  Role = "admin"
	RoleMember Role = "member"
	RoleViewer Role = "viewer"
)

// rank orders roles so a person in several mapped groups gets the highest.
var rank = map[Role]int{RoleViewer: 1, RoleMember: 2, RoleAdmin: 3, RoleOwner: 4}

// Mode is how much of a mapped workspace's membership SCIM controls.
type Mode string

const (
	// ModeAdditive: SCIM changes only the memberships it created.
	ModeAdditive Mode = "additive"
	// ModeAuthoritative: the identity provider is the single source of truth for
	// the workspace's membership.
	ModeAuthoritative Mode = "authoritative"
)

// Grant is one mapped group's effect in one workspace.
type Grant struct {
	Workspace string
	Role      Role
}

// Config is the operator's SCIM configuration.
type Config struct {
	Token  string
	Groups map[string][]Grant // by group displayName, case-sensitive
	Modes  map[string]Mode    // by workspace slug; unlisted means additive
}

// minTokenLen keeps the bearer token out of guessing range; the token holder can
// create accounts and grant any mapped role, including owner.
const minTokenLen = 32

// LoadConfig reads SCIM_TOKEN, SCIM_GROUP_MAP and SCIM_WORKSPACE_MODES. It
// returns nil, nil when SCIM_TOKEN is unset (SCIM off). Any malformed value is
// an error naming the entry, so a typo stops the server at boot instead of
// silently granting nothing (or the wrong thing).
func LoadConfig(getenv func(string) string) (*Config, error) {
	token := strings.TrimSpace(getenv("SCIM_TOKEN"))
	if token == "" {
		return nil, nil
	}
	if len(token) < minTokenLen {
		return nil, fmt.Errorf("SCIM_TOKEN must be at least %d characters", minTokenLen)
	}
	cfg := &Config{Token: token, Groups: map[string][]Grant{}, Modes: map[string]Mode{}}
	seen := map[[2]string]bool{}
	for _, entry := range splitList(getenv("SCIM_GROUP_MAP")) {
		group, target, ok := strings.Cut(entry, "=")
		group, target = strings.TrimSpace(group), strings.TrimSpace(target)
		slug, role, ok2 := strings.Cut(target, ":")
		slug, role = strings.TrimSpace(slug), strings.ToLower(strings.TrimSpace(role))
		if !ok || !ok2 || group == "" || slug == "" {
			return nil, fmt.Errorf("SCIM_GROUP_MAP entry %q: want <group>=<workspace slug>:<role>", entry)
		}
		if _, known := rank[Role(role)]; !known {
			return nil, fmt.Errorf("SCIM_GROUP_MAP entry %q: unknown role %q (owner, admin, member or viewer)", entry, role)
		}
		key := [2]string{group, slug}
		if seen[key] {
			return nil, fmt.Errorf("SCIM_GROUP_MAP maps group %q to workspace %q twice", group, slug)
		}
		seen[key] = true
		cfg.Groups[group] = append(cfg.Groups[group], Grant{Workspace: slug, Role: Role(role)})
	}
	mapped := map[string]bool{}
	for _, slug := range cfg.Workspaces() {
		mapped[slug] = true
	}
	for _, entry := range splitList(getenv("SCIM_WORKSPACE_MODES")) {
		slug, mode, ok := strings.Cut(entry, ":")
		slug, mode = strings.TrimSpace(slug), strings.ToLower(strings.TrimSpace(mode))
		if !ok || slug == "" {
			return nil, fmt.Errorf("SCIM_WORKSPACE_MODES entry %q: want <workspace slug>:<additive or authoritative>", entry)
		}
		if mode != string(ModeAdditive) && mode != string(ModeAuthoritative) {
			return nil, fmt.Errorf("SCIM_WORKSPACE_MODES entry %q: unknown mode %q (additive or authoritative)", entry, mode)
		}
		if !mapped[slug] {
			// A mode for a workspace no group maps would control nothing, which is
			// almost certainly a typo in one of the two variables.
			return nil, fmt.Errorf("SCIM_WORKSPACE_MODES entry %q: workspace %q is not in SCIM_GROUP_MAP", entry, slug)
		}
		cfg.Modes[slug] = Mode(mode)
	}
	return cfg, nil
}

// ModeFor is the workspace's mode; additive unless configured otherwise.
func (c *Config) ModeFor(slug string) Mode {
	if m, ok := c.Modes[slug]; ok {
		return m
	}
	return ModeAdditive
}

// Workspaces lists every workspace slug the map mentions, sorted.
func (c *Config) Workspaces() []string {
	set := map[string]bool{}
	for _, grants := range c.Groups {
		for _, g := range grants {
			set[g.Workspace] = true
		}
	}
	out := make([]string, 0, len(set))
	for s := range set {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
