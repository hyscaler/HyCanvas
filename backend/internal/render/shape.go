// Arabic contextual shaping for the headless renderer (F38 FR-10).
//
// Arabic letters change form depending on their neighbors: a letter joins its
// predecessor, its successor, both, or neither, and each state is a different
// glyph. Canvas2D does this in the browser for free; this renderer draws rune
// by rune, so without shaping every letter came out in its ISOLATED form -
// legible roughly the way "d i s j o i n t e d" English is.
//
// This implements the Unicode joining model (UAX #9 companion, chapter 9.2 of
// the core spec) for the Arabic block by mapping each letter to its
// Presentation Forms glyph (isolated / final / initial / medial), plus the
// four mandatory lam-alef ligatures. Harakat (combining marks) are transparent
// to joining, exactly as the spec requires. ZWJ forces a join, ZWNJ breaks
// one.
//
// Applied to text in LOGICAL order, before bidi reversal: contextual forms
// depend on reading order, not display order.
//
// Deliberate limits, stated rather than implied:
//   - Persian and Urdu extensions (peh, cheh, gaf, farsi yeh, ...) are covered
//     for the letters with Presentation Forms-A codepoints; rarer extension
//     letters fall back to their isolated codepoint unshaped.
//   - Optional ligatures beyond lam-alef are not formed; fonts render the
//     sequence of contextual forms, which is correct if less calligraphic.
package render

// joining type per the Unicode ArabicShaping classification, reduced to what
// the algorithm needs.
type joinType int

const (
	joinNone        joinType = iota // does not join at all (hamza, punctuation)
	joinRight                       // joins the preceding letter only (alef, dal, reh, waw)
	joinDual                        // joins both sides (most letters)
	joinTransparent                 // invisible to joining (harakat)
)

// forms holds the four presentation-form codepoints for a letter:
// [isolated, final, initial, medial]. Zero means the form does not exist for
// that letter (right-joining letters have no initial or medial form).
type forms [4]rune

