// The problem+json contract (F38 FR-9): every error response carries a stable
// machine code, because the code is the only thing a client can localize.
//
// Deleting the uncoded Problem() helper makes the common case structural, but a
// deletion cannot stop three things: passing an empty or computed code, giving
// two different messages the same code (which would make them mistranslate as
// each other), or hand-rolling a new problem+json writer that bypasses
// ProblemCode entirely. This reads the package source and checks all three.
package httpapi

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// goFilesUnder returns every non-test .go file under dir, recursively.
func goFilesUnder(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	err := filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return nil
		}
		out = append(out, p)
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", dir, err)
	}
	return out
}

// problemCodeCalls collects the code argument of every ProblemCode /
// problemWithCode call, as (file:line, code literal, ok) where ok is false when
// the argument is not a plain string literal.
type codeCall struct {
	where string
	code  string
	lit   bool
}

func collectProblemCodeCalls(t *testing.T, root string) []codeCall {
	t.Helper()
	var calls []codeCall
	fset := token.NewFileSet()
	for _, path := range goFilesUnder(t, root) {
		// problem.go defines the helpers and forwards a `code` VARIABLE between
		// them, which is not a call site and must not be judged as one.
		if filepath.Base(path) == "problem.go" {
			continue
		}
		f, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			name := ""
			switch fn := call.Fun.(type) {
			case *ast.Ident:
				name = fn.Name
			case *ast.SelectorExpr:
				name = fn.Sel.Name
			}
			if name != "ProblemCode" && name != "problemWithCode" {
				return true
			}
			if len(call.Args) != 6 {
				return true // a definition or a wrapper, not a call site
			}
			where := fset.Position(call.Pos()).String()
			lit, isLit := call.Args[5].(*ast.BasicLit)
			if !isLit || lit.Kind != token.STRING {
				calls = append(calls, codeCall{where: where, lit: false})
				return true
			}
			s, err := strconv.Unquote(lit.Value)
			if err != nil {
				calls = append(calls, codeCall{where: where, lit: false})
				return true
			}
			calls = append(calls, codeCall{where: where, code: s, lit: true})
			return true
		})
	}
	return calls
}

// A code must be a literal, non-empty, and snake_case, so it is greppable and
// can key a catalog entry. A computed code cannot be enumerated for translation.
func TestProblemCodesAreLiteralAndWellFormed(t *testing.T) {
	calls := collectProblemCodeCalls(t, ".")
	if len(calls) < 200 {
		t.Fatalf("only found %d problem+json call sites; the scanner is probably broken", len(calls))
	}
	for _, c := range calls {
		if !c.lit {
			t.Errorf("%s: problem code is not a string literal, so it cannot be translated", c.where)
			continue
		}
		if c.code == "" {
			t.Errorf("%s: empty problem code", c.where)
			continue
		}
		for _, r := range c.code {
			if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '_' {
				t.Errorf("%s: problem code %q must be snake_case (lowercase, digits, underscore)", c.where, c.code)
				break
			}
		}
	}
}

// Two DIFFERENT English messages sharing one code would be translated as each
// other, which is worse than leaving both in English. Sharing a code for the
// same message is fine and expected ("invalid body" is used 70 times).
func TestProblemCodeMapsToOneMessage(t *testing.T) {
	fset := token.NewFileSet()
	byCode := map[string]map[string]string{} // code -> message -> first location
	for _, path := range goFilesUnder(t, ".") {
		f, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			name := ""
			switch fn := call.Fun.(type) {
			case *ast.Ident:
				name = fn.Name
			case *ast.SelectorExpr:
				name = fn.Sel.Name
			}
			if (name != "ProblemCode" && name != "problemWithCode") || len(call.Args) != 6 {
				return true
			}
			codeLit, ok1 := call.Args[5].(*ast.BasicLit)
			detailLit, ok2 := call.Args[4].(*ast.BasicLit)
			if !ok1 || !ok2 || codeLit.Kind != token.STRING || detailLit.Kind != token.STRING {
				return true // a computed detail cannot be compared; the other test covers codes
			}
			code, err1 := strconv.Unquote(codeLit.Value)
			detail, err2 := strconv.Unquote(detailLit.Value)
			if err1 != nil || err2 != nil {
				return true
			}
			if byCode[code] == nil {
				byCode[code] = map[string]string{}
			}
			if _, seen := byCode[code][detail]; !seen {
				byCode[code][detail] = fset.Position(call.Pos()).String()
			}
			return true
		})
	}
	for code, msgs := range byCode {
		if len(msgs) > 1 {
			t.Errorf("code %q is used for %d different messages, so translating it would be wrong:", code, len(msgs))
			for m, where := range msgs {
				t.Errorf("    %q at %s", m, where)
			}
		}
	}
}

// Nothing may write problem+json except ProblemCode. A hand-rolled writer would
// reintroduce exactly the uncoded responses this contract exists to prevent.
func TestOnlyProblemCodeWritesProblemJSON(t *testing.T) {
	for _, path := range goFilesUnder(t, "..") {
		if filepath.Base(path) == "problem.go" {
			continue
		}
		src, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		if strings.Contains(string(src), "application/problem+json") {
			t.Errorf("%s writes application/problem+json directly; route it through httpapi.ProblemCode so the response carries a code", path)
		}
	}
}
