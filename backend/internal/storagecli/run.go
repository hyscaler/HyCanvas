// Package storagecli implements the `hycanvas storage` subcommand, starting
// with `migrate`: copy every object from local-disk storage into an
// S3-compatible bucket, verify, and flip the .env to STORAGE_DRIVER=s3.
// Database rows store storage keys (never driver URLs), so moving the blobs
// and switching the driver is the whole migration.
package storagecli

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"
)

// Run executes `hycanvas storage <verb>` and returns the process exit code.
func Run(args []string, stdin *os.File, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		usage(stderr)
		return 2
	}
	c := &cli{in: bufio.NewReader(stdin), rawStdin: stdin, out: stdout}

	switch verb := args[0]; verb {
	case "migrate":
		fs := flag.NewFlagSet("migrate", flag.ContinueOnError)
		fs.SetOutput(stderr)
		dryRun := fs.Bool("dry-run", false, "list what would be copied without copying")
		yes := fs.Bool("yes", false, "non-interactive: use S3_* from the environment and update .env without asking")
		if err := fs.Parse(args[1:]); err != nil {
			return 2
		}
		if err := c.runMigrate(*dryRun, *yes); err != nil {
			fmt.Fprintln(stderr, "error:", err)
			return 1
		}
		return 0
	default:
		fmt.Fprintf(stderr, "unknown storage command %q\n\n", verb)
		usage(stderr)
		return 2
	}
}

func usage(w io.Writer) {
	fmt.Fprintln(w, "usage: hycanvas storage migrate [--dry-run] [--yes]")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Copies every object from local-disk storage (LOCAL_STORAGE_PATH) into an")
	fmt.Fprintln(w, "S3-compatible bucket and updates .env to STORAGE_DRIVER=s3. The S3 target")
	fmt.Fprintln(w, "comes from S3_* in the environment when set, or is asked interactively.")
	fmt.Fprintln(w, "Idempotent: objects already in the bucket are skipped, so re-runs are safe.")
	fmt.Fprintln(w, "Local files are kept as a rollback. Stop the server first (`hycanvas")
	fmt.Fprintln(w, "service stop`) so no new objects are written mid-copy.")
}

// cli carries the interactive plumbing; prompts mirror the setup wizard's.
type cli struct {
	in       *bufio.Reader
	rawStdin *os.File
	out      io.Writer
}

func (c *cli) ask(label, def string) string {
	if def != "" {
		fmt.Fprintf(c.out, "%s [%s]: ", label, def)
	} else {
		fmt.Fprintf(c.out, "%s: ", label)
	}
	line, err := c.in.ReadString('\n')
	if err != nil && line == "" {
		return def
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return def
	}
	return line
}

func (c *cli) askYesNo(label string, def bool) bool {
	hint := "y/N"
	if def {
		hint = "Y/n"
	}
	for {
		switch strings.ToLower(c.ask(label+" ("+hint+")", "")) {
		case "":
			return def
		case "y", "yes":
			return true
		case "n", "no":
			return false
		}
		fmt.Fprintln(c.out, "Please answer y or n.")
	}
}

// password reads without echo on a real terminal and falls back to a plain
// line otherwise (tests, pipes); buffered type-ahead wins over ReadPassword.
func (c *cli) password(label string) string {
	if c.rawStdin != nil && c.in.Buffered() == 0 && term.IsTerminal(int(c.rawStdin.Fd())) {
		fmt.Fprintf(c.out, "%s: ", label)
		b, err := term.ReadPassword(int(c.rawStdin.Fd()))
		fmt.Fprintln(c.out)
		if err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	return c.ask(label, "")
}
