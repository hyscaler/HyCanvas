// Host shims for running the yjs/lib0 module graph under goja (the Go-embedded
// JS engine). This must be the entry's FIRST import so it evaluates before any
// library module's top-level code touches these globals.
//
// crypto.getRandomValues only seeds Yjs client ids; a fold READS frames and
// never writes, so Math.random-quality randomness is fine here.
if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.getRandomValues) {
  globalThis.crypto = {
    getRandomValues(arr) {
      const max = Math.pow(2, 8 * (arr.BYTES_PER_ELEMENT || 1));
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * max);
      return arr;
    },
  };
}

if (typeof globalThis.performance === "undefined") {
  globalThis.performance = { now: () => Date.now() };
}
