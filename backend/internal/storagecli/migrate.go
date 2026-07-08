package storagecli

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"hycanvas/backend/internal/daemon"
	"hycanvas/backend/internal/platform/config"
	"hycanvas/backend/internal/storage"
)

// report summarizes one migration pass.
type report struct {
	Copied  int
	Skipped int
	Failed  []string
	Bytes   int64
	Total   int
}

// listTree walks the local storage base and returns every object as its
// storage key (relative slash path), the inverse of the local driver's
// key-to-path mapping.
func listTree(base string) (keys []string, total int64, err error) {
	err = filepath.WalkDir(base, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(base, path)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		keys = append(keys, filepath.ToSlash(rel))
		total += info.Size()
		return nil
	})
	return keys, total, err
}

// migrateTree copies every object under base into dst, skipping keys that
// already exist (idempotent re-runs) and retrying each failure once. Objects
// are buffered whole, matching the drivers' bytes-based API.
func migrateTree(base string, dst storage.Driver, out io.Writer) (report, error) {
	keys, _, err := listTree(base)
	if err != nil {
		return report{}, fmt.Errorf("walk %s: %w", base, err)
	}
	r := report{Total: len(keys)}
	for i, key := range keys {
		exists, err := dst.Exists(key)
		if err == nil && exists {
			r.Skipped++
			fmt.Fprintf(out, "[%d/%d] %s (already present, skipped)\n", i+1, len(keys), key)
			continue
		}
		data, err := os.ReadFile(filepath.Join(base, filepath.FromSlash(key)))
		if err != nil {
			r.Failed = append(r.Failed, key+": "+err.Error())
			fmt.Fprintf(out, "[%d/%d] %s FAILED to read: %v\n", i+1, len(keys), key, err)
			continue
		}
		if _, err := dst.Put(key, data); err != nil {
			// One retry: object stores hiccup, and Put overwrites safely.
			if _, err2 := dst.Put(key, data); err2 != nil {
				r.Failed = append(r.Failed, key+": "+err2.Error())
				fmt.Fprintf(out, "[%d/%d] %s FAILED: %v\n", i+1, len(keys), key, err2)
				continue
			}
		}
		r.Copied++
		r.Bytes += int64(len(data))
		fmt.Fprintf(out, "[%d/%d] %s (%s)\n", i+1, len(keys), key, humanBytes(int64(len(data))))
	}
	return r, nil
}

// verifyTree confirms every local object exists in dst; returns missing keys.
func verifyTree(base string, dst storage.Driver) ([]string, error) {
	keys, _, err := listTree(base)
	if err != nil {
		return nil, err
	}
	var missing []string
	for _, key := range keys {
		ok, err := dst.Exists(key)
		if err != nil {
			return nil, fmt.Errorf("verify %s: %w", key, err)
		}
		if !ok {
			missing = append(missing, key)
		}
	}
	return missing, nil
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return strconv.FormatInt(n, 10) + " B"
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}

// serverPidAlive reports whether the daemon pidfile next to this binary
// points at a live process (mirrors the daemon package's layout).
func serverPidAlive() (int, bool) {
	exe, err := os.Executable()
	if err != nil {
		return 0, false
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(exe), "hycanvas.pid"))
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		return 0, false
	}
	return pid, daemon.ProcessAlive(pid)
}

