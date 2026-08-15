// Package daemon implements the `hycanvas service` subcommand: it runs the
// binary as a self-managed background process with a pidfile and logfile next
// to the binary. No OS service manager is involved, so the same verbs work on
// Linux, macOS, and Windows; boot persistence, if wanted, is up to the
// operator (Docker, cron, or their own supervisor).
package daemon

import (
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"hycanvas/backend/internal/setup"
)

const (
	pidFileName = "hycanvas.pid"
	logFileName = "hycanvas.log"

	// stopGrace is how long stop waits for a graceful shutdown before
	// escalating to a hard kill.
	stopGrace = 15 * time.Second
)

// SetupSecretEnv carries the wizard access secret from `service start` to the
// spawned server so the operator sees the secret in their own terminal while
// the server (booting into setup mode without a .env) enforces the same value.
const SetupSecretEnv = "HYCANVAS_SETUP_SECRET"

// ProcessAlive exposes the platform liveness probe to sibling CLI commands
// (storage migrate checks the server pidfile with it).
func ProcessAlive(pid int) bool {
	return processAlive(pid)
}

// GenerateSecret returns a random secret for the first-run wizard gate.
func GenerateSecret() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand failing means the host is unusable
	}
	return hex.EncodeToString(b)
}

// Run executes `hycanvas service <verb>` and returns the process exit code.
func Run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		usage(stderr)
		return 2
	}
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintln(stderr, "error: resolve executable path:", err)
		return 1
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	s := &svc{exe: exe, dir: filepath.Dir(exe), out: stdout}

	var verr error
	switch verb := args[0]; verb {
	case "start":
		verr = s.start()
	case "stop":
		verr = s.stop()
	case "restart":
		verr = s.restart()
	case "status":
		verr = s.status()
	case "log", "logs":
		verr = s.log(args[1:])
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
	fmt.Fprintln(w, "usage: hycanvas service <start|stop|restart|status|log>")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Runs HyCanvas as a self-managed background process (pidfile and logfile")
	fmt.Fprintln(w, "next to the binary; the binary's directory is the working directory, which")
	fmt.Fprintln(w, "is where .env is read from). `hycanvas start` runs it in the foreground.")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  start     start the background process (a first run without a .env asks")
	fmt.Fprintln(w, "            whether to set up in the browser, printing the wizard URL and")
	fmt.Fprintln(w, "            access secret, or right here in the terminal)")
	fmt.Fprintln(w, "  stop      graceful shutdown, hard kill after a grace period")
	fmt.Fprintln(w, "  restart   stop then start")
	fmt.Fprintln(w, "  status    liveness and the last log line")
	fmt.Fprintln(w, "  log       print the last log lines; -f follows, -n sets the line count")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "See also: `hycanvas storage migrate` moves local-disk blobs to S3.")
}

type svc struct {
	exe string
	dir string
	out io.Writer
	// Immediate-death window for start(): how long the spawned server may take
	// to fail before start reports success. Zero means the production default
	// (startGrace). Tests inject a larger window: on a loaded machine even the
	// fork+exec+exit+reap of an instantly-dying child can exceed the default,
	// and death is detected the moment it is reaped, so a generous window adds
	// no wall time when the child actually dies.
	grace time.Duration
}

// How long start() watches the spawned server for an immediate exit before
// reporting success. Every successful start waits this out in full, so it
// stays short; see svc.grace for the tradeoff.
const startGrace = 1500 * time.Millisecond

func (s *svc) pidPath() string { return filepath.Join(s.dir, pidFileName) }
func (s *svc) logPath() string { return filepath.Join(s.dir, logFileName) }

// readPid returns the recorded pid and whether that process is alive.
// A pidfile whose process is gone is stale; callers may clean it up.
func (s *svc) readPid() (pid int, alive bool) {
	raw, err := os.ReadFile(s.pidPath())
	if err != nil {
		return 0, false
	}
	pid, err = strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		return 0, false
	}
	return pid, processAlive(pid)
}

