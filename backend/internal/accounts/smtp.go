// Transactional email delivery. When SMTP is configured (env), account emails
// (verification, password reset, magic link, workspace invite, design share) are
// sent for real; otherwise they fall back to the in-memory dev outbox so local
// flows stay testable with no SMTP server. All sends are best-effort and async,
// so a slow mail server never adds latency to the request that triggered it.
package accounts

import (
	"crypto/tls"
	"fmt"
	"html"
	"log/slog"
	"net"
	"net/smtp"
	"os"
	"strings"
	"time"
)

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

func (m *smtpSender) message(to, subject, htmlBody string) []byte {
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
	b.WriteString("Content-Type: text/html; charset=UTF-8\r\n\r\n")
	b.WriteString(htmlBody)
	return []byte(b.String())
}

// send delivers one message synchronously (callers run it in a goroutine).
func (m *smtpSender) send(to, subject, htmlBody string) error {
	addr := net.JoinHostPort(m.host, m.port)
	msg := m.message(to, subject, htmlBody)
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
		body := emailBody(msg.Subject, msg.Link)
		sender, m := s.smtp, msg
		go func() {
			if err := sender.send(m.To, m.Subject, body); err != nil {
				slog.Warn("email send failed", "to", m.To, "subject", m.Subject, "err", err)
			}
		}()
		return
	}
	s.outboxMu.Lock()
	s.outbox = append(s.outbox, msg)
	s.outboxMu.Unlock()
}

// emailBody renders a minimal branded HTML email around a single call-to-action
// link. The subject doubles as the headline.
func emailBody(subject, link string) string {
	esc := html.EscapeString(subject)
	safeLink := html.EscapeString(link)
	return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1f2937">` +
		`<h2 style="font-size:18px;font-weight:700;margin:0 0 12px">` + esc + `</h2>` +
		`<p style="font-size:14px;line-height:1.5;margin:0 0 20px;color:#4b5563">Use the button below to continue. This link is single-use and expires.</p>` +
		`<p style="margin:0 0 20px"><a href="` + safeLink + `" style="display:inline-block;background:#6238db;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 20px;border-radius:10px">Open HyCanvas</a></p>` +
		`<p style="font-size:12px;line-height:1.5;color:#9ca3af;margin:0">If the button doesn't work, paste this link into your browser:<br><a href="` + safeLink + `" style="color:#6238db;word-break:break-all">` + safeLink + `</a></p>` +
		`</div>`
}
