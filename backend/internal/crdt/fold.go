// Package crdt gives the Go server a real Yjs decoder without cgo: the exact
// client-side fold logic (yjs + y-protocols + @hc/realtime docToFile) is
// bundled into fold.js (scripts/build-crdt-fold.mjs, committed) and executed
// in-process under goja, a pure-Go JavaScript engine. The folded output is
// byte-identical to the browser's history fold because it IS the same code.
// The single self-contained binary story is unchanged: no cgo, no external
// runtime, `go build` needs no Node toolchain.
package crdt

import (
	"context"
	_ "embed"
	"encoding/base64"
	"fmt"
	"sync"
	"time"

	"github.com/dop251/goja"
)

//go:embed fold.js
var foldJS string

var (
	progOnce sync.Once
	prog     *goja.Program
	progErr  error
)

// program compiles the embedded bundle once per process; each fold then runs
// it in a fresh, throwaway VM (goja VMs are not goroutine-safe, and folds are
// cold-path operations: last-leave snapshots, history materialization).
func program() (*goja.Program, error) {
	progOnce.Do(func() {
		prog, progErr = goja.Compile("fold.js", foldJS, true)
	})
	return prog, progErr
}

const (
	// maxFoldFrames / maxFoldBytes bound what one fold will even attempt. Any
	// editor can journal frames, so the input is untrusted in both count and
	// size; beyond these the fold refuses rather than loading the whole log
	// into memory and doubling it into the VM.
	maxFoldFrames = 200_000
	maxFoldBytes  = 256 << 20
	// foldTimeout stops a fold that will not finish. Journaled bytes are
	// attacker-influenced, and a goja VM spinning in a pathological decode has
	// no other way out: without an interrupt the goroutine is wedged for the
	// life of the process, and every later fold of the same design adds one.
	foldTimeout = 30 * time.Second
)

// FoldUpdates folds journaled y-protocols update frames (oldest first, exactly
// as rows come out of DesignUpdateLog) into open-format DesignFile JSON, the
// same projection a browser client computes for the history scrubber. It is
// bounded in input size and wall-clock; every failure is non-destructive
// (callers treat an error as "do not materialize anything").
func FoldUpdates(frames [][]byte) ([]byte, error) {
	return FoldUpdatesContext(context.Background(), frames)
}

// FoldUpdatesContext is FoldUpdates with caller-supplied cancellation: the VM
// is interrupted when ctx ends or foldTimeout elapses, whichever comes first.
func FoldUpdatesContext(ctx context.Context, frames [][]byte) ([]byte, error) {
	if len(frames) > maxFoldFrames {
		return nil, fmt.Errorf("update log too long to fold: %d frames", len(frames))
	}
	total := 0
	for _, f := range frames {
		total += len(f)
		if total > maxFoldBytes {
			return nil, fmt.Errorf("update log too large to fold: over %d bytes", maxFoldBytes)
		}
	}
	p, err := program()
	if err != nil {
		return nil, fmt.Errorf("compile fold bundle: %w", err)
	}
	vm := goja.New()
	ctx, cancel := context.WithTimeout(ctx, foldTimeout)
	defer cancel()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			vm.Interrupt("fold cancelled")
		case <-done:
		}
	}()
	if _, err := vm.RunProgram(p); err != nil {
		return nil, fmt.Errorf("evaluate fold bundle: %w", err)
	}
	fn, ok := goja.AssertFunction(vm.Get("__hcFoldUpdates"))
	if !ok {
		return nil, fmt.Errorf("fold bundle did not define __hcFoldUpdates")
	}
	b64s := make([]string, len(frames))
	for i, f := range frames {
		b64s[i] = base64.StdEncoding.EncodeToString(f)
	}
	res, err := fn(goja.Undefined(), vm.ToValue(b64s))
	if err != nil {
		return nil, fmt.Errorf("fold updates: %w", err)
	}
	return []byte(res.String()), nil
}
