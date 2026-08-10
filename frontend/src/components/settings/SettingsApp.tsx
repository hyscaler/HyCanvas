// Account settings page (replaces the old Security modal). One destination with
// three sections: Account (profile + your data), Security (2FA + sessions), and
// Notifications (email/push preferences). Reached from the avatar menu's single
// "Settings" entry.

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/router";
import QRCode from "qrcode";
import { Bell, BellRing, Check, ChevronLeft, Contrast, Copy, Download, Gauge, KeyRound, LogOut, Moon, MonitorSmartphone, ShieldCheck, Sun, Trash2, User as UserIcon } from "lucide-react";
import { ApiError, type MfaEnrollment, type NotificationType, type SessionInfo, type TimeFormat, type WeekStart } from "@hc/sdk";
import { oc, ssoLinkUrl } from "@/lib/sdk";
import { browserTimezone } from "@/lib/datetime";
import { getContrastPreference, getMotionPreference, getThemePreference, setContrastPreference, setMotionPreference, setThemePreference, type ContrastPreference, type MotionPreference, type ThemePreference } from "@/lib/theme";
import { disablePush, enablePush, getPushState, type PushState } from "@/lib/push";
import { useAuth } from "@/store/auth";
import { MIRROR_IN_RTL, setLocalePreference, getLocalePreference } from "@/lib/locale";
import { loadCatalog } from "@/lib/i18n";
import { useToast } from "@/components/ui/Toast";
import { FullScreenLoader } from "@/components/ui/BrandLoader";
import { Logo } from "@/components/ui/Logo";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { settingsPath, type SettingsTab } from "./tabs";
import { tr } from "@/lib/i18n";
import { apiCodeMessage, CodedError, userMessage } from "@/lib/errors";

type Tab = SettingsTab;
type Step = "idle" | "enrolling" | "codes";

// Built on call, not held as a module constant: a `tr()` at module scope is
// evaluated once at import, before any catalog has loaded, and would stay
// English whatever language the user picks.
const tabs = (): { id: Tab; label: string; icon: typeof UserIcon }[] => [
  { id: "account", label: tr("settings.account"), icon: UserIcon },
  { id: "security", label: tr("settings.security"), icon: ShieldCheck },
  { id: "notifications", label: tr("settings.notifications"), icon: Bell },
];

// A small, friendly set of UI languages. The user's current locale is added if
// it is not already listed, so the select always reflects their value.
// i18n-ignore: a language picker shows each language in its OWN name.
const locales = (): { value: string; label: string }[] => [
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
// Functions rather than constants, for the reason given above `tabs`.
const timeFormats = (): { value: TimeFormat; label: string }[] => [
  { value: "auto", label: tr("settings.automatic_match_language") },
  { value: "12h", label: tr("settings.12_hour_clock") },
  { value: "24h", label: tr("settings.24_hour_clock") },
];
const weekStarts = (): { value: WeekStart; label: string }[] => [
  { value: "auto", label: tr("settings.automatic_match_language") },
  { value: "sunday", label: tr("settings.sunday") },
  { value: "monday", label: tr("settings.monday") },
];

// The full IANA zone list from the platform when available (all modern engines),
// with a small fallback for older ones. "" is offered separately as "Automatic".
// i18n-ignore: IANA zone ids are data passed to Intl, never labels.
const timezoneFallback = () => [
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
  return timezoneFallback();
}

const notificationPrefTypes = (): { type: NotificationType; label: string }[] => [
  { type: "mention", label: tr("settings.mentions") },
  { type: "reply", label: tr("settings.replies_to_my_comments") },
  { type: "task_assign", label: tr("settings.task_assignments") },
  { type: "share", label: tr("settings.shared_with_me") },
  { type: "approval_request", label: tr("settings.approval_requests") },
  { type: "approval_decision", label: tr("settings.approval_decisions") },
];

function exportFilename(email: string | undefined): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const who = (email ?? "account").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `hycanvas-export-${who}-${stamp}.json`;
}

function errMessage(e: unknown, fallback: string): string {
  if (e instanceof CodedError) return userMessage(e, fallback);
  if (e instanceof ApiError) {
    const body = e.body as { detail?: string; message?: string } | undefined;
    return apiCodeMessage(body) ?? body?.detail ?? body?.message ?? fallback;
  }
  return fallback;
}