func (s *svc) start() error {
	if pid, alive := s.readPid(); alive {
		fmt.Fprintf(s.out, "already running (pid %d)\n", pid)
		return nil
	}
	// A pidfile without a live process is left over from a crash or kill -9.
	_ = os.Remove(s.pidPath())

	logf, err := os.OpenFile(s.logPath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("open log file: %w", err)
	}
	defer logf.Close()

	env := os.Environ()
	secret := ""
	if _, err := os.Stat(filepath.Join(s.dir, ".env")); err != nil {
		// No .env: this is a first run. When interactive, offer the terminal
		// wizard right here (it writes .env, then the service starts
		// normally); otherwise, or when the operator picks the browser, the
		// spawned server boots into the web wizard and the access secret
		// generated here reaches the operator's terminal.
		stdin := setup.NewStdinReader()
		if setup.ChooseMode(true, stdin, s.out) == setup.ModeCLI {
			if err := setup.RunCLI(s.dir, stdin); err != nil {
				return err
			}
		} else {
			secret = GenerateSecret()
			env = append(env, SetupSecretEnv+"="+secret)
		}
	}

	cmd := exec.Command(s.exe, "start")
	cmd.Dir = s.dir
	cmd.Stdout = logf
	cmd.Stderr = logf
	cmd.Env = env
	cmd.SysProcAttr = detachAttr()
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("spawn server: %w", err)
	}
	pid := cmd.Process.Pid
	if err := os.WriteFile(s.pidPath(), []byte(strconv.Itoa(pid)+"\n"), 0o600); err != nil {
		_ = forceKill(pid)
		return fmt.Errorf("write pidfile: %w", err)
	}
	// Reap the child if it exits while this command still runs; otherwise a
	// dead server would linger as a zombie and read as alive. This command
	// exits right after anyway, at which point init adopts the server.
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()

	// Catch immediate failures (bad port, unreadable dir) so the operator is
	// not told "started" about a process that already died. Waiting on the
	// child's own exit (not a PID liveness probe) is immune to the OS
	// recycling the PID within the grace window. The window is generous
	// because on a loaded machine even fork+exec+exit of a dying child can
	// take the better part of a second; a daemon start can afford the wait.
	grace := s.grace
	if grace <= 0 {
		grace = startGrace
	}
	select {
	case <-exited:
		_ = os.Remove(s.pidPath())
		fmt.Fprintln(s.out, "server exited immediately; last log lines:")
		s.printTail(80)
		return fmt.Errorf("server failed to start")
	case <-time.After(grace):
	}

	fmt.Fprintf(s.out, "started (pid %d)\n", pid)
	fmt.Fprintln(s.out, "logs:", s.logPath())
	port := os.Getenv("PORT")
	if port == "" {
		port = "8005"
	}
	if secret != "" {
		fmt.Fprintf(s.out, "\nfirst run: finish setup at http://localhost:%s/installation/step-1\n", port)
		fmt.Fprintf(s.out, "wizard access secret: %s\n", secret)
		fmt.Fprintln(s.out, "(the wizard asks for this secret before anything can be configured)")
	} else {
		fmt.Fprintf(s.out, "serving on http://localhost:%s\n", port)
	}
	return nil
}

func (s *svc) stop() error {
	pid, alive := s.readPid()
	if !alive {
		_ = os.Remove(s.pidPath())
		fmt.Fprintln(s.out, "not running")
		return nil
	}
	if err := terminate(pid); err != nil {
		return fmt.Errorf("signal pid %d: %w", pid, err)
	}
	deadline := time.Now().Add(stopGrace)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			_ = os.Remove(s.pidPath())
			fmt.Fprintf(s.out, "stopped (pid %d)\n", pid)
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	_ = forceKill(pid)
	time.Sleep(500 * time.Millisecond)
	if processAlive(pid) {
		return fmt.Errorf("pid %d did not exit even after SIGKILL", pid)
	}
	_ = os.Remove(s.pidPath())
	fmt.Fprintf(s.out, "stopped (pid %d, forced after %s grace)\n", pid, stopGrace)
	return nil
}

func (s *svc) restart() error {
	if err := s.stop(); err != nil {
		return err
	}
	return s.start()
}

func (s *svc) status() error {
	pid, alive := s.readPid()
	if !alive {
		fmt.Fprintln(s.out, "not running")
		return nil
	}
	fmt.Fprintf(s.out, "running (pid %d)\n", pid)
	if last := lastLine(s.logPath()); last != "" {
		fmt.Fprintln(s.out, "last log:", last)
	}
	return nil
}

func (s *svc) log(args []string) error {
	fs := flag.NewFlagSet("log", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	follow := fs.Bool("f", false, "follow the log")
	lines := fs.Int("n", 100, "number of lines to print")
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("usage: hycanvas service log [-f] [-n lines]")
	}
	if _, err := os.Stat(s.logPath()); err != nil {
		fmt.Fprintln(s.out, "no log file yet:", s.logPath())
		return nil
	}
	s.printTail(*lines)
	if !*follow {
		return nil
	}
	return s.followLog()
}

// followLog streams appended log data until the command is interrupted.
func (s *svc) followLog() error {
	f, err := os.Open(s.logPath())
	if err != nil {
		return err
	}
	defer f.Close()
	offset, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}
	for {
		time.Sleep(500 * time.Millisecond)
		info, err := os.Stat(s.logPath())
		if err != nil {
			return nil // log removed; stop following
		}
		if info.Size() < offset {
			offset = 0 // truncated/rotated; start over
			if _, err := f.Seek(0, io.SeekStart); err != nil {
				return err
			}
		}
		n, err := io.Copy(s.out, f)
		if err != nil {
			return err
		}
		offset += n
	}
}

func (s *svc) printTail(n int) {
	for _, line := range tailLines(s.logPath(), n) {
		fmt.Fprintln(s.out, line)
	}
}

// tailLines returns up to n final lines of the file, reading at most the last
// 256KB so huge logs stay cheap.
func tailLines(path string, n int) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	const window = 256 * 1024
	info, err := f.Stat()
	if err != nil {
		return nil
	}
	start := info.Size() - window
	if start < 0 {
		start = 0
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return nil
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if start > 0 && len(lines) > 0 {
		lines = lines[1:] // first line is likely cut mid-way
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	if len(lines) == 1 && lines[0] == "" {
		return nil
	}
	return lines
}

func lastLine(path string) string {
	lines := tailLines(path, 1)
	if len(lines) == 0 {
		return ""
	}
	return lines[0]
}
