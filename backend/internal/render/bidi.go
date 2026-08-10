// Bidirectional text ordering for the headless renderer (F38 FR-10).
//
// This is the Go half of `packages/text/src/bidi.ts` and must agree with it:
// the browser and the export path lay the same paragraph out, so a design that
// reads correctly on the canvas has to read correctly in a PNG or a PDF.
// `bidi_test.go` runs the same cases as the TypeScript suite for that reason.
//
// One important difference from the browser side. Canvas2D's `fillText` applies
// character-level ordering and Arabic shaping itself, so the TypeScript layout
// only has to order the style RUNS. This renderer draws rune by rune through a
// font face, so it gets no ordering for free: the characters inside a
// right-to-left run have to be emitted in reverse here as well, which
// `OrderVisual` does.
//
// Shaping IS applied on this path: `shape.go` maps Arabic letters to their
// contextual presentation forms (and the mandatory lam-alef ligatures) before
// the reversal below, so joined script exports joined. See shape.go for the
// stated limits (rare extension letters, optional ligatures).
package render

import (
	"strings"
	"unicode"
)

type bidiClass int

const (
	bcL bidiClass = iota
	bcR
	bcAL
	bcEN
	bcAN
	bcES
	bcET
	bcCS
	bcNSM
	bcB
	bcS
	bcWS
	bcON
)

// classOf mirrors the ranges in the TypeScript implementation exactly. Any
// divergence here is a divergence between what the user sees and what they
// export, so the two lists are kept identical rather than "equivalent".
func classOf(r rune) bidiClass {
	switch {
	case r >= 0x0590 && r <= 0x05ff:
		return bcR // Hebrew
	case r >= 0x0600 && r <= 0x07bf:
		switch {
		case r >= 0x0660 && r <= 0x0669, r >= 0x066b && r <= 0x066c:
			return bcAN
		case r >= 0x06f0 && r <= 0x06f9:
			return bcEN
		case r >= 0x0610 && r <= 0x061a, r >= 0x064b && r <= 0x065f,
			r == 0x0670, r >= 0x06d6 && r <= 0x06dc, r >= 0x06df && r <= 0x06e4:
			return bcNSM
		}
		return bcAL
	case r >= 0x0700 && r <= 0x085f:
		return bcR
	case r >= 0xfb1d && r <= 0xfb4f:
		return bcR
	case r >= 0xfb50 && r <= 0xfdff, r >= 0xfe70 && r <= 0xfeff:
		return bcAL
	case r >= '0' && r <= '9':
		return bcEN
	case r == '+' || r == '-':
		return bcES
	case r == '#' || r == '$' || r == '%', r >= 0x00a2 && r <= 0x00a5:
		return bcET
	case r == ',' || r == '.' || r == ':' || r == '/':
		return bcCS
	case r == '\n' || r == '\r' || r == 0x001c || r == 0x001d || r == 0x001e || r == 0x0085:
		return bcB
	case r == '\t' || r == '\v' || r == 0x001f:
		return bcS
	case r == ' ' || r == '\f' || r == 0x2028 || r == 0x2029 || r == 0x3000:
		return bcWS
	case r >= 0x0300 && r <= 0x036f, r >= 0x20d0 && r <= 0x20ff:
		return bcNSM
	case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z':
		return bcL
	case r >= 0x00c0 && r <= 0x058f,
		r >= 0x0900 && r <= 0x1fff,
		r >= 0x2c00 && r <= 0xd7ff,
		r >= 0xf900 && r <= 0xfaff,
		r >= 0x10000:
		return bcL
	}
	return bcON
}

func strongRtl(c bidiClass) bool { return c == bcR || c == bcAL }

// ResolveBaseDirection is UAX #9 P2 and P3: an explicit declaration wins, and
// "auto" follows the first strong character, defaulting to left-to-right.
func ResolveBaseDirection(text, declared string) string {
	if declared == "ltr" || declared == "rtl" {
		return declared
	}
	for _, r := range text {
		c := classOf(r)
		if c == bcL {
			return "ltr"
		}
		if strongRtl(c) {
			return "rtl"
		}
	}
	return "ltr"
}

// HasRtl reports whether the text contains any strong right-to-left character.
func HasRtl(text string) bool {
	for _, r := range text {
		if strongRtl(classOf(r)) {
			return true
		}
	}
	return false
}

