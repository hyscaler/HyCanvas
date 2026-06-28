package accounts

import (
	"bufio"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/mail"
	"strings"
	"testing"
)

// TestEmailEndToEndTransport drives a rendered email through the real SMTP send
// path into a minimal in-process SMTP server, then parses the captured bytes as
// a real MIME message: it must be valid multipart/alternative with a plain-text
// and an HTML part that quoted-printable-decode back to the rendered bodies, and
// the CRLF header-injection attempt in the subject must be neutralized.
func TestEmailEndToEndTransport(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	captured := make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		br := bufio.NewReader(conn)
		fmt.Fprint(conn, "220 test ESMTP\r\n")
		var data strings.Builder
		inData := false
		for {
			line, err := br.ReadString('\n')
			if err != nil {
				return
			}
			if inData {
				if line == ".\r\n" {
					inData = false
					fmt.Fprint(conn, "250 queued\r\n")
					captured <- data.String()
					continue
				}
				data.WriteString(line)
				continue
			}
			switch cmd := strings.ToUpper(strings.TrimSpace(line)); {
			case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
				fmt.Fprint(conn, "250-test\r\n250 OK\r\n")
			case strings.HasPrefix(cmd, "DATA"):
				fmt.Fprint(conn, "354 end with .\r\n")
				inData = true
			case strings.HasPrefix(cmd, "QUIT"):
				fmt.Fprint(conn, "221 bye\r\n")
				return
			default: // MAIL, RCPT, RSET, NOOP, ...
				fmt.Fprint(conn, "250 OK\r\n")
			}
		}
	}()

	host, port, _ := net.SplitHostPort(ln.Addr().String())
	// No username => no AUTH => plaintext send, which is fine for a localhost test.
	sender := &smtpSender{host: host, port: port, from: "no-reply@hycanvas.test", fromName: "HyCanvas"}

	// A subject carrying a CRLF + a forged Bcc header, and a link with & and <
	// to confirm header stripping and HTML escaping respectively.
	evilSubject := "Welcome to HyCanvas\r\nBcc: attacker@evil.test"
	c := contentFrom(OutboxMessage{
		To:        "you@example.com",
		Subject:   evilSubject,
		Link:      "https://app.example.com/verify?token=abc&x=1<y",
		Heading:   "Welcome to HyCanvas",
		Intro:     "Your account is ready.",
		CTALabel:  "Start designing",
		Preheader: "ready",
		Footnote:  "tip",
	})
	if err := sender.send("you@example.com", evilSubject, renderHTML(c), renderText(c)); err != nil {
		t.Fatalf("send: %v", err)
	}
	raw := <-captured

	msg, err := mail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		t.Fatalf("parse message: %v", err)
	}
	if bcc := msg.Header.Get("Bcc"); bcc != "" {
		t.Fatalf("HEADER INJECTION: forged Bcc leaked through: %q", bcc)
	}
	if !strings.HasPrefix(msg.Header.Get("Subject"), "Welcome to HyCanvas") {
		t.Fatalf("unexpected subject: %q", msg.Header.Get("Subject"))
	}
	mediaType, params, err := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/alternative" {
		t.Fatalf("not multipart/alternative: %q err=%v", mediaType, err)
	}

	var gotText, gotHTML string
	mr := multipart.NewReader(msg.Body, params["boundary"])
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("next part: %v", err)
		}
		b, err := io.ReadAll(p) // transparently quoted-printable-decodes
		if err != nil {
			t.Fatalf("read part: %v", err)
		}
		switch ct := p.Header.Get("Content-Type"); {
		case strings.HasPrefix(ct, "text/plain"):
			gotText = string(b)
		case strings.HasPrefix(ct, "text/html"):
			gotHTML = string(b)
		}
	}

	if gotText == "" || gotHTML == "" {
		t.Fatalf("missing parts: text=%dB html=%dB", len(gotText), len(gotHTML))
	}
	if !strings.HasPrefix(strings.TrimSpace(gotHTML), "<!DOCTYPE html>") {
		t.Fatalf("html part did not QP-decode to a document; head=%q", gotHTML[:min(60, len(gotHTML))])
	}
	if !strings.Contains(gotHTML, "Start designing") || !strings.Contains(gotHTML, "#9B2C72") {
		t.Fatalf("html missing CTA or brand color")
	}
	if strings.Contains(gotHTML, "x=1<y") {
		t.Fatalf("link not HTML-escaped in body (raw < present)")
	}
	if !strings.Contains(gotHTML, "x=1&amp;x") && !strings.Contains(gotHTML, "&amp;x=1") && !strings.Contains(gotHTML, "abc&amp;x=1") {
		// the & in the query must be escaped to &amp;
		if !strings.Contains(gotHTML, "&amp;") {
			t.Fatalf("ampersand not escaped in body")
		}
	}
	if !strings.Contains(gotText, "Start designing:") {
		t.Fatalf("text part missing CTA line")
	}
	t.Logf("OK: valid multipart/alternative, text=%dB html=%dB, no header injection, body escaped", len(gotText), len(gotHTML))
}
