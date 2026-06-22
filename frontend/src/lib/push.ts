// Web push subscription helper for the browser. Registers the
// service worker (/sw.js, shipped from public/), requests Notification
// permission, fetches the public VAPID key from the backend (so no build-time
// env is needed), subscribes via the PushManager, and POSTs the subscription to
// the API. Also exposes the current device state and an unsubscribe path. Every
// entry point guards for unsupported browsers and denied permission so callers
// get a friendly status rather than a thrown error.

import { oc } from "@/lib/sdk";

/** The push capability state for this device, surfaced in the settings UI. */
export type PushState =
  | "unsupported" // no service worker / PushManager / Notification API
  | "unconfigured" // server has no VAPID keys, so push is disabled
  | "denied" // the user blocked notifications in the browser
  | "subscribed" // an active subscription exists on this device
  | "default"; // supported + permitted-or-promptable, not yet subscribed

/** True when the browser exposes everything web push needs. */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Decode a URL-safe base64 VAPID key to the ArrayBuffer-backed bytes the
 *  PushManager applicationServerKey expects (a plain ArrayBuffer, not a
 *  SharedArrayBuffer-backed view, so the BufferSource type is satisfied). */
function urlBase64ToUint8Array(base64: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return buffer;
}

/** Register the service worker once and return its ready registration. */
async function getRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/sw.js");
  if (existing) return existing;
  await navigator.serviceWorker.register("/sw.js");
  return navigator.serviceWorker.ready;
}

/** Map a PushSubscription to the API body (endpoint + base64 keys). */
function toApiSubscription(
  sub: PushSubscription,
): { endpoint: string; keys: { p256dh: string; auth: string } } | null {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

/**
 * Resolve the current push state for this device without prompting: unsupported,
 * unconfigured (no server key), denied, subscribed, or default (can enable).
 */
export async function getPushState(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";
  let key: string | null = null;
  try {
    key = (await oc.pushVapidPublicKey()).key;
  } catch {
    return "unconfigured";
  }
  if (!key) return "unconfigured";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) return "subscribed";
  } catch {
    /* fall through to default */
  }
  return "default";
}

/**
 * Enable push on this device: register the SW, request permission, fetch the
 * VAPID key, subscribe, and store the subscription server-side. Returns the
 * resulting state. Throws only on an unexpected failure; "denied"/"unsupported"/
 * "unconfigured" are returned as states so the caller can message the user.
 */
export async function enablePush(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";
  const { key } = await oc.pushVapidPublicKey();
  if (!key) return "unconfigured";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return permission === "denied" ? "denied" : "default";
  }

  const reg = await getRegistration();
  // Reuse an existing subscription if present, else create one.
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }
  const api = toApiSubscription(sub);
  if (!api) return "default";
  await oc.pushSubscribe(api);
  return "subscribed";
}

/**
 * Disable push on this device: unsubscribe from the PushManager and remove the
 * subscription server-side. Best-effort and idempotent; returns the new state.
 */
export async function disablePush(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";
  try {
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe().catch(() => undefined);
      await oc.pushUnsubscribe(endpoint).catch(() => undefined);
    }
  } catch {
    /* nothing to remove */
  }
  return (await getPushState()) === "denied" ? "denied" : "default";
}
