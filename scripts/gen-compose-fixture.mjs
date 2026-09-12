// Regenerates the composer parity fixture after an INTENTIONAL change to the
// compose path. The Go test (backend/internal/composer/composer_test.go) runs
// the goja bundle over testdata/compose-input.json and requires the result to
// match testdata/compose-expected.json byte for byte, which this script
// produces under Node from the built @hc/aistudio. Run `npm run build:packages`
// first, then this, then `npm run gen:composer`.
//
// Node ids are replaced by a counter here exactly as the goja entry replaces
// them, so the two runtimes compose to the same bytes.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testdata = path.join(root, "backend/internal/composer/testdata");

let seq = 0;
// Same shape as scripts/composer-polyfill.mjs, so both runtimes mint "n-1", "n-2", ...
Object.defineProperty(globalThis, "crypto", { configurable: true, value: { randomUUID: () => `n-${++seq}` } });
if (typeof globalThis.structuredClone !== "function") {
  globalThis.structuredClone = (v) => JSON.parse(JSON.stringify(v));
}

const { composeDeckFile } = await import(path.join(root, "packages/aistudio/dist/index.js"));
const input = JSON.parse(readFileSync(path.join(testdata, "compose-input.json"), "utf8"));
const out = composeDeckFile(input);
writeFileSync(path.join(testdata, "compose-expected.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`wrote compose-expected.json: ${out.pages.length} pages`);
