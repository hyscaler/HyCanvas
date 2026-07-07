package daemon

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// stubCommands replaces runCommand for the test's lifetime, recording every
// invocation and returning success.
func stubCommands(t *testing.T) *[][]string {
	t.Helper()
	var calls [][]string
	orig := runCommand
	runCommand = func(name string, args ...string) (string, error) {
		calls = append(calls, append([]string{name}, args...))
		return "", nil
	}
	t.Cleanup(func() { runCommand = orig })
	return &calls
}

func TestSystemdUnitUser(t *testing.T) {
	unit := systemdUnit("/opt/hy canvas/hycanvas", "/opt/hy canvas", false, "")
	for _, want := range []string{
		"ExecStart=\"/opt/hy canvas/hycanvas\"",
		"WorkingDirectory=/opt/hy canvas",
		"Restart=on-failure",
		"RestartSec=5",
		"WantedBy=default.target",
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("user unit missing %q:\n%s", want, unit)
		}
	}
	if strings.Contains(unit, "network-online.target") {
		t.Errorf("user unit must not order against network-online.target:\n%s", unit)
	}
	if strings.Contains(unit, "User=") {
		t.Errorf("user unit must not carry a User directive:\n%s", unit)
	}
}

func TestSystemdUnitSystem(t *testing.T) {
	unit := systemdUnit("/usr/local/bin/hycanvas", "/srv/hycanvas", true, "deploy")
	for _, want := range []string{
		"Wants=network-online.target",
		"After=network-online.target",
		"WantedBy=multi-user.target",
		"User=deploy",
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("system unit missing %q:\n%s", want, unit)
		}
	}
}

func TestLaunchdPlistSystemRunsAsUser(t *testing.T) {
	plist := launchdPlist("/srv/hycanvas/hycanvas", "/srv/hycanvas", "/Library/Logs/hycanvas", "deploy")
	if !strings.Contains(plist, "<key>UserName</key>") || !strings.Contains(plist, "<string>deploy</string>") {
		t.Errorf("system daemon plist must pin a non-root UserName:\n%s", plist)
	}
}

func TestLaunchdPlistEscapesXML(t *testing.T) {
	plist := launchdPlist("/tmp/a&b/hycanvas", "/tmp/a&b", "/tmp/a&b/logs", "")
	if strings.Contains(plist, "UserName") {
		t.Errorf("per-user agent must not carry a UserName key:\n%s", plist)
	}
	if !strings.Contains(plist, "<string>/tmp/a&amp;b/hycanvas</string>") {
		t.Errorf("exe path not XML-escaped:\n%s", plist)
	}
	for _, want := range []string{
		"<string>" + launchdLabel + "</string>",
		"<key>WorkingDirectory</key>",
		"<key>KeepAlive</key>",
		"<key>SuccessfulExit</key>",
		"<key>RunAtLoad</key>",
	} {
		if !strings.Contains(plist, want) {
			t.Errorf("plist missing %q:\n%s", want, plist)
		}
	}
}

func TestEnsureEnv(t *testing.T) {
	t.Run("env present", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("A=1\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		ready, _, err := ensureEnv(dir)
		if err != nil || !ready {
			t.Fatalf("want ready with existing .env, got ready=%v err=%v", ready, err)
		}
	})

	t.Run("bootstraps from example", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, ".env.example"), []byte("DATABASE_URL=\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		ready, msg, err := ensureEnv(dir)
		if err != nil {
			t.Fatal(err)
		}
		if ready {
			t.Fatal("freshly created .env must not be treated as ready")
		}
		if !strings.Contains(msg, "created") {
			t.Errorf("msg = %q, want creation notice", msg)
		}
		data, err := os.ReadFile(filepath.Join(dir, ".env"))
		if err != nil || string(data) != "DATABASE_URL=\n" {
			t.Fatalf(".env not copied from example: %q, %v", data, err)
		}
	})

	t.Run("nothing to bootstrap from", func(t *testing.T) {
		dir := t.TempDir()
		ready, msg, err := ensureEnv(dir)
		if err != nil || ready {
			t.Fatalf("want not ready, got ready=%v err=%v", ready, err)
		}
		if !strings.Contains(msg, "no .env") {
			t.Errorf("msg = %q, want missing-.env notice", msg)
		}
	})
}

func TestRunArgErrors(t *testing.T) {
	var out, errBuf bytes.Buffer
	if code := Run(nil, &out, &errBuf); code != 2 {
		t.Errorf("no args: code = %d, want 2", code)
	}
	if !strings.Contains(errBuf.String(), "usage:") {
		t.Errorf("no usage printed: %q", errBuf.String())
	}
	errBuf.Reset()
	if code := Run([]string{"dance"}, &out, &errBuf); code != 2 {
		t.Errorf("unknown verb: code = %d, want 2", code)
	}
	if !strings.Contains(errBuf.String(), "unknown service command") {
		t.Errorf("unknown-verb message missing: %q", errBuf.String())
	}
}

