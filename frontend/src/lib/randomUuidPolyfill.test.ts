// An instance served over plain HTTP at a LAN address (the common self-host
// shape: a NAS at http://192.168.1.10:8005) is not a secure context, so the
// browser withholds crypto.randomUUID and every id-minting action throws.
import { describe, expect, it, afterEach } from "vitest";
import { installRandomUuidPolyfill } from "./randomUuidPolyfill";

const real = globalThis.crypto;
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function setCrypto(c: unknown) {
  Object.defineProperty(globalThis, "crypto", { value: c, configurable: true, writable: true });
}

afterEach(() => setCrypto(real));

describe("crypto.randomUUID polyfill", () => {
  it("supplies randomUUID when the origin is insecure", () => {
    // What Chrome exposes on http://<lan-ip>: getRandomValues, but no randomUUID.
    setCrypto({ getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });
    expect((globalThis.crypto as Crypto).randomUUID).toBeUndefined();

    installRandomUuidPolyfill();

    const id = (globalThis.crypto as Crypto).randomUUID();
    expect(id).toMatch(V4);
  });

  it("produces distinct ids", () => {
    setCrypto({ getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });
    installRandomUuidPolyfill();
    const uuid = () => (globalThis.crypto as Crypto).randomUUID();
    const ids = new Set(Array.from({ length: 500 }, uuid));
    expect(ids.size).toBe(500);
  });

  it("leaves a native implementation untouched", () => {
    const native = () => "11111111-2222-4333-8444-555555555555" as const;
    setCrypto({ randomUUID: native, getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });

    installRandomUuidPolyfill();

    expect((globalThis.crypto as Crypto).randomUUID).toBe(native);
  });

  it("does not invent randomness when getRandomValues is missing too", () => {
    // Guessable ids would be worse than a loud failure, so nothing is installed.
    setCrypto({});
    installRandomUuidPolyfill();
    expect((globalThis.crypto as Crypto).randomUUID).toBeUndefined();
  });
});
