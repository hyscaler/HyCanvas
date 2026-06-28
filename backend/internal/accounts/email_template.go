// Transactional email rendering: a single branded, responsive template shared by
// every account email (verification, welcome, password reset, magic link,
// workspace invite, design share). Each email supplies its own heading, intro, and call to
// action; the layout, brand identity, and footer are common. Output is a
// multipart message (plain text + HTML) so it renders well everywhere and reads
// cleanly in text-only clients. Brand name/colors come from the generated
// `brand` package (single-sourced with the frontend via theme.config.mjs).
package accounts

import (
	"html"
	"strings"

	"hycanvas/backend/internal/platform/brand"
)

// emailContent is the per-email copy the shared template renders around.
type emailContent struct {
	Preheader string // inbox preview snippet (hidden in the body)
	Heading   string // the headline inside the card
	Intro     string // one short paragraph of context
	CTALabel  string // the action button label
	CTALink   string // the action button + fallback URL
	Footnote  string // small print (expiry / "ignore if you didn't request this")
}

func pick(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

// contentFrom derives the render content from an OutboxMessage, filling generic
// fallbacks so an email that only sets To/Subject/Link still renders sensibly.
func contentFrom(m OutboxMessage) emailContent {
	return emailContent{
		Preheader: pick(m.Preheader, m.Subject),
		Heading:   pick(m.Heading, m.Subject),
		Intro:     pick(m.Intro, "Use the button below to continue."),
		CTALabel:  pick(m.CTALabel, "Open "+brand.Name),
		CTALink:   m.Link,
		Footnote:  pick(m.Footnote, "If you didn't request this, you can safely ignore this email."),
	}
}

const emailFont = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

// emailStyleCSS holds the only non-inline rules (responsive padding + button
// hover). Kept separate so a preview can reuse it verbatim.
const emailStyleCSS = `@media (max-width:600px){.hc-card{padding:28px 22px!important}.hc-h1{font-size:20px!important}}a.hc-btn:hover{opacity:.92}`

// renderHTML builds the full responsive HTML document. All dynamic text is
// HTML-escaped; brand color constants are trusted (hex from the generator).
func renderHTML(c emailContent) string {
	var b strings.Builder
	b.WriteString(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">`)
	b.WriteString(`<meta name="viewport" content="width=device-width,initial-scale=1">`)
	b.WriteString(`<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">`)
	b.WriteString(`<title>` + html.EscapeString(c.Heading) + `</title>`)
	b.WriteString(`<style>` + emailStyleCSS + `</style>`)
	b.WriteString(`</head><body style="margin:0;padding:0;background:#f3f3f6;">`)
	b.WriteString(renderBodyInner(c))
	b.WriteString(`</body></html>`)
	return b.String()
}

// renderBodyInner is the email body markup (table-based, inline styles), without
// the surrounding document. Shared by renderHTML and the preview gallery.
func renderBodyInner(c emailContent) string {
	h := html.EscapeString
	link := h(c.CTALink)

	footnote := ""
	if strings.TrimSpace(c.Footnote) != "" {
		footnote = `<p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#a1a1aa;border-top:1px solid #f0f0f3;padding-top:16px;">` + h(c.Footnote) + `</p>`
	}

	var b strings.Builder
	// Hidden inbox-preview text.
	b.WriteString(`<span style="display:none!important;max-height:0;overflow:hidden;opacity:0;color:transparent;">` + h(c.Preheader) + `</span>`)
	b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f3f6;width:100%;"><tr><td align="center" style="padding:32px 16px;">`)
	b.WriteString(`<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;">`)
	// Wordmark.
	b.WriteString(`<tr><td align="center" style="padding:0 0 24px;font-family:` + emailFont + `;font-size:22px;font-weight:800;letter-spacing:-0.02em;color:` + brand.Primary + `;">` + h(brand.Name) + `</td></tr>`)
	// Card.
	b.WriteString(`<tr><td class="hc-card" style="background:#ffffff;border:1px solid #ececf1;border-radius:16px;padding:40px;font-family:` + emailFont + `;">`)
	b.WriteString(`<div style="height:4px;width:44px;border-radius:2px;background:linear-gradient(90deg,` + brand.GradientStart + `,` + brand.GradientEnd + `);margin:0 0 24px;"></div>`)
	b.WriteString(`<h1 class="hc-h1" style="margin:0 0 14px;font-size:22px;line-height:1.3;font-weight:700;color:#18181b;">` + h(c.Heading) + `</h1>`)
	b.WriteString(`<p style="margin:0 0 28px;font-size:15px;line-height:1.65;color:#3f3f46;">` + h(c.Intro) + `</p>`)
	// Call to action (cell bgcolor gives Outlook a filled button).
	b.WriteString(`<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="` + brand.Primary + `" style="border-radius:10px;">`)
	b.WriteString(`<a class="hc-btn" href="` + link + `" style="display:inline-block;padding:13px 28px;font-family:` + emailFont + `;font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:10px;background:` + brand.Primary + `;">` + h(c.CTALabel) + `</a>`)
	b.WriteString(`</td></tr></table>`)
	// Fallback link.
	b.WriteString(`<p style="margin:28px 0 0;font-size:13px;line-height:1.6;color:#71717a;">Or paste this link into your browser:<br><a href="` + link + `" style="color:` + brand.Primary + `;word-break:break-all;">` + link + `</a></p>`)
	b.WriteString(footnote)
	b.WriteString(`</td></tr>`)
	// Footer.
	b.WriteString(`<tr><td align="center" style="padding:24px 8px 0;font-family:` + emailFont + `;font-size:12px;line-height:1.6;color:#a1a1aa;">`)
	b.WriteString(`<p style="margin:0 0 4px;">` + h(brand.Name) + ` is a free, self-hostable design tool.</p>`)
	b.WriteString(`<p style="margin:0;">You received this email because of activity on your ` + h(brand.Name) + ` account.</p>`)
	b.WriteString(`</td></tr></table></td></tr></table>`)
	return b.String()
}

// renderText is the plain-text alternative (deliverability + text-only clients).
func renderText(c emailContent) string {
	var b strings.Builder
	b.WriteString(brand.Name + "\n\n")
	b.WriteString(c.Heading + "\n\n")
	b.WriteString(c.Intro + "\n\n")
	b.WriteString(c.CTALabel + ":\n" + c.CTALink + "\n")
	if strings.TrimSpace(c.Footnote) != "" {
		b.WriteString("\n" + c.Footnote + "\n")
	}
	b.WriteString("\n" + brand.Name + " is a free, self-hostable design tool.\n")
	b.WriteString("You received this email because of activity on your " + brand.Name + " account.\n")
	return b.String()
}
