// Multi-factor authentication primitives: RFC 6238 time-based
// one-time passwords (TOTP) over RFC 4226 HOTP, plus single-use recovery codes.
// Pure functions only: no I/O, no clock dependency beyond an injectable `time`.
// The backend layer stores the secret encrypted at rest and the recovery codes
// hashed; this module never touches storage. WebAuthn/passkeys are deferred.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648, no padding

/** Encode bytes to unpadded RFC 4648 base32 (the form authenticator apps want). */
function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decode an RFC 4648 base32 string (padding and case insensitive) to bytes. */
function base32Decode(input: string): Buffer {
  // Strip whitespace with a single-character class (no `+`, so no ReDoS), then
  // trim trailing `=` padding with a loop rather than a `/=+$/` replace that is
  // quadratic on an all-`=` input.
  let clean = input.replace(/\s/g, "").toUpperCase();
  while (clean.endsWith("=")) clean = clean.slice(0, -1);
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32 character in TOTP secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Generate a fresh TOTP secret as a base32 string (default 20 bytes / 160 bits,
 * the RFC 6238 reference size). This is the value to encrypt at rest and to
 * embed in the otpauth:// enrollment URL.
 */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/** HOTP (RFC 4226): HMAC-SHA1 of the 8-byte counter, dynamically truncated. */
function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const buf = Buffer.alloc(8);
  // Counter is well within 2^53, so split into hi/lo 32-bit words safely.
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

/**
 * Compute the current TOTP code for a base32 secret (RFC 6238: HMAC-SHA1, 6
 * digits, 30s step). `time` is ms epoch and defaults to now; pass it explicitly
 * to make tests deterministic.
 */
export function totp(secret: string, time: number = Date.now()): string {
  const counter = Math.floor(time / 1000 / TOTP_STEP_SECONDS);
  return hotp(base32Decode(secret), counter);
}

/** Constant-time string compare to avoid leaking match position via timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a submitted code against the secret, accepting codes within `window`
 * steps on either side of now (default +/-1 step, i.e. +/-30s) to tolerate
 * clock skew. Returns true on the first matching step.
 */
export function verifyTotp(
  secret: string,
  code: string,
  window = 1,
  time: number = Date.now(),
): boolean {
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const key = base32Decode(secret);
  const counter = Math.floor(time / 1000 / TOTP_STEP_SECONDS);
  for (let i = -window; i <= window; i++) {
    if (safeEqual(hotp(key, counter + i), normalized)) return true;
  }
  return false;
}

/**
 * Generate `n` single-use recovery codes (default 10). Each is a grouped,
 * easy-to-read string like "abcd-efgh-ijkl"; the caller hashes these before
 * storage and shows the plaintext to the user exactly once.
 */
export function generateRecoveryCodes(n = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const raw = base32Encode(randomBytes(8)).toLowerCase().slice(0, 12);
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
  }
  return codes;
}

/** Normalize a recovery code for comparison/hashing (lowercase, no separators). */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * Build the otpauth:// URI authenticator apps consume (rendered as a QR by the
 * client). `label` is usually the account email; `issuer` the product name.
 */
export function otpauthUrl(secret: string, label: string, issuer: string): string {
  const enc = encodeURIComponent;
  const acct = `${enc(issuer)}:${enc(label)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${acct}?${params.toString()}`;
}
