// Package daemon implements the `hycanvas service` subcommand: it installs and
// manages the binary as an OS service (a systemd unit on Linux, a launchd
// agent on macOS) so self-hosted deployments need no external process manager.
// The serving path is untouched; the service manager simply runs the binary in
// the foreground and relies on its existing graceful SIGTERM shutdown.
package daemon

import (
	"encoding/xml"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

const (
	serviceName  = "hycanvas"
	launchdLabel = "com.hycanvas.app"
)

// runCommand is swappable in tests so verbs can be exercised without touching
// the host's systemd or launchd.
var runCommand = func(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

type manager interface {
	install() error
	uninstall() error
	start() error
	stop() error
	restart() error
	status() error
}

// Run executes `hycanvas service <verb>` and returns the process exit code.
// Output is plain text: this is an interactive command, not the JSON server.
func Run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		usage(stderr)
		return 2
	}
	verb := args[0]
	fs := flag.NewFlagSet("service", flag.ContinueOnError)
	fs.SetOutput(stderr)
	system := fs.Bool("system", false, "manage a system-wide service instead of a per-user one")
	if err := fs.Parse(args[1:]); err != nil {
		return 2
	}

	mgr, err := newManager(runtime.GOOS, *system, stdout)
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 1
	}

	var verr error
	switch verb {
	case "install":
		verr = mgr.install()
	case "uninstall":
		verr = mgr.uninstall()
	case "start":
		verr = mgr.start()
	case "stop":
		verr = mgr.stop()
	case "restart":
		verr = mgr.restart()
	case "status":
		verr = mgr.status()
	default:
		fmt.Fprintf(stderr, "unknown service command %q\n\n", verb)
		usage(stderr)
		return 2
	}
	if verr != nil {
		fmt.Fprintln(stderr, "error:", verr)
		return 1
	}
	return 0
}

func usage(w io.Writer) {
	fmt.Fprintln(w, "usage: hycanvas service <install|uninstall|start|stop|restart|status> [--system]")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Installs and manages HyCanvas as an OS service: a systemd unit on Linux,")
	fmt.Fprintln(w, "a launchd agent on macOS. The service runs per-user by default; --system")
	fmt.Fprintln(w, "installs it system-wide (sudo needed to install, but the service itself")
	fmt.Fprintln(w, "still runs as the non-root user who invoked sudo; HyCanvas never runs as")
	fmt.Fprintln(w, "root). The directory the binary lives in becomes the working directory,")
	fmt.Fprintln(w, "which is where .env is read from.")
}

