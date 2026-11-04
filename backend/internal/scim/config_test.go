package scim

import (
	"reflect"
	"strings"
	"testing"
)

const goodToken = "0123456789abcdef0123456789abcdef"

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestLoadConfigDisabledWithoutToken(t *testing.T) {
	cfg, err := LoadConfig(env(map[string]string{"SCIM_GROUP_MAP": "a=b:member"}))
	if err != nil || cfg != nil {
		t.Fatalf("no token: got %v, %v; want nil, nil (SCIM off)", cfg, err)
	}
}

func TestLoadConfigParsesMapAndModes(t *testing.T) {
	cfg, err := LoadConfig(env(map[string]string{
		"SCIM_TOKEN":           goodToken,
		"SCIM_GROUP_MAP":       " hycanvas-admins = vera:admin , staff=vera:member, staff=clients:viewer ,Design Team=vera:member",
		"SCIM_WORKSPACE_MODES": "vera:authoritative",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][]Grant{
		"hycanvas-admins": {{Workspace: "vera", Role: RoleAdmin}},
		"staff":           {{Workspace: "vera", Role: RoleMember}, {Workspace: "clients", Role: RoleViewer}},
		"Design Team":     {{Workspace: "vera", Role: RoleMember}},
	}
	if !reflect.DeepEqual(cfg.Groups, want) {
		t.Fatalf("groups = %#v", cfg.Groups)
	}
	if cfg.ModeFor("vera") != ModeAuthoritative || cfg.ModeFor("clients") != ModeAdditive {
		t.Fatalf("modes: vera=%s clients=%s", cfg.ModeFor("vera"), cfg.ModeFor("clients"))
	}
	if cfg.Token != goodToken {
		t.Fatal("token not kept")
	}
}

func TestLoadConfigRejects(t *testing.T) {
	for name, c := range map[string]struct {
		vars map[string]string
		want string
	}{
		"short token":       {map[string]string{"SCIM_TOKEN": "short"}, "32"},
		"entry without =":   {map[string]string{"SCIM_TOKEN": goodToken, "SCIM_GROUP_MAP": "staff"}, "staff"},
		"entry without :":   {map[string]string{"SCIM_TOKEN": goodToken, "SCIM_GROUP_MAP": "staff=vera"}, "staff=vera"},
		"unknown role":      {map[string]string{"SCIM_TOKEN": goodToken, "SCIM_GROUP_MAP": "staff=vera:god"}, "god"},
		"empty group":       {map[string]string{"SCIM_TOKEN": goodToken, "SCIM_GROUP_MAP": "=vera:member"}, "=vera:member"},
		"unknown mode":      {map[string]string{"SCIM_TOKEN": goodToken, "SCIM_GROUP_MAP": "s=vera:member", "SCIM_WORKSPACE_MODES": "vera:sometimes"}, "sometimes"},
		"unmapped mode":     {map[string]string{"SCIM_TOKEN": goodToken, "SCIM_GROUP_MAP": "s=vera:member", "SCIM_WORKSPACE_MODES": "other:authoritative"}, "other"},
		"duplicate mapping": {map[string]string{"SCIM_TOKEN": goodToken, "SCIM_GROUP_MAP": "s=vera:member,s=vera:admin"}, "vera"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := LoadConfig(env(c.vars))
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("got %v, want an error naming %q", err, c.want)
			}
		})
	}
}

func TestWorkspacesListsEveryMappedSlug(t *testing.T) {
	cfg, err := LoadConfig(env(map[string]string{"SCIM_TOKEN": goodToken, "SCIM_GROUP_MAP": "a=vera:member,b=clients:viewer,c=vera:admin"}))
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Workspaces(); !reflect.DeepEqual(got, []string{"clients", "vera"}) {
		t.Fatalf("workspaces = %v", got)
	}
}