// runMigrate is the `storage migrate` flow.
func (c *cli) runMigrate(dryRun, yes bool) error {
	// Load .env exactly like the server (cwd, then parent) so paths and S3
	// settings resolve identically; the database is not needed here.
	if _, err := config.Load(); err != nil && !errors.Is(err, config.ErrDatabaseURLMissing) {
		return err
	}

	// A running server keeps writing objects that a copy pass would miss.
	if pid, alive := serverPidAlive(); alive {
		fmt.Fprintf(c.out, "The HyCanvas server appears to be running (pid %d).\n", pid)
		fmt.Fprintln(c.out, "Objects written during the migration may be missed; stop it first with `hycanvas service stop`.")
		if !c.askYesNo("Continue anyway?", false) {
			return errors.New("migration aborted while the server is running")
		}
	}

	// Source: the local storage tree.
	base := os.Getenv("LOCAL_STORAGE_PATH")
	if base == "" {
		base = filepath.Join(".data", "storage")
	}
	abs, err := filepath.Abs(base)
	if err != nil {
		return err
	}
	keys, total, err := listTree(abs)
	if err != nil {
		return fmt.Errorf("local storage at %s: %w", abs, err)
	}
	if len(keys) == 0 {
		return fmt.Errorf("no objects found under %s; nothing to migrate (is LOCAL_STORAGE_PATH right?)", abs)
	}
	if os.Getenv("STORAGE_DRIVER") == "s3" {
		fmt.Fprintln(c.out, "STORAGE_DRIVER is already s3; migrating any remaining local objects.")
	}

	fmt.Fprintf(c.out, "Source: %s (%d objects, %s)\n", abs, len(keys), humanBytes(total))
	if dryRun {
		max := len(keys)
		if max > 10 {
			max = 10
		}
		for _, k := range keys[:max] {
			fmt.Fprintln(c.out, "  ", k)
		}
		if len(keys) > max {
			fmt.Fprintf(c.out, "   ... and %d more\n", len(keys)-max)
		}
		fmt.Fprintln(c.out, "Dry run: nothing copied.")
		return nil
	}

	// Destination: env config when complete, interactive otherwise.
	cfg := storage.S3ConfigFromEnv()
	envComplete := cfg.Endpoint != "" && cfg.AccessKey != "" && cfg.SecretKey != "" && cfg.Bucket != ""
	if !envComplete && yes {
		return errors.New("--yes needs S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY in the environment or .env")
	}
	var dst storage.Driver
	if envComplete {
		s3, err := storage.NewS3(cfg)
		if err != nil {
			return fmt.Errorf("S3 destination from env: %w", err)
		}
		dst = s3
		fmt.Fprintf(c.out, "Destination: bucket %s @ %s (from env)\n", cfg.Bucket, cfg.Endpoint)
	} else {
		fmt.Fprintln(c.out, "\nS3-compatible destination (AWS S3, MinIO, R2, ...)")
		for {
			cfg = storage.S3Config{
				Endpoint:       c.ask("  Endpoint", cfg.Endpoint),
				Region:         c.ask("  Region (empty for none)", cfg.Region),
				Bucket:         c.ask("  Bucket", nonEmpty(cfg.Bucket, "hycanvas")),
				AccessKey:      c.ask("  Access key ID", cfg.AccessKey),
				SecretKey:      c.password("  Secret access key"),
				ForcePathStyle: c.askYesNo("  Path-style addressing (MinIO)?", true),
			}
			fmt.Fprint(c.out, "Checking the bucket... ")
			s3, err := storage.NewS3(cfg)
			if err == nil {
				fmt.Fprintln(c.out, "ok")
				dst = s3
				break
			}
			fmt.Fprintln(c.out, "failed:", err)
			fmt.Fprintln(c.out, "Let's try again.")
		}
	}

	// Copy + verify.
	rep, err := migrateTree(abs, dst, c.out)
	if err != nil {
		return err
	}
	fmt.Fprintf(c.out, "\nCopied %d, skipped %d (already present), failed %d, %s transferred.\n",
		rep.Copied, rep.Skipped, len(rep.Failed), humanBytes(rep.Bytes))
	if len(rep.Failed) > 0 {
		for _, f := range rep.Failed {
			fmt.Fprintln(c.out, "  failed:", f)
		}
		return fmt.Errorf("%d objects failed to copy; fix the cause and re-run (already-copied objects are skipped)", len(rep.Failed))
	}
	missing, err := verifyTree(abs, dst)
	if err != nil {
		return err
	}
	if len(missing) > 0 {
		for _, k := range missing {
			fmt.Fprintln(c.out, "  missing after copy:", k)
		}
		return fmt.Errorf("verification found %d objects missing in the bucket; re-run the migration", len(missing))
	}
	fmt.Fprintln(c.out, "Verified: every local object is present in the bucket.")

	// Flip the config.
	envPath := ".env"
	if _, err := os.Stat(envPath); err != nil {
		envPath = filepath.Join("..", ".env")
		if _, err := os.Stat(envPath); err != nil {
			fmt.Fprintln(c.out, "No .env found to update; set STORAGE_DRIVER=s3 and the S3_* values in your deployment config.")
			return nil
		}
	}
	if !yes && !c.askYesNo("Update "+envPath+" to use S3 storage now?", true) {
		fmt.Fprintln(c.out, "Config left unchanged; set STORAGE_DRIVER=s3 (and the S3_* values) when ready.")
		return nil
	}
	set := []kv{
		{"STORAGE_DRIVER", "s3"},
		{"S3_ENDPOINT", cfg.Endpoint},
		{"S3_BUCKET", cfg.Bucket},
		{"S3_ACCESS_KEY_ID", cfg.AccessKey},
		{"S3_SECRET_ACCESS_KEY", cfg.SecretKey},
	}
	if cfg.Region != "" {
		set = append(set, kv{"S3_REGION", cfg.Region})
	}
	if cfg.ForcePathStyle {
		set = append(set, kv{"S3_FORCE_PATH_STYLE", "true"})
	}
	if err := patchEnv(envPath, set); err != nil {
		return err
	}
	fmt.Fprintln(c.out, "Updated", envPath, "(STORAGE_DRIVER=s3).")
	fmt.Fprintf(c.out, "Local files are kept at %s as a rollback; delete them once you are confident.\n", abs)
	fmt.Fprintln(c.out, "Restart to apply: `hycanvas service restart`.")
	return nil
}

func nonEmpty(v, def string) string {
	if v != "" {
		return v
	}
	return def
}
