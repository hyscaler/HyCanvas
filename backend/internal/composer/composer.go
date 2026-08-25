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
	Dir          string   `json:"dir,omitempty"`
}

// Compose runs the embedded composer on one outline and returns the
// DesignFile JSON. The result is a complete open-format file (pages laid out,
// theme stamped, placeholder id) ready for persistence.Create, which
// validates it at the write boundary and assigns the real id.
func Compose(ctx context.Context, in Input) ([]byte, error) {
	if in.Width <= 0 || in.Height <= 0 {
		return nil, errors.New("composer: width and height must be positive")
	}
	p, err := program()
	if err != nil {
		return nil, fmt.Errorf("composer: bundle compile: %w", err)
	}
	inputJSON, err := json.Marshal(in)
	if err != nil {
		return nil, fmt.Errorf("composer: marshal input: %w", err)
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
		return nil, fmt.Errorf("composer: bundle eval: %w", err)
	}
	fnVal := vm.Get("__composeDeckFile")
	fn, ok := goja.AssertFunction(fnVal)
	if !ok {
		return nil, errors.New("composer: bundle exposes no __composeDeckFile")
	}
	res, err := fn(goja.Undefined(), vm.ToValue(string(inputJSON)))
	if err != nil {
		return nil, fmt.Errorf("composer: compose failed: %w", err)
	}
	out, ok := res.Export().(string)
	if !ok || out == "" {
		return nil, errors.New("composer: compose returned no output")
	}
	return []byte(out), nil
}