// shapeTable maps each base letter to its joining type and presentation forms.
var shapeTable = map[rune]struct {
	join  joinType
	forms forms
}{
	// --- Arabic block, Presentation Forms-B ---
	0x0621: {joinNone, forms{0xFE80, 0, 0, 0}},                // hamza
	0x0622: {joinRight, forms{0xFE81, 0xFE82, 0, 0}},          // alef madda
	0x0623: {joinRight, forms{0xFE83, 0xFE84, 0, 0}},          // alef hamza above
	0x0624: {joinRight, forms{0xFE85, 0xFE86, 0, 0}},          // waw hamza
	0x0625: {joinRight, forms{0xFE87, 0xFE88, 0, 0}},          // alef hamza below
	0x0626: {joinDual, forms{0xFE89, 0xFE8A, 0xFE8B, 0xFE8C}}, // yeh hamza
	0x0627: {joinRight, forms{0xFE8D, 0xFE8E, 0, 0}},          // alef
	0x0628: {joinDual, forms{0xFE8F, 0xFE90, 0xFE91, 0xFE92}}, // beh
	0x0629: {joinRight, forms{0xFE93, 0xFE94, 0, 0}},          // teh marbuta
	0x062A: {joinDual, forms{0xFE95, 0xFE96, 0xFE97, 0xFE98}}, // teh
	0x062B: {joinDual, forms{0xFE99, 0xFE9A, 0xFE9B, 0xFE9C}}, // theh
	0x062C: {joinDual, forms{0xFE9D, 0xFE9E, 0xFE9F, 0xFEA0}}, // jeem
	0x062D: {joinDual, forms{0xFEA1, 0xFEA2, 0xFEA3, 0xFEA4}}, // hah
	0x062E: {joinDual, forms{0xFEA5, 0xFEA6, 0xFEA7, 0xFEA8}}, // khah
	0x062F: {joinRight, forms{0xFEA9, 0xFEAA, 0, 0}},          // dal
	0x0630: {joinRight, forms{0xFEAB, 0xFEAC, 0, 0}},          // thal
	0x0631: {joinRight, forms{0xFEAD, 0xFEAE, 0, 0}},          // reh
	0x0632: {joinRight, forms{0xFEAF, 0xFEB0, 0, 0}},          // zain
	0x0633: {joinDual, forms{0xFEB1, 0xFEB2, 0xFEB3, 0xFEB4}}, // seen
	0x0634: {joinDual, forms{0xFEB5, 0xFEB6, 0xFEB7, 0xFEB8}}, // sheen
	0x0635: {joinDual, forms{0xFEB9, 0xFEBA, 0xFEBB, 0xFEBC}}, // sad
	0x0636: {joinDual, forms{0xFEBD, 0xFEBE, 0xFEBF, 0xFEC0}}, // dad
	0x0637: {joinDual, forms{0xFEC1, 0xFEC2, 0xFEC3, 0xFEC4}}, // tah
	0x0638: {joinDual, forms{0xFEC5, 0xFEC6, 0xFEC7, 0xFEC8}}, // zah
	0x0639: {joinDual, forms{0xFEC9, 0xFECA, 0xFECB, 0xFECC}}, // ain
	0x063A: {joinDual, forms{0xFECD, 0xFECE, 0xFECF, 0xFED0}}, // ghain
	0x0640: {joinDual, forms{0x0640, 0x0640, 0x0640, 0x0640}}, // tatweel joins both sides
	0x0641: {joinDual, forms{0xFED1, 0xFED2, 0xFED3, 0xFED4}}, // feh
	0x0642: {joinDual, forms{0xFED5, 0xFED6, 0xFED7, 0xFED8}}, // qaf
	0x0643: {joinDual, forms{0xFED9, 0xFEDA, 0xFEDB, 0xFEDC}}, // kaf
	0x0644: {joinDual, forms{0xFEDD, 0xFEDE, 0xFEDF, 0xFEE0}}, // lam
	0x0645: {joinDual, forms{0xFEE1, 0xFEE2, 0xFEE3, 0xFEE4}}, // meem
	0x0646: {joinDual, forms{0xFEE5, 0xFEE6, 0xFEE7, 0xFEE8}}, // noon
	0x0647: {joinDual, forms{0xFEE9, 0xFEEA, 0xFEEB, 0xFEEC}}, // heh
	0x0648: {joinRight, forms{0xFEED, 0xFEEE, 0, 0}},          // waw
	0x0649: {joinRight, forms{0xFEEF, 0xFEF0, 0, 0}},          // alef maksura
	0x064A: {joinDual, forms{0xFEF1, 0xFEF2, 0xFEF3, 0xFEF4}}, // yeh

	// --- Persian / Urdu letters with Presentation Forms-A codepoints ---
	0x0679: {joinDual, forms{0xFB66, 0xFB67, 0xFB68, 0xFB69}}, // tteh
	0x067E: {joinDual, forms{0xFB56, 0xFB57, 0xFB58, 0xFB59}}, // peh
	0x0686: {joinDual, forms{0xFB7A, 0xFB7B, 0xFB7C, 0xFB7D}}, // tcheh
	0x0688: {joinRight, forms{0xFB88, 0xFB89, 0, 0}},          // ddal
	0x0691: {joinRight, forms{0xFB8C, 0xFB8D, 0, 0}},          // rreh
	0x0698: {joinRight, forms{0xFB8A, 0xFB8B, 0, 0}},          // jeh (zhe)
	0x06A9: {joinDual, forms{0xFB8E, 0xFB8F, 0xFB90, 0xFB91}}, // keheh
	0x06AF: {joinDual, forms{0xFB92, 0xFB93, 0xFB94, 0xFB95}}, // gaf
	0x06BA: {joinRight, forms{0xFB9E, 0xFB9F, 0, 0}},          // noon ghunna
	0x06BE: {joinDual, forms{0xFBAA, 0xFBAB, 0xFBAC, 0xFBAD}}, // heh doachashmee
	0x06C1: {joinDual, forms{0xFBA6, 0xFBA7, 0xFBA8, 0xFBA9}}, // heh goal
	0x06CC: {joinDual, forms{0xFBFC, 0xFBFD, 0xFBFE, 0xFBFF}}, // farsi yeh
	0x06D2: {joinRight, forms{0xFBAE, 0xFBAF, 0, 0}},          // yeh barree
}

// lamAlef maps the alef variant following LAM to its ligature pair
// [isolated, final]. The ligature is mandatory in Arabic; rendering lam and
// alef as separate contextual forms is a spelling error, not a style choice.
var lamAlef = map[rune][2]rune{
	0x0622: {0xFEF5, 0xFEF6}, // lam + alef madda
	0x0623: {0xFEF7, 0xFEF8}, // lam + alef hamza above
	0x0625: {0xFEF9, 0xFEFA}, // lam + alef hamza below
	0x0627: {0xFEFB, 0xFEFC}, // lam + alef
}

const (
	zwnj = 0x200C // zero-width non-joiner: breaks a join
	zwj  = 0x200D // zero-width joiner: forces a join
)

// unshape maps every presentation form back to its base letter(s), built by
// inverting shapeTable and lamAlef. Many modern Arabic fonts rely on OpenType
// shaping and cover the base block (0621..064A) but NOT Forms-B in their
// cmap, so the glyph-fallback path uses this to draw the base letter
// (unjoined, exactly what the export produced before shaping existed) rather
// than dropping the character entirely.
var unshape = func() map[rune][]rune {
	m := make(map[rune][]rune, len(shapeTable)*4+len(lamAlef)*2)
	for base, e := range shapeTable {
		for _, f := range e.forms {
			if f != 0 {
				m[f] = []rune{base}
			}
		}
	}
	const lam = 0x0644
	for alef, lig := range lamAlef {
		m[lig[0]] = []rune{lam, alef}
		m[lig[1]] = []rune{lam, alef}
	}
	return m
}()

