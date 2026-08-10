// Publish dialog (Publishing and scheduling). Three tabs:
//   1. Publish  - pick platforms, see proposed per-platform export sizes, write a
//      caption with live per-platform character limits and a hashtag preview, and
//      post-now or schedule. Submitting appends a LOCAL ScheduledPost only.
//   2. Planner  - a month calendar of the locally-created posts, with cancel.
//   3. QR code  - byte-mode QR encoder + SVG renderer with style controls.
//
// HONEST SCOPE NOTE: this dialog uses only the pure @hc/publishing core. Real
// social-account OAuth, durable scheduled-delivery jobs (BullMQ), and published-
// post insights all require backend infrastructure that is NOT yet built
// (FR-1/FR-4/FR-7/FR-14). Nothing here hits the network: "publishing" appends an
// in-memory ScheduledPost so the planner has something to show. This is clearly
// surfaced in the UI.

import { useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  Hash,
  Info,
  QrCode as QrCodeIcon,
  Send,
  Trash2,
  X,
} from "lucide-react";
import {
  PLATFORM_LIMITS,
  composeCaption,
  extractHashtags,
  normalizeHashtags,
  validateCaption,
  PLATFORM_FORMATS,
  proposeResizes,
  planVariants,
  dueAt,
  canCancel,
  calendarMatrix,
  groupByDay,
  filterPosts,
  encodeQr,
  qrToSvg,
  type SocialPlatform,
  type ScheduledPost,
  type PostStatus,
  type QrEcLevel,
} from "@hc/publishing";
import { useEditor } from "@/store/editor";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { useToast } from "@/components/ui/Toast";
import { MIRROR_IN_RTL } from "@/lib/locale";
import { tr } from "@/lib/i18n";
import { userMessage } from "@/lib/errors";

type Tab = "publish" | "planner" | "qr";

const ALL_PLATFORMS: SocialPlatform[] = [
  "instagram",
  "facebook",
  "x",
  "linkedin",
  "tiktok",
  "pinterest",
  "youtube",
];

const platformLabel = (): Record<SocialPlatform, string> => ({
  instagram: tr("editor.instagram"),
  facebook: tr("editor.facebook"),
  x: "X",
  linkedin: tr("editor.linkedin"),
  tiktok: tr("editor.tiktok"),
  pinterest: tr("editor.pinterest"),
  youtube: tr("editor.youtube"),
});

// Status -> chip color, used in the planner and its legend.
const STATUS_COLOR: Record<PostStatus, string> = {
  draft: "bg-neutral-200 text-neutral-700",
  scheduled: "bg-blue-100 text-blue-700",
  publishing: "bg-amber-100 text-amber-700",
  published: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
  canceled: "bg-neutral-100 text-neutral-400 line-through",
};

const monthNames = () => [
  tr("editor.january"), tr("editor.february"), tr("editor.march"), tr("editor.april"), tr("editor.may"), tr("editor.june"),
  tr("editor.july"), tr("editor.august"), tr("editor.september"), tr("editor.october"), tr("editor.november"), tr("editor.december"),
];

