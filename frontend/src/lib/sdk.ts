// Shared HyCanvas API client for the web app. Uses httpOnly cookie auth
// (credentials: "include"), so the SPA never handles tokens directly.

import { HyCanvasClient, type UploadedAsset } from "@hc/sdk";

const baseUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8005/api";

export const oc = new HyCanvasClient({ baseUrl, credentials: "include" });

/** Upload one asset with byte-level progress. Same endpoint and JSON shape as
 *  `oc.uploadAsset`, but via XMLHttpRequest so the caller can show a real upload
 *  percentage (fetch has no upload-progress events). Cookie auth. On a 401 it
 *  falls back to the fetch client, which transparently refreshes the session. */
export function uploadAssetWithProgress(
  workspaceId: string,
  input: { filename: string; dataBase64: string; folderId?: string | null; thumbnail?: string },
  onProgress?: (pct: number) => void,
): Promise<UploadedAsset> {
  return new Promise<UploadedAsset>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${baseUrl}/v1/workspaces/${workspaceId}/assets`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          if (onProgress) onProgress(100);
          resolve(JSON.parse(xhr.responseText) as UploadedAsset);
        } catch {
          reject(new Error("Upload succeeded but the response was unreadable."));
        }
      } else if (xhr.status === 401) {
        // Session likely needs a refresh; the fetch client handles that for us.
        oc.uploadAsset(workspaceId, input).then(resolve, reject);
      } else {
        const err = new Error(`Upload failed (${xhr.status}).`) as Error & { status?: number };
        err.status = xhr.status;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.send(JSON.stringify(input));
  });
}

/** Origin the backend serves from (without the /api suffix). Empty in the
 *  same-origin dist build. Used to resolve relative asset content URLs. */
export const apiOrigin = baseUrl.replace(/\/api\/?$/, "");

/** Full URL to begin a social sign-in flow (a browser redirect, not a fetch:
 *  the backend sets state cookies and 302s to the provider). */
export function authStartUrl(providerId: string): string {
  return `${baseUrl}/v1/auth/${providerId}/start`;
}

/** Full URL to begin connecting an SSO identity to the signed-in account (a
 *  browser redirect, not a fetch). The backend binds the session user into the
 *  signed state and returns to /settings?sso=connected|error. */
export function ssoLinkUrl(): string {
  return `${baseUrl}/v1/auth/oidc/link`;
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
