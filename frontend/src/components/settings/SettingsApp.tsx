// Account settings page (replaces the old Security modal). One destination with
// three sections: Account (profile + your data), Security (2FA + sessions), and
// Notifications (email/push preferences). Reached from the avatar menu's single
// "Settings" entry.

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/router";
import QRCode from "qrcode";
import { Bell, BellRing, Check, ChevronLeft, Copy, Download, KeyRound, LogOut, Moon, MonitorSmartphone, ShieldCheck, Sun, Trash2, User as UserIcon } from "lucide-react";
import { ApiError, type MfaEnrollment, type NotificationType, type SessionInfo, type TimeFormat, type WeekStart } from "@hc/sdk";
import { oc, ssoLinkUrl } from "@/lib/sdk";
import { browserTimezone } from "@/lib/datetime";
import { getThemePreference, setThemePreference, type ThemePreference } from "@/lib/theme";
import { disablePush, enablePush, getPushState, type PushState } from "@/lib/push";
import { useAuth } from "@/store/auth";
import { useToast } from "@/components/ui/Toast";
import { FullScreenLoader } from "@/components/ui/BrandLoader";
import { Logo } from "@/components/ui/Logo";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";

type Tab = "account" | "security" | "notifications";
type Step = "idle" | "enrolling" | "codes";

const TABS: { id: Tab; label: string; icon: typeof UserIcon }[] = [
  { id: "account", label: "Account", icon: UserIcon },
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "notifications", label: "Notifications", icon: Bell },
];

// A small, friendly set of UI languages. The user's current locale is added if
// it is not already listed, so the select always reflects their value.
const LOCALES: { value: string; label: string }[] = [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "es-ES", label: "Español" },
  { value: "fr-FR", label: "Français" },
  { value: "de-DE", label: "Deutsch" },
  { value: "pt-BR", label: "Português (Brasil)" },
  { value: "hi-IN", label: "हिन्दी" },
  { value: "ja-JP", label: "日本語" },
  { value: "zh-CN", label: "中文 (简体)" },
];

// Clock and week-start preferences. "auto" defers to the chosen language.
const TIME_FORMATS: { value: TimeFormat; label: string }[] = [
  { value: "auto", label: "Automatic (match language)" },
  { value: "12h", label: "12-hour (1:30 PM)" },
  { value: "24h", label: "24-hour (13:30)" },
];
const WEEK_STARTS: { value: WeekStart; label: string }[] = [
  { value: "auto", label: "Automatic (match language)" },
  { value: "sunday", label: "Sunday" },
  { value: "monday", label: "Monday" },
];

// The full IANA zone list from the platform when available (all modern engines),
// with a small fallback for older ones. "" is offered separately as "Automatic".
const TIMEZONE_FALLBACK = [
  "UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Sao_Paulo", "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Moscow",
  "Africa/Johannesburg", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Shanghai",
  "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
];
function timezoneList(): string[] {
  try {
    const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    const zones = sv?.("timeZone");
    if (zones && zones.length) return zones;
  } catch {
    /* fall through to the curated list */
  }
  return TIMEZONE_FALLBACK;
}

const NOTIFICATION_PREF_TYPES: { type: NotificationType; label: string }[] = [
  { type: "mention", label: "Mentions" },
  { type: "reply", label: "Replies to my comments" },
  { type: "task_assign", label: "Task assignments" },
  { type: "share", label: "Shared with me" },
  { type: "approval_request", label: "Approval requests" },
  { type: "approval_decision", label: "Approval decisions" },
];

function exportFilename(email: string | undefined): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const who = (email ?? "account").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `hycanvas-export-${who}-${stamp}.json`;
}

function errMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const body = e.body as { detail?: string; message?: string } | undefined;
    return body?.detail ?? body?.message ?? fallback;
  }
  return fallback;
}

