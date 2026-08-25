// Host shims for running the @hc/aistudio composer under goja (the Go-embedded
// JS engine). MUST be the entry's first import so it evaluates before any
// library module's top-level code touches these globals.
//
// crypto.randomUUID here mints NODE ids inside one composed file, where only
// in-file uniqueness matters. A deterministic counter (not randomness) is the
// point: the goja run and the Node parity test install the same shim, so the
// same input composes to the same bytes on both runtimes (the golden test's
// whole claim).
let uuidSeq = 0;
// defineProperty, not assignment: Node exposes globalThis.crypto through a
// getter-only accessor (assignment throws), while goja has no crypto at all.
// The property is configurable in Node, so defineProperty replaces it in both.
Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: {
    randomUUID() {
      uuidSeq += 1;
      return `n-${uuidSeq}`;
    },
    getRandomValues(arr) {
      // Never used by the composer path; present so an incidental library call
      // cannot crash the VM. Deterministic for the same reason as randomUUID.
      for (let i = 0; i < arr.length; i++) arr[i] = (uuidSeq + i) % 256;
      return arr;
    },
  },
});

if (typeof globalThis.performance === "undefined") {
  globalThis.performance = { now: () => 0 };
}
