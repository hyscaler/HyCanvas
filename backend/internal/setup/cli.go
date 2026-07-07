package setup

// The CLI variant of the first-run wizard: the same questions and live
// validation as the web wizard, asked right on the operator's terminal.
// It writes the same .env and then the caller continues the normal boot.

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/term"
)

// Setup modes offered on an interactive first run.
const (
	ModeWeb = "web"
	ModeCLI = "cli"
)

// StdinIsTerminal reports whether the process is attached to an interactive
// terminal, which is what gates asking first-run questions at all.
func StdinIsTerminal() bool {
	return term.IsTerminal(int(os.Stdin.Fd()))
}

// NewStdinReader wraps stdin once for the whole first-run interaction.
// ChooseMode and RunCLI must share one buffered reader: separate readers
// would silently swallow input buffered by the first one.
func NewStdinReader() *bufio.Reader {
	return bufio.NewReader(os.Stdin)
}

// ChooseMode asks an interactive operator whether to configure in the
// browser or in the terminal. Non-interactive stdin (Docker, pipes, service
// children) defaults to the web wizard; a build without any frontend falls
// back to the CLI wizard when interactive.
func ChooseMode(webAvailable bool, in *bufio.Reader, out io.Writer) string {
	if !StdinIsTerminal() {
		return ModeWeb
	}
	if !webAvailable {
		fmt.Fprintln(out, "No frontend is available in this build, so setup runs in the terminal.")
		return ModeCLI
	}
	fmt.Fprintln(out, "\nNo configuration found. How do you want to set up HyCanvas?")
	fmt.Fprintln(out, "  1) Web wizard - configure in your browser (default)")
	fmt.Fprintln(out, "  2) CLI wizard - configure right here in the terminal")
	for {
		fmt.Fprint(out, "Choose [1/2]: ")
		line, err := in.ReadString('\n')
		if err != nil && line == "" {
			return ModeWeb
		}
		switch strings.TrimSpace(line) {
		case "", "1", "web":
			return ModeWeb
		case "2", "cli":
			return ModeCLI
		}
		fmt.Fprintln(out, "Please answer 1 or 2.")
	}
}

// RunCLI walks the operator through configuration on the terminal and writes
// destDir/.env. The caller reloads config and continues the normal boot,
// which also applies migrations. in is the shared stdin reader from
// NewStdinReader (a fresh one is created when nil).
func RunCLI(destDir string, in *bufio.Reader) error {
	if in == nil {
		in = NewStdinReader()
	}
	w := &cliWizard{
		in:       in,
		rawStdin: os.Stdin,
		out:      os.Stdout,
		testDB:   testDB,
		testSMTP: testSMTP,
		testS3:   testS3,
	}
	return w.run(destDir)
}

type cliWizard struct {
	in       *bufio.Reader
	rawStdin *os.File // nil in tests; enables hidden password input on a TTY
	out      io.Writer

	// Injectable validators so tests can script failures.
	testDB   func(ctx context.Context, dsn string) error
	testSMTP func(cfg smtpRequest) error
	testS3   func(cfg s3Request) error
}

// ask prints "label [def]: " and returns the trimmed answer, or def when the
// operator just presses Enter.
func (w *cliWizard) ask(label, def string) string {
	if def != "" {
		fmt.Fprintf(w.out, "%s [%s]: ", label, def)
	} else {
		fmt.Fprintf(w.out, "%s: ", label)
	}
	line, err := w.in.ReadString('\n')
	if err != nil && line == "" {
		return def
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return def
	}
	return line
}

func (w *cliWizard) askYesNo(label string, def bool) bool {
	hint := "y/N"
	if def {
		hint = "Y/n"
	}
	for {
		switch strings.ToLower(w.ask(label+" ("+hint+")", "")) {
		case "":
			return def
		case "y", "yes":
			return true
		case "n", "no":
			return false
		}
		fmt.Fprintln(w.out, "Please answer y or n.")
	}
}