// resolveLevels assigns an embedding level per RUNE (the TypeScript version
// works per UTF-16 code unit; both index their own string type, and the run
// boundaries they produce are the same).
func resolveLevels(runes []rune, base string) []int {
	baseLevel := 0
	if base == "rtl" {
		baseLevel = 1
	}
	n := len(runes)
	cls := make([]bidiClass, n)
	for i, r := range runes {
		cls[i] = classOf(r)
	}
	// W1: a non-spacing mark takes the previous character's class.
	for i := 0; i < n; i++ {
		if cls[i] == bcNSM {
			if i == 0 {
				if base == "rtl" {
					cls[i] = bcR
				} else {
					cls[i] = bcL
				}
			} else {
				cls[i] = cls[i-1]
			}
		}
	}
	// W2: EN becomes AN after an Arabic strong class.
	lastStrong := bcL
	if base == "rtl" {
		lastStrong = bcR
	}
	for i := 0; i < n; i++ {
		switch cls[i] {
		case bcL, bcR, bcAL:
			lastStrong = cls[i]
		case bcEN:
			if lastStrong == bcAL {
				cls[i] = bcAN
			}
		}
	}
	// W3: AL is R from here on.
	for i := 0; i < n; i++ {
		if cls[i] == bcAL {
			cls[i] = bcR
		}
	}
	// W4: a single separator between two like numbers joins them.
	for i := 1; i < n-1; i++ {
		if cls[i] == bcES && cls[i-1] == bcEN && cls[i+1] == bcEN {
			cls[i] = bcEN
		}
		if cls[i] == bcCS && cls[i-1] == bcEN && cls[i+1] == bcEN {
			cls[i] = bcEN
		}
		if cls[i] == bcCS && cls[i-1] == bcAN && cls[i+1] == bcAN {
			cls[i] = bcAN
		}
	}
	// W5: a run of European terminators next to European numbers becomes EN.
	for i := 0; i < n; i++ {
		if cls[i] != bcET {
			continue
		}
		j := i
		for j < n && cls[j] == bcET {
			j++
		}
		if (i > 0 && cls[i-1] == bcEN) || (j < n && cls[j] == bcEN) {
			for k := i; k < j; k++ {
				cls[k] = bcEN
			}
		}
		i = j - 1
	}
	// W6: leftover separators and terminators are neutral.
	for i := 0; i < n; i++ {
		if cls[i] == bcES || cls[i] == bcET || cls[i] == bcCS {
			cls[i] = bcON
		}
	}
	// W7: EN becomes L after an L strong class.
	lastStrong = bcL
	if base == "rtl" {
		lastStrong = bcR
	}
	for i := 0; i < n; i++ {
		switch cls[i] {
		case bcL, bcR:
			lastStrong = cls[i]
		case bcEN:
			if lastStrong == bcL {
				cls[i] = bcL
			}
		}
	}
	// N1 and N2: neutrals take the surrounding direction when it agrees, else
	// the base direction. Numbers count as right-to-left for this.
	dirOf := func(c bidiClass) int {
		switch c {
		case bcL:
			return 1 // L
		case bcR, bcEN, bcAN:
			return 2 // R
		}
		return 0 // neutral
	}
	baseDir := 1
	if base == "rtl" {
		baseDir = 2
	}
	for i := 0; i < n; i++ {
		if dirOf(cls[i]) != 0 {
			continue
		}
		j := i
		for j < n && dirOf(cls[j]) == 0 {
			j++
		}
		before := baseDir
		if i > 0 {
			before = dirOf(cls[i-1])
		}
		after := baseDir
		if j < n {
			after = dirOf(cls[j])
		}
		take := baseDir
		if before == after && before != 0 {
			take = before
		}
		for k := i; k < j; k++ {
			if take == 1 {
				cls[k] = bcL
			} else {
				cls[k] = bcR
			}
		}
		i = j - 1
	}
	// I1 and I2.
	levels := make([]int, n)
	for i := range levels {
		levels[i] = baseLevel
		c := cls[i]
		if baseLevel == 0 {
			if c == bcR {
				levels[i] = 1
			} else if c == bcEN || c == bcAN {
				levels[i] = 2
			}
		} else if c == bcL || c == bcEN || c == bcAN {
			levels[i] = 2
		}
	}
	return levels
}

type levelRun struct{ start, end, level int }

