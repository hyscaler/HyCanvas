import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Yjs must load as a SINGLE module instance: it uses `instanceof` constructor
// checks (Y.Map / Y.Array) and silently breaks cross-doc merges when two copies
// load ("Yjs was already imported"). By default vitest resolves @hc/schema to
// its compiled CJS `dist` (which `require`s yjs), while the test and reconcile
// source import yjs via ESM, yielding two instances. Aliasing @hc/schema to its
// TypeScript source routes its yjs import through the same ESM resolver, and
// deduping collapses every yjs spec to one physical module.
const schemaSrc = fileURLToPath(new URL("../schema/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@hc/schema": schemaSrc,
    },
    dedupe: ["yjs"],
  },
});