// password reads without echo on a real terminal and falls back to a plain
// line otherwise (tests, pipes). When the shared reader already buffered
// typed-ahead input, ReadPassword (which reads the fd directly) would miss
// it, so the buffered line wins.
func (w *cliWizard) password(label string) string {
	if w.rawStdin != nil && w.in.Buffered() == 0 && term.IsTerminal(int(w.rawStdin.Fd())) {
		fmt.Fprintf(w.out, "%s: ", label)
		b, err := term.ReadPassword(int(w.rawStdin.Fd()))
		fmt.Fprintln(w.out)
		if err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	return w.ask(label, "")
}

func (w *cliWizard) run(destDir string) error {
	fmt.Fprintln(w.out, "\nHyCanvas terminal setup. Press Enter to accept a [default].")

	var body completeRequest
	body.Port = w.ask("Port", "8005")
	body.AppURL = w.ask("Public URL", "http://localhost:"+body.Port)

	// Database: loop until the connection actually works.
	var dsn string
	fmt.Fprintln(w.out, "\nPostgreSQL (the database must exist; tables are created automatically)")
	for {
		if url := w.ask("Connection URL (leave empty to enter host and credentials)", ""); url != "" {
			body.DB = dbRequest{URL: url}
		} else {
			body.DB = dbRequest{
				Host:     w.ask("  Host", "localhost"),
				Port:     w.ask("  Port", "5432"),
				User:     w.ask("  Username", "postgres"),
				Password: w.password("  Password"),
				Name:     w.ask("  Database name", "hycanvas"),
			}
		}
		var err error
		if dsn, err = body.DB.dsn(); err == nil {
			fmt.Fprint(w.out, "Checking the connection... ")
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			err = w.testDB(ctx, dsn)
			cancel()
		}
		if err == nil {
			fmt.Fprintln(w.out, "ok")
			break
		}
		fmt.Fprintln(w.out, "failed:", err)
		fmt.Fprintln(w.out, "Let's try again.")
	}

	// Storage.
	fmt.Fprintln(w.out, "\nAsset storage (uploads, stock caches, exports)")
	if w.askYesNo("Use S3-compatible storage instead of the local disk?", false) {
		for {
			body.Storage.Driver = "s3"
			body.Storage.S3 = s3Request{
				Endpoint:       w.ask("  Endpoint", ""),
				Region:         w.ask("  Region (empty for none)", ""),
				Bucket:         w.ask("  Bucket", "hycanvas"),
				AccessKey:      w.ask("  Access key ID", ""),
				SecretKey:      w.password("  Secret access key"),
				ForcePathStyle: w.askYesNo("  Path-style addressing (MinIO)?", true),
			}
			fmt.Fprint(w.out, "Checking the bucket... ")
			if err := w.testS3(body.Storage.S3); err == nil {
				fmt.Fprintln(w.out, "ok")
				break
			} else {
				fmt.Fprintln(w.out, "failed:", err)
				fmt.Fprintln(w.out, "Let's try again.")
			}
		}
	} else {
		body.Storage.Driver = "local"
		body.Storage.LocalPath = w.ask("Storage directory", filepath.Join(destDir, ".data", "storage"))
	}

	// SMTP (optional).
	fmt.Fprintln(w.out, "\nTransactional email (verification, resets, invites)")
	if w.askYesNo("Configure SMTP now? Without it the server sends no email in production.", false) {
		for {
			body.SMTP = smtpAnswers{
				Enabled:  true,
				Host:     w.ask("  SMTP host", ""),
				Port:     w.ask("  Port", "587"),
				Username: w.ask("  Username (empty for none)", ""),
				From:     w.ask("  From address (empty for the username)", ""),
				FromName: w.ask("  From name", "HyCanvas"),
			}
			if body.SMTP.Username != "" {
				body.SMTP.Password = w.password("  Password")
			}
			fmt.Fprint(w.out, "Checking SMTP... ")
			err := w.testSMTP(smtpRequest{Host: body.SMTP.Host, Port: body.SMTP.Port, Username: body.SMTP.Username, Password: body.SMTP.Password})
			if err == nil {
				fmt.Fprintln(w.out, "ok")
				break
			}
			fmt.Fprintln(w.out, "failed:", err)
			if !w.askYesNo("Try different SMTP settings? (choosing n skips email)", true) {
				body.SMTP = smtpAnswers{}
				break
			}
		}
	}

	// Summary + confirm.
	fmt.Fprintln(w.out, "\nSummary")
	fmt.Fprintln(w.out, "  Public URL:", body.AppURL)
	fmt.Fprintln(w.out, "  Port:      ", body.Port)
	if body.DB.URL != "" {
		fmt.Fprintln(w.out, "  Database:  ", maskDSN(body.DB.URL))
	} else {
		fmt.Fprintf(w.out, "  Database:   %s@%s:%s/%s\n", body.DB.User, body.DB.Host, body.DB.Port, body.DB.Name)
	}
	if body.Storage.Driver == "s3" {
		fmt.Fprintf(w.out, "  Storage:    S3 %s @ %s\n", body.Storage.S3.Bucket, body.Storage.S3.Endpoint)
	} else {
		fmt.Fprintln(w.out, "  Storage:    local disk", body.Storage.LocalPath)
	}
	if body.SMTP.Enabled {
		fmt.Fprintln(w.out, "  Email:      SMTP via", body.SMTP.Host)
	} else {
		fmt.Fprintln(w.out, "  Email:      not configured")
	}
	fmt.Fprintln(w.out, "  Secrets:    JWT and encryption keys are generated automatically")
	if !w.askYesNo("Write the configuration and start HyCanvas?", true) {
		return errors.New("setup cancelled")
	}

	dest := filepath.Join(destDir, ".env")
	if err := writeEnvFile(dest, renderEnv(body, dsn, GenerateToken(), GenerateToken())); err != nil {
		return err
	}
	fmt.Fprintln(w.out, "Wrote", dest)
	return nil
}

// maskDSN hides the password portion of a connection URL for display.
func maskDSN(dsn string) string {
	if i := strings.Index(dsn, "://"); i >= 0 {
		if j := strings.LastIndex(dsn, "@"); j > i {
			cred := dsn[i+3 : j]
			if k := strings.Index(cred, ":"); k >= 0 {
				return dsn[:i+3] + cred[:k] + ":••••" + dsn[j:]
			}
		}
	}
	return dsn
}
