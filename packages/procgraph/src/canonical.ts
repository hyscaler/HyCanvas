// Canonical serialization and hashing (F40 FR-8, FR-14).
//
// Everything the cache key is built from passes through here, and the whole
// point is that the browser, the worker, and the Go export path must agree
// byte for byte. So the rules are fixed here once, deliberately boring, and
// chosen to be trivial to mirror in Go rather than to be clever:
//
//   Object keys are emitted in code-unit order, so an object's hash does not
//   depend on the order its keys happened to be inserted in. FR-14 forbids
//   iterating unordered collections precisely because that leaks insertion
//   order into results.
//
//   Numbers get ONE representation. JavaScript's default already round-trips
//   doubles exactly, but it prints -0 as "0" and has no way to spell NaN or
//   Infinity in JSON. Those are spelled explicitly so a NaN can never silently
//   collide with a null, and -0 can never collide with 0 (they behave
//   differently once divided into).
//
//   The hash is FNV-1a over UTF-8, 64-bit, in BigInt. Not because it is a good
//   hash in a cryptographic sense (it is not, and it must never be used where
//   that matters) but because it is exactly reproducible in any language in
//   about ten lines, which is the property that actually matters for keeping
//   three runtimes in agreement.

/** A value that can be canonically serialized. */
export type Canonical =
  | null
  | boolean
  | number
  | string
  | Canonical[]
  | { [k: string]: Canonical | undefined };

/**
 * The one number spelling. `-0`, `NaN`, and the infinities are given explicit
 * forms because JSON has none, and conflating them with `0` or `null` would let
 * two genuinely different graphs share a cache entry.
 */
export function canonicalNumber(n: number): string {
  if (Number.isNaN(n)) return '"@NaN"';
  if (n === Infinity) return '"@Inf"';
  if (n === -Infinity) return '"@-Inf"';
  if (n === 0) return Object.is(n, -0) ? '"@-0"' : "0";
  // Default JS formatting round-trips a double exactly and is specified, so it
  // is a fine canonical form as long as every runtime uses the same one.
  return String(n);
}

/** Serialize deterministically: sorted keys, one number spelling, no spaces. */
export function canonicalize(value: Canonical): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return canonicalNumber(value as number);
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalize(v as Canonical)).join(",") + "]";
  const obj = value as { [k: string]: Canonical | undefined };
  // Sort by code unit, not by locale: `localeCompare` would make the hash
  // depend on the machine's locale, which is exactly what FR-14 forbids.
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k] as Canonical)).join(",") + "}";
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/**
 * FNV-1a over the UTF-8 bytes of `s`, as 16 lowercase hex digits.
 *
 * Not a cryptographic hash. It is used for cache identity and change detection
 * only; nothing security-relevant may depend on its collision resistance.
 */
export function hashString(s: string): string {
  const bytes = utf8Bytes(s);
  let h = FNV_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}

/** Hash a value through the canonical form. */
export function hashValue(value: Canonical): string {
  return hashString(canonicalize(value));
}

/**
 * UTF-8 encode without depending on TextEncoder, which is present in browsers
 * and modern Node but is one more thing to be unavailable in some host. The
 * evaluator core is meant to run anywhere, so it encodes by hand.
 */
function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    // Combine a surrogate pair into one code point.
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = (cp - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return out;
}