export function SettingsApp() {
  const router = useRouter();
  const toast = useToast();
  const user = useAuth((s) => s.user);
  const setUser = useAuth((s) => s.setUser);
  const bootstrap = useAuth((s) => s.bootstrap);
  const logout = useAuth((s) => s.logout);
  const deleteAccount = useAuth((s) => s.deleteAccount);
  const enabled = !!user?.mfaEnabled;

  // Returning from the SSO connect flow lands on /settings?sso=... ; open the
  // Security tab (where the SSO card lives) so the result is visible. Safe to read
  // window here: this component is client-only (ssr: false).
  const [tab, setTab] = useState<Tab>(() =>
    typeof window !== "undefined" && /[?&]sso=(connected|error)\b/.test(window.location.search) ? "security" : "account",
  );

  // Profile form.
  const [name, setName] = useState(user?.name ?? "");
  const [locale, setLocale] = useState(user?.locale ?? "en-US");
  // The default timezone comes from the browser when the account has none stored.
  const defaultTimezone = user?.timezone || browserTimezone();
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [timeFormat, setTimeFormat] = useState<TimeFormat>(user?.timeFormat ?? "auto");
  const [weekStart, setWeekStart] = useState<WeekStart>(user?.weekStart ?? "auto");
  const [savingProfile, setSavingProfile] = useState(false);
  const localeOptions = useMemo(() => {
    if (!locale || LOCALES.some((l) => l.value === locale)) return LOCALES;
    return [{ value: locale, label: locale }, ...LOCALES];
  }, [locale]);
  const timezoneOptions = useMemo(() => {
    const zones = timezoneList();
    // Keep the user's stored zone selectable even if the platform list omits it.
    return timezone && !zones.includes(timezone) ? [timezone, ...zones] : zones;
  }, [timezone]);
  const profileDirty =
    !!user &&
    (name.trim() !== (user.name ?? "") ||
      locale !== (user.locale ?? "en-US") ||
      timezone !== defaultTimezone ||
      timeFormat !== (user.timeFormat ?? "auto") ||
      weekStart !== (user.weekStart ?? "auto"));

  // MFA enrollment.
  const [step, setStep] = useState<Step>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [disableCode, setDisableCode] = useState("");

  // Notification preferences + this device's push capability.
  const [emailTypes, setEmailTypes] = useState<NotificationType[] | null>(null);
  const [pushTypes, setPushTypes] = useState<NotificationType[] | null>(null);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [pushState, setPushState] = useState<PushState | null>(null);
  const [togglingPush, setTogglingPush] = useState(false);

  // Active sessions.
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [signingOutAll, setSigningOutAll] = useState(false);

  // Single sign-on (OIDC) connection. null until loaded; the card only renders
  // when SSO is configured server-side.
  const [sso, setSso] = useState<{ linked: boolean; configured: boolean } | null>(null);
  const [ssoBusy, setSsoBusy] = useState(false);
  const ssoHandledRef = useRef(false);

  // Data export + account deletion.
  const [exporting, setExporting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteCode, setDeleteCode] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!enrollment) return;
    let active = true;
    void QRCode.toDataURL(enrollment.otpauthUrl, { margin: 1, width: 200 }).then((url) => {
      if (active) setQrDataUrl(url);
    });
    return () => { active = false; };
  }, [enrollment]);

  useEffect(() => {
    let active = true;
    void oc.notificationPrefs()
      .then((p) => { if (active) { setEmailTypes(p.emailTypes); setPushTypes(p.pushTypes); } })
      .catch(() => { if (active) { setEmailTypes([]); setPushTypes([]); } });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void getPushState().then((s) => { if (active) setPushState(s); }).catch(() => { if (active) setPushState("unsupported"); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void oc.sessions().then((s) => { if (active) setSessions(s); }).catch(() => { if (active) setSessions([]); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void oc.oidcIdentity().then((s) => { if (active) setSso(s); }).catch(() => { if (active) setSso({ linked: false, configured: false }); });
    return () => { active = false; };
  }, []);

  // Surface the connect-flow result (the backend redirects to ?sso=connected|error)
  // and strip the param so a refresh doesn't re-toast. The on-mount fetch above
  // already reflects the new linked state, so no optimistic update is needed.
  useEffect(() => {
    if (!router.isReady || ssoHandledRef.current) return;
    const result = router.query.sso;
    if (result !== "connected" && result !== "error") return;
    ssoHandledRef.current = true;
    if (result === "connected") toast.success("Single sign-on connected.");
    else toast.error("Couldn't connect single sign-on. Please try again.");
    const rest = { ...router.query };
    delete rest.sso;
    void router.replace({ pathname: router.pathname, query: rest }, undefined, { shallow: true });
  }, [router, toast]);

  function resetMfaFlow() {
    setStep("idle");
    setEnrollment(null);
    setQrDataUrl(null);
    setCode("");
    setRecoveryCodes([]);
    setAcknowledged(false);
    setError(null);
  }

  async function saveProfile() {
    if (!name.trim()) return;
    setSavingProfile(true);
    try {
      const updated = await oc.updateProfile({ name: name.trim(), locale, timezone, timeFormat, weekStart });
      setUser(updated);
      toast.success("Profile updated.");
    } catch (e) {
      toast.error(errMessage(e, "Couldn't update your profile."));
    } finally {
      setSavingProfile(false);
    }
  }

  async function signOutEverywhere() {
    setSigningOutAll(true);
    try {
      await oc.logout(true);
    } catch {
      /* best-effort */
    } finally {
      await logout();
      await router.replace("/login");
    }
  }

  function connectSso() {
    // A full-page redirect, not a fetch: the backend sets the signed state cookie
    // (binding this session's user) and 302s to the identity provider.
    window.location.assign(ssoLinkUrl());
  }

  async function disconnectSso() {
    setSsoBusy(true);
    try {
      await oc.disconnectOidc();
      setSso((s) => (s ? { ...s, linked: false } : s));
      toast.success("Single sign-on disconnected.");
    } catch (e) {
      // 409 when SSO is the only sign-in method; the API detail explains it.
      toast.error(errMessage(e, "Couldn't disconnect single sign-on."));
    } finally {
      setSsoBusy(false);
    }
  }

  function reloadPrefs() {
    void oc.notificationPrefs().then((p) => { setEmailTypes(p.emailTypes); setPushTypes(p.pushTypes); }).catch(() => undefined);
  }

  async function toggleEmailType(type: NotificationType) {
    if (!emailTypes) return;
    const next = emailTypes.includes(type) ? emailTypes.filter((t) => t !== type) : [...emailTypes, type];
    setEmailTypes(next);
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
    const next = pushTypes.includes(type) ? pushTypes.filter((t) => t !== type) : [...pushTypes, type];
    setPushTypes(next);
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

  async function togglePushDevice() {
    setTogglingPush(true);
    try {
      const next = pushState === "subscribed" ? await disablePush() : await enablePush();
      setPushState(next);
      if (next === "denied") toast.error("Notifications are blocked. Allow them in your browser settings.");
      else if (next === "unsupported") toast.error("This browser does not support push notifications.");
      else if (next === "unconfigured") toast.error("Push notifications are not available on this server.");
      else if (next === "subscribed") toast.success("Push notifications enabled on this device.");
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
      await bootstrap();
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
      setDisableCode("");
      await bootstrap();
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

  async function downloadData() {
    setExporting(true);
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
      toast.error(errMessage(e, "Couldn't export your data. Please try again."));
    } finally {
      setExporting(false);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteAccount({ password: deletePassword, code: enabled ? deleteCode.trim() || undefined : undefined });
      await router.replace("/");
    } catch (e) {
      setDeleteError(errMessage(e, "Couldn't delete the account. Check your credentials."));
      setDeleting(false);
    }
  }

  if (!user) {
    return <FullScreenLoader />;
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-neutral-200 bg-surface/90 px-4 py-2.5 backdrop-blur">
        <button onClick={() => void router.push("/dashboard")} aria-label="Back to dashboard" className="grid h-8 w-8 place-items-center rounded-lg text-neutral-500 hover:bg-neutral-100">
          <ChevronLeft size={20} />
        </button>
        <Logo size={26} />
        <span className="text-sm font-semibold text-neutral-800">Settings</span>
      </header>

      <div className="mx-auto grid max-w-4xl gap-8 px-6 py-10 md:grid-cols-[12rem_1fr]">
        {/* Sub-nav */}
        <nav className="flex gap-1 md:flex-col">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex flex-1 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition md:flex-none ${tab === t.id ? "bg-brand-50 text-brand-ink" : "text-neutral-600 hover:bg-neutral-100"}`}
            >
              <t.icon size={16} className={tab === t.id ? "text-brand-ink" : "text-neutral-400"} />
              {t.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="min-w-0 space-y-6">
          {tab === "account" && (
            <>
              <Card title="Profile" description="Your name, language, and regional preferences across HyCanvas.">
                <div className="flex items-center gap-4">
                  {user.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- user-provided avatar URL
                    <img src={user.avatarUrl} alt="" className="h-14 w-14 rounded-full object-cover" />
                  ) : (
                    <span className="oc-gradient grid h-14 w-14 place-items-center rounded-full text-lg font-bold text-white">
                      {(name || user.email || "?").charAt(0).toUpperCase()}
                    </span>
                  )}
                  <div className="min-w-0 text-sm">
                    <div className="truncate font-semibold text-neutral-800">{user.name || user.email}</div>
                    <div className="truncate text-xs text-neutral-500">{user.email}{user.emailVerified ? "" : " · unverified"}</div>
                  </div>
                </div>
                <div className="mt-5 flex flex-col gap-4">
                  <Input label="Display name" value={name} onChange={(e) => setName(e.target.value)} />
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-neutral-700">
                    Language
                    <select
                      value={locale}
                      onChange={(e) => setLocale(e.target.value)}
                      className="h-11 rounded-xl border border-neutral-200 bg-surface px-3 text-sm text-neutral-800 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                    >
                      {localeOptions.map((l) => (
                        <option key={l.value} value={l.value}>{l.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-neutral-700">
                    Timezone
                    <select
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                      className="h-11 rounded-xl border border-neutral-200 bg-surface px-3 text-sm text-neutral-800 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                    >
                      {timezoneOptions.map((z) => (
                        <option key={z} value={z}>{z.replace(/_/g, " ")}</option>
                      ))}
                    </select>
                    <span className="text-xs font-normal text-neutral-500">
                      Defaults to your browser&rsquo;s timezone. Controls how dates and times are shown to you across HyCanvas.
                    </span>
                  </label>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <label className="flex flex-col gap-1.5 text-sm font-medium text-neutral-700">
                      Time format
                      <select
                        value={timeFormat}
                        onChange={(e) => setTimeFormat(e.target.value as TimeFormat)}
                        className="h-11 rounded-xl border border-neutral-200 bg-surface px-3 text-sm text-neutral-800 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                      >
                        {TIME_FORMATS.map((t) => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1.5 text-sm font-medium text-neutral-700">
                      Week starts on
                      <select
                        value={weekStart}
                        onChange={(e) => setWeekStart(e.target.value as WeekStart)}
                        className="h-11 rounded-xl border border-neutral-200 bg-surface px-3 text-sm text-neutral-800 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                      >
                        {WEEK_STARTS.map((w) => (
                          <option key={w.value} value={w.value}>{w.label}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="flex justify-end border-t border-neutral-100 pt-4">
                    <Button disabled={savingProfile || !profileDirty || !name.trim()} onClick={() => void saveProfile()}>
                      {savingProfile ? "Saving…" : "Save changes"}
                    </Button>
                  </div>
                </div>
              </Card>

              <Card title="Appearance" description="How the HyCanvas interface looks on this device. Your designs are never restyled.">
                <ThemePicker />
              </Card>

              <Card title="Your data" description="Download everything in your account, or permanently delete it.">
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" disabled={exporting} onClick={() => void downloadData()}>
                    <Download size={16} /> {exporting ? "Preparing…" : "Download my data"}
                  </Button>
                  <Button variant="danger" onClick={() => setConfirmingDelete(true)}>
                    <Trash2 size={16} /> Delete account
                  </Button>
                </div>
              </Card>
            </>
          )}

          {tab === "security" && (
            <>
              <Card title="Two-step verification" description="Add a code from your authenticator app each time you sign in.">
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${enabled ? "bg-green-50 text-green-700" : "bg-neutral-100 text-neutral-500"}`}>
                  <ShieldCheck size={13} /> {enabled ? "On" : "Off"}
                </span>

                {error && <div role="alert" className="mt-4 rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">{error}</div>}

                {enabled && step !== "codes" && (
                  <div className="mt-4 flex max-w-sm flex-col gap-3">
                    <Input label="Enter a code to turn it off" placeholder="123456 or a recovery code" value={disableCode} onChange={(e) => setDisableCode(e.target.value)} autoComplete="one-time-code" />
                    <div>
                      <Button variant="danger" disabled={busy || !disableCode} onClick={() => void disable()}>{busy ? "Working…" : "Turn off"}</Button>
                    </div>
                  </div>
                )}

                {!enabled && step === "idle" && (
                  <div className="mt-4">
                    <Button disabled={busy} onClick={() => void startEnroll()}>{busy ? "Starting…" : "Set up two-step verification"}</Button>
                  </div>
                )}

                {!enabled && step === "enrolling" && enrollment && (
                  <div className="mt-4 flex max-w-md flex-col gap-4">
                    <p className="text-sm text-neutral-600">Scan this with your authenticator app, then enter the 6-digit code it shows.</p>
                    <div className="flex items-center gap-4">
                      {qrDataUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- data URL, no remote asset
                        <img src={qrDataUrl} alt="Authenticator QR code" className="h-40 w-40 rounded-lg border border-neutral-200" />
                      ) : (
                        <div className="grid h-40 w-40 place-items-center rounded-lg border border-neutral-200 text-xs text-neutral-400">Generating…</div>
                      )}
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-neutral-500">Or enter this key manually</p>
                        <code className="mt-1 block break-all rounded-lg bg-neutral-50 px-2 py-1.5 text-xs text-neutral-800">{enrollment.secret}</code>
                      </div>
                    </div>
                    <Input label="Code from your app" placeholder="123456" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoFocus />
                    <div className="flex gap-2">
                      <Button variant="ghost" onClick={resetMfaFlow}>Cancel</Button>
                      <Button disabled={busy || !code} onClick={() => void confirmEnroll()}>{busy ? "Verifying…" : "Verify"}</Button>
                    </div>
                  </div>
                )}

                {step === "codes" && (
                  <div className="mt-4 flex max-w-md flex-col gap-3">
                    <p className="text-sm text-neutral-600">Save these recovery codes somewhere safe. Each one works once if you lose your authenticator. They will not be shown again.</p>
                    <ul className="grid grid-cols-2 gap-1.5 rounded-xl bg-neutral-50 p-3 font-mono text-sm text-neutral-800">
                      {recoveryCodes.map((c) => <li key={c}>{c}</li>)}
                    </ul>
                    <button type="button" onClick={copyCodes} className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-brand-ink hover:underline"><Copy size={14} /> Copy codes</button>
                    <label className="flex items-start gap-2 text-sm text-neutral-700">
                      <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-0.5" />
                      I have saved these recovery codes.
                    </label>
                    <div>
                      <Button disabled={!acknowledged} onClick={resetMfaFlow}><Check size={16} /> Done</Button>
                    </div>
                  </div>
                )}
              </Card>

              {sso?.configured && step !== "enrolling" && step !== "codes" && (
                <Card title="Single sign-on" description="Sign in with your organization's identity provider.">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${sso.linked ? "bg-green-50 text-green-700" : "bg-neutral-100 text-neutral-500"}`}>
                      <KeyRound size={13} /> {sso.linked ? "Connected" : "Not connected"}
                    </span>
                    {sso.linked ? (
                      <Button variant="ghost" disabled={ssoBusy} onClick={() => void disconnectSso()}>{ssoBusy ? "Working…" : "Disconnect"}</Button>
                    ) : (
                      <Button onClick={connectSso}>Connect</Button>
                    )}
                  </div>
                  {sso.linked && (
                    <p className="mt-3 text-xs text-neutral-500">Keep a password on your account so you are not locked out if SSO becomes unavailable.</p>
                  )}
                </Card>
              )}

              {step !== "enrolling" && step !== "codes" && (
                <Card title="Active sessions" description="Devices currently signed in to your account.">
                  {sessions === null ? (
                    <p className="text-xs text-neutral-400">Loading…</p>
                  ) : sessions.length === 0 ? (
                    <p className="text-xs text-neutral-400">No other active sessions.</p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {sessions.map((s) => (
                        <li key={s.id} className="flex items-center justify-between gap-3 rounded-lg bg-neutral-50 px-3 py-2 text-sm">
                          <span className="min-w-0 truncate text-neutral-700">{s.device || "Unknown device"}{s.ip ? ` · ${s.ip}` : ""}</span>
                          <span className="shrink-0 text-xs text-neutral-400">{new Date(s.lastSeenAt).toLocaleDateString()}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-4 border-t border-neutral-100 pt-4">
                    <Button variant="ghost" disabled={signingOutAll} onClick={() => void signOutEverywhere()}><LogOut size={16} /> {signingOutAll ? "Signing out…" : "Sign out everywhere"}</Button>
                  </div>
                </Card>
              )}
            </>
          )}

          {tab === "notifications" && (
            <Card title="Notifications" description="In-app notifications are always on. Choose what also emails or pushes to you.">
              <div className="flex items-start gap-3 rounded-xl bg-neutral-50 p-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-ink"><BellRing size={16} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-neutral-800">Push on this device</p>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    {pushState === null ? "Checking…"
                      : pushState === "unsupported" ? "This browser does not support push notifications."
                      : pushState === "unconfigured" ? "Push notifications are not available on this server."
                      : pushState === "denied" ? "Blocked. Allow notifications in your browser settings."
                      : pushState === "subscribed" ? "Enabled on this device."
                      : "Get notified even when HyCanvas is closed."}
                  </p>
                </div>
                {(pushState === "default" || pushState === "subscribed") && (
                  <Button variant={pushState === "subscribed" ? "ghost" : "primary"} disabled={togglingPush} onClick={() => void togglePushDevice()}>
                    {togglingPush ? "Working…" : pushState === "subscribed" ? "Disable" : "Enable"}
                  </Button>
                )}
              </div>

              <div className="mt-5">
                <div className="grid grid-cols-[1fr_3.5rem_3.5rem] items-center gap-y-3 text-sm">
                  <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Notify me about</span>
                  <span className="justify-self-center text-xs font-medium text-neutral-500">Email</span>
                  <span className="justify-self-center text-xs font-medium text-neutral-500">Push</span>
                  {NOTIFICATION_PREF_TYPES.map(({ type, label }) => (
                    <Fragment key={type}>
                      <span className="text-neutral-700">{label}</span>
                      <input type="checkbox" aria-label={`Email: ${label}`} className="h-4 w-4 justify-self-center" disabled={emailTypes === null || savingPrefs} checked={!!emailTypes?.includes(type)} onChange={() => void toggleEmailType(type)} />
                      <input type="checkbox" aria-label={`Push: ${label}`} className="h-4 w-4 justify-self-center" disabled={pushTypes === null || savingPrefs || pushState !== "subscribed"} checked={!!pushTypes?.includes(type)} onChange={() => void togglePushType(type)} />
                    </Fragment>
                  ))}
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>

      {confirmingDelete && (
        <Modal open onClose={() => setConfirmingDelete(false)} title="Delete account" width="w-[26rem]">
          <p className="text-sm text-neutral-600">
            This permanently deletes your account and any workspaces only you belong to, including their designs.
            Workspaces you share with others stay, and you are removed from them. This cannot be undone.
          </p>
          {deleteError && <div role="alert" className="mt-4 rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">{deleteError}</div>}
          <div className="mt-4 flex flex-col gap-3">
            <Input label="Confirm your password" type="password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} autoComplete="current-password" autoFocus />
            {enabled && <Input label="Authentication code" placeholder="123456 or a recovery code" value={deleteCode} onChange={(e) => setDeleteCode(e.target.value)} autoComplete="one-time-code" />}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>Cancel</Button>
              <Button variant="danger" disabled={deleting || !deletePassword || (enabled && !deleteCode)} onClick={() => void confirmDelete()}>{deleting ? "Deleting…" : "Delete account"}</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Appearance: the app-chrome theme choice (system / light / dark), applied
// instantly and remembered per device via lib/theme.ts.
function ThemePicker() {
  const [pref, setPref] = useState<ThemePreference>(() => getThemePreference());
  const options: { value: ThemePreference; label: string; icon: typeof Sun; hint: string }[] = [
    { value: "system", label: "System", icon: MonitorSmartphone, hint: "Follow this device" },
    { value: "light", label: "Light", icon: Sun, hint: "Always light" },
    { value: "dark", label: "Dark", icon: Moon, hint: "Always dark" },
  ];
  return (
    <div role="radiogroup" aria-label="Interface theme" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {options.map((o) => {
        const active = pref === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => {
              setPref(o.value);
              setThemePreference(o.value);
            }}
            className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm transition ${
              active
                ? "border-brand-500 bg-brand-50 text-brand-ink ring-1 ring-brand-200"
                : "border-neutral-200 text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50"
            }`}
          >
            <o.icon size={18} className="shrink-0" />
            <span className="min-w-0">
              <span className="block font-medium">{o.label}</span>
              <span className={`block text-xs ${active ? "text-brand-ink/80" : "text-neutral-500"}`}>{o.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// A settings section: a titled, lightly-bordered white card.
function Card({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-neutral-200 bg-surface p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
      {description && <p className="mt-1 text-sm text-neutral-500">{description}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}