// UnshapeFallback returns the base letter(s) for a presentation form, or nil
// when the rune is not a shaped form.
func UnshapeFallback(r rune) []rune {
	return unshape[r]
}

// transparent reports whether the rune is invisible to joining (harakat and
// other combining marks that sit on a letter without interrupting the word).
func transparent(r rune) bool {
	return (r >= 0x0610 && r <= 0x061A) || // honorific signs and small marks
		(r >= 0x064B && r <= 0x065F) || r == 0x0670 ||
		(r >= 0x06D6 && r <= 0x06DC) || (r >= 0x06DF && r <= 0x06E4) ||
		r == 0x06E7 || r == 0x06E8 || (r >= 0x06EA && r <= 0x06ED)
}

// joins reports whether the rune joins toward the FOLLOWING letter (i.e. can
// take an initial or medial form itself, or forces a join like ZWJ).
func joinsForward(r rune) bool {
	if r == zwj {
		return true
	}
	e, ok := shapeTable[r]
	return ok && e.join == joinDual
}

// joinsBackward reports whether the rune joins toward the PRECEDING letter.
func joinsBackward(r rune) bool {
	if r == zwj {
		return true
	}
	e, ok := shapeTable[r]
	return ok && (e.join == joinDual || e.join == joinRight)
}

// prevJoining returns the nearest non-transparent rune before i, or 0.
func prevJoining(runes []rune, i int) rune {
	for j := i - 1; j >= 0; j-- {
		if !transparent(runes[j]) {
			return runes[j]
		}
	}
	return 0
}

// nextJoining returns the nearest non-transparent rune after i, or 0.
func nextJoining(runes []rune, i int) rune {
	for j := i + 1; j < len(runes); j++ {
		if !transparent(runes[j]) {
			return runes[j]
		}
	}
	return 0
}

// ShapeArabic replaces Arabic letters with their contextual presentation
// forms and forms the mandatory lam-alef ligatures. Text must be in LOGICAL
// order. Non-Arabic runes, unknown letters, and combining marks pass through
// unchanged, so the function is safe to call on any string.
//
// prev and next give joining context beyond the slice (the neighboring runes
// in the full logical line), so a word split across style runs still joins
// correctly at the seam. Pass 0 when there is no neighbor.
func ShapeArabic(text string, prev, next rune) string {
	runes := []rune(text)
	out := make([]rune, 0, len(runes))

	// contextBefore(i): does the letter at i have a joining predecessor?
	contextBefore := func(i int) bool {
		p := prevJoining(runes, i)
		if p == 0 {
			p = prev
		}
		if p == zwnj {
			return false
		}
		return joinsForward(p)
	}
	contextAfter := func(i int) bool {
		n := nextJoining(runes, i)
		if n == 0 {
			n = next
		}
		if n == zwnj {
			return false
		}
		return joinsBackward(n)
	}

	for i := 0; i < len(runes); i++ {
		r := runes[i]
		entry, ok := shapeTable[r]
		if !ok || transparent(r) {
			// Not a shapeable letter (or a mark): keep as-is. ZWJ/ZWNJ have
			// done their job as context and are dropped from the output so
			// they never reach the glyph loop.
			if r != zwj && r != zwnj {
				out = append(out, r)
			}
			continue
		}

		// Mandatory lam-alef ligature: LAM directly followed (ignoring marks)
		// by an alef variant fuses into one glyph carrying both.
		if r == 0x0644 {
			if n := nextJoining(runes, i); n != 0 {
				if lig, isLig := lamAlef[n]; isLig {
					form := lig[0] // isolated
					if contextBefore(i) {
						form = lig[1] // final
					}
					out = append(out, form)
					// Skip forward past the alef, carrying any marks between.
					for j := i + 1; j < len(runes); j++ {
						if transparent(runes[j]) {
							out = append(out, runes[j])
							continue
						}
						i = j
						break
					}
					continue
				}
			}
		}

		before := contextBefore(i)
		after := contextAfter(i)

		var form rune
		switch entry.join {
		case joinDual:
			switch {
			case before && after:
				form = entry.forms[3] // medial
			case before:
				form = entry.forms[1] // final
			case after:
				form = entry.forms[2] // initial
			default:
				form = entry.forms[0] // isolated
			}
		case joinRight:
			if before {
				form = entry.forms[1] // final
			} else {
				form = entry.forms[0] // isolated
			}
		default:
			form = entry.forms[0]
		}
		if form == 0 {
			form = entry.forms[0]
		}
		out = append(out, form)
	}
	return string(out)
}

// hasArabic reports whether the string contains any letter this shaper knows.
func hasArabic(s string) bool {
	for _, r := range s {
		if _, ok := shapeTable[r]; ok {
			return true
		}
	}
	return false
}