const weekdays = () => [tr("editor.mon"), tr("editor.tue"), tr("editor.wed"), tr("editor.thu"), tr("editor.fri"), tr("editor.sat"), tr("editor.sun")];

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Format a minutes-ahead-of-UTC offset as a "UTC+5:30" style label. */
function formatOffsetLabel(offsetMin: number): string {
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}:${m.toString().padStart(2, "0")}`;
}

/** Current local timezone offset in minutes (ahead-of-UTC), formatted. */
function tzNote(): { offsetMin: number; label: string } {
  // Date.getTimezoneOffset() is minutes BEHIND UTC (positive when behind), so
  // the IANA-style offset (ahead-positive) that dueAt() wants is its negation.
  const offsetMin = -new Date().getTimezoneOffset();
  return { offsetMin, label: formatOffsetLabel(offsetMin) };
}

/** Local UTC offset (minutes ahead of UTC) AT a given local wall-clock instant.
 *  Using the offset at the scheduled instant (not "now") keeps a future post
 *  correct across a DST boundary between now and the scheduled time. */
function offsetAtLocal(localIso: string): number {
  const at = new Date(localIso);
  return Number.isNaN(at.getTime()) ? -new Date().getTimezoneOffset() : -at.getTimezoneOffset();
}

// Module-scope wrappers for the impure clock/random calls so the React compiler
// does not flag them inside the component's event handlers.
function clockMs(): number {
  return Date.now();
}
function randId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function PublishDialog({
  open,
  onClose,
  designId,
  workspaceId,
}: {
  open: boolean;
  onClose: () => void;
  designId?: string;
  workspaceId?: string;
}): React.ReactElement | null {
  const toast = useToast();

  const [tab, setTab] = useState<Tab>("publish");

  // Locally-created posts (drives the Planner tab). Not persisted: real
  // scheduling needs the backend job queue (deferred).
  const [posts, setPosts] = useState<ScheduledPost[]>([]);

  // ---- Publish tab state ----
  const [selected, setSelected] = useState<SocialPlatform[]>(["instagram"]);
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<"now" | "schedule">("now");
  const [scheduledLocal, setScheduledLocal] = useState(""); // datetime-local value

  // ---- Planner tab state ----
  const today = useMemo(() => new Date(), []);
  const [calYear, setCalYear] = useState(today.getUTCFullYear());
  const [calMonth, setCalMonth] = useState(today.getUTCMonth() + 1); // 1-12
  const [planFilter, setPlanFilter] = useState<SocialPlatform | "all">("all");
  const [openPostId, setOpenPostId] = useState<string | null>(null);

  // ---- QR tab state ----
  const [qrText, setQrText] = useState(() => {
    // Default to this instance's own origin so self-hosted servers get their
    // own domain in the QR code, not ours.
    const origin =
      typeof window !== "undefined" ? window.location.origin : "https://hycanvas.art";
    return designId ? `${origin}/d/${designId}` : origin;
  });
  const [qrEc, setQrEc] = useState<QrEcLevel>("M");
  const [qrFg, setQrFg] = useState("#000000");
  const [qrBg, setQrBg] = useState("#ffffff");

  // Read the current design reactively (matches PrintDialog/WebsiteDialog) so the
  // dialog reflects live page-size / QR changes made while it is open. `rev` is
  // subscribed so edits in place (which keep the same `doc` reference) re-render.
  const doc = useEditor((s) => s.doc);
  const activePage = useEditor((s) => s.activePage);
  useEditor((s) => s.rev);

  if (!open) return null;

  const pageIdx = Math.min(Math.max(0, activePage), doc.pages.length - 1);
  const page = doc.pages[pageIdx];
  const sourceW = Math.max(1, Math.round(page.width));
  const sourceH = Math.max(1, Math.round(page.height));

  // Hashtags parsed live from the caption body.
  const hashtags = normalizeHashtags(extractHashtags(body));
  const composed = composeCaption(body, hashtags);

  // Proposed export sizes for the selected platforms.
  const resizes = proposeResizes(sourceW, sourceH, selected);

  // Render-variant dedup preview: how many distinct renders the selection needs.
  const plannedVariants = planVariants(
    designId ?? "unsaved",
    page.id,
    selected.map((p) => {
      const fmt = PLATFORM_FORMATS[p][0];
      return { targetId: p, width: fmt.width, height: fmt.height, format: fmt.format };
    }),
  );

  // The strictest selected platform decides the live limit warning.
  const strictest =
    selected.length > 0
      ? selected.reduce((a, b) => (PLATFORM_LIMITS[a] <= PLATFORM_LIMITS[b] ? a : b))
      : null;
  const strictValidation = strictest ? validateCaption(strictest, composed) : null;

  function togglePlatform(p: SocialPlatform) {
    setSelected((cur) =>
      cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p],
    );
  }

  function submitPublish() {
    if (selected.length === 0) {
      toast.error(tr("editor.pick_at_least_one_platform"));
      return;
    }
    const nowMs = clockMs();

    let scheduledAtIso: string | undefined;
    let status: PostStatus;
    // The offset that resolves a scheduled wall-clock time to an instant must be
    // the offset AT that scheduled time, not "now" (they differ across a DST
    // boundary). Post-now uses the current offset.
    let dueOffsetMin = tzNote().offsetMin;
    if (mode === "schedule") {
      if (!scheduledLocal) {
        toast.error(tr("editor.choose_a_date_and_time_to_schedule"));
        return;
      }
      scheduledAtIso = scheduledLocal; // already a local wall-clock ISO-ish string
      dueOffsetMin = offsetAtLocal(scheduledLocal);
      // dueAt interprets the wall-clock string against the supplied offset.
      const due = dueAt(scheduledAtIso, dueOffsetMin);
      status = due > nowMs ? "scheduled" : "published";
    } else {
      // Post now.
      status = "published";
    }
    const tzLabel = formatOffsetLabel(dueOffsetMin);

    const id = `local-${nowMs}-${randId()}`;
    const createdIso = new Date(nowMs).toISOString();
    const post: ScheduledPost = {
      id,
      workspaceId: workspaceId ?? "local",
      designId: designId ?? "unsaved",
      sourcePageId: page.id,
      status,
      scheduledAt: scheduledAtIso,
      timezone: tzLabel,
      createdBy: "me",
      createdAt: createdIso,
      updatedAt: createdIso,
      targets: selected.map((platform) => {
        const fmt = PLATFORM_FORMATS[platform][0];
        return {
          targetId: platform,
          platform,
          caption: composed,
          hashtags: hashtags.length ? hashtags : undefined,
          renderVariantId: `${page.id}:${fmt.width}x${fmt.height}:${fmt.format}`,
          state: "pending" as const,
        };
      }),
    };

    setPosts((cur) => [...cur, post]);
    toast.success(
      status === "scheduled"
        ? tr("editor.post_queued_locally_for_its_scheduled_time_c")
        : tr("editor.post_recorded_locally_actual_delivery_to_acc"),
    );
    // Jump to the planner so the user sees what they just created.
    setTab("planner");
    if (scheduledAtIso) {
      const d = new Date(dueAt(scheduledAtIso, dueOffsetMin));
      setCalYear(d.getUTCFullYear());
      setCalMonth(d.getUTCMonth() + 1);
    }
  }

  function cancelPost(id: string) {
    setPosts((cur) =>
      cur.map((p) => (p.id === id ? { ...p, status: "canceled" as PostStatus } : p)),
    );
    setOpenPostId(null);
    toast.toast(tr("editor.post_canceled"), "info");
  }

  // ---- Planner derived data ----
  const tz = tzNote();
  const filteredPosts = filterPosts(
    posts.map((p) => ({ ...p, platform: p.targets[0]?.platform })),
    planFilter === "all" ? {} : { platform: planFilter },
  );
  // Only posts with a resolvable due time land on a calendar day. Posts without
  // a scheduledAt (post-now) are bucketed on their creation day. Resolve each
  // scheduled wall-clock time against the offset AT that instant so DST does not
  // shift a post onto the wrong day.
  const byDay = groupByDay(filteredPosts, (p) => {
    if (p.scheduledAt) return dueAt(p.scheduledAt, offsetAtLocal(p.scheduledAt));
    return Date.parse(p.createdAt);
  });
  const matrix = calendarMatrix(calYear, calMonth);
  const openPost = posts.find((p) => p.id === openPostId) ?? null;

  function prevMonth() {
    setCalMonth((m) => {
      if (m === 1) {
        setCalYear((y) => y - 1);
        return 12;
      }
      return m - 1;
    });
  }
  function nextMonth() {
    setCalMonth((m) => {
      if (m === 12) {
        setCalYear((y) => y + 1);
        return 1;
      }
      return m + 1;
    });
  }

  // ---- QR derived data ----
  let qrSvg = "";
  let qrError: string | null = null;
  try {
    if (qrText.trim()) {
      qrSvg = qrToSvg(encodeQr(qrText, qrEc), { fg: qrFg, bg: qrBg, moduleSize: 6 });
    }
  } catch (e) {
    qrError = userMessage(e, tr("editor.could_not_encode_this_value_as_a_qr_code"));
  }

  function downloadQr() {
    if (!qrSvg) return;
    download(new Blob([qrSvg], { type: "image/svg+xml" }), "qr-code.svg");
  }

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "publish", label: tr("editor.publish"), icon: <Send size={15} /> },
    { id: "planner", label: tr("editor.planner"), icon: <CalendarDays size={15} /> },
    { id: "qr", label: tr("editor.qr_code"), icon: <QrCodeIcon size={15} /> },
  ];

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-[40rem] max-w-[94vw] flex-col overflow-hidden rounded-xl bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3.5">
          <h2 className="text-base font-semibold text-neutral-900">Publish &amp; schedule</h2>
          <IconButton size="sm" aria-label={tr("editor.close")} onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-neutral-200 px-3 pt-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={
                "flex items-center gap-1.5 rounded-t-md px-3 py-2 text-sm font-medium " +
                (tab === t.id
                  ? "border-b-2 border-neutral-900 text-neutral-900"
                  : "text-neutral-500 hover:text-neutral-800")
              }
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {/* Global honesty note */}
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>
              Account connection (OAuth), scheduled delivery jobs, and post insights
              require backend infrastructure that is not yet wired. Publishing here
              records the post locally so you can preview the planner.
            </span>
          </div>

          {tab === "publish" && (
            <div className="space-y-5">
              {/* Platform multi-select */}
              <div>
                <div className="mb-2 text-sm font-medium text-neutral-700">{tr("editor.platforms")}</div>
                <div className="flex flex-wrap gap-2">
                  {ALL_PLATFORMS.map((p) => {
                    const on = selected.includes(p);
                    return (
                      <button
                        key={p}
                        onClick={() => togglePlatform(p)}
                        className={
                          "rounded-full border px-3 py-1 text-sm " +
                          (on
                            ? "border-neutral-900 bg-neutral-900 text-surface"
                            : "border-neutral-300 text-neutral-600 hover:border-neutral-400")
                        }
                      >
                        {platformLabel()[p]}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Proposed export sizes per selected platform */}
              {selected.length > 0 && (
                <div>
                  <div className="mb-2 text-sm font-medium text-neutral-700">
                    {tr("editor.proposed_export_sizes")}
                    <span className="ms-2 font-normal text-neutral-400">
                      source {sourceW}&times;{sourceH}
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {resizes.map((r) => (
                      <div
                        key={r.platform}
                        className="flex items-center justify-between rounded-md bg-neutral-50 px-3 py-1.5 text-sm"
                      >
                        <span className="text-neutral-700">{platformLabel()[r.platform]}</span>
                        <span className="text-neutral-500">
                          {r.width}&times;{r.height}
                          <span className="ms-2 rounded bg-neutral-200 px-1.5 py-0.5 text-[11px] uppercase text-neutral-600">
                            {r.mode}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-neutral-400">
                    {plannedVariants.length} distinct render
                    {plannedVariants.length === 1 ? "" : "s"} needed (shared sizes are
                    reused).
                  </p>
                </div>
              )}

              {/* Caption */}
              <div>
                <div className="mb-2 flex items-center justify-between text-sm font-medium text-neutral-700">
                  <span>{tr("editor.caption")}</span>
                  {strictest && strictValidation && (
                    <span
                      className={
                        "text-xs font-normal " +
                        (strictValidation.ok ? "text-neutral-400" : "text-red-600")
                      }
                    >
                      {strictValidation.length}/{strictValidation.limit} ({platformLabel()[strictest]})
                    </span>
                  )}
                </div>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={4}
                  placeholder={tr("editor.write_your_caption_use_hashtags_inline")}
                  className="w-full resize-y rounded-md border border-neutral-300 p-2.5 text-sm outline-none focus:border-neutral-500"
                />
                {strictValidation && !strictValidation.ok && (
                  <ul className="mt-1 list-disc ps-4 text-[11px] text-red-600">
                    {strictValidation.errors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                )}
                {hashtags.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Hash size={13} className="text-neutral-400" />
                    {hashtags.map((h) => (
                      <span
                        key={h}
                        className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700"
                      >
                        #{h}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Publish now vs schedule */}
              <div>
                <div className="mb-2 flex gap-2">
                  {(["now", "schedule"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      className={
                        "rounded-md px-3 py-1.5 text-sm font-medium " +
                        (mode === m
                          ? "bg-neutral-900 text-surface"
                          : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200")
                      }
                    >
                      {m === "now" ? tr("editor.publish_now") : tr("editor.schedule")}
                    </button>
                  ))}
                </div>
                {mode === "schedule" && (
                  <div>
                    <input
                      type="datetime-local"
                      value={scheduledLocal}
                      onChange={(e) => setScheduledLocal(e.target.value)}
                      className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-500"
                    />
                    <p className="mt-1 text-[11px] text-neutral-400">
                      Interpreted as local wall-clock time ({tz.label}).
                    </p>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={onClose}>
                  {tr("editor.cancel")}
                </Button>
                <Button onClick={submitPublish}>
                  {mode === "now" ? tr("editor.publish_now") : tr("editor.schedule")}
                </Button>
              </div>
            </div>
          )}

          {tab === "planner" && (
            <div className="space-y-3">
              {/* Calendar nav + filter */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <IconButton size="sm" aria-label={tr("editor.previous_month")} onClick={prevMonth}>
                    <ChevronLeft size={16} className={MIRROR_IN_RTL} />
                  </IconButton>
                  <span className="min-w-[9rem] text-center text-sm font-medium text-neutral-800">
                    {monthNames()[calMonth - 1]} {calYear}
                  </span>
                  <IconButton size="sm" aria-label={tr("editor.next_month")} onClick={nextMonth}>
                    <ChevronRight size={16} className={MIRROR_IN_RTL} />
                  </IconButton>
                </div>
                <select
                  value={planFilter}
                  onChange={(e) => setPlanFilter(e.target.value as SocialPlatform | "all")}
                  className="rounded border border-neutral-300 px-2 py-1 text-sm"
                >
                  <option value="all">{tr("editor.all_platforms")}</option>
                  {ALL_PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {platformLabel()[p]}
                    </option>
                  ))}
                </select>
              </div>

              {/* Weekday header */}
              <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-neutral-400">
                {weekdays().map((d) => (
                  <div key={d}>{d}</div>
                ))}
              </div>

              {/* Calendar grid */}
              <div className="grid grid-cols-7 gap-1">
                {matrix.flat().map((cell) => {
                  const dayPosts = byDay[cell.dateIso] ?? [];
                  return (
                    <div
                      key={cell.dateIso}
                      className={
                        "min-h-[4.5rem] rounded-md border p-1 text-start " +
                        (cell.inMonth
                          ? "border-neutral-200 bg-surface"
                          : "border-neutral-100 bg-neutral-50 text-neutral-300")
                      }
                    >
                      <div className="mb-1 text-[11px] text-neutral-400">
                        {Number(cell.dateIso.slice(8, 10))}
                      </div>
                      <div className="space-y-0.5">
                        {dayPosts.map((p) => (
                          <button
                            key={p.id}
                            onClick={() => setOpenPostId(p.id)}
                            className={
                              "block w-full truncate rounded px-1 py-0.5 text-start text-[10px] " +
                              STATUS_COLOR[p.status]
                            }
                            title={p.targets.map((t) => platformLabel()[t.platform]).join(", ")}
                          >
                            {p.targets.map((t) => platformLabel()[t.platform]).join(", ")}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Status legend */}
              <div className="flex flex-wrap gap-2 pt-1 text-[11px]">
                {(Object.keys(STATUS_COLOR) as PostStatus[]).map((s) => (
                  <span
                    key={s}
                    className={"rounded px-1.5 py-0.5 " + STATUS_COLOR[s]}
                  >
                    {s}
                  </span>
                ))}
              </div>

              {posts.length === 0 && (
                <p className="pt-2 text-center text-sm text-neutral-400">
                  {tr("editor.no_posts_yet_create_one_from_the_publish_tab")}
                </p>
              )}

              {/* Post detail */}
              {openPost && (
                <div className="mt-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span
                      className={
                        "rounded px-1.5 py-0.5 text-[11px] " + STATUS_COLOR[openPost.status]
                      }
                    >
                      {openPost.status}
                    </span>
                    <button
                      onClick={() => setOpenPostId(null)}
                      className="text-[11px] text-neutral-400 hover:text-neutral-700"
                    >
                      {tr("editor.close")}
                    </button>
                  </div>
                  <div className="mb-1 text-xs text-neutral-500">
                    {openPost.targets.map((t) => platformLabel()[t.platform]).join(", ")}
                    {openPost.scheduledAt && (
                      <span className="ms-2">
                        scheduled {openPost.scheduledAt.replace("T", " ")} ({openPost.timezone})
                      </span>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-neutral-700">
                    {openPost.targets[0]?.caption || <span className="text-neutral-400">(no caption)</span>}
                  </p>
                  {canCancel(openPost.status) && (
                    <button
                      onClick={() => cancelPost(openPost.id)}
                      className="mt-2 flex items-center gap-1 text-xs font-medium text-red-600 hover:underline"
                    >
                      <Trash2 size={13} /> {tr("editor.cancel_post")}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {tab === "qr" && (
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-neutral-700">
                  {tr("editor.target_url_or_text")}
                </label>
                <input
                  type="text"
                  value={qrText}
                  onChange={(e) => setQrText(e.target.value)}
                  className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-500"
                />
              </div>

              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm text-neutral-600">
                  {tr("editor.error_correction")}
                  <select
                    value={qrEc}
                    onChange={(e) => setQrEc(e.target.value as QrEcLevel)}
                    className="rounded border border-neutral-300 px-2 py-1"
                  >
                    <option value="L">L (7%)</option>
                    <option value="M">M (15%)</option>
                    <option value="Q">Q (25%)</option>
                    <option value="H">H (30%)</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-sm text-neutral-600">
                  {tr("editor.foreground")}
                  <input
                    type="color"
                    value={qrFg}
                    onChange={(e) => setQrFg(e.target.value)}
                    className="h-8 w-10 rounded border border-neutral-300"
                  />
                </label>
                <label className="flex items-center gap-2 text-sm text-neutral-600">
                  {tr("editor.background")}
                  <input
                    type="color"
                    value={qrBg}
                    onChange={(e) => setQrBg(e.target.value)}
                    className="h-8 w-10 rounded border border-neutral-300"
                  />
                </label>
              </div>

              <div className="flex flex-col items-center gap-3">
                <div className="rounded-lg border border-neutral-200 p-3">
                  {qrError ? (
                    <p className="max-w-[16rem] text-center text-sm text-red-600">{qrError}</p>
                  ) : qrSvg ? (
                    // eslint-disable-next-line @next/next/no-img-element -- inline data-URL SVG, not a remote asset
                    <img
                      src={`data:image/svg+xml;utf8,${encodeURIComponent(qrSvg)}`}
                      alt={tr("editor.qr_code_preview")}
                      width={216}
                      height={216}
                    />
                  ) : (
                    <p className="text-sm text-neutral-400">{tr("editor.enter_a_value_to_generate_a_code")}</p>
                  )}
                </div>
                {qrText.trim() && !qrError && (
                  <p className="max-w-full truncate text-[11px] text-neutral-400">{qrText}</p>
                )}
                <Button variant="ghost" onClick={downloadQr} disabled={!qrSvg}>
                  <Download size={15} className="me-1.5" /> {tr("editor.download_svg")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
