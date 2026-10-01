// Package composer gives the Go server the client's outline-to-pages deck
// composition without cgo or a Node runtime (F40 E03): the exact
// @hc/aistudio composeDeckFile code path is bundled into composer.js
// (scripts/build-composer.mjs, committed) and executed in-process under goja.
// The output is byte-identical to what the same input composes to in the
// browser because it IS the same code, which the parity test proves against a
// shared committed fixture.
package composer

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/dop251/goja"
)

//go:embed composer.js
var composerJS string

var (
	progOnce sync.Once
	prog     *goja.Program
	progErr  error
)

// program compiles the embedded bundle once per process; each compose then
// runs in a fresh, throwaway VM (goja VMs are not goroutine-safe, and a
// compose is a cold-path operation inside a generation job).
func program() (*goja.Program, error) {
	progOnce.Do(func() {
		prog, progErr = goja.Compile("composer.js", composerJS, true)
	})
	return prog, progErr
}

// composeTimeout stops a compose that will not finish: the outline is
// model-produced (bounded upstream), but a VM wedged on pathological input
// has no other way out.
const composeTimeout = 15 * time.Second

// Input mirrors @hc/aistudio ComposeDeckInput.
type Input struct {
	Outline      any      `json:"outline"`
	Width        int      `json:"width"`
	Height       int      `json:"height"`
	BrandPalette []string `json:"brandPalette,omitempty"`
	// ThemeID names a built-in catalog theme (F40 E12); the bundle resolves
	// it and THROWS on an unknown id, so validate before composing.
	ThemeID string `json:"themeId,omitempty"`
	// LayoutSet + ThemeRecord (F40 E14): a template's layout system and theme
	// record, passed through as raw JSON from the template file; the bundle
	// composes layout-grounded pages on them.
	LayoutSet   any    `json:"layoutSet,omitempty"`
	ThemeRecord any    `json:"themeRecord,omitempty"`
	Dir         string `json:"dir,omitempty"`
	// Motion is the entrance motion on the composed pages: "subtle" (the
	// bundle's default when empty) or "none".
	Motion string `json:"motion,omitempty"`
	// DesignType is what the pages are ("deck", "doc", "poster", "social"):
	// a post or poster composes without deck furniture.
	DesignType string `json:"designType,omitempty"`
	// Look is the deck's house style ("classic", "editorial", "bold",
	// "technical"); empty lets the outline's or the catalog's stand.
	Look string `json:"look,omitempty"`
	// Renderer names the composer that draws a deck's pages: "kit" (the
	// bundle's default: the signature templates' systems and forms) or
	// "classic" (the archetype composer).
	Renderer string `json:"renderer,omitempty"`
	// BrandFonts are the workspace brand kit's faces by role; the generated
	// theme sets headings and body in them. A catalog theme or a template
	// keeps its own.
	BrandFonts *BrandFonts `json:"brandFonts,omitempty"`
	// Logo is the brand kit's primary logo; the composer places it small on
	// every archetype page and lists the asset in the file.
	Logo *Logo `json:"logo,omitempty"`
}

// BrandFonts mirrors the editor's brandFonts: a face for headings and one for
// body copy, either optional.
type BrandFonts struct {
	Heading string `json:"heading,omitempty"`
	Body    string `json:"body,omitempty"`
}

// Logo is an asset the composer may place: its id (the file's asset ref) and
// the URL that ref carries.
type Logo struct {
	AssetID string `json:"assetId"`
	URL     string `json:"url"`
	// Aspect is width over height when the asset's dimensions are known, so
	// the composer's box fits the picture; zero means unknown.
	Aspect float64 `json:"aspect,omitempty"`
	// MinSizePx is the brand kit's floor on the logo's width.
	MinSizePx int `json:"minSizePx,omitempty"`
	// Dark is the version drawn on a dark ground, when the kit has one.
	Dark *LogoVariant `json:"dark,omitempty"`
}