func TestNewManagerUnsupportedGOOS(t *testing.T) {
	if _, err := newManager("windows", false, io.Discard); err == nil {
		t.Fatal("windows must be rejected with guidance")
	} else if !strings.Contains(err.Error(), "Docker") {
		t.Errorf("error should point at alternatives: %v", err)
	}
}

func TestSystemdInstallReady(t *testing.T) {
	calls := stubCommands(t)
	home, dir := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("A=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	m := &systemdManager{exe: filepath.Join(dir, "hycanvas"), dir: dir, home: home, out: &out}
	if err := m.install(); err != nil {
		t.Fatal(err)
	}

	unit, err := os.ReadFile(filepath.Join(home, ".config", "systemd", "user", "hycanvas.service"))
	if err != nil {
		t.Fatalf("unit not written: %v", err)
	}
	if !strings.Contains(string(unit), "WorkingDirectory="+dir) {
		t.Errorf("unit lacks workdir:\n%s", unit)
	}

	want := [][]string{
		{"systemctl", "--user", "daemon-reload"},
		{"systemctl", "--user", "enable", "--now", "hycanvas"},
	}
	if len(*calls) != len(want) {
		t.Fatalf("calls = %v, want %v", *calls, want)
	}
	for i, w := range want {
		if strings.Join((*calls)[i], " ") != strings.Join(w, " ") {
			t.Errorf("call %d = %v, want %v", i, (*calls)[i], w)
		}
	}
}

func TestSystemdInstallNotReadyDoesNotStart(t *testing.T) {
	calls := stubCommands(t)
	home, dir := t.TempDir(), t.TempDir()
	var out bytes.Buffer
	m := &systemdManager{exe: filepath.Join(dir, "hycanvas"), dir: dir, home: home, out: &out}
	if err := m.install(); err != nil {
		t.Fatal(err)
	}
	for _, c := range *calls {
		joined := strings.Join(c, " ")
		if strings.Contains(joined, "--now") || strings.Contains(joined, " start") {
			t.Errorf("service must not start without a ready .env: %v", c)
		}
	}
	if !strings.Contains(out.String(), "hycanvas service start") {
		t.Errorf("output should tell the user how to start later: %q", out.String())
	}
}

func TestSystemdUninstallRemovesUnit(t *testing.T) {
	stubCommands(t)
	home := t.TempDir()
	unitPath := filepath.Join(home, ".config", "systemd", "user", "hycanvas.service")
	if err := os.MkdirAll(filepath.Dir(unitPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(unitPath, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := &systemdManager{home: home, out: io.Discard}
	if err := m.uninstall(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(unitPath); !os.IsNotExist(err) {
		t.Errorf("unit file still present after uninstall")
	}
}

func TestLaunchdInstallReady(t *testing.T) {
	calls := stubCommands(t)
	home, dir := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("A=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	m := &launchdManager{exe: filepath.Join(dir, "hycanvas"), dir: dir, home: home, uid: 501, out: &out}
	if err := m.install(); err != nil {
		t.Fatal(err)
	}

	plist, err := os.ReadFile(filepath.Join(home, "Library", "LaunchAgents", launchdLabel+".plist"))
	if err != nil {
		t.Fatalf("plist not written: %v", err)
	}
	if !strings.Contains(string(plist), "<string>"+dir+"</string>") {
		t.Errorf("plist lacks workdir:\n%s", plist)
	}

	var sawBootstrap bool
	for _, c := range *calls {
		if len(c) >= 3 && c[0] == "launchctl" && c[1] == "bootstrap" && c[2] == "gui/501" {
			sawBootstrap = true
		}
	}
	if !sawBootstrap {
		t.Errorf("expected launchctl bootstrap gui/501, got calls: %v", *calls)
	}
}

func TestLaunchdInstallNotReadyDoesNotBootstrap(t *testing.T) {
	calls := stubCommands(t)
	home, dir := t.TempDir(), t.TempDir()
	m := &launchdManager{exe: filepath.Join(dir, "hycanvas"), dir: dir, home: home, uid: 501, out: io.Discard}
	if err := m.install(); err != nil {
		t.Fatal(err)
	}
	for _, c := range *calls {
		if len(c) >= 2 && c[1] == "bootstrap" {
			t.Errorf("must not bootstrap without a ready .env: %v", *calls)
		}
	}
}

func TestLaunchdUninstallRemovesPlist(t *testing.T) {
	stubCommands(t)
	home := t.TempDir()
	plistPath := filepath.Join(home, "Library", "LaunchAgents", launchdLabel+".plist")
	if err := os.MkdirAll(filepath.Dir(plistPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(plistPath, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := &launchdManager{home: home, uid: 501, out: io.Discard}
	if err := m.uninstall(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(plistPath); !os.IsNotExist(err) {
		t.Errorf("plist still present after uninstall")
	}
}