// reorderRuns is UAX #9 L2: reverse each maximal run at or above each level,
// from the highest level down to the lowest odd one.
func reorderRuns(levels []int) []levelRun {
	var runs []levelRun
	for i := 0; i < len(levels); {
		j := i
		for j < len(levels) && levels[j] == levels[i] {
			j++
		}
		runs = append(runs, levelRun{i, j, levels[i]})
		i = j
	}
	if len(runs) == 0 {
		return runs
	}
	highest, lowestOdd := 0, int(^uint(0)>>1)
	for _, r := range runs {
		if r.level > highest {
			highest = r.level
		}
		if r.level%2 == 1 && r.level < lowestOdd {
			lowestOdd = r.level
		}
	}
	for lvl := highest; lvl >= lowestOdd && lvl > 0; lvl-- {
		for i := 0; i < len(runs); i++ {
			if runs[i].level < lvl {
				continue
			}
			j := i
			for j < len(runs) && runs[j].level >= lvl {
				j++
			}
			for a, b := i, j-1; a < b; a, b = a+1, b-1 {
				runs[a], runs[b] = runs[b], runs[a]
			}
			i = j - 1
		}
	}
	return runs
}

// BidiPiece is a span of one style run, in display order.
type BidiPiece struct {
	// Index of the source item this piece came from, so the caller keeps its style.
	Item  int
	Text  string
	Level int
}

// OrderVisual reorders a line's style runs into display order AND reverses the
// characters inside right-to-left runs, because this renderer draws rune by
// rune and gets no ordering from the text stack. `texts` is the line's runs in
// logical order.
func OrderVisual(texts []string, base string) []BidiPiece {
	if len(texts) == 0 {
		return nil
	}
	full := strings.Join(texts, "")
	if base == "ltr" && !HasRtl(full) {
		out := make([]BidiPiece, 0, len(texts))
		for i, t := range texts {
			out = append(out, BidiPiece{Item: i, Text: t, Level: 0})
		}
		return out
	}
	runes := []rune(full)
	levels := resolveLevels(runes, base)
	runs := reorderRuns(levels)

	// Rune offsets of each source item, so a level run can be split back into
	// per-style pieces.
	type bound struct{ item, start, end int }
	bounds := make([]bound, 0, len(texts))
	at := 0
	for i, t := range texts {
		n := len([]rune(t))
		bounds = append(bounds, bound{i, at, at + n})
		at += n
	}

	var out []BidiPiece
	for _, run := range runs {
		var slice []BidiPiece
		for _, b := range bounds {
			s, e := max(run.start, b.start), min(run.end, b.end)
			if s >= e {
				continue
			}
			piece := string(runes[s:e])
			if run.level%2 == 1 {
				// Shape BEFORE reversing: contextual forms follow logical
				// reading order. The neighboring runes of the full line give
				// joining context across style-run seams, so a word whose
				// color changes mid-word still connects.
				if hasArabic(piece) {
					// The joining context skips transparent marks (harakat):
					// a vowel sign at a style-run seam must not break the
					// join between the letters on either side of it.
					var prev, next rune
					for k := s - 1; k >= 0; k-- {
						if !transparent(runes[k]) {
							prev = runes[k]
							break
						}
					}
					for k := e; k < len(runes); k++ {
						if !transparent(runes[k]) {
							next = runes[k]
							break
						}
					}
					piece = ShapeArabic(piece, prev, next)
				}
				piece = reverseRunes(piece)
			}
			slice = append(slice, BidiPiece{Item: b.item, Text: piece, Level: run.level})
		}
		// Inside a reversed run the style pieces are visited back to front too.
		if run.level%2 == 1 {
			for a, b := 0, len(slice)-1; a < b; a, b = a+1, b-1 {
				slice[a], slice[b] = slice[b], slice[a]
			}
		}
		out = append(out, slice...)
	}
	return out
}

// reverseRunes reverses text for RTL display, keeping combining marks
// (harakat, niqqud) attached to their base letter. A blind rune reversal
// would put each zero-width mark BEFORE its base in draw order, so the mark
// glyph (drawn at the pen position) would land on the visually previous
// letter instead of its own.
func reverseRunes(s string) string {
	r := []rune(s)
	out := make([]rune, 0, len(r))
	for end := len(r); end > 0; {
		start := end - 1
		for start > 0 && unicode.Is(unicode.Mn, r[start]) {
			start--
		}
		out = append(out, r[start:end]...)
		end = start
	}
	return string(out)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
