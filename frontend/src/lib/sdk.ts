// Shared HyCanvas API client for the web app. Uses httpOnly cookie auth
// (credentials: "include"), so the SPA never handles tokens directly.

import { ApiError, HyCanvasClient, type UploadedAsset } from "@hc/sdk";
import { CodedError } from "./errors";

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
    // Protocol token, not UI text: translating a header NAME produces an
    // illegal token and setRequestHeader throws (i18n-ignore).
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
          reject(new CodedError("errors.upload_response_unreadable", "Upload succeeded but the response was unreadable."));
        }
      } else if (xhr.status === 401) {
        // Session likely needs a refresh; the fetch client handles that for us.
        oc.uploadAsset(workspaceId, input).then(resolve, reject);
      } else {
        // CodedError so the toast translates. A problem+json `code` from the
        // server (quota, membership) becomes the translation key; the English
        // detail is the fallback message. `status`/`detail` stay attached
        // because callers word quota errors from the problem+json detail.
        let detail: string | undefined;
        let code: string | undefined;
        try {
          const body = JSON.parse(xhr.responseText) as { detail?: string; code?: string };
          detail = body.detail;
          code = body.code;
        } catch {
          /* non-JSON error body */
        }
        const err = new CodedError(
          code ? `errors.api_${code}` : "errors.upload_failed_status",
          detail || `Upload failed (${xhr.status}).`,
          { status: xhr.status },
        ) as CodedError & { status?: number; detail?: string };
        err.status = xhr.status;
        err.detail = detail;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new CodedError("errors.upload_network_error", "Network error during upload."));
    xhr.send(JSON.stringify(input));
  });
}

/** Origin the backend serves from (without the /api suffix). Empty in the
 *  same-origin dist build. Used to resolve relative asset content URLs. */
export const apiOrigin = baseUrl.replace(/\/api\/?$/, "");

/** Send a Blob to a direct-upload grant's target with byte-level progress:
 *  an S3 POST-policy form or the API's raw-body streaming PUT. */
/** How much of a file goes in one request on the api-put leg.
 *
 *  A CDN in front of the instance caps a single request body long before the
 *  server sees it: Cloudflare rejects anything over 100 MB on its Free, Pro and
 *  Business plans, which is why a ~300 MB upload used to fail with a 413 that no
 *  server setting could lift. 8 MiB keeps every request far below that and any
 *  other cap we are likely to meet, at ~38 requests for a 300 MB file. */
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/** How many times to re-sync and retry after a failed chunk before giving up. */
const CHUNK_RETRIES = 3;

/** Split an api-put grant URL into its path and token. The URL is relative in
 *  the same-origin dist build and absolute when BACKEND_PUBLIC_URL is set. */
function splitGrantUrl(uploadUrl: string): { base: string; query: string } {
  const i = uploadUrl.indexOf("?");
  const path = i < 0 ? uploadUrl : uploadUrl.slice(0, i);
  const query = i < 0 ? "" : uploadUrl.slice(i);
  return { base: /^https?:\/\//.test(path) ? path : `${apiOrigin}${path}`, query };
}

/** Ask the server how many bytes of this upload it already holds. */
async function readUploadOffset(base: string, query: string): Promise<number> {
  const res = await fetch(`${base}/offset${query}`, { credentials: "include" });
  if (!res.ok) throw new CodedError("errors.upload_offset_unreadable", "Could not resume the upload.");
  const body = (await res.json()) as { receivedBytes?: number };
  return body.receivedBytes ?? 0;
}

/** PATCH one chunk at `offset`; resolves with the server's new offset. */
function sendChunk(
  base: string,
  query: string,
  offset: number,
  part: Blob,
  total: number,
  onProgress?: (pct: number) => void,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PATCH", `${base}${query}`);
    xhr.withCredentials = true;
    // Protocol token, not UI text (i18n-ignore).
    xhr.setRequestHeader("Upload-Offset", String(offset));
    xhr.upload.onprogress = (e) => {
      // Progress is over the WHOLE file, not this chunk, or the bar would
      // restart on every part.
      if (e.lengthComputable && onProgress && total > 0) {
        onProgress(Math.min(100, Math.round(((offset + e.loaded) / total) * 100)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body = JSON.parse(xhr.responseText) as { receivedBytes?: number };
          resolve(body.receivedBytes ?? offset + part.size);
        } catch {
          resolve(offset + part.size);
        }
        return;
      }
      // A 409 is not a failure: the server is at a different offset (a earlier
      // chunk was retried, or a connection dropped mid-write). Report where it
      // is so the caller resumes from there.
      const err = new CodedError("errors.upload_chunk_failed", "Part of the upload failed.") as CodedError & { status?: number; serverOffset?: number };
      err.status = xhr.status;
      // Protocol token, not UI text (i18n-ignore).
      const at = Number(xhr.getResponseHeader("Upload-Offset"));
      if (Number.isFinite(at)) err.serverOffset = at;
      reject(err);
    };
    xhr.onerror = () => reject(new CodedError("errors.upload_network_error", "Network error during upload."));
    xhr.send(part);
  });
}

/** Send a file to an api-put grant as a sequence of appends.
 *
 *  Every request is one chunk, so no single body approaches a CDN's limit. A
 *  dropped connection costs one chunk, not the whole upload: the client re-reads
 *  the server's offset and continues from there. */
async function sendChunked(uploadUrl: string, blob: Blob, onProgress?: (pct: number) => void): Promise<void> {
  const { base, query } = splitGrantUrl(uploadUrl);
  let offset = 0;
  let retries = 0;
  while (offset < blob.size) {
    const end = Math.min(offset + UPLOAD_CHUNK_BYTES, blob.size);
    try {
      offset = await sendChunk(base, query, offset, blob.slice(offset, end), blob.size, onProgress);
      retries = 0;
    } catch (e) {
      const at = (e as { serverOffset?: number }).serverOffset;
      if (typeof at === "number" && at !== offset) {
        offset = at; // resync and continue; not a retry
        continue;
      }
      if (retries++ >= CHUNK_RETRIES) throw e;
      offset = await readUploadOffset(base, query);
    }
  }
  if (onProgress) onProgress(100);
}

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
      const err = new CodedError("errors.upload_failed_status", `Upload failed (${xhr.status}).`) as CodedError & { status?: number };
      err.status = xhr.status;
      reject(err);
    };
    xhr.onerror = () => reject(new CodedError("errors.upload_network_error", "Network error during upload."));
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
    // The api-put leg goes through the API (and therefore any CDN in front of
    // it), so it is sent as chunks. The s3-post leg goes straight to the bucket
    // and is bounded only by the POST policy, so it stays a single request.
    if (grant.kind === "api-put") await sendChunked(grant.uploadUrl ?? "", file, onProgress);
    else await sendToGrant(grant, file, onProgress);
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

/** Resolve a (possibly relative) backend URL to something an <img> can load.
 *  Only server-relative paths get the origin prefix: a pasted or dropped image
 *  lives in the document as a `data:` URL (and previews may hand in `blob:`),
 *  and prefixing those produced an unparseable URL, so every fetch consumer
 *  (background removal, export) failed on exactly the images people paste in. */
export function resolveAssetUrl(url: string): string {
  if (/^(https?:\/\/|data:|blob:)/.test(url)) return url;
  return `${apiOrigin}${url}`;
}

/** Route a stock image through our backend proxy so it loads from our origin
 *  (CORS-clean) and can be exported from the canvas without tainting it. */
export function stockProxyUrl(sourceUrl: string): string {
  return `${apiOrigin}/api/v1/stock/proxy?url=${encodeURIComponent(sourceUrl)}`;
}
