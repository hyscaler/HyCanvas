// Transactional email delivery. When SMTP is configured (env), account emails
// (verification, welcome, password reset, magic link, workspace invite, design
// share) are sent for real; otherwise they fall back to the in-memory dev outbox so local
// flows stay testable with no SMTP server. All sends are best-effort and async,
// so a slow mail server never adds latency to the request that triggered it.
package accounts

import (
	"crypto/tls"
	"fmt"
	"log/slog"
	"mime/quotedprintable"
	"net"
	"net/smtp"
	"os"
	"strings"
	"time"
)

// qp quoted-printable-encodes a body part: it soft-wraps long lines (well under
// the RFC 5321 998-octet limit) and escapes special bytes, so a single long
// HTML line is never rejected, folded, or corrupted by a strict MTA.
func qp(s string) string {
	var buf strings.Builder
	w := quotedprintable.NewWriter(&buf)
	_, _ = w.Write([]byte(s))
	_ = w.Close()
	return buf.String()
}

// mimeBoundary separates the plain-text and HTML parts of the multipart message.
// A fixed, unlikely-to-collide token is fine: our bodies never contain it.
const mimeBoundary = "=_hycanvas_alt_8f3a9c2b1d7e"

// smtpSender holds resolved SMTP settings. nil => unconfigured (dev outbox).
type smtpSender struct {
	host        string
	port        string
	username    string
	password    string
	from        string
	fromName    string
	implicitTLS bool // true for port 465 / SMTP_TLS=implicit; else STARTTLS
}

// smtpFromEnv builds a sender from the environment, or returns nil when SMTP is
// not configured (no SMTP_HOST, or no From address) so the dev outbox is used.
func smtpFromEnv() *smtpSender {
	host := strings.TrimSpace(os.Getenv("SMTP_HOST"))
	if host == "" {
		return nil
	}
	from := strings.TrimSpace(os.Getenv("SMTP_FROM"))
	if from == "" {
		from = strings.TrimSpace(os.Getenv("SMTP_USERNAME"))
	}
	if from == "" {
		slog.Warn("SMTP_HOST set but no SMTP_FROM/SMTP_USERNAME; email falls back to dev outbox")
		return nil
	}
	port := strings.TrimSpace(os.Getenv("SMTP_PORT"))
	if port == "" {
		port = "587"
	}
	fromName := strings.TrimSpace(os.Getenv("SMTP_FROM_NAME"))
	if fromName == "" {
		fromName = "HyCanvas"
	}
	return &smtpSender{
		host:        host,
		port:        port,
		username:    strings.TrimSpace(os.Getenv("SMTP_USERNAME")),
		password:    os.Getenv("SMTP_PASSWORD"),
		from:        from,
		fromName:    fromName,
		implicitTLS: port == "465" || strings.EqualFold(strings.TrimSpace(os.Getenv("SMTP_TLS")), "implicit"),
	}
}

// header strips CR/LF so a header value can't inject extra headers.
func header(v string) string { return strings.NewReplacer("\r", "", "\n", "").Replace(v) }

func (m *smtpSender) message(to, subject, htmlBody, textBody string) []byte {
	fromHeader := m.from
	if m.fromName != "" {
		fromHeader = fmt.Sprintf("%s <%s>", header(m.fromName), m.from)
	}
	var b strings.Builder
	b.WriteString("From: " + fromHeader + "\r\n")
	b.WriteString("To: " + header(to) + "\r\n")
	b.WriteString("Subject: " + header(subject) + "\r\n")
	b.WriteString("Date: " + time.Now().Format(time.RFC1123Z) + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: multipart/alternative; boundary=\"" + mimeBoundary + "\"\r\n\r\n")
	// Plain text first (least capable client), HTML last (the preferred part).
	// Both are quoted-printable so long HTML lines stay within the 998-octet limit.
	b.WriteString("--" + mimeBoundary + "\r\n")
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
	b.WriteString(qp(textBody) + "\r\n")
	b.WriteString("--" + mimeBoundary + "\r\n")
	b.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
	b.WriteString(qp(htmlBody) + "\r\n")
	b.WriteString("--" + mimeBoundary + "--\r\n")
	return []byte(b.String())
}

// send delivers one message synchronously (callers run it in a goroutine).
func (m *smtpSender) send(to, subject, htmlBody, textBody string) error {
	addr := net.JoinHostPort(m.host, m.port)
	msg := m.message(to, subject, htmlBody, textBody)
	var auth smtp.Auth
	if m.username != "" {
		auth = smtp.PlainAuth("", m.username, m.password, m.host)
	}
	if !m.implicitTLS {
		// STARTTLS (or plain) path; smtp.SendMail upgrades to TLS when offered.
		return smtp.SendMail(addr, auth, m.from, []string{to}, msg)
	}
	// Implicit TLS (port 465): dial TLS first, then speak SMTP.
	conn, err := tls.Dial("tcp", addr, &tls.Config{ServerName: m.host})
	if err != nil {
		return err
	}
	c, err := smtp.NewClient(conn, m.host)
	if err != nil {
		return err
	}
	defer func() { _ = c.Close() }()
	if auth != nil {
		if err := c.Auth(auth); err != nil {
			return err
		}
	}
	if err := c.Mail(m.from); err != nil {
		return err
	}
	if err := c.Rcpt(to); err != nil {
		return err
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(msg); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.Quit()
}

// deliver routes an outbound mail: a real SMTP send when configured (best-effort,
// async, logged on failure), otherwise the in-memory dev outbox. Centralizing
// here keeps every account email (verification/reset/magic/invite/share) on one
// path. Preserves the prior behavior exactly when SMTP is unset (tests + dev).
func (s *Service) deliver(msg OutboxMessage) {
	if s.smtp != nil {
		c := contentFrom(msg)
		htmlBody, textBody := renderHTML(c), renderText(c)
		sender, to, subj := s.smtp, msg.To, msg.Subject
		go func() {
			if err := sender.send(to, subj, htmlBody, textBody); err != nil {
				slog.Warn("email send failed", "to", to, "subject", subj, "err", err)
			}
		}()
		return
	}
	s.outboxMu.Lock()
	s.outbox = append(s.outbox, msg)
	s.outboxMu.Unlock()
}
