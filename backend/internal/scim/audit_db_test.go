package scim

import (
	"bytes"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// An audit line records what happened. A request that fails after deciding to
// deactivate someone rolls back, so it must not leave a line saying it did.
func TestAuditIsWrittenOnlyAfterCommit_DB(t *testing.T) {
	tx := testTx(t)
	var buf bytes.Buffer
	srv := NewServer(&Config{Token: goodToken}, tx, testJWT, nil, slog.New(slog.NewTextHandler(&buf, nil)))
	call := func(fail bool) {
		srv.run(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/x", nil), func(o *op) (int, any, error) {
			o.audit("user.deactivate", "user_id", "u-audit")
			if fail {
				return 0, nil, errors.New("later step failed")
			}
			return http.StatusOK, map[string]any{}, nil
		})
	}

	call(true)
	if strings.Contains(buf.String(), "user.deactivate") {
		t.Fatalf("a rolled-back request was audited:\n%s", buf.String())
	}
	call(false)
	if n := strings.Count(buf.String(), "user.deactivate"); n != 1 {
		t.Fatalf("a committed request was audited %d times, want 1:\n%s", n, buf.String())
	}
}
