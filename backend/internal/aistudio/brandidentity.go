// Brand identity suggestions for the brand guide wizard (#54). A brand drafted
// from a logo or a web page arrives with colors (and, from a page, font
// guesses), but no voice and often no usable type pairing. This one structured
// call fills those in from what the user and the scan already know: the brand
// name, a short description, the page's own headings, the observed colors and
// fonts, and (when the provider can see images) a short reading of the logo.
// Everything it returns is a DRAFT the user edits before anything is saved, and
// fonts are held to the catalog so a suggestion always renders.

package aistudio

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// BrandFontChoices are the families the suggestion may pick from, besides the
// fonts the scan actually observed. All of them are in the shipped font
// catalog (packages/text), so a suggested pairing always loads.
var BrandFontChoices = []string{
	"Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", "Raleway", "Nunito",
	"Work Sans", "DM Sans", "Manrope", "Plus Jakarta Sans", "Outfit", "Source Sans 3",
	"IBM Plex Sans", "Rubik", "Karla", "Mulish", "Space Grotesk", "Sora", "Urbanist",
	"Lexend", "Figtree", "Archivo", "Barlow", "Josefin Sans", "Quicksand", "Oswald",
	"Bebas Neue", "Playfair Display", "Merriweather", "Lora", "Libre Baskerville",
	"DM Serif Display", "Cormorant Garamond", "EB Garamond", "Crimson Pro", "Fraunces",
	"Source Serif 4", "Bitter", "Roboto Slab", "Space Mono", "IBM Plex Mono", "Comfortaa",
	"Syne", "Abril Fatface",
}

const brandIdentitySchema = `{"type":"object","additionalProperties":false,"required":["name","tone","doSay","dontSay","sampleCopy","headingFont","bodyFont"],"properties":{"name":{"type":"string","maxLength":60},"tone":{"type":"array","minItems":2,"maxItems":5,"items":{"type":"string","maxLength":24}},"doSay":{"type":"array","maxItems":5,"items":{"type":"string","maxLength":80}},"dontSay":{"type":"array","maxItems":5,"items":{"type":"string","maxLength":80}},"sampleCopy":{"type":"string","maxLength":240},"headingFont":{"type":"string"},"bodyFont":{"type":"string"}}}`

// BrandIdentityInput is what is known about the brand before the model pass.
// Every field is optional, but at least a name, a description, or some page
// context is needed for the suggestion to say anything specific.
type BrandIdentityInput struct {
	Name          string
	Description   string
	PageContext   string // the page's title, description, and headings
	LogoNotes     string // a short reading of the logo, when one was made
	Colors        []string
	ObservedFonts []string
}

// BrandIdentity is the suggested draft.
type BrandIdentity struct {
	Name        string   `json:"name"`
	Tone        []string `json:"tone"`
	DoSay       []string `json:"doSay"`
	DontSay     []string `json:"dontSay"`
	SampleCopy  string   `json:"sampleCopy"`
	HeadingFont string   `json:"headingFont"`
	BodyFont    string   `json:"bodyFont"`
}

// ErrBrandIdentityEmpty means there was nothing to base a suggestion on.
var ErrBrandIdentityEmpty = errors.New("describe the brand or give its website first")

const (
	maxBrandListItems = 5
	maxBrandItemRunes = 80
)

