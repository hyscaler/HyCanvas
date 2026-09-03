// `crypto.randomUUID` exists only in a SECURE CONTEXT: HTTPS, or localhost.
// A self-hosted instance reached over plain HTTP at a LAN address (a NAS at
// http://192.168.1.10:8005, say) is neither, so the function is simply absent
// and every `crypto.randomUUID()` call throws a TypeError. The editor and the
// dashboard mint ids constantly, so on such an instance creating a design fails
// with no request ever leaving the browser and, because the call sites catch,
// no console error either.
//
// `crypto.getRandomValues` carries no such restriction, so a real v4 UUID is
// still available; only the convenience wrapper is missing. Installing it keeps
// every existing `crypto.randomUUID()` call site working unchanged, including
// the ones inside @hc/* packages.
//
// Nothing is replaced when the browser already provides it, so a normal HTTPS
// deployment runs the native implementation exactly as before.

/** RFC 4122 v4 UUID from CSPRNG bytes, formatted like crypto.randomUUID(). */
function uuidV4FromRandomValues(getRandomValues: (a: Uint8Array) => Uint8Array): string {
  const b = getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const hex: string[] = [];
  for (let i = 0; i < 256; i++) hex.push((i + 0x100).toString(16).slice(1));
  const s = (i: number) => hex[b[i]];
  return (
    s(0) + s(1) + s(2) + s(3) + "-" + s(4) + s(5) + "-" + s(6) + s(7) + "-" +
    s(8) + s(9) + "-" + s(10) + s(11) + s(12) + s(13) + s(14) + s(15)
  );
}

/** Install crypto.randomUUID when the browser withholds it (insecure origin). */
export function installRandomUuidPolyfill(): void {
  if (typeof globalThis === "undefined") return;
  const c = globalThis.crypto as Crypto | undefined;
  // Present already (HTTPS/localhost, or Node): leave the native one alone.
  if (!c || typeof c.randomUUID === "function") return;
  // Without getRandomValues there is no safe source of randomness to fall back
  // on, and inventing one with Math.random would hand out guessable ids. Better
  // to leave the call throwing than to silently weaken id generation.
  if (typeof c.getRandomValues !== "function") return;
  const getRandomValues = (a: Uint8Array) => c.getRandomValues(a);
  Object.defineProperty(c, "randomUUID", {
    value: () => uuidV4FromRandomValues(getRandomValues),
    configurable: true,
    writable: true,
  });
}
