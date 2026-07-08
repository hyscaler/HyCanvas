package storagecli

import (
	"fmt"
	"os"
	"strings"
)

// kv is one .env assignment to apply.
type kv struct {
	key   string
	value string
}

// envLine renders one KEY=value line, quoting values godotenv would otherwise
// misparse (same rules as the setup wizard's renderer).
func envLine(key, value string) string {
	if strings.ContainsAny(value, " #\"'\n\t") {
		value = "\"" + strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "\n", "\\n").Replace(value) + "\""
	}
	return key + "=" + value
}

// patchEnv updates path in place: existing assignments of the given keys are
// replaced on their own lines, everything else (comments, unrelated keys,
// blank lines, ordering) is preserved verbatim, and keys not present are
// appended under a Storage comment. The write is atomic at 0600 so a crash
// can never leave a half-written config.
func patchEnv(path string, set []kv) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}

	pending := make(map[string]string, len(set))
	order := make([]string, 0, len(set))
	for _, s := range set {
		if _, dup := pending[s.key]; !dup {
			order = append(order, s.key)
		}
		pending[s.key] = s.value
	}

	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	out := make([]string, 0, len(lines)+len(set)+2)
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		replaced := false
		for key, value := range pending {
			if strings.HasPrefix(trimmed, key+"=") {
				out = append(out, envLine(key, value))
				delete(pending, key)
				replaced = true
				break
			}
		}
		if !replaced {
			out = append(out, line)
		}
	}

	// Keys that had no existing assignment are appended, in the caller's
	// order, under one section comment.
	appended := false
	for _, key := range order {
		value, still := pending[key]
		if !still {
			continue
		}
		if !appended {
			out = append(out, "", "# Storage (updated by `hycanvas storage migrate`)")
			appended = true
		}
		out = append(out, envLine(key, value))
	}

	content := strings.Join(out, "\n") + "\n"
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename into place: %w", err)
	}
	return nil
}
