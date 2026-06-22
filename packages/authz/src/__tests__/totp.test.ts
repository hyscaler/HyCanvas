// Unit tests for the MFA primitives. The TOTP checks use the
// RFC 6238 Appendix B reference vectors for the SHA1 variant: the shared secret
// is the ASCII string "12345678901234567890" (20 bytes). The RFC publishes
// 8-digit codes; our implementation emits 6 digits, so we assert the last 6.

import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  otpauthUrl,
  totp,
  verifyTotp,
} from "../totp";

// Base32 of ASCII "12345678901234567890" (the RFC 6238 SHA1 seed).
const RFC_SECRET = base32(Buffer.from("12345678901234567890", "ascii"));

function base32(buf: Buffer): string {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

describe("@hc/authz TOTP (RFC 6238)", () => {
  // [unix seconds, expected 8-digit RFC code] -> assert last 6 digits.
  const VECTORS: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ];

  it("matches the RFC 6238 SHA1 reference codes (last 6 digits)", () => {
    for (const [seconds, eightDigit] of VECTORS) {
      const expected = eightDigit.slice(-6);
      expect(totp(RFC_SECRET, seconds * 1000)).toBe(expected);
    }
  });

  it("verifies a freshly computed code", () => {
    const t = 1700000000_000;
    const code = totp(RFC_SECRET, t);
    expect(verifyTotp(RFC_SECRET, code, 1, t)).toBe(true);
  });

  it("accepts a code one step away within the window and rejects beyond it", () => {
    const t = 1700000000_000;
    const prevStepTime = t - 30_000; // one step earlier
    const prevCode = totp(RFC_SECRET, prevStepTime);
    // The previous step's code is accepted at time t with window 1.
    expect(verifyTotp(RFC_SECRET, prevCode, 1, t)).toBe(true);
    // Two steps away is outside the +/-1 window.
    const farCode = totp(RFC_SECRET, t - 90_000);
    expect(verifyTotp(RFC_SECRET, farCode, 1, t)).toBe(false);
  });

  it("rejects wrong, malformed, and empty codes", () => {
    const t = 1700000000_000;
    expect(verifyTotp(RFC_SECRET, "000000", 1, t)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "12345", 1, t)).toBe(false); // too short
    expect(verifyTotp(RFC_SECRET, "abcdef", 1, t)).toBe(false); // non-numeric
    expect(verifyTotp(RFC_SECRET, "", 1, t)).toBe(false);
  });

  it("tolerates whitespace in the submitted code", () => {
    const t = 1700000000_000;
    const code = totp(RFC_SECRET, t);
    expect(verifyTotp(RFC_SECRET, ` ${code} `, 1, t)).toBe(true);
  });

  it("generates valid, distinct base32 secrets that verify round-trip", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).not.toBe(b);
    expect(/^[A-Z2-7]+$/.test(a)).toBe(true);
    const t = Date.now();
    expect(verifyTotp(a, totp(a, t), 1, t)).toBe(true);
  });

  it("builds a spec-compliant otpauth URL", () => {
    const url = otpauthUrl(RFC_SECRET, "user@example.com", "HyCanvas");
    expect(url.startsWith("otpauth://totp/")).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("secret")).toBe(RFC_SECRET);
    expect(parsed.searchParams.get("issuer")).toBe("HyCanvas");
    expect(parsed.searchParams.get("digits")).toBe("6");
    expect(parsed.searchParams.get("period")).toBe("30");
    expect(decodeURIComponent(parsed.pathname)).toContain("user@example.com");
  });
});

describe("@hc/authz recovery codes", () => {
  it("generates the requested count of distinct, formatted codes", () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(c)).toBe(true);
  });

  it("normalizes codes by stripping separators and casing", () => {
    expect(normalizeRecoveryCode("AbCd-EFgh-1234")).toBe("abcdefgh1234");
    expect(normalizeRecoveryCode("abcdefgh1234")).toBe("abcdefgh1234");
  });
});
