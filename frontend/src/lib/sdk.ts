// Shared HyCanvas API client for the web app. Uses httpOnly cookie auth
// (credentials: "include"), so the SPA never handles tokens directly.

import { ApiError, HyCanvasClient, type UploadedAsset } from "@hc/sdk";

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
        const err = new Error(`Upload failed (${xhr.status}).`) as Error & { status?: number; detail?: string };
        err.status = xhr.status;
        // Surface the problem+json detail so callers can word quota errors
        // (workspace cap vs the global account limit) accurately.
        try {
          err.detail = (JSON.parse(xhr.responseText) as { detail?: string }).detail;
        } catch {
          /* non-JSON error body */
        }
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

/** Send a Blob to a direct-upload grant's target with byte-level progress:
 *  an S3 POST-policy form or the API's raw-body streaming PUT. */
function sendToGrant(
  grant: { kind: "s3-post" | "api-put"; uploadUrl?: string; fields?: Record<string, string> },
  blob: Blob,
  onProgress?: (pct: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = grant.uploadUrl ?? "";
    // The api-put URL may be relative when BACKEND_PUBLIC_URL is unset (the
    // same-origin dist build); the S3 URL is always absolute.
    const absolute = /^https?:\/\//.test(url) ? url : `${apiOrigin}${url}`;
    xhr.open(grant.kind === "s3-post" ? "POST" : "PUT", absolute);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        if (onProgress) onProgress(100);
        resolve();
        return;
      }
      const err = new Error(`Direct upload failed (${xhr.status}).`) as Error & { status?: number };
      err.status = xhr.status;
      reject(err);
    };
    xhr.onerror = () => reject(new Error("Network error during direct upload."));
    if (grant.kind === "s3-post") {
      // POST-policy multipart: the signed fields first, the file LAST (S3
      // ignores anything after the file part).
      const form = new FormData();
      for (const [k, v] of Object.entries(grant.fields ?? {})) form.append(k, v);
      form.append("file", blob);
      xhr.send(form);
    } else {
      xhr.send(blob);
    }
  });
}

/** Upload a file as a direct (presigned) upload: init -> raw bytes to storage
 *  -> complete. No base64, no whole-file JSON body; on S3/MinIO deployments
 *  with direct uploads enabled the bytes bypass the API entirely. Falls back
 *  to the legacy base64 endpoint when the server predates the direct routes
 *  (404 on init) so a new client keeps working against an old binary. */
export async function directUploadWithProgress(
  workspaceId: string,
  file: Blob,
  input: { filename: string; folderId?: string | null; thumbnail?: string },
  onProgress?: (pct: number) => void,
): Promise<UploadedAsset> {
  let grant;
  try {
    grant = await oc.initDirectUpload(workspaceId, {
      filename: input.filename,
      byteSize: file.size,
      folderId: input.folderId,
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return legacyUpload(workspaceId, file, input, onProgress);
    throw e;
  }
  try {
    await sendToGrant(grant, file, onProgress);
  } catch (e) {
    // A failed s3-post leg is almost always a bucket CORS/reachability gap:
    // surface it in the console for the operator, but keep the user moving by
    // falling back to the legacy in-band upload for this file.
    if (grant.kind === "s3-post") {
      console.warn("Direct-to-bucket upload failed (bucket CORS/public URL?); falling back to in-band upload.", e);
      return legacyUpload(workspaceId, file, input, onProgress);
    }
    throw e;
  }
  return oc.completeDirectUpload(grant.id, { thumbnail: input.thumbnail });
}

/** The pre-direct-upload path: base64 JSON via XHR (kept as the fallback). */
async function legacyUpload(
  workspaceId: string,
  file: Blob,
  input: { filename: string; folderId?: string | null; thumbnail?: string },
  onProgress?: (pct: number) => void,
): Promise<UploadedAsset> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("Could not read the file."));
    fr.readAsDataURL(file);
  });
  return uploadAssetWithProgress(
    workspaceId,
    { filename: input.filename, dataBase64: dataUrl.split(",")[1] ?? "", folderId: input.folderId, thumbnail: input.thumbnail },
    onProgress,
  );
}

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