// SuggestBrandIdentity drafts a voice and a type pairing for a brand. Provider
// and policy errors propagate unchanged so the route can name them; a reply
// that never validates is an error too, since the caller asked for exactly
// this and has no deterministic fallback for a voice.
func (s *Service) SuggestBrandIdentity(ctx context.Context, workspaceID string, in BrandIdentityInput) (*BrandIdentity, error) {
	name := clipRunes(strings.TrimSpace(in.Name), 60)
	desc := clipRunes(strings.TrimSpace(in.Description), 600)
	page := clipRunes(strings.TrimSpace(in.PageContext), 1500)
	logo := clipRunes(strings.TrimSpace(in.LogoNotes), 400)
	if name == "" && desc == "" && page == "" && logo == "" {
		return nil, ErrBrandIdentityEmpty
	}

	// Allowed families: the curated catalog choices plus whatever the page
	// really uses, matched case-insensitively and returned in catalog casing.
	allowed := map[string]string{}
	for _, f := range BrandFontChoices {
		allowed[strings.ToLower(f)] = f
	}
	var observed []string
	for _, f := range in.ObservedFonts {
		f = strings.TrimSpace(f)
		if f == "" || len(observed) >= 6 {
			continue
		}
		observed = append(observed, f)
		if _, ok := allowed[strings.ToLower(f)]; !ok {
			allowed[strings.ToLower(f)] = f
		}
	}

	system := "You are a brand strategist drafting a starting brand guide. From what is known about the brand, write its voice " +
		"(2 to 5 one- or two-word tone adjectives; up to 5 short phrases or habits it uses; up to 5 it avoids; one or two sentences of sample copy " +
		"written in that voice about the brand itself) and choose a heading font and a body font that suit it and pair well. " +
		"If the brand already uses web fonts, prefer them. Fonts MUST be chosen from the allowed list, spelled exactly as listed. " +
		"Keep the given brand name unless none is given, in which case infer a short one. Do not invent facts, products, prices or claims. " +
		"Output ONLY a single JSON object, no prose/markdown/fences. Schema: " + brandIdentitySchema

	var b strings.Builder
	if name != "" {
		fmt.Fprintf(&b, "Brand name: %s\n", name)
	}
	if desc != "" {
		fmt.Fprintf(&b, "About the brand: %s\n", desc)
	}
	if page != "" {
		fmt.Fprintf(&b, "From its website:\n%s\n", page)
	}
	if logo != "" {
		fmt.Fprintf(&b, "Its logo: %s\n", logo)
	}
	if len(in.Colors) > 0 {
		fmt.Fprintf(&b, "Brand colors: %s\n", strings.Join(capStrings(in.Colors, 8), ", "))
	}
	if len(observed) > 0 {
		fmt.Fprintf(&b, "Fonts its website uses: %s\n", strings.Join(observed, ", "))
	}
	fmt.Fprintf(&b, "Allowed fonts: %s", strings.Join(append(append([]string{}, observed...), BrandFontChoices...), ", "))

	return generateValidated(ctx, s, workspaceID, system, b.String(), brandIdentitySchema, false, func(v *BrandIdentity) error {
		return normalizeBrandIdentity(v, name, allowed)
	})
}

// normalizeBrandIdentity holds a reply to the contract: trimmed and clipped
// text, de-duplicated lists, fonts in the allowed set, and the user's own
// brand name kept when one was given.
func normalizeBrandIdentity(v *BrandIdentity, givenName string, allowed map[string]string) error {
	v.Name = clipRunes(strings.TrimSpace(v.Name), 60)
	if givenName != "" {
		v.Name = givenName
	}
	v.Tone = cleanBrandList(v.Tone, 24)
	v.DoSay = cleanBrandList(v.DoSay, maxBrandItemRunes)
	v.DontSay = cleanBrandList(v.DontSay, maxBrandItemRunes)
	v.SampleCopy = clipRunes(strings.TrimSpace(v.SampleCopy), 240)
	if len(v.Tone) < 2 {
		return fmt.Errorf("give at least 2 tone words, got %d", len(v.Tone))
	}
	h, okH := allowed[strings.ToLower(strings.TrimSpace(v.HeadingFont))]
	bd, okB := allowed[strings.ToLower(strings.TrimSpace(v.BodyFont))]
	if !okH || !okB {
		return fmt.Errorf("headingFont and bodyFont must be chosen from the allowed fonts list (got %q, %q)", v.HeadingFont, v.BodyFont)
	}
	v.HeadingFont, v.BodyFont = h, bd
	return nil
}

func cleanBrandList(in []string, maxRunes int) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, s := range in {
		s = clipRunes(strings.TrimSpace(s), maxRunes)
		k := strings.ToLower(s)
		if s == "" || seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, s)
		if len(out) == maxBrandListItems {
			break
		}
	}
	return out
}

func capStrings(in []string, n int) []string {
	if len(in) > n {
		return in[:n]
	}
	return in
}

const logoReadInstruction = "This image is a company logo. In at most three short sentences, describe its style (for example geometric, playful, classic, handwritten, minimal), its shapes or symbol, and any words it spells, exactly as written. Plain prose only, no lists, no markdown."

// DescribeLogo reads a logo image (base64 PNG/JPEG, optionally a data URL)
// into a short plain-text note the identity suggestion can use. It reports
// ErrReviewUnsupported when the provider cannot see images; callers treat
// any error as "no logo notes" and carry on.
func (s *Service) DescribeLogo(ctx context.Context, workspaceID, imageBase64 string) (string, error) {
	reader, ok := s.ai.(imageReader)
	if !ok {
		return "", ErrReviewUnsupported
	}
	out, err := reader.DescribeImage(ctx, workspaceID, imageBase64, logoReadInstruction)
	if err != nil {
		return "", err
	}
	return clipRunes(strings.TrimSpace(out), 400), nil
}
