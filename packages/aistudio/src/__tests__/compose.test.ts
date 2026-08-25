// F40 E03: the headless composer's Node-side half of the golden parity claim.
// This file must stay ISOLATED (its own test file, composing exactly once):
// node ids come from module counters and the shimmed crypto.randomUUID, so any
// earlier compose in the same module graph would shift every id. The Go test
// (backend/internal/composer) asserts the goja run equals the same fixture.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const testdata = path.resolve(__dirname, "../../../../backend/internal/composer/testdata");

describe("composeDeckFile parity fixture", () => {
  it("composes the committed input to the committed expected file", async () => {
    // The same deterministic shim the goja entry installs, BEFORE the compose
    // module graph loads (createNode reads crypto.randomUUID at call time).
    let uuidSeq = 0;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: () => `n-${++uuidSeq}` },
    });
    const { composeDeckFile } = await import("../compose");
    const input = JSON.parse(readFileSync(path.join(testdata, "compose-input.json"), "utf8"));
    const expected = JSON.parse(readFileSync(path.join(testdata, "compose-expected.json"), "utf8"));
    const got = JSON.parse(JSON.stringify(composeDeckFile(input)));
    expect(got).toEqual(expected);
  });
});
