// Notifications bell for the app chrome. Shows an unread
// count badge and a dropdown listing the caller's notifications (icon + text +
// relative time + deep link). Clicking a row marks it read and routes to the
// design/comment; a "Mark all read" clears the badge. The unread count polls on
// an interval and updates live on the `{ t: "notify" }` realtime signal when the
// caller is in the editor (best-effort; the poll is the fallback). Used in both
// the dashboard header and the editor top bar.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import {
  AtSign,
  Bell,
  CheckCheck,
  MessageSquare,
  Reply,
  Share2,
  ShieldCheck,
  CheckSquare,
  UserCheck,
  UserPlus,
} from "lucide-react";
import type { NotificationType, NotificationView } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { onNotify } from "@/lib/realtime";
import { cn } from "@/lib/cn";

const POLL_MS = 30_000;

function iconFor(type: NotificationType) {
  switch (type) {
    case "mention":
      return AtSign;
    case "reply":
      return Reply;
    case "task_assign":
      return CheckSquare;
    case "share":
      return Share2;
    case "approval_request":
    case "approval_decision":
      return ShieldCheck;
    case "access_request":
    case "access_decision":
      return UserCheck;
    case "workspace_invite":
      return UserPlus;
    default:
      return MessageSquare;
  }
}

/** Compact relative time (e.g. "3m", "2h", "5d"); falls back to a date. */
function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (!Number.isFinite(diff)) return "";
  const s = Math.max(0, Math.round(diff / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}

export function NotificationsBell({ className }: { className?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<NotificationView[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  // Set true on mount AND false on unmount: under React StrictMode (dev) the
  // mount->unmount->remount cycle would otherwise leave this stuck `false` after
  // the cleanup, freezing every guarded setState (the dropdown hung on "Loading…").
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshCount = useCallback(async () => {
    try {
      const { count: c } = await oc.unreadNotificationCount();
      if (mounted.current) setCount(c);
    } catch {
      /* offline / not signed in: leave the badge as-is */
    }
  }, []);

  const refreshList = useCallback(async () => {
    setLoading(true);
    try {
      const page = await oc.notifications();
      if (mounted.current) setItems(page.items);
    } catch {
      if (mounted.current) setItems([]);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  // Poll the unread count + refresh live on the realtime notify signal. The
  // first read is fetched via .then (no synchronous setState in the effect).
  useEffect(() => {
    oc.unreadNotificationCount()
      .then(({ count: c }) => { if (mounted.current) setCount(c); })
      .catch(() => undefined);
    const id = setInterval(() => void refreshCount(), POLL_MS);
    const off = onNotify(() => void refreshCount());
    return () => {
      clearInterval(id);
      off();
    };
  }, [refreshCount]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = useCallback(() => {
    setOpen((v) => {
      const next = !v;
      if (next) void refreshList();
      return next;
    });
  }, [refreshList]);

  async function onRowClick(n: NotificationView) {
    setOpen(false);
    if (!n.read) {
      // Optimistic: drop the badge immediately, then persist.
      setCount((c) => Math.max(0, c - 1));
      setItems((list) => list.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      try {
        await oc.markNotificationRead(n.id);
      } catch {
        void refreshCount();
      }
    }
    if (n.link) void router.push(n.link);
  }

  async function markAll() {
    setCount(0);
    setItems((list) => list.map((x) => ({ ...x, read: true })));
    try {
      await oc.markAllNotificationsRead();
    } catch {
      void refreshCount();
    }
  }

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={toggle}
        aria-label="Notifications"
        title="Notifications"
        className="relative grid h-9 w-9 place-items-center rounded-lg text-neutral-600 transition hover:bg-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      >
        <Bell size={18} />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold leading-none text-white">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-xl border border-neutral-200 bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-neutral-100 px-3 py-2">
            <span className="text-sm font-semibold text-neutral-800">Notifications</span>
            <button
              onClick={() => void markAll()}
              className="flex items-center gap-1 text-xs font-medium text-neutral-500 hover:text-neutral-900"
              title="Mark all as read"
            >
              <CheckCheck size={14} /> Mark all read
            </button>
          </div>
          <div className="oc-scroll max-h-96 overflow-y-auto">
            {loading ? (
              <div className="px-3 py-8 text-center text-sm text-neutral-400">Loading…</div>
            ) : items.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-neutral-400">
                You are all caught up.
              </div>
            ) : (
              items.map((n) => {
                const Icon = iconFor(n.type);
                return (
                  <button
                    key={n.id}
                    onClick={() => void onRowClick(n)}
                    className={cn(
                      "flex w-full items-start gap-3 px-3 py-2.5 text-left transition hover:bg-neutral-50",
                      !n.read && "bg-brand-50/40",
                    )}
                  >
                    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-500">
                      <Icon size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-neutral-800">{n.text}</span>
                      <span className="text-xs text-neutral-400">{relTime(n.createdAt)}</span>
                    </span>
                    {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-500" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
