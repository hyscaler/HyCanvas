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
  // Format each byte directly. Every byte keeps its own value, so no arithmetic
  // touches the random data and the distribution is exactly what the CSPRNG gave.
  const h = (i: number) => b[i].toString(16).padStart(2, "0");
  return (
    h(0) + h(1) + h(2) + h(3) + "-" + h(4) + h(5) + "-" + h(6) + h(7) + "-" +
    h(8) + h(9) + "-" + h(10) + h(11) + h(12) + h(13) + h(14) + h(15)
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
