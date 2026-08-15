// Prefs-aware date/time formatting. Timestamps are rendered in the signed-in
// user's regional preferences (timezone, locale, and 12h/24h clock) instead of
// the raw browser default. Every preference has an "auto" state that falls back
// to the browser/locale, so a user who never sets them sees no change.

import { useMemo } from "react";
import type { User, WeekStart } from "@hc/sdk";
import { useAuth } from "@/store/auth";

type WhenInput = string | number | Date;

/** The browser's own IANA timezone (e.g. "Asia/Kolkata"), or "" if the runtime
 *  cannot report one. Used as the default a user gets until they choose another.
 *  Defined in a leaf module so the auth store can use it without importing this
 *  one, which imports the auth store; re-exported here for existing callers. */
export { browserTimezone } from "./timezone";

interface Resolved {
  locale: string | undefined;
  timeZone: string | undefined;
  hour12: boolean | undefined;
}

// Turn a user (or null) into Intl options. Undefined values let Intl use its own
// default (the browser locale / timezone / clock), which is the "auto" behavior.
function resolve(user: User | null | undefined): Resolved {
  return {
    locale: user?.locale || undefined,
    timeZone: user?.timezone || undefined,
    hour12: user?.timeFormat === "12h" ? true : user?.timeFormat === "24h" ? false : undefined,
  };
}

/** Numeric first-day-of-week (0 = Sunday, 1 = Monday) for calendar surfaces,
 *  resolving "auto" from the locale where the runtime supports it, else Sunday. */
export function weekStartDay(weekStart: WeekStart | undefined, locale?: string): 0 | 1 {
  if (weekStart === "sunday") return 0;
  if (weekStart === "monday") return 1;
  // auto: ask the locale if the API is available (not in every engine yet).
  try {
    const tag = locale || (typeof navigator !== "undefined" ? navigator.language : "en-US");
    const loc = new Intl.Locale(tag) as Intl.Locale & { weekInfo?: { firstDay?: number } };
    const first = loc.weekInfo?.firstDay ?? (loc as unknown as { getWeekInfo?: () => { firstDay: number } }).getWeekInfo?.().firstDay;
    if (first === 7) return 0; // ISO Sunday is 7
    if (first === 1) return 1;
  } catch {
    /* fall through */
  }
  return 0;
}

/** Date only, e.g. "13 Jul 2026". */
export function formatDate(when: WhenInput, user: User | null | undefined): string {
  const { locale, timeZone } = resolve(user);
  try {
    return new Date(when).toLocaleDateString(locale, { timeZone, year: "numeric", month: "short", day: "numeric" });
  } catch {
    return new Date(when).toLocaleDateString();
  }
}

/** Date + time, e.g. "13 Jul 2026, 4:07 PM" (or 16:07 with the 24h preference). */
export function formatDateTime(when: WhenInput, user: User | null | undefined): string {
  const { locale, timeZone, hour12 } = resolve(user);
  try {
    return new Date(when).toLocaleString(locale, {
      timeZone,
      hour12,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return new Date(when).toLocaleString();
  }
}

/** Hook bound to the signed-in user, so components format timestamps in that
 *  user's regional preferences without threading the user through props. */
export function useDateFormat() {
  const user = useAuth((s) => s.user);
  return useMemo(
    () => ({
      date: (when: WhenInput) => formatDate(when, user),
      dateTime: (when: WhenInput) => formatDateTime(when, user),
      weekStartDay: weekStartDay(user?.weekStart, user?.locale),
    }),
    [user],
  );
}