export function SettingsApp({ tab: urlTab }: { tab: SettingsTab | null }) {
  const router = useRouter();
  const toast = useToast();
  const user = useAuth((s) => s.user);
  const setUser = useAuth((s) => s.setUser);
  const bootstrap = useAuth((s) => s.bootstrap);
  const logout = useAuth((s) => s.logout);
  const deleteAccount = useAuth((s) => s.deleteAccount);
  const enabled = !!user?.mfaEnabled;

  // The active tab comes from the URL (one static page per tab; see
  // pages/settings/[[...tab]].tsx), so tabs are deep-linkable and survive a
  // refresh. Returning from the SSO connect flow lands on /settings?sso=... ;
  // the bare path defers to that and opens the Security tab (where the SSO
  // card lives) so the result is visible. Safe to read window here: this
  // component is client-only (ssr: false).
  const tab: Tab =
    urlTab ??
    (typeof window !== "undefined" && /[?&]sso=(connected|error)\b/.test(window.location.search)
      ? "security"
      : "account");
  // No-op when already there, so re-clicking the active tab can't stack
  // duplicate history entries.
  const gotoTab = (t: Tab) => { if (t !== tab) void router.push(settingsPath(t)); };

  // Profile form.
  const [name, setName] = useState(user?.name ?? "");
  // Seeded from the DEVICE preference first: picking a language remounts the
  // app (the tree is keyed on the catalog version), which resets this form.
  // Without this, the dropdown snapped back to the account value after the
  // remount and "Save changes" then silently wrote the OLD language over the
  // one the user had just picked.
  const [locale, setLocale] = useState(getLocalePreference() ?? user?.locale ?? "en-US");
  // The default timezone comes from the browser when the account has none stored.
  const defaultTimezone = user?.timezone || browserTimezone();
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [timeFormat, setTimeFormat] = useState<TimeFormat>(user?.timeFormat ?? "auto");
  const [weekStart, setWeekStart] = useState<WeekStart>(user?.weekStart ?? "auto");
  const [savingProfile, setSavingProfile] = useState(false);
  const localeOptions = useMemo(() => {
    if (!locale || locales().some((l) => l.value === locale)) return locales();
    return [{ value: locale, label: locale }, ...locales()];
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
  // and replace the URL with the Security tab's own path, so the param can't
  // re-toast on refresh and the address bar matches the visible tab. Not
  // shallow: the replace must load the security page's props or the derived
  // `tab` would fall back to Account. The on-mount fetch above already
  // reflects the new linked state, so no optimistic update is needed.
  useEffect(() => {
    if (!router.isReady || ssoHandledRef.current) return;
    const result = router.query.sso;
    if (result !== "connected" && result !== "error") return;
    ssoHandledRef.current = true;
    if (result === "connected") toast.success(tr("settings.single_sign_on_connected"));
    else toast.error(tr("settings.couldnt_connect_single_sign_on_please_try_ag"));
    void router.replace(settingsPath("security"));
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
      toast.success(tr("settings.profile_updated"));
    } catch (e) {
      toast.error(errMessage(e, tr("settings.couldnt_update_your_profile")));
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
      toast.success(tr("settings.single_sign_on_disconnected"));
    } catch (e) {
      // 409 when SSO is the only sign-in method; the API detail explains it.
      toast.error(errMessage(e, tr("settings.couldnt_disconnect_single_sign_on")));
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
      toast.error(tr("settings.couldnt_save_notification_preferences"));
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
      toast.error(tr("settings.couldnt_save_notification_preferences"));
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
      if (next === "denied") toast.error(tr("settings.notifications_are_blocked_allow_them_in_your"));
      else if (next === "unsupported") toast.error(tr("settings.this_browser_does_not_support_push_notificat"));
      else if (next === "unconfigured") toast.error(tr("settings.push_notifications_are_not_available_on_this"));
      else if (next === "subscribed") toast.success(tr("settings.push_notifications_enabled_on_this_device"));
    } catch {
      toast.error(tr("settings.couldnt_update_push_notifications"));
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
      setError(errMessage(e, tr("settings.couldnt_start_setup_please_try_again")));
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
      setError(errMessage(e, tr("settings.that_code_wasnt_valid_try_again")));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      await oc.disableMfa(disableCode.trim());
      toast.success(tr("settings.two_step_verification_turned_off"));
      setDisableCode("");
      await bootstrap();
    } catch (e) {
      setError(errMessage(e, tr("settings.that_code_wasnt_valid_try_again")));
    } finally {
      setBusy(false);
    }
  }

  function copyCodes() {
    void navigator.clipboard?.writeText(recoveryCodes.join("\n"));
    toast.success(tr("settings.recovery_codes_copied"));
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
      toast.success(tr("settings.your_data_export_has_started_downloading"));
    } catch (e) {
      toast.error(errMessage(e, tr("settings.couldnt_export_your_data_please_try_again")));
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
      setDeleteError(errMessage(e, tr("settings.couldnt_delete_the_account_check_your_creden")));
      setDeleting(false);
    }
  }

  if (!user) {
    return <FullScreenLoader />;
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-neutral-200 bg-surface/90 px-4 py-2.5 backdrop-blur">
        <button onClick={() => void router.push("/dashboard")} aria-label={tr("settings.back_to_dashboard")} className="grid h-8 w-8 place-items-center rounded-lg text-neutral-500 hover:bg-neutral-100">
          <ChevronLeft size={20} className={MIRROR_IN_RTL} />
        </button>
        <Logo size={26} />
        {/* The page's level-one heading. It is the visible title too, so
            heading navigation and the visual hierarchy agree. */}
        <h1 className="text-sm font-semibold text-neutral-800">{tr("settings.settings")}</h1>
      </header>

      <div className="mx-auto grid max-w-4xl gap-8 px-6 py-10 md:grid-cols-[12rem_1fr]">
        {/* Sub-nav */}
        <nav className="flex gap-1 md:flex-col">
          {tabs().map((t) => (
            <button
              key={t.id}
              onClick={() => gotoTab(t.id)}
              className={`flex flex-1 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition md:flex-none ${tab === t.id ? "bg-brand-50 text-brand-ink" : "text-neutral-600 hover:bg-neutral-100"}`}
            >
              <t.icon size={16} className={tab === t.id ? "text-brand-ink" : "text-neutral-400"} />
              {t.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <main className="min-w-0 space-y-6">
          {tab === "account" && (
            <>
              <Card title={tr("settings.profile")} description={tr("settings.your_name_language_and_regional_preferences")}>
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
                  <Input label={tr("settings.display_name")} value={name} onChange={(e) => setName(e.target.value)} />
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-neutral-700">
                    {tr("settings.language")}
                    <select
                      value={locale}
                      onChange={(e) => {
                        setLocale(e.target.value);
                        // Apply immediately: the point of picking a language is
                        // seeing it. The account still saves on "Save changes";
                        // until then this is the device preference, and if the
                        // user leaves without saving, the account value wins
                        // again on the next load.
                        setLocalePreference(e.target.value);
                        void loadCatalog(e.target.value);
                      }}
                      className="h-11 rounded-xl border border-neutral-200 bg-surface px-3 text-sm text-neutral-800 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                    >
                      {localeOptions.map((l) => (
                        <option key={l.value} value={l.value}>{l.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-neutral-700">
                    {tr("settings.timezone")}
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
                      {tr("settings.time_format")}
                      <select
                        value={timeFormat}
                        onChange={(e) => setTimeFormat(e.target.value as TimeFormat)}
                        className="h-11 rounded-xl border border-neutral-200 bg-surface px-3 text-sm text-neutral-800 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                      >
                        {timeFormats().map((t) => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1.5 text-sm font-medium text-neutral-700">
                      {tr("settings.week_starts_on")}
                      <select
                        value={weekStart}
                        onChange={(e) => setWeekStart(e.target.value as WeekStart)}
                        className="h-11 rounded-xl border border-neutral-200 bg-surface px-3 text-sm text-neutral-800 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                      >
                        {weekStarts().map((w) => (
                          <option key={w.value} value={w.value}>{w.label}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="flex justify-end border-t border-neutral-100 pt-4">
                    <Button disabled={savingProfile || !profileDirty || !name.trim()} onClick={() => void saveProfile()}>
                      {savingProfile ? tr("settings.saving") : tr("settings.save_changes")}
                    </Button>
                  </div>
                </div>
              </Card>

              <Card title={tr("settings.appearance")} description={tr("settings.how_the_hycanvas_interface_looks_on_this_dev")}>
                <div className="space-y-5">
                  <ThemePicker />
                  <ContrastPicker />
                  <MotionPicker />
                </div>
              </Card>

              <Card title={tr("settings.your_data")} description={tr("settings.download_everything_in_your_account_or_perma")}>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" disabled={exporting} onClick={() => void downloadData()}>
                    <Download size={16} /> {exporting ? tr("settings.preparing") : tr("settings.download_my_data")}
                  </Button>
                  <Button variant="danger" onClick={() => setConfirmingDelete(true)}>
                    <Trash2 size={16} /> {tr("settings.delete_account")}
                  </Button>
                </div>
              </Card>
            </>
          )}

          {tab === "security" && (
            <>
              <Card title={tr("settings.two_step_verification")} description={tr("settings.add_a_code_from_your_authenticator_app_each")}>
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${enabled ? "bg-green-50 text-green-700" : "bg-neutral-100 text-neutral-500"}`}>
                  <ShieldCheck size={13} /> {enabled ? tr("settings.on") : tr("settings.off")}
                </span>

                {error && <div role="alert" className="mt-4 rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">{error}</div>}

                {enabled && step !== "codes" && (
                  <div className="mt-4 flex max-w-sm flex-col gap-3">
                    <Input label={tr("settings.enter_a_code_to_turn_it_off")} placeholder={tr("settings.123456_or_a_recovery_code")} value={disableCode} onChange={(e) => setDisableCode(e.target.value)} autoComplete="one-time-code" />
                    <div>
                      <Button variant="danger" disabled={busy || !disableCode} onClick={() => void disable()}>{busy ? tr("settings.working") : tr("settings.turn_off")}</Button>
                    </div>
                  </div>
                )}

                {!enabled && step === "idle" && (
                  <div className="mt-4">
                    <Button disabled={busy} onClick={() => void startEnroll()}>{busy ? tr("settings.starting") : tr("settings.set_up_two_step_verification")}</Button>
                  </div>
                )}

                {!enabled && step === "enrolling" && enrollment && (
                  <div className="mt-4 flex max-w-md flex-col gap-4">
                    <p className="text-sm text-neutral-600">{tr("settings.scan_this_with_your_authenticator_app_then_e")}</p>
                    <div className="flex items-center gap-4">
                      {qrDataUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- data URL, no remote asset
                        <img src={qrDataUrl} alt={tr("settings.authenticator_qr_code")} className="h-40 w-40 rounded-lg border border-neutral-200" />
                      ) : (
                        <div className="grid h-40 w-40 place-items-center rounded-lg border border-neutral-200 text-xs text-neutral-400">{tr("settings.generating")}</div>
                      )}
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-neutral-500">{tr("settings.or_enter_this_key_manually")}</p>
                        <code className="mt-1 block break-all rounded-lg bg-neutral-50 px-2 py-1.5 text-xs text-neutral-800">{enrollment.secret}</code>
                      </div>
                    </div>
                    <Input label={tr("settings.code_from_your_app")} placeholder="123456" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoFocus />
                    <div className="flex gap-2">
                      <Button variant="ghost" onClick={resetMfaFlow}>{tr("settings.cancel")}</Button>
                      <Button disabled={busy || !code} onClick={() => void confirmEnroll()}>{busy ? tr("settings.verifying") : tr("settings.verify")}</Button>
                    </div>
                  </div>
                )}

                {step === "codes" && (
                  <div className="mt-4 flex max-w-md flex-col gap-3">
                    <p className="text-sm text-neutral-600">{tr("settings.save_these_recovery_codes_somewhere_safe_eac")}</p>
                    <ul className="grid grid-cols-2 gap-1.5 rounded-xl bg-neutral-50 p-3 font-mono text-sm text-neutral-800">
                      {recoveryCodes.map((c) => <li key={c}>{c}</li>)}
                    </ul>
                    <button type="button" onClick={copyCodes} className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-brand-ink hover:underline"><Copy size={14} /> {tr("settings.copy_codes")}</button>
                    <label className="flex items-start gap-2 text-sm text-neutral-700">
                      <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-0.5" />
                      {tr("settings.i_have_saved_these_recovery_codes")}
                    </label>
                    <div>
                      <Button disabled={!acknowledged} onClick={resetMfaFlow}><Check size={16} /> {tr("settings.done")}</Button>
                    </div>
                  </div>
                )}
              </Card>

              {sso?.configured && step !== "enrolling" && step !== "codes" && (
                <Card title={tr("settings.single_sign_on")} description={tr("settings.sign_in_with_your_organizations_identity_pro")}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${sso.linked ? "bg-green-50 text-green-700" : "bg-neutral-100 text-neutral-500"}`}>
                      <KeyRound size={13} /> {sso.linked ? tr("settings.connected") : tr("settings.not_connected")}
                    </span>
                    {sso.linked ? (
                      <Button variant="ghost" disabled={ssoBusy} onClick={() => void disconnectSso()}>{ssoBusy ? tr("settings.working") : tr("settings.disconnect")}</Button>
                    ) : (
                      <Button onClick={connectSso}>{tr("settings.connect")}</Button>
                    )}
                  </div>
                  {sso.linked && (
                    <p className="mt-3 text-xs text-neutral-500">{tr("settings.keep_a_password_on_your_account_so_you_are_n")}</p>
                  )}
                </Card>
              )}

              {step !== "enrolling" && step !== "codes" && (
                <Card title={tr("settings.active_sessions")} description={tr("settings.devices_currently_signed_in_to_your_account")}>
                  {sessions === null ? (
                    <p className="text-xs text-neutral-400">{tr("settings.loading")}</p>
                  ) : sessions.length === 0 ? (
                    <p className="text-xs text-neutral-400">{tr("settings.no_other_active_sessions")}</p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {sessions.map((s) => (
                        <li key={s.id} className="flex items-center justify-between gap-3 rounded-lg bg-neutral-50 px-3 py-2 text-sm">
                          <span className="min-w-0 truncate text-neutral-700">{s.device || tr("settings.unknown_device")}{s.ip ? ` · ${s.ip}` : ""}</span>
                          <span className="shrink-0 text-xs text-neutral-400">{new Date(s.lastSeenAt).toLocaleDateString()}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-4 border-t border-neutral-100 pt-4">
                    <Button variant="ghost" disabled={signingOutAll} onClick={() => void signOutEverywhere()}><LogOut size={16} /> {signingOutAll ? tr("settings.signing_out") : tr("settings.sign_out_everywhere")}</Button>
                  </div>
                </Card>
              )}
            </>
          )}

          {tab === "notifications" && (
            <Card title={tr("settings.notifications")} description={tr("settings.in_app_notifications_are_always_on_choose_wh")}>
              <div className="flex items-start gap-3 rounded-xl bg-neutral-50 p-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-ink"><BellRing size={16} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-neutral-800">{tr("settings.push_on_this_device")}</p>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    {pushState === null ? tr("settings.checking")
                      : pushState === "unsupported" ? tr("settings.this_browser_does_not_support_push_notificat")
                      : pushState === "unconfigured" ? tr("settings.push_notifications_are_not_available_on_this")
                      : pushState === "denied" ? tr("settings.blocked_allow_notifications_in_your_browser")
                      : pushState === "subscribed" ? tr("settings.enabled_on_this_device")
                      : tr("settings.get_notified_even_when_hycanvas_is_closed")}
                  </p>
                </div>
                {(pushState === "default" || pushState === "subscribed") && (
                  <Button variant={pushState === "subscribed" ? "ghost" : "primary"} disabled={togglingPush} onClick={() => void togglePushDevice()}>
                    {togglingPush ? tr("settings.working") : pushState === "subscribed" ? tr("settings.disable") : tr("settings.enable")}
                  </Button>
                )}
              </div>

              <div className="mt-5">
                <div className="grid grid-cols-[1fr_3.5rem_3.5rem] items-center gap-y-3 text-sm">
                  <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">{tr("settings.notify_me_about")}</span>
                  <span className="justify-self-center text-xs font-medium text-neutral-500">{tr("settings.email")}</span>
                  <span className="justify-self-center text-xs font-medium text-neutral-500">{tr("settings.push")}</span>
                  {notificationPrefTypes().map(({ type, label }) => (
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
        </main>
      </div>

      {confirmingDelete && (
        <Modal open onClose={() => setConfirmingDelete(false)} title={tr("settings.delete_account")} width="w-[26rem]">
          <p className="text-sm text-neutral-600">
            This permanently deletes your account and any workspaces only you belong to, including their designs.
            Workspaces you share with others stay, and you are removed from them. This cannot be undone.
          </p>
          {deleteError && <div role="alert" className="mt-4 rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">{deleteError}</div>}
          <div className="mt-4 flex flex-col gap-3">
            <Input label={tr("settings.confirm_your_password")} type="password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} autoComplete="current-password" autoFocus />
            {enabled && <Input label={tr("settings.authentication_code")} placeholder={tr("settings.123456_or_a_recovery_code")} value={deleteCode} onChange={(e) => setDeleteCode(e.target.value)} autoComplete="one-time-code" />}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>{tr("settings.cancel")}</Button>
              <Button variant="danger" disabled={deleting || !deletePassword || (enabled && !deleteCode)} onClick={() => void confirmDelete()}>{deleting ? tr("settings.deleting") : tr("settings.delete_account")}</Button>
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
    { value: "system", label: tr("settings.system"), icon: MonitorSmartphone, hint: tr("settings.follow_this_device") },
    { value: "light", label: tr("settings.light"), icon: Sun, hint: tr("settings.always_light") },
    { value: "dark", label: tr("settings.dark"), icon: Moon, hint: tr("settings.always_dark") },
  ];
  return (
    <div role="radiogroup" aria-label={tr("settings.interface_theme")} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
            className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-start text-sm transition ${
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

// Contrast: normal / high / follow-the-OS (F38 FR-4), the second appearance
// axis. High contrast strengthens chrome text, borders, and focus indicators
// via the generated `.hc` token overrides; design content is never restyled.
function ContrastPicker() {
  const [pref, setPref] = useState<ContrastPreference>(() => getContrastPreference());
  const options: { value: ContrastPreference; label: string; hint: string }[] = [
    { value: "system", label: tr("settings.system"), hint: tr("settings.follow_this_device") },
    { value: "normal", label: tr("settings.normal_contrast"), hint: tr("settings.the_standard_look") },
    { value: "high", label: tr("settings.high_contrast"), hint: tr("settings.stronger_text_borders_and_focus") },
  ];
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-neutral-500">
        <Contrast size={13} /> {tr("settings.contrast")}
      </div>
      <div role="radiogroup" aria-label={tr("settings.contrast")} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
                setContrastPreference(o.value);
              }}
              className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-start text-sm transition ${
                active
                  ? "border-brand-500 bg-brand-50 text-brand-ink ring-1 ring-brand-200"
                  : "border-neutral-200 text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50"
              }`}
            >
              <span className="min-w-0">
                <span className="block font-medium">{o.label}</span>
                <span className={`block text-xs ${active ? "text-brand-ink/80" : "text-neutral-500"}`}>{o.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Motion: skip or keep nonessential animation (F38 FR-4), the third
// appearance axis. "System" follows the OS reduce-motion setting; "Reduced"
// forces the damping on; "Full" keeps animation even when the OS asks to
// reduce. Present mode and the deck export planner read the same resolution.
function MotionPicker() {
  const [pref, setPref] = useState<MotionPreference>(() => getMotionPreference());
  const options: { value: MotionPreference; label: string; hint: string }[] = [
    { value: "system", label: tr("settings.system"), hint: tr("settings.follow_this_device") },
    { value: "reduce", label: tr("settings.reduced"), hint: tr("settings.skip_nonessential_animation") },
    { value: "full", label: tr("settings.full"), hint: tr("settings.always_animate") },
  ];
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-neutral-500">
        <Gauge size={13} /> {tr("settings.motion")}
      </div>
      <div role="radiogroup" aria-label={tr("settings.motion")} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
                setMotionPreference(o.value);
              }}
              className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-start text-sm transition ${
                active
                  ? "border-brand-500 bg-brand-50 text-brand-ink ring-1 ring-brand-200"
                  : "border-neutral-200 text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50"
              }`}
            >
              <span className="min-w-0">
                <span className="block font-medium">{o.label}</span>
                <span className={`block text-xs ${active ? "text-brand-ink/80" : "text-neutral-500"}`}>{o.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
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
