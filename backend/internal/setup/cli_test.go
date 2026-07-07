package setup

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// scriptedWizard builds a cliWizard fed by scripted answers (one per line)
// with stubbed validators.
func scriptedWizard(answers []string, out *bytes.Buffer) *cliWizard {
	return &cliWizard{
		in:       bufio.NewReader(strings.NewReader(strings.Join(answers, "\n") + "\n")),
		out:      out,
		testDB:   func(context.Context, string) error { return nil },
		testSMTP: func(smtpRequest) error { return nil },
		testS3:   func(s3Request) error { return nil },
	}
}

func TestCLIWizardHappyPath(t *testing.T) {
	dir := t.TempDir()
	var out bytes.Buffer
	w := scriptedWizard([]string{
		"9000",                // Port
		"http://canvas.local", // Public URL
		"",                    // DB: no URL, use fields
		"db.internal",         // host
		"",                    // port -> default 5432
		"hy",                  // user
		"pw",                  // password (plain fallback, no TTY)
		"",                    // db name -> default hycanvas
		"",                    // S3? -> default no
		"",                    // storage dir -> default
		"",                    // SMTP? -> default no
		"",                    // confirm -> default yes
	}, &out)

	if err := w.run(dir); err != nil {
		t.Fatalf("run: %v\noutput:\n%s", err, out.String())
	}
	env, err := os.ReadFile(filepath.Join(dir, ".env"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"PORT=9000",
		"APP_URL=http://canvas.local",
		"COOKIE_SECURE=false",
		"DATABASE_URL=postgresql://hy:pw@db.internal:5432/hycanvas",
		"JWT_SECRET=",
		"STORAGE_DRIVER=local",
	} {
		if !strings.Contains(string(env), want) {
			t.Errorf("env missing %q:\n%s", want, env)
		}
	}
	if strings.Contains(string(env), "SMTP_") {
		t.Error("skipped SMTP must not be written")
	}
	info, _ := os.Stat(filepath.Join(dir, ".env"))
	if info.Mode().Perm() != 0o600 {
		t.Errorf("perms = %o, want 600", info.Mode().Perm())
	}
}

func TestCLIWizardRetriesFailedDB(t *testing.T) {
	dir := t.TempDir()
	var out bytes.Buffer
	w := scriptedWizard([]string{
		"", "", // port, url defaults
		"postgres://bad@host/db", // first attempt: URL that fails validation
		"",                       // second attempt: fields
		"localhost", "5432", "postgres", "pw", "hycanvas",
		"", // S3? no
		"", // storage dir default
		"", // SMTP? no
		"", // confirm yes
	}, &out)
	calls := 0
	w.testDB = func(context.Context, string) error {
		calls++
		if calls == 1 {
			return errors.New("connection refused")
		}
		return nil
	}

	if err := w.run(dir); err != nil {
		t.Fatalf("run: %v\noutput:\n%s", err, out.String())
	}
	if calls != 2 {
		t.Errorf("testDB calls = %d, want 2 (retry after failure)", calls)
	}
	if !strings.Contains(out.String(), "failed: connection refused") {
		t.Errorf("failure not surfaced:\n%s", out.String())
	}
}

func TestCLIWizardCancelWritesNothing(t *testing.T) {
	dir := t.TempDir()
	var out bytes.Buffer
	w := scriptedWizard([]string{
		"", "", // port, url
		"", "localhost", "", "postgres", "pw", "", // db fields
		"", "", // s3 no, storage default
		"",  // smtp no
		"n", // confirm -> cancel
	}, &out)
	if err := w.run(dir); err == nil {
		t.Fatal("cancelled run must error")
	}
	if _, err := os.Stat(filepath.Join(dir, ".env")); !os.IsNotExist(err) {
		t.Error(".env written despite cancel")
	}
}

func TestCLIWizardSMTPSkipAfterFailure(t *testing.T) {
	dir := t.TempDir()
	var out bytes.Buffer
	w := scriptedWizard([]string{
		"", "", // port, url
		"", "localhost", "", "postgres", "pw", "", // db fields
		"", "", // s3 no, storage default
		"y",               // configure smtp
		"smtp.broken", "", // host, port default
		"", "", "", // username none, from, from name default
		"n", // try different settings? -> skip email
		"",  // confirm yes
	}, &out)
	w.testSMTP = func(smtpRequest) error { return errors.New("dial timeout") }

	if err := w.run(dir); err != nil {
		t.Fatalf("run: %v\noutput:\n%s", err, out.String())
	}
	env, _ := os.ReadFile(filepath.Join(dir, ".env"))
	if strings.Contains(string(env), "SMTP_") {
		t.Errorf("SMTP written despite skip:\n%s", env)
	}
}

func TestChooseModeNonInteractiveDefaultsToWeb(t *testing.T) {
	// Test stdin is never a TTY, so this exercises the non-interactive path.
	var out bytes.Buffer
	if got := ChooseMode(true, bufio.NewReader(strings.NewReader("2\n")), &out); got != ModeWeb {
		t.Errorf("non-interactive mode = %q, want web", got)
	}
	if out.Len() != 0 {
		t.Errorf("non-interactive must not prompt: %q", out.String())
	}
}

func TestMaskDSN(t *testing.T) {
	got := maskDSN("postgresql://hy:s3cret@db:5432/x")
	if strings.Contains(got, "s3cret") || !strings.Contains(got, "hy:••••@") {
		t.Errorf("maskDSN = %q", got)
	}
}
