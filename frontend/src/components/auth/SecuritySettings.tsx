// Account security settings: enable or disable authenticator-app
// MFA (TOTP) and surface single-use recovery codes once at enrollment. WebAuthn
// /passkeys are deferred. The QR is rendered from the otpauth:// URL with the
// `qrcode` lib already used for QR nodes; the secret is also shown for manual
// entry. Recovery codes are displayed exactly once and never re-fetchable.

import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/router";
import QRCode from "qrcode";
import { Bell, BellRing, Check, Copy, Download, LogOut, Monitor, ShieldCheck, Trash2 } from "lucide-react";
import { ApiError, type MfaEnrollment, type NotificationType, type SessionInfo } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { disablePush, enablePush, getPushState, type PushState } from "@/lib/push";
import { useAuth } from "@/store/auth";
import { useToast } from "@/components/ui/Toast";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

type Step = "idle" | "enrolling" | "codes";

// The notification types a user can opt into for email. Reactions
// are not notifiable, so they are intentionally absent.
const NOTIFICATION_PREF_TYPES: { type: NotificationType; label: string }[] = [
  { type: "mention", label: "Mentions" },
  { type: "reply", label: "Replies to my comments" },
  { type: "task_assign", label: "Task assignments" },
  { type: "share", label: "Shared with me" },
  { type: "approval_request", label: "Approval requests" },
  { type: "approval_decision", label: "Approval decisions" },
];

/** Build a filename-safe slug from the user's email for the export download. */
function exportFilename(email: string | undefined): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const who = (email ?? "account").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `hycanvas-export-${who}-${stamp}.json`;
}

function errMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const body = e.body as { message?: string } | undefined;
    return body?.message ?? fallback;
  }
  return fallback;
}

// Mounting the stateful body only while open keeps the flow fresh on each open
// (no reset effect needed) and avoids running enrollment hooks when closed.
export function SecuritySettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <SecurityDialog onClose={onClose} />;
}

function SecurityDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const user = useAuth((s) => s.user);
  const bootstrap = useAuth((s) => s.bootstrap);
  const logout = useAuth((s) => s.logout);
  const deleteAccount = useAuth((s) => s.deleteAccount);
  const enabled = !!user?.mfaEnabled;

  const [step, setStep] = useState<Step>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [disableCode, setDisableCode] = useState("");

  // Notification preferences. emailTypes/pushTypes are
  // the per-channel type sets delivered by email and web push (in-app is always
  // on). The device push state drives the "enable on this device" toggle.
  const [emailTypes, setEmailTypes] = useState<NotificationType[] | null>(null);
  const [pushTypes, setPushTypes] = useState<NotificationType[] | null>(null);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [pushState, setPushState] = useState<PushState | null>(null);
  const [togglingPush, setTogglingPush] = useState(false);

  // Active sessions: every signed-in device, with a sign-out-everywhere
  // action that revokes them all server-side and drops this tab to anon.
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [signingOutAll, setSigningOutAll] = useState(false);

  // Account data portability (FR-17).
  const [exporting, setExporting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteCode, setDeleteCode] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Render the otpauth URL to a QR image once enrollment material arrives.
  useEffect(() => {
    if (!enrollment) return;
    let active = true;
    void QRCode.toDataURL(enrollment.otpauthUrl, { margin: 1, width: 200 }).then((url) => {
      if (active) setQrDataUrl(url);
    });
    return () => {
      active = false;
    };
  }, [enrollment]);

  // Load the current notification channel preferences once (FR-13).
  useEffect(() => {
    let active = true;
    void oc
      .notificationPrefs()
      .then((p) => {
        if (!active) return;
        setEmailTypes(p.emailTypes);
        setPushTypes(p.pushTypes);
      })
      .catch(() => {
        if (!active) return;
        setEmailTypes([]);
        setPushTypes([]);
      });
    return () => { active = false; };
  }, []);

  // Resolve this device's push capability/state once (FR-13).
  useEffect(() => {
    let active = true;
    void getPushState()
      .then((s) => { if (active) setPushState(s); })
      .catch(() => { if (active) setPushState("unsupported"); });
    return () => { active = false; };
  }, []);

  // Load the active sessions once.
  useEffect(() => {
    let active = true;
    void oc
      .sessions()
      .then((s) => { if (active) setSessions(s); })
      .catch(() => { if (active) setSessions([]); });
    return () => { active = false; };
  }, []);

  // Revoke every session server-side, then drop this tab to the anon state.
  async function signOutEverywhere() {
    setSigningOutAll(true);
    try {
      await oc.logout(true);
    } catch {
      // Best-effort: even if the request fails, clear local state below.
    } finally {
      await logout(); // resets the store to anon (and clears cookies again)
      await router.replace("/login");
    }
  }

  // Refresh both channel sets from the server (on a save failure rollback).
  function reloadPrefs() {
    void oc
      .notificationPrefs()
      .then((p) => { setEmailTypes(p.emailTypes); setPushTypes(p.pushTypes); })
      .catch(() => undefined);
  }

  async function toggleEmailType(type: NotificationType) {
    if (!emailTypes) return;
    const next = emailTypes.includes(type)
      ? emailTypes.filter((t) => t !== type)
      : [...emailTypes, type];
    setEmailTypes(next); // optimistic
    setSavingPrefs(true);
    try {
      const saved = await oc.setNotificationPrefs({ emailTypes: next });
      setEmailTypes(saved.emailTypes);
    } catch {
      toast.error("Couldn't save notification preferences.");
      reloadPrefs();
    } finally {
      setSavingPrefs(false);
    }
  }

  async function togglePushType(type: NotificationType) {
    if (!pushTypes) return;
    const next = pushTypes.includes(type)
      ? pushTypes.filter((t) => t !== type)
      : [...pushTypes, type];
    setPushTypes(next); // optimistic
    setSavingPrefs(true);
    try {
      const saved = await oc.setNotificationPrefs({ pushTypes: next });
      setPushTypes(saved.pushTypes);
    } catch {
      toast.error("Couldn't save notification preferences.");
      reloadPrefs();
    } finally {
      setSavingPrefs(false);
    }
  }

  // Enable or disable web push on THIS device (subscribe/unsubscribe).
  async function togglePushDevice() {
    setTogglingPush(true);
    try {
      const next = pushState === "subscribed" ? await disablePush() : await enablePush();
      setPushState(next);
      if (next === "denied")
        toast.error("Notifications are blocked. Allow them in your browser settings.");
      else if (next === "unsupported")
        toast.error("This browser does not support push notifications.");
      else if (next === "unconfigured")
        toast.error("Push notifications are not available on this server.");
      else if (next === "subscribed")
        toast.success("Push notifications enabled on this device.");
    } catch {
      toast.error("Couldn't update push notifications.");
      void getPushState().then(setPushState).catch(() => undefined);
    } finally {
      setTogglingPush(false);
    }
  }

  async function startEnroll() {
    setBusy(true);
    setError(null);
    try {
      const e = await oc.enrollMfa();
      setEnrollment(e);
      setStep("enrolling");
    } catch (e) {
      setError(errMessage(e, "Couldn't start setup. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnroll() {
    setBusy(true);
    setError(null);
    try {
      const { recoveryCodes: codes } = await oc.confirmMfa(code.trim());
      setRecoveryCodes(codes);
      setStep("codes");
      await bootstrap(); // refresh user.mfaEnabled
    } catch (e) {
      setError(errMessage(e, "That code wasn't valid. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      await oc.disableMfa(disableCode.trim());
      toast.success("Two-step verification turned off.");
      await bootstrap();
      onClose();
    } catch (e) {
      setError(errMessage(e, "That code wasn't valid. Try again."));
    } finally {
      setBusy(false);
    }
  }

  function copyCodes() {
    void navigator.clipboard?.writeText(recoveryCodes.join("\n"));
    toast.success("Recovery codes copied.");
  }

  // Fetch the export bundle and trigger a client-side JSON download.
  async function downloadData() {
    setExporting(true);
    setError(null);
    try {
      const bundle = await oc.exportAccount();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = exportFilename(user?.email);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Your data export has started downloading.");
    } catch (e) {
      setError(errMessage(e, "Couldn't export your data. Please try again."));
    } finally {
      setExporting(false);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteAccount({
        password: deletePassword,
        code: enabled ? deleteCode.trim() || undefined : undefined,
      });
      // The store dropped us to anon; leave the app for the home/login page.
      await router.replace("/");
    } catch (e) {
      setDeleteError(errMessage(e, "Couldn't delete the account. Check your credentials."));
      setDeleting(false);
    }
  }

  return (
    <>
    <Modal open onClose={onClose} title="Security" width="w-[28rem]">
      <div className="flex items-start gap-3 rounded-xl bg-neutral-50 p-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
          <ShieldCheck size={18} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-neutral-900">Two-step verification</p>
          <p className="mt-0.5 text-xs text-neutral-500">
            Add a code from your authenticator app when you sign in.{" "}
            {enabled ? "Currently on." : "Currently off."}
          </p>
        </div>
      </div>

      {error && (
        <div role="alert" className="mt-4 rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Enabled -> offer disable with a code challenge. */}
      {enabled && step !== "codes" && (
        <div className="mt-4 flex flex-col gap-3">
          <Input
            label="Enter a code to turn it off"
            placeholder="123456 or a recovery code"
            value={disableCode}
            onChange={(e) => setDisableCode(e.target.value)}
            autoComplete="one-time-code"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button variant="danger" disabled={busy || !disableCode} onClick={() => void disable()}>
              {busy ? "Working…" : "Turn off"}
            </Button>
          </div>
        </div>
      )}

      {/* Disabled + idle -> start enrollment. */}
      {!enabled && step === "idle" && (
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button disabled={busy} onClick={() => void startEnroll()}>
            {busy ? "Starting…" : "Set up"}
          </Button>
        </div>
      )}

      {/* Enrolling -> show QR + secret, confirm with a code. */}
      {!enabled && step === "enrolling" && enrollment && (
        <div className="mt-4 flex flex-col gap-4">
          <p className="text-sm text-neutral-600">
            Scan this with your authenticator app, then enter the 6-digit code it shows.
          </p>
          <div className="flex items-center gap-4">
            {qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- data URL, no remote asset
              <img src={qrDataUrl} alt="Authenticator QR code" className="h-40 w-40 rounded-lg border border-neutral-200" />
            ) : (
              <div className="grid h-40 w-40 place-items-center rounded-lg border border-neutral-200 text-xs text-neutral-400">
                Generating…
              </div>
            )}
            <div className="min-w-0">
              <p className="text-xs font-medium text-neutral-500">Or enter this key manually</p>
              <code className="mt-1 block break-all rounded-lg bg-neutral-50 px-2 py-1.5 text-xs text-neutral-800">
                {enrollment.secret}
              </code>
            </div>
          </div>
          <Input
            label="Code from your app"
            placeholder="123456"
            inputMode="numeric"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button disabled={busy || !code} onClick={() => void confirmEnroll()}>
              {busy ? "Verifying…" : "Verify"}
            </Button>
          </div>
        </div>
      )}

      {/* Codes -> show recovery codes once, require acknowledgement. */}
      {step === "codes" && (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-sm text-neutral-600">
            Save these recovery codes somewhere safe. Each one works once if you lose your
            authenticator. They will not be shown again.
          </p>
          <ul className="grid grid-cols-2 gap-1.5 rounded-xl bg-neutral-50 p-3 font-mono text-sm text-neutral-800">
            {recoveryCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <button
            type="button"
            onClick={copyCodes}
            className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-brand-700 hover:underline"
          >
            <Copy size={14} /> Copy codes
          </button>
          <label className="flex items-start gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5"
            />
            I have saved these recovery codes.
          </label>
          <div className="flex justify-end">
            <Button disabled={!acknowledged} onClick={onClose}>
              <Check size={16} /> Done
            </Button>
          </div>
        </div>
      )}

      {/* Notification preferences: per-type email and
          web-push toggles plus a per-device push enable. In-app notifications
          are always on; these control the email and push channels. */}
      {step !== "enrolling" && step !== "codes" && (
        <div className="mt-6 border-t border-neutral-200 pt-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-neutral-900">
            <Bell size={15} /> Notifications
          </p>
          <p className="mt-0.5 text-xs text-neutral-500">
            In-app notifications are always on. Choose what also emails or pushes to you.
          </p>

          {/* Per-device push enable (subscribes/unsubscribes this browser). */}
          <div className="mt-3 flex items-start gap-3 rounded-xl bg-neutral-50 p-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
              <BellRing size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-neutral-800">Push on this device</p>
              <p className="mt-0.5 text-xs text-neutral-500">
                {pushState === null
                  ? "Checking…"
                  : pushState === "unsupported"
                    ? "This browser does not support push notifications."
                    : pushState === "unconfigured"
                      ? "Push notifications are not available on this server."
                      : pushState === "denied"
                        ? "Blocked. Allow notifications in your browser settings."
                        : pushState === "subscribed"
                          ? "Enabled on this device."
                          : "Get notified even when HyCanvas is closed."}
              </p>
            </div>
            {(pushState === "default" || pushState === "subscribed") && (
              <Button
                variant={pushState === "subscribed" ? "ghost" : "primary"}
                disabled={togglingPush}
                onClick={() => void togglePushDevice()}
              >
                {togglingPush
                  ? "Working…"
                  : pushState === "subscribed"
                    ? "Disable"
                    : "Enable"}
              </Button>
            )}
          </div>

          {/* Per-type channel matrix: Email + Push columns. */}
          <div className="mt-3">
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 gap-y-2 text-sm">
              <span />
              <span className="text-xs font-medium text-neutral-500">Email</span>
              <span className="text-xs font-medium text-neutral-500">Push</span>
              {NOTIFICATION_PREF_TYPES.map(({ type, label }) => (
                <Fragment key={type}>
                  <span className="text-neutral-700">{label}</span>
                  <input
                    type="checkbox"
                    aria-label={`Email: ${label}`}
                    className="justify-self-center"
                    disabled={emailTypes === null || savingPrefs}
                    checked={!!emailTypes?.includes(type)}
                    onChange={() => void toggleEmailType(type)}
                  />
                  <input
                    type="checkbox"
                    aria-label={`Push: ${label}`}
                    className="justify-self-center"
                    disabled={
                      pushTypes === null ||
                      savingPrefs ||
                      pushState !== "subscribed"
                    }
                    checked={!!pushTypes?.includes(type)}
                    onChange={() => void togglePushType(type)}
                  />
                </Fragment>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Active sessions: list signed-in devices and offer a single
          sign-out-everywhere. Hidden during the focused enrollment flow. */}
      {step !== "enrolling" && step !== "codes" && (
        <div className="mt-6 border-t border-neutral-200 pt-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-neutral-900">
            <Monitor size={15} /> Active sessions
          </p>
          <p className="mt-0.5 text-xs text-neutral-500">
            Devices currently signed in to your account.
          </p>
          {sessions === null ? (
            <p className="mt-3 text-xs text-neutral-400">Loading…</p>
          ) : sessions.length === 0 ? (
            <p className="mt-3 text-xs text-neutral-400">No other active sessions.</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {sessions.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-3 rounded-lg bg-neutral-50 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 truncate text-neutral-700">
                    {s.device || "Unknown device"}
                    {s.ip ? ` · ${s.ip}` : ""}
                  </span>
                  <span className="shrink-0 text-xs text-neutral-400">
                    {new Date(s.lastSeenAt).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3">
            <Button
              variant="ghost"
              disabled={signingOutAll}
              onClick={() => void signOutEverywhere()}
            >
              <LogOut size={16} /> {signingOutAll ? "Signing out…" : "Sign out everywhere"}
            </Button>
          </div>
        </div>
      )}

      {/* Your data: export + account deletion (FR-17). Hidden during the
          enrollment / recovery-codes steps so that flow stays focused. */}
      {step !== "enrolling" && step !== "codes" && (
        <div className="mt-6 border-t border-neutral-200 pt-5">
          <p className="text-sm font-semibold text-neutral-900">Your data</p>
          <p className="mt-0.5 text-xs text-neutral-500">
            Download everything in your account, or permanently delete it.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="ghost" disabled={exporting} onClick={() => void downloadData()}>
              <Download size={16} /> {exporting ? "Preparing…" : "Download my data"}
            </Button>
            <Button variant="danger" onClick={() => setConfirmingDelete(true)}>
              <Trash2 size={16} /> Delete account
            </Button>
          </div>
        </div>
      )}
    </Modal>

    {/* Re-authenticated, irreversible account deletion (FR-17). A dedicated
        modal so the confirmation is deliberate and the password never lingers. */}
    {confirmingDelete && (
      <Modal open onClose={() => setConfirmingDelete(false)} title="Delete account" width="w-[26rem]">
        <p className="text-sm text-neutral-600">
          This permanently deletes your account and any workspaces only you belong to, including
          their designs. Workspaces you share with others stay, and you are removed from them.
          This cannot be undone.
        </p>
        {deleteError && (
          <div role="alert" className="mt-4 rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
            {deleteError}
          </div>
        )}
        <div className="mt-4 flex flex-col gap-3">
          <Input
            label="Confirm your password"
            type="password"
            value={deletePassword}
            onChange={(e) => setDeletePassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
          />
          {enabled && (
            <Input
              label="Authentication code"
              placeholder="123456 or a recovery code"
              value={deleteCode}
              onChange={(e) => setDeleteCode(e.target.value)}
              autoComplete="one-time-code"
            />
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={deleting || !deletePassword || (enabled && !deleteCode)}
              onClick={() => void confirmDelete()}
            >
              {deleting ? "Deleting…" : "Delete account"}
            </Button>
          </div>
        </div>
      </Modal>
    )}
    </>
  );
}
