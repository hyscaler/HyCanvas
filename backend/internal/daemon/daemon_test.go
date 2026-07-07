package daemon

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

// stubServer writes an executable script into dir that ignores its args and
// sleeps, standing in for the real server so start/stop can be exercised.
func stubServer(t *testing.T, dir string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("stub script based tests are unix-only")
	}
	exe := filepath.Join(dir, "hycanvas")
	script := "#!/bin/sh\necho \"stub server up\"\nexec sleep 60\n"
	if err := os.WriteFile(exe, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return exe
}

func newTestSvc(t *testing.T) (*svc, *bytes.Buffer) {
	t.Helper()
	dir := t.TempDir()
	var out bytes.Buffer
	s := &svc{exe: stubServer(t, dir), dir: dir, out: &out}
	t.Cleanup(func() {
		if pid, alive := s.readPid(); alive {
			_ = forceKill(pid)
		}
	})
	return s, &out
}

func TestGenerateSecret(t *testing.T) {
	a, b := GenerateSecret(), GenerateSecret()
	if len(a) < 24 || a == b {
		t.Fatalf("weak secret generation: %q %q", a, b)
	}
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

func TestStartStopLifecycle(t *testing.T) {
	s, out := newTestSvc(t)

	if err := s.start(); err != nil {
		t.Fatalf("start: %v\noutput: %s", err, out.String())
	}
	pid, alive := s.readPid()
	if !alive {
		t.Fatal("server not alive after start")
	}
	// First run without .env must surface the wizard secret and URL.
	if !strings.Contains(out.String(), "wizard access secret:") ||
		!strings.Contains(out.String(), "/installation/step-1") {
		t.Errorf("first-run output missing wizard secret/URL: %q", out.String())
	}

	out.Reset()
	if err := s.start(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "already running") {
		t.Errorf("double start should refuse: %q", out.String())
	}
	if p2, _ := s.readPid(); p2 != pid {
		t.Errorf("double start replaced pid %d with %d", pid, p2)
	}

	out.Reset()
	if err := s.status(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "running (pid "+strconv.Itoa(pid)+")") {
		t.Errorf("status should report running: %q", out.String())
	}

	out.Reset()
	if err := s.stop(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "stopped") {
		t.Errorf("stop output: %q", out.String())
	}
	if _, err := os.Stat(s.pidPath()); !os.IsNotExist(err) {
		t.Error("pidfile not removed by stop")
	}
	if processAlive(pid) {
		t.Error("process still alive after stop")
	}
}

func TestStartWithEnvDoesNotPrintSecret(t *testing.T) {
	s, out := newTestSvc(t)
	if err := os.WriteFile(filepath.Join(s.dir, ".env"), []byte("A=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.start(); err != nil {
		t.Fatalf("start: %v\noutput: %s", err, out.String())
	}
	defer func() { _ = s.stop() }()
	if strings.Contains(out.String(), "wizard access secret") {
		t.Errorf("secret printed although .env exists: %q", out.String())
	}
	if !strings.Contains(out.String(), "serving on") {
		t.Errorf("normal start output missing: %q", out.String())
	}
}

func TestStalePidfileRecovery(t *testing.T) {
	s, out := newTestSvc(t)
	// A pid that cannot be alive: max pid space on the platforms we test.
	if err := os.WriteFile(s.pidPath(), []byte("99999999\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.start(); err != nil {
		t.Fatalf("start with stale pidfile: %v\noutput: %s", err, out.String())
	}
	defer func() { _ = s.stop() }()
	if pid, alive := s.readPid(); !alive || pid == 99999999 {
		t.Errorf("stale pidfile not replaced: pid=%d alive=%v", pid, alive)
	}
}

func TestStopWhenNotRunning(t *testing.T) {
	s, out := newTestSvc(t)
	if err := s.stop(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "not running") {
		t.Errorf("stop on idle service: %q", out.String())
	}
}

func TestStartFailsFastWhenServerDies(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "hycanvas")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\necho boom >&2\nexit 3\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	s := &svc{exe: exe, dir: dir, out: &out}
	if err := s.start(); err == nil {
		t.Fatalf("start should fail when the server dies immediately; output: %s", out.String())
	}
	if !strings.Contains(out.String(), "boom") {
		t.Errorf("failure output should include the log tail: %q", out.String())
	}
	if _, err := os.Stat(s.pidPath()); !os.IsNotExist(err) {
		t.Error("pidfile left behind after failed start")
	}
}

func TestLogTail(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, logFileName)
	var content strings.Builder
	for i := 1; i <= 300; i++ {
		content.WriteString("line " + strconv.Itoa(i) + "\n")
	}
	if err := os.WriteFile(logPath, []byte(content.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	s := &svc{dir: dir, out: &out}
	if err := s.log([]string{"-n", "3"}); err != nil {
		t.Fatal(err)
	}
	got := strings.TrimSpace(out.String())
	want := "line 298\nline 299\nline 300"
	if got != want {
		t.Errorf("log -n 3 = %q, want %q", got, want)
	}
}

func TestLogMissingFile(t *testing.T) {
	var out bytes.Buffer
	s := &svc{dir: t.TempDir(), out: &out}
	if err := s.log(nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "no log file yet") {
		t.Errorf("missing log message: %q", out.String())
	}
}

func TestTailLinesTruncatedWindow(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "big.log")
	// Bigger than the 256KB window so the partial first line is dropped.
	line := strings.Repeat("x", 1024)
	var b strings.Builder
	for i := 0; i < 400; i++ {
		b.WriteString(line + strconv.Itoa(i) + "\n")
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	lines := tailLines(path, 5)
	if len(lines) != 5 {
		t.Fatalf("got %d lines, want 5", len(lines))
	}
	if !strings.HasSuffix(lines[4], "399") {
		t.Errorf("last line = %q, want suffix 399", lines[4])
	}
}
