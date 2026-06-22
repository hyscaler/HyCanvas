// SSRF guard for server-side URL import. Validates an
// import URL's scheme and host before the worker fetches it: rejects non-HTTP
// schemes, localhost, and private/reserved IP literals, and (optionally)
// enforces a host allowlist. URL parsing is done without the WHATWG `URL`
// global so this stays lib-free and pure.
//
// NOTE: a hostname that resolves via DNS to a private IP must be re-checked at
// fetch time (after resolution) by the egress layer; this validates the literal
// authority only.

export interface ParsedUrl {
  scheme: string;
  host: string; // lowercased, no brackets/port/userinfo
  port?: number;
}

/** Parse scheme and host from a URL string, or null if it is not absolute. */
export function parseUrl(url: string): ParsedUrl | null {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]+)/.exec(url.trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  let authority = m[2];
  const at = authority.lastIndexOf("@");
  if (at >= 0) authority = authority.slice(at + 1); // drop userinfo
  let host: string;
  let port: number | undefined;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) return null;
    host = authority.slice(1, close);
    const rest = authority.slice(close + 1);
    if (rest.startsWith(":")) port = Number(rest.slice(1)) || undefined;
  } else {
    const colon = authority.indexOf(":");
    if (colon >= 0) {
      host = authority.slice(0, colon);
      port = Number(authority.slice(colon + 1)) || undefined;
    } else {
      host = authority;
    }
  }
  return { scheme, host: host.toLowerCase(), port };
}

function ipv4Parts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

/** Whether an IP literal (v4 or v6) is private, loopback, link-local, or reserved. */
export function isPrivateIp(host: string): boolean {
  const v4 = ipv4Parts(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // loopback
    if (a === 0) return true; // "this" network
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // multicast/reserved/broadcast
    return false;
  }
  // IPv6 literals
  if (host.includes(":")) {
    const h = host.replace(/^\[|\]$/g, "");
    if (h === "::1" || h === "::") return true; // loopback / unspecified
    const lead = h.toLowerCase();
    if (lead.startsWith("fe8") || lead.startsWith("fe9") || lead.startsWith("fea") || lead.startsWith("feb")) return true; // fe80::/10 link-local
    if (lead.startsWith("fc") || lead.startsWith("fd")) return true; // fc00::/7 unique-local
    if (lead.startsWith("::ffff:")) {
      const mapped = lead.slice(7);
      return ipv4Parts(mapped) ? isPrivateIp(mapped) : false; // IPv4-mapped
    }
    return false;
  }
  return false;
}

export interface SsrfOptions {
  allowedSchemes?: string[]; // default http, https
  /** If set, the host must equal or be a subdomain of an allowlisted host. */
  allowlist?: string[];
}

export interface UrlValidation {
  ok: boolean;
  reason?: string;
  parsed?: ParsedUrl;
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

/** Validate an import URL against the SSRF policy (FR-12). */
export function validateImportUrl(url: string, opts: SsrfOptions = {}): UrlValidation {
  const parsed = parseUrl(url);
  if (!parsed) return { ok: false, reason: "invalid or non-absolute URL" };

  const schemes = opts.allowedSchemes ?? ["http", "https"];
  if (!schemes.includes(parsed.scheme)) return { ok: false, reason: `scheme not allowed: ${parsed.scheme}`, parsed };

  if (!parsed.host) return { ok: false, reason: "empty host", parsed };
  if (BLOCKED_HOSTNAMES.has(parsed.host) || parsed.host.endsWith(".localhost") || parsed.host.endsWith(".local")) {
    return { ok: false, reason: "loopback/local hostname blocked", parsed };
  }
  if (isPrivateIp(parsed.host)) return { ok: false, reason: "private or reserved IP blocked", parsed };

  if (opts.allowlist && opts.allowlist.length > 0) {
    const ok = opts.allowlist.some((h) => {
      const host = h.toLowerCase();
      return parsed.host === host || parsed.host.endsWith(`.${host}`);
    });
    if (!ok) return { ok: false, reason: "host not in allowlist", parsed };
  }

  return { ok: true, parsed };
}