// LogoVariant is one alternative rendering of the kit's logo.
type LogoVariant struct {
	AssetID string  `json:"assetId"`
	URL     string  `json:"url"`
	Aspect  float64 `json:"aspect,omitempty"`
}

// PageReport is the reviewer's verdict on one composed page. Mirrors
// PageReport in packages/aistudio/src/measure.ts.
type PageReport struct {
	Index     int    `json:"index"`
	Archetype string `json:"archetype"`
	Impact    bool   `json:"impact"`
	// Overfull names the text regions whose copy reached the readability floor
	// and still did not fit. Geometry has done what it can; only shorter copy
	// fixes it, which is what the generation API hands back to the model once.
	Overfull   []string `json:"overfull"`
	Whitespace float64  `json:"whitespace"`
	// Repairs counts the text runs the composer re-inked to AA before the
	// page left it.
	Repairs int `json:"repairs"`
}

// Report is the reviewer's verdict on a composed deck. Mirrors DeckReport in
// packages/aistudio/src/measure.ts.
type Report struct {
	Pages       []PageReport `json:"pages"`
	BulletShare float64      `json:"bulletShare"`
	Repetition  []int        `json:"repetition"`
	Shorten     []int        `json:"shorten"`
	Repairs     int          `json:"repairs"`
	OK          bool         `json:"ok"`
}

// Compose runs the embedded composer on one outline and returns the
// DesignFile JSON. The result is a complete open-format file (pages laid out,
// theme stamped, placeholder id) ready for persistence.Create, which
// validates it at the write boundary and assigns the real id.
func Compose(ctx context.Context, in Input) ([]byte, error) {
	return run(ctx, in, "__composeDeckFile")
}

// ComposeWithReport is Compose plus the reviewer's report on the result, so a
// caller can act on overfull copy before persisting. The file bytes are the
// same bytes Compose would return for the same input.
func ComposeWithReport(ctx context.Context, in Input) ([]byte, Report, error) {
	raw, err := run(ctx, in, "__composeDeckFileWithReport")
	if err != nil {
		return nil, Report{}, err
	}
	var out struct {
		File   json.RawMessage `json:"file"`
		Report Report          `json:"report"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, Report{}, fmt.Errorf("composer: report unreadable: %w", err)
	}
	return []byte(out.File), out.Report, nil
}

// run evaluates the bundle and calls one of its entry points with the input.
func run(ctx context.Context, in Input, entry string) ([]byte, error) {
	if in.Width <= 0 || in.Height <= 0 {
		return nil, errors.New("composer: width and height must be positive")
	}
	inputJSON, err := json.Marshal(in)
	if err != nil {
		return nil, fmt.Errorf("composer: marshal input: %w", err)
	}
	out, err := callString(ctx, entry, string(inputJSON))
	if err != nil {
		return nil, err
	}
	return []byte(out), nil
}

// callString evaluates the bundle and calls one entry point with one string
// argument, returning its string result.
func callString(ctx context.Context, entry string, arg string) (string, error) {
	p, err := program()
	if err != nil {
		return "", fmt.Errorf("composer: bundle compile: %w", err)
	}

	vm := goja.New()
	ctx, cancel := context.WithTimeout(ctx, composeTimeout)
	defer cancel()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			vm.Interrupt("composer timeout")
		case <-done:
		}
	}()

	if _, err := vm.RunProgram(p); err != nil {
		return "", fmt.Errorf("composer: bundle eval: %w", err)
	}
	fnVal := vm.Get(entry)
	fn, ok := goja.AssertFunction(fnVal)
	if !ok {
		return "", fmt.Errorf("composer: bundle exposes no %s", entry)
	}
	res, err := fn(goja.Undefined(), vm.ToValue(arg))
	if err != nil {
		return "", fmt.Errorf("composer: compose failed: %w", err)
	}
	out, ok := res.Export().(string)
	if !ok || out == "" {
		return "", errors.New("composer: compose returned no output")
	}
	return out, nil
}
