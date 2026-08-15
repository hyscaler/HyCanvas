// Activity panel for a design. A reverse-chronological,
// filterable feed of who did what: edits (folded in from version history),
// comments/resolves, shares/link changes, role changes, tasks, and approvals.
// A type filter narrows the feed; "Load more" pages by the server cursor. Read
// only; gated server-side on the `view` capability.

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AtSign,
  History,
  MessageSquare,
  Pencil,
  Share2,
  ShieldCheck,
  X,
} from "lucide-react";
import type { ActivityItem, ActivityType } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { onCommentChanged } from "@/lib/realtime";
import { tr } from "@/lib/i18n";

const filters = (): { value: ActivityType | "all"; label: string }[] => [
  { value: "all", label: tr("editor.all") },
  { value: "edit", label: tr("editor.edits") },
  { value: "comment", label: tr("editor.comments") },
  { value: "share", label: tr("editor.sharing") },
  { value: "approval_decision", label: tr("editor.approvals") },
  { value: "task_assign", label: tr("editor.tasks") },
];

function iconFor(type: ActivityType) {
  switch (type) {
    case "edit":
      return Pencil;
    case "comment":
    case "reply":
    case "resolve":
    case "reaction":
      return MessageSquare;
    case "share":
    case "link_change":
    case "role_change":
      return Share2;
    case "approval_request":
    case "approval_decision":
    case "reopen":
      return ShieldCheck;
    case "task_assign":
    case "task_status":
      return AtSign;
    default:
      return History;
  }
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "";
  const s = Math.max(0, Math.round(diff / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ActivityPanel({ designId, onClose }: { designId: string; onClose: () => void }) {
  const [filter, setFilter] = useState<ActivityType | "all">("all");
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Fetch the top of the feed for the current filter. Returns the page; the
  // caller owns the state writes (so an effect can do them in a .then chain,
  // avoiding a synchronous setState inside the effect).
  const fetchTop = useCallback(
    (signal: { cancelled: boolean }) =>
      oc
        .designActivity(designId, { type: filter === "all" ? undefined : filter })
        .then((page) => {
          if (signal.cancelled) return;
          setItems(page.items);
          setCursor(page.nextCursor);
          setLoading(false);
        })
        .catch(() => {
          if (signal.cancelled) return;
          setItems([]);
          setLoading(false);
        }),
    [designId, filter],
  );

  // Reload from the top when the design or filter changes.
  useEffect(() => {
    const signal = { cancelled: false };
    void fetchTop(signal);
    return () => { signal.cancelled = true; };
  }, [fetchTop]);

  // Refetch the top of the feed when a comment mutation pings the room.
  useEffect(() => {
    const off = onCommentChanged((d) => {
      if (d === designId) void fetchTop({ cancelled: false });
    });
    return off;
  }, [designId, fetchTop]);

  // Append the next page (a user action, not an effect).
  async function loadMore() {
    setLoadingMore(true);
    try {
      const page = await oc.designActivity(designId, {
        type: filter === "all" ? undefined : filter,
        cursor,
      });
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      /* keep what we have */
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <aside className="oc-scroll flex w-80 shrink-0 flex-col overflow-y-auto border-s border-neutral-200 bg-surface">
      <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold text-neutral-800">
          <Activity size={16} /> {tr("editor.activity")}
        </span>
        <button onClick={onClose} aria-label={tr("editor.close_activity")} className="text-neutral-400 hover:text-neutral-700">
          <X size={18} />
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5 border-b border-neutral-100 px-3 py-2">
        {filters().map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
              filter === f.value ? "bg-brand-50 text-brand-ink" : "text-neutral-500 hover:bg-neutral-100"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="flex-1">
        {loading ? (
          <div className="px-4 py-10 text-center text-sm text-neutral-400">{tr("editor.loading")}</div>
        ) : items.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-neutral-400">{tr("editor.no_activity_yet")}</div>
        ) : (
          <ul className="divide-y divide-neutral-50">
            {items.map((it) => {
              const Icon = iconFor(it.type);
              return (
                <li key={it.id} className="flex items-start gap-3 px-4 py-3">
                  <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-500">
                    <Icon size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-neutral-800">{it.summary}</span>
                    <span className="text-xs text-neutral-400">{relTime(it.createdAt)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {cursor && !loading && (
          <button
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="my-3 w-full text-center text-xs font-medium text-brand-ink hover:text-brand-ink disabled:opacity-50"
          >
            {loadingMore ? tr("editor.loading") : tr("editor.load_more")}
          </button>
        )}
      </div>
    </aside>
  );
}
