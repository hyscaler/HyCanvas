// Shared HyCanvas API client for the web app. Uses httpOnly cookie auth
// (credentials: "include"), so the SPA never handles tokens directly.

import { HyCanvasClient } from "@hc/sdk";

const baseUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8005/api";

export const oc = new HyCanvasClient({ baseUrl, credentials: "include" });

/** Origin the backend serves from (without the /api suffix). Empty in the
 *  same-origin dist build. Used to resolve relative asset content URLs. */
export const apiOrigin = baseUrl.replace(/\/api\/?$/, "");

/** Full URL to begin a social sign-in flow (a browser redirect, not a fetch:
 *  the backend sets state cookies and 302s to the provider). */
export function authStartUrl(providerId: string): string {
  return `${baseUrl}/v1/auth/${providerId}/start`;
}

/** Resolve a (possibly relative) backend URL to something an <img> can load. */
export function resolveAssetUrl(url: string): string {
  if (/^https?:\/\//.test(url)) return url;
  return `${apiOrigin}${url}`;
}

/** Route a stock image through our backend proxy so it loads from our origin
 *  (CORS-clean) and can be exported from the canvas without tainting it. */
export function stockProxyUrl(sourceUrl: string): string {
  return `${apiOrigin}/api/v1/stock/proxy?url=${encodeURIComponent(sourceUrl)}`;
}