func newManager(goos string, system bool, out io.Writer) (manager, error) {
	switch goos {
	case "linux", "darwin":
	default:
		return nil, fmt.Errorf("`hycanvas service` supports Linux (systemd) and macOS (launchd) only; on %s run the binary under Docker or a service wrapper such as NSSM or the Task Scheduler", goos)
	}
	var runAs *user.User
	if system {
		if os.Geteuid() != 0 {
			return nil, fmt.Errorf("--system requires sudo to install; the service itself still runs unprivileged")
		}
		// HyCanvas must never run as root, so a system-wide service is pinned
		// to the non-root user who invoked sudo.
		name := os.Getenv("SUDO_USER")
		if name == "" || name == "root" {
			return nil, fmt.Errorf("cannot determine the non-root user the service should run as; invoke as `sudo hycanvas service ... --system` from that user's shell (not from a root shell)")
		}
		u, err := user.Lookup(name)
		if err != nil {
			return nil, fmt.Errorf("look up user %q: %w", name, err)
		}
		runAs = u
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("resolve executable path: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	home, err := os.UserHomeDir()
	if err != nil && !system {
		return nil, fmt.Errorf("resolve home directory: %w", err)
	}
	if goos == "linux" {
		return &systemdManager{system: system, runAs: runAs, exe: exe, dir: filepath.Dir(exe), home: home, out: out}, nil
	}
	return &launchdManager{system: system, runAs: runAs, exe: exe, dir: filepath.Dir(exe), home: home, uid: os.Getuid(), out: out}, nil
}

// ensureEnv makes sure a .env exists next to the binary. When it has to create
// one from .env.example (the release archive ships it), or cannot create one
// at all, the service must not be started yet; ready reports that.
func ensureEnv(dir string) (ready bool, msg string, err error) {
	envPath := filepath.Join(dir, ".env")
	if _, err := os.Stat(envPath); err == nil {
		return true, "", nil
	}
	example := filepath.Join(dir, ".env.example")
	if _, err := os.Stat(example); err == nil {
		data, err := os.ReadFile(example)
		if err != nil {
			return false, "", err
		}
		if err := os.WriteFile(envPath, data, 0o600); err != nil {
			return false, "", err
		}
		return false, fmt.Sprintf("created %s from .env.example; edit it (at minimum DATABASE_URL and JWT_SECRET)", envPath), nil
	}
	return false, fmt.Sprintf("no .env found next to the binary; create %s (at minimum DATABASE_URL and JWT_SECRET)", envPath), nil
}

func cmdErr(what, out string, err error) error {
	if out == "" {
		return fmt.Errorf("%s: %w", what, err)
	}
	return fmt.Errorf("%s: %w: %s", what, err, out)
}

// ---- systemd (Linux) ----

type systemdManager struct {
	system bool
	runAs  *user.User // service account for --system units; nil in user mode
	exe    string
	dir    string
	home   string
	out    io.Writer
}

func (m *systemdManager) unitPath() string {
	if m.system {
		return filepath.Join("/etc/systemd/system", serviceName+".service")
	}
	return filepath.Join(m.home, ".config", "systemd", "user", serviceName+".service")
}

func (m *systemdManager) systemctl(args ...string) (string, error) {
	if !m.system {
		args = append([]string{"--user"}, args...)
	}
	return runCommand("systemctl", args...)
}

// systemdUnit renders the unit file. ExecStart is quoted because systemd
// shell-splits it; WorkingDirectory takes the value verbatim. User units
// cannot order against network-online.target, only the system instance can.
// runAs pins a system unit to a non-root account (HyCanvas never runs as
// root); it is empty for per-user units, which are unprivileged by nature.
func systemdUnit(exe, workdir string, system bool, runAs string) string {
	var b strings.Builder
	b.WriteString("[Unit]\n")
	b.WriteString("Description=HyCanvas server\n")
	if system {
		b.WriteString("Wants=network-online.target\n")
		b.WriteString("After=network-online.target\n")
	}
	b.WriteString("\n[Service]\n")
	fmt.Fprintf(&b, "ExecStart=%q\n", exe)
	fmt.Fprintf(&b, "WorkingDirectory=%s\n", workdir)
	if system && runAs != "" {
		fmt.Fprintf(&b, "User=%s\n", runAs)
	}
	b.WriteString("Restart=on-failure\n")
	b.WriteString("RestartSec=5\n")
	b.WriteString("\n[Install]\n")
	if system {
		b.WriteString("WantedBy=multi-user.target\n")
	} else {
		b.WriteString("WantedBy=default.target\n")
	}
	return b.String()
}

func (m *systemdManager) install() error {
	ready, msg, err := ensureEnv(m.dir)
	if err != nil {
		return err
	}
	path := m.unitPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(systemdUnit(m.exe, m.dir, m.system, m.runAsName())), 0o644); err != nil {
		return err
	}
	fmt.Fprintln(m.out, "wrote", path)
	if m.system {
		fmt.Fprintf(m.out, "the service runs as %s (never root); %s must stay readable and writable by that user\n", m.runAsName(), m.dir)
	}
	if out, err := m.systemctl("daemon-reload"); err != nil {
		return cmdErr("systemctl daemon-reload", out, err)
	}
	if ready {
		if out, err := m.systemctl("enable", "--now", serviceName); err != nil {
			return cmdErr("systemctl enable --now", out, err)
		}
		fmt.Fprintln(m.out, "service enabled and started")
	} else {
		if out, err := m.systemctl("enable", serviceName); err != nil {
			return cmdErr("systemctl enable", out, err)
		}
		fmt.Fprintln(m.out, msg)
		fmt.Fprintln(m.out, "service enabled; run `hycanvas service start` once .env is ready")
	}
	if !m.system {
		fmt.Fprintf(m.out, "hint: run `loginctl enable-linger %s` so the service keeps running after logout\n", userName())
	}
	return nil
}

func (m *systemdManager) runAsName() string {
	if m.runAs == nil {
		return ""
	}
	return m.runAs.Username
}

func (m *systemdManager) uninstall() error {
	// Best effort: the unit may not be enabled or running.
	_, _ = m.systemctl("disable", "--now", serviceName)
	if err := os.Remove(m.unitPath()); err != nil && !os.IsNotExist(err) {
		return err
	}
	_, _ = m.systemctl("daemon-reload")
	fmt.Fprintln(m.out, "service removed")
	return nil
}

func (m *systemdManager) start() error   { return m.ctl("start") }
func (m *systemdManager) stop() error    { return m.ctl("stop") }
func (m *systemdManager) restart() error { return m.ctl("restart") }

func (m *systemdManager) ctl(verb string) error {
	if out, err := m.systemctl(verb, serviceName); err != nil {
		return cmdErr("systemctl "+verb, out, err)
	}
	fmt.Fprintf(m.out, "service %s: ok\n", verb)
	return nil
}

func (m *systemdManager) status() error {
	// systemctl status exits non-zero for inactive units; the output already
	// says so, so only treat an empty result as a real error.
	out, err := m.systemctl("status", "--no-pager", serviceName)
	if out != "" {
		fmt.Fprintln(m.out, out)
		return nil
	}
	return err
}

// ---- launchd (macOS) ----

type launchdManager struct {
	system bool
	runAs  *user.User // service account for --system daemons; nil in user mode
	exe    string
	dir    string
	home   string
	uid    int
	out    io.Writer
}

func (m *launchdManager) plistPath() string {
	if m.system {
		return filepath.Join("/Library/LaunchDaemons", launchdLabel+".plist")
	}
	return filepath.Join(m.home, "Library", "LaunchAgents", launchdLabel+".plist")
}

func (m *launchdManager) domain() string {
	if m.system {
		return "system"
	}
	return fmt.Sprintf("gui/%d", m.uid)
}

func (m *launchdManager) target() string {
	return m.domain() + "/" + launchdLabel
}

func (m *launchdManager) logDir() string {
	if m.system {
		return filepath.Join("/Library/Logs", serviceName)
	}
	return filepath.Join(m.home, "Library", "Logs", serviceName)
}

// launchdPlist renders the agent/daemon definition. runAs pins a system
// daemon to a non-root account (HyCanvas never runs as root); it is empty for
// per-user agents, which launchd already runs as the logged-in user.
func launchdPlist(exe, workdir, logDir, runAs string) string {
	userNameKey := ""
	if runAs != "" {
		userNameKey = fmt.Sprintf("\t<key>UserName</key>\n\t<string>%s</string>\n", xmlEscape(runAs))
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>%s</string>
	<key>ProgramArguments</key>
	<array>
		<string>%s</string>
	</array>
	<key>WorkingDirectory</key>
	<string>%s</string>
%s	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>StandardOutPath</key>
	<string>%s</string>
	<key>StandardErrorPath</key>
	<string>%s</string>
</dict>
</plist>
`, launchdLabel, xmlEscape(exe), xmlEscape(workdir), userNameKey,
		xmlEscape(filepath.Join(logDir, serviceName+".log")),
		xmlEscape(filepath.Join(logDir, serviceName+".err.log")))
}

func xmlEscape(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func (m *launchdManager) install() error {
	ready, msg, err := ensureEnv(m.dir)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(m.logDir(), 0o755); err != nil {
		return err
	}
	// A --system install runs as root but the service does not; the service
	// account must be able to write its logs.
	if m.runAs != nil {
		uid, uerr := strconv.Atoi(m.runAs.Uid)
		gid, gerr := strconv.Atoi(m.runAs.Gid)
		if uerr == nil && gerr == nil {
			if err := os.Chown(m.logDir(), uid, gid); err != nil {
				return fmt.Errorf("chown log dir to %s: %w", m.runAs.Username, err)
			}
		}
	}
	path := m.plistPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	// Unload any previous definition so a reinstall picks up the new plist.
	_, _ = runCommand("launchctl", "bootout", m.target())
	if err := os.WriteFile(path, []byte(launchdPlist(m.exe, m.dir, m.logDir(), m.runAsName())), 0o644); err != nil {
		return err
	}
	fmt.Fprintln(m.out, "wrote", path)
	if m.system {
		fmt.Fprintf(m.out, "the service runs as %s (never root); %s must stay readable and writable by that user\n", m.runAsName(), m.dir)
	}
	if ready {
		if out, err := runCommand("launchctl", "bootstrap", m.domain(), path); err != nil {
			return cmdErr("launchctl bootstrap", out, err)
		}
		fmt.Fprintln(m.out, "service loaded and started")
		fmt.Fprintln(m.out, "logs:", m.logDir())
	} else {
		fmt.Fprintln(m.out, msg)
		fmt.Fprintln(m.out, "run `hycanvas service start` once .env is ready")
	}
	return nil
}

func (m *launchdManager) runAsName() string {
	if m.runAs == nil {
		return ""
	}
	return m.runAs.Username
}

func (m *launchdManager) uninstall() error {
	// Best effort: the agent may not be loaded.
	_, _ = runCommand("launchctl", "bootout", m.target())
	if err := os.Remove(m.plistPath()); err != nil && !os.IsNotExist(err) {
		return err
	}
	fmt.Fprintln(m.out, "service removed")
	return nil
}

func (m *launchdManager) start() error {
	if _, err := os.Stat(m.plistPath()); err != nil {
		return fmt.Errorf("not installed; run `hycanvas service install` first")
	}
	// Bootstrap is a no-op failure when already loaded; kickstart then does
	// the actual start and reports meaningful errors.
	_, _ = runCommand("launchctl", "bootstrap", m.domain(), m.plistPath())
	if out, err := runCommand("launchctl", "kickstart", m.target()); err != nil {
		return cmdErr("launchctl kickstart", out, err)
	}
	fmt.Fprintln(m.out, "service started")
	return nil
}

func (m *launchdManager) stop() error {
	if out, err := runCommand("launchctl", "bootout", m.target()); err != nil {
		return cmdErr("launchctl bootout", out, err)
	}
	fmt.Fprintln(m.out, "service stopped (unloaded until the next start or login)")
	return nil
}

func (m *launchdManager) restart() error {
	if _, err := runCommand("launchctl", "kickstart", "-k", m.target()); err != nil {
		// Not loaded; treat as a fresh start.
		return m.start()
	}
	fmt.Fprintln(m.out, "service restarted")
	return nil
}

func (m *launchdManager) status() error {
	out, err := runCommand("launchctl", "print", m.target())
	if err != nil {
		if _, statErr := os.Stat(m.plistPath()); statErr == nil {
			fmt.Fprintln(m.out, "installed but not loaded; run `hycanvas service start`")
		} else {
			fmt.Fprintln(m.out, "not installed; run `hycanvas service install`")
		}
		return nil
	}
	// launchctl print is verbose; surface only the interesting lines.
	for _, line := range strings.Split(out, "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "state") || strings.HasPrefix(t, "pid") ||
			strings.HasPrefix(t, "path") || strings.HasPrefix(t, "last exit") {
			fmt.Fprintln(m.out, t)
		}
	}
	return nil
}

func userName() string {
	if u := os.Getenv("USER"); u != "" {
		return u
	}
	return "<user>"
}
