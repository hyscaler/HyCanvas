// The Comments panel (FR-1, FR-2, FR-3, FR-4). A side panel that
// lists comment threads for the open design: author, time, body, emoji reactions,
// replies, resolve/reopen, author edit/delete, and convert-to-task with an
// assignee/status/due. A composer at the bottom has @mention autocomplete from
// the design's mentionable people and drops a comment at the draft pin (or a
// general design comment). The composer/actions are gated on the `comment`
// capability so a view-only user sees threads read-only. Threads refresh live via
// the realtime `{ t: "comment" }` signal (wired in the editor shell).

import { useEffect, useMemo, useRef, useState } from "react";
import {
  MessageSquare,
  X,
  Check,
  RotateCcw,
  Trash2,
  Pencil,
  Send,
  CheckSquare,
  CornerDownRight,
  Smile,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import type { Comment, CommentThread, MentionablePerson, TaskStatus } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { useComments } from "@/store/comments";
import { useEditor } from "@/store/editor";
import { useAuth } from "@/store/auth";
import { anchorPagePoint } from "@/components/editor/CommentPins";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { initials, avatarColor } from "@/lib/avatar";
import { tr } from "@/lib/i18n";

const REACTIONS = ["👍", "❤️", "🎉", "😂", "👀"];
const statusLabel = (): Record<TaskStatus, string> => ({ open: tr("editor.open"), in_progress: tr("editor.in_progress"), done: tr("editor.done") });
const filters = (): { id: ReturnType<typeof useComments.getState>["filter"]; label: string }[] => [
  { id: "all", label: tr("editor.all") },
  { id: "open", label: tr("editor.open") },
  { id: "resolved", label: tr("editor.resolved") },
];

function relativeTime(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

// Deterministic avatar: initials on a stable color picked from the author id/name.
function Avatar({ name, id, size = 28 }: { name: string; id?: string | null; size?: number }) {
  return (
    <span
      className="grid shrink-0 select-none place-items-center rounded-full font-semibold leading-none text-white"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4), background: avatarColor(id || name) }}
      title={name}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

/** Bring a thread's pin into view on the canvas: switch to the anchor's
 *  page if needed, then center the viewport on the pin's page coordinates. When
 *  the anchor is a (live) element we select it and zoom-to-selection, which
 *  frames the node nicely; otherwise we pan so the point sits dead-center at the
 *  current zoom. All of this is one viewport change (viewports are not undoable),
 *  and it never mutates the document. A no-op when the pin cannot be placed
 *  (general/page-level/orphaned anchors with no on-canvas point). */
function jumpToThread(thread: CommentThread): void {
  const ed = useEditor.getState();
  const anchor = thread.anchor;

  // Switch to the anchor's page first, so the pin is actually on screen. Resolve
  // the page by id; setActivePage clamps and is a no-op when already there.
  if (anchor.pageId) {
    const idx = ed.doc.pages.findIndex((p) => p.id === anchor.pageId);
    if (idx >= 0 && idx !== ed.activePage) ed.setActivePage(idx);
  }

  // A live element anchor: select it and frame it (reuses existing store APIs).
  if (anchor.kind === "element" && !anchor.orphaned && anchor.nodeId) {
    const here = useEditor.getState();
    if (here.doc.pages[here.activePage]?.children.some((n) => n.id === anchor.nodeId)) {
      here.select([anchor.nodeId]);
      here.zoomToSelection();
      return;
    }
  }

  // Otherwise center the viewport on the pin's page point at the current zoom.
  const here = useEditor.getState();
  const pt = anchorPagePoint(anchor, here.doc);
  if (!pt) return;
  const { zoom } = here.viewport;
  const { width: vw, height: vh } = here.viewportSize;
  if (!vw || !vh || zoom <= 0) return;
  here.setViewport({ panX: pt.x - vw / 2 / zoom, panY: pt.y - vh / 2 / zoom });
}

/** A textarea with @mention autocomplete. Reports the typed text and the picked
 *  mention user ids (sent explicitly to the API, more robust than body parsing). */
function Composer({
  people,
  disabled,
  placeholder,
  submitLabel,
  initial,
  onSubmit,
  onCancel,
}: {
  people: MentionablePerson[];
  disabled?: boolean;
  placeholder: string;
  submitLabel: string;
  initial?: string;
  onSubmit: (body: string, mentions: string[]) => Promise<void> | void;
  onCancel?: () => void;
}) {
  const [text, setText] = useState(initial ?? "");
  const [mentions, setMentions] = useState<string[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const matches = useMemo(() => {
    if (query == null) return [];
    const q = query.toLowerCase();
    return people.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 6);
  }, [query, people]);

  function onChange(value: string) {
    setText(value);
    // Detect a trailing "@token" at the caret to drive the picker.
    const m = /(^|\s)@([\w.-]*)$/.exec(value.slice(0, ref.current?.selectionStart ?? value.length));
    setQuery(m ? m[2] : null);
  }

  function pick(p: MentionablePerson) {
    // Replace the trailing @token with the person's name and record the id.
    setText((prev) => prev.replace(/(^|\s)@([\w.-]*)$/, (_all, pre) => `${pre}@${p.name} `));
    setMentions((prev) => (prev.includes(p.id) ? prev : [...prev, p.id]));
    setQuery(null);
    ref.current?.focus();
  }

  async function submit() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await onSubmit(body, mentions);
      setText("");
      setMentions([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      {query != null && matches.length > 0 && (
        <div className="absolute bottom-full start-0 z-20 mb-1 w-60 overflow-hidden rounded-xl border border-neutral-200 bg-surface p-1 shadow-lg ring-1 ring-black/5">
          {matches.map((p) => (
            <button
              key={p.id}
              // preventDefault keeps the textarea focused; the action itself runs
              // on click so a keyboard Enter on the option works too.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(p)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start hover:bg-neutral-100"
            >
              <Avatar name={p.name} id={p.id} size={24} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-neutral-800">{p.name}</span>
                {p.email && <span className="block truncate text-xs text-neutral-400">{p.email}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        rows={2}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
        }}
        className="w-full resize-none rounded-lg border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-brand-400 disabled:bg-neutral-50"
      />
      <div className="mt-1 flex items-center justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>{tr("editor.cancel")}</Button>
        )}
        <Button size="sm" onClick={() => void submit()} disabled={disabled || busy || !text.trim()}>
          <Send size={14} /> {submitLabel}
        </Button>
      </div>
    </div>
  );
}

/** Existing reaction pills (shown only when there are reactions). */
function ReactionPills({ comment, canComment, userId, onReact }: { comment: Comment; canComment: boolean; userId: string | null; onReact: (emoji: string) => void }) {
  if (!comment.reactions.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {comment.reactions.map((r) => {
        const mine = !!userId && r.userIds.includes(userId);
        return (
          <button
            key={r.emoji}
            disabled={!canComment}
            onClick={() => onReact(r.emoji)}
            className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition disabled:opacity-60 ${mine ? "border-brand-300 bg-brand-50 text-brand-ink" : "border-neutral-200 text-neutral-600 hover:bg-neutral-50"}`}
            title={`${r.userIds.length} reaction(s)`}
          >
            <span>{r.emoji}</span>
            <span className={mine ? "text-brand-ink" : "text-neutral-500"}>{r.userIds.length}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The add-reaction button + emoji popover, for the hover action toolbar. */
function ReactButton({ onReact }: { onReact: (emoji: string) => void }) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setPicking((v) => !v)} className="grid h-6 w-6 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600" title={tr("editor.add_reaction")}>
        <Smile size={14} />
      </button>
      {picking && (
        <div className="absolute end-0 z-20 mt-1 flex gap-1 rounded-lg border border-neutral-200 bg-surface p-1 shadow-lg ring-1 ring-black/5">
          {/* preventDefault keeps the composer's focus; the action runs on
              click so a keyboard Enter on the option works too. */}
          {REACTIONS.map((e) => (
            <button key={e} onMouseDown={(ev) => ev.preventDefault()} onClick={() => { onReact(e); setPicking(false); }} className="rounded px-1 text-base hover:bg-neutral-100">{e}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The convert-to-task / task controls for a thread root. */
function TaskControls({ comment, people, canComment, open, onClose, onChange }: { comment: Comment; people: MentionablePerson[]; canComment: boolean; open: boolean; onClose: () => void; onChange: () => void }) {
  const toast = useToast();
  const task = comment.task ?? null;
  // The full editor is collapsed to a one-line summary by default. It shows when
  // the user expands the summary, or when the parent opened the form via the
  // footer "Task" trigger (no task yet) so it can be filled in.
  const [expanded, setExpanded] = useState(false);
  const showEditor = expanded || open;

  async function patch(input: { assigneeId?: string | null; status?: TaskStatus | null; dueAt?: string | null }) {
    try {
      await oc.setCommentTask(comment.id, input);
      onChange();
    } catch {
      toast.error(tr("editor.could_not_update_the_task"));
    }
  }

  // Nothing to show until a task exists or the user opened the form.
  if (!task && !showEditor) return null;

  const assigneeName = task?.assigneeId ? people.find((p) => p.id === task.assigneeId)?.name ?? tr("editor.someone") : tr("editor.unassigned");
  const dueShort = task?.dueAt ? new Date(task.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;

  // Collapsed one-line summary: status · assignee · due. Click to expand.
  if (task && !showEditor) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="mt-2 flex w-full items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-xs transition hover:bg-neutral-100"
      >
        <CheckSquare size={13} className="shrink-0 text-brand-ink" />
        <span className="shrink-0 rounded-full bg-surface px-1.5 py-0.5 text-[11px] text-neutral-600 ring-1 ring-neutral-200">{statusLabel()[task.status]}</span>
        <span className="min-w-0 flex-1 truncate text-start text-neutral-600">{assigneeName}</span>
        {dueShort && <span className="shrink-0 text-neutral-400">Due {dueShort}</span>}
        <ChevronDown size={13} className="shrink-0 text-neutral-400" />
      </button>
    );
  }

  // Expanded editor.
  const collapse = () => { setExpanded(false); onClose(); };
  return (
    <div className="mt-2 rounded-lg border border-neutral-200 bg-neutral-50 p-2 text-xs">
      <div className="flex items-center gap-2">
        <CheckSquare size={13} className="text-brand-ink" />
        <span className="font-semibold text-neutral-700">{tr("editor.task")}</span>
        {task && <span className="rounded-full bg-surface px-1.5 py-0.5 text-[11px] text-neutral-600 ring-1 ring-neutral-200">{statusLabel()[task.status]}</span>}
        <button onClick={collapse} className="ms-auto grid h-5 w-5 place-items-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700" title={tr("editor.collapse")}><ChevronUp size={14} /></button>
      </div>
      <div className="mt-2 grid gap-1.5">
        <label className="flex items-center gap-2">
          <span className="w-16 text-neutral-500">{tr("editor.assignee")}</span>
          <select
            value={task?.assigneeId ?? ""}
            disabled={!canComment}
            onChange={(e) => void patch({ assigneeId: e.target.value || null, status: task?.status ?? "open" })}
            className="flex-1 rounded border border-neutral-200 px-1.5 py-1"
          >
            <option value="">{tr("editor.unassigned")}</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="w-16 text-neutral-500">{tr("editor.status")}</span>
          <select
            value={task?.status ?? "open"}
            disabled={!canComment}
            onChange={(e) => void patch({ status: e.target.value as TaskStatus })}
            className="flex-1 rounded border border-neutral-200 px-1.5 py-1"
          >
            {(["open", "in_progress", "done"] as TaskStatus[]).map((s) => <option key={s} value={s}>{statusLabel()[s]}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="w-16 text-neutral-500">{tr("editor.due")}</span>
          <input
            type="date"
            value={task?.dueAt ? task.dueAt.slice(0, 10) : ""}
            disabled={!canComment}
            onChange={(e) => void patch({ dueAt: e.target.value || null, status: task?.status ?? "open" })}
            className="flex-1 rounded border border-neutral-200 px-1.5 py-1"
          />
        </label>
      </div>
      {canComment && task && (
        <div className="mt-2 flex justify-end">
          <button onClick={() => void patch({ assigneeId: null, status: null, dueAt: null }).then(collapse)} className="text-neutral-400 hover:text-red-500">
            {tr("editor.remove_task")}
          </button>
        </div>
      )}
    </div>
  );
}

/** One comment (root or reply) row. */
function CommentRow({ comment, people, canComment, userId, isRoot, onChanged }: {
  comment: Comment;
  people: MentionablePerson[];
  canComment: boolean;
  userId: string | null;
  isRoot: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const mine = !!userId && comment.authorId === userId;

  async function react(emoji: string) {
    try { await oc.reactComment(comment.id, emoji); onChanged(); } catch { toast.error(tr("editor.reaction_failed")); }
  }
  async function remove() {
    try { await oc.deleteComment(comment.id); onChanged(); } catch { toast.error(tr("editor.delete_failed")); }
  }
  async function saveEdit(body: string, mentions: string[]) {
    try { await oc.editComment(comment.id, { body, mentions }); setEditing(false); onChanged(); }
    catch { toast.error(tr("editor.edit_failed")); }
  }

  return (
    <div className="group/row relative flex gap-2.5">
      <Avatar name={comment.authorName} id={comment.authorId} size={isRoot ? 28 : 24} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-semibold text-neutral-800">{comment.authorName}</span>
          <span className="ms-auto shrink-0 text-[11px] text-neutral-400">{relativeTime(comment.createdAt)}{comment.editedAt ? " · edited" : ""}</span>
        </div>
        {editing ? (
          <div className="mt-1">
            <Composer people={people} placeholder={tr("editor.edit_comment")} submitLabel={tr("editor.save")} initial={comment.body} onSubmit={saveEdit} onCancel={() => setEditing(false)} />
          </div>
        ) : (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-snug text-neutral-700">{comment.body}</p>
        )}
        {!editing && <ReactionPills comment={comment} canComment={canComment} userId={userId} onReact={react} />}
      </div>
      {/* Hover toolbar: react + author edit/delete, floating top-right so the
          resting card stays clean (a common design-tool pattern). */}
      {!editing && (canComment || mine) && (
        <div className="absolute end-0 top-0 flex items-center gap-0.5 rounded-lg border border-neutral-200 bg-surface p-0.5 opacity-0 shadow-sm ring-1 ring-black/5 transition focus-within:opacity-100 group-hover/row:opacity-100">
          {canComment && <ReactButton onReact={react} />}
          {mine && (
            <button onClick={() => setEditing(true)} className="grid h-6 w-6 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" title={tr("editor.edit")}><Pencil size={13} /></button>
          )}
          {mine && (
            <button onClick={() => void remove()} className="grid h-6 w-6 place-items-center rounded-md text-neutral-400 hover:bg-red-50 hover:text-red-500" title={tr("editor.delete")}><Trash2 size={13} /></button>
          )}
        </div>
      )}
    </div>
  );
}

/** A full thread: the root, its task controls, replies, and a reply composer. */
function Thread({ thread, people, canComment, userId, onChanged }: {
  thread: CommentThread;
  people: MentionablePerson[];
  canComment: boolean;
  userId: string | null;
  onChanged: () => void;
}) {
  const toast = useToast();
  const openThreadId = useComments((s) => s.openThreadId);
  const expanded = openThreadId === thread.id;
  const [replying, setReplying] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);

  async function toggleResolve() {
    try { await oc.resolveComment(thread.id, !thread.resolved); onChanged(); }
    catch { toast.error(tr("editor.could_not_update_the_thread")); }
  }
  async function reply(body: string, mentions: string[]) {
    try { await oc.replyComment(thread.id, { body, mentions }); setReplying(false); onChanged(); }
    catch { toast.error(tr("editor.reply_failed")); }
  }

  // Open + highlight a thread and bring its pin into view; collapsing it leaves
  // the viewport alone. Shared by the row click and the replies toggle.
  function openAndReveal() {
    if (expanded) {
      useComments.getState().setOpenThread(null);
      return;
    }
    useComments.getState().setOpenThread(thread.id);
    jumpToThread(thread);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      className={`cursor-pointer rounded-xl border p-3 transition ${thread.resolved ? "border-neutral-100 bg-neutral-50/60" : "border-neutral-200 bg-surface hover:border-neutral-300"} ${expanded ? "ring-1 ring-brand-200" : ""}`}
      onClick={openAndReveal}
      onKeyDown={(e) => {
        // Keys from the card's inner controls bubble here; only toggle when the
        // card itself is focused.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openAndReveal(); }
      }}
    >
      <div onClick={(e) => e.stopPropagation()}>
        <div className="mb-1.5 flex flex-wrap gap-1.5 empty:hidden">
          {thread.resolved && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700"><Check size={11} /> {tr("editor.resolved")}</span>
          )}
          {thread.anchor.orphaned && (
            <span className="inline-block rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">{tr("editor.detached_element_deleted")}</span>
          )}
        </div>
        <CommentRow comment={thread} people={people} canComment={canComment} userId={userId} isRoot onChanged={onChanged} />
        <TaskControls comment={thread} people={people} canComment={canComment} open={taskOpen} onClose={() => setTaskOpen(false)} onChange={onChanged} />

        {expanded && thread.replies.length > 0 && (
          <div className="ms-3.5 mt-3 space-y-3 border-s border-neutral-100 ps-3">
            {thread.replies.map((r) => (
              <CommentRow key={r.id} comment={r} people={people} canComment={canComment} userId={userId} isRoot={false} onChanged={onChanged} />
            ))}
          </div>
        )}

        <div className="mt-2 flex items-center gap-3 border-t border-neutral-100 pt-2 text-[11px] text-neutral-500">
          {canComment && (
            <button onClick={() => setReplying((v) => !v)} className="flex items-center gap-1 hover:text-neutral-800"><CornerDownRight size={12} /> {tr("editor.reply")}</button>
          )}
          {canComment && !thread.task && !taskOpen && (
            <button onClick={() => setTaskOpen(true)} className="flex items-center gap-1 hover:text-neutral-800"><CheckSquare size={12} /> {tr("editor.task")}</button>
          )}
          {thread.replies.length > 0 && (
            <button onClick={openAndReveal} className="hover:text-neutral-800">
              {expanded ? tr("editor.hide") : `${thread.replies.length} ${thread.replies.length === 1 ? "reply" : "replies"}`}
            </button>
          )}
          {canComment && (
            <button onClick={() => void toggleResolve()} className="ms-auto flex items-center gap-1 hover:text-neutral-800">
              {thread.resolved ? <><RotateCcw size={12} /> {tr("editor.reopen")}</> : <><Check size={12} /> {tr("editor.resolve")}</>}
            </button>
          )}
        </div>

        {replying && (
          <div className="mt-2">
            <Composer people={people} placeholder={tr("editor.write_a_reply_use_to_mention")} submitLabel={tr("editor.reply")} onSubmit={reply} onCancel={() => setReplying(false)} />
          </div>
        )}
      </div>
    </div>
  );
}

export function CommentsPanel({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const designId = useComments((s) => s.designId);
  const canComment = useComments((s) => s.canComment);
  const threads = useComments((s) => s.threads);
  const loading = useComments((s) => s.loading);
  const filter = useComments((s) => s.filter);
  const draftAnchor = useComments((s) => s.draftAnchor);
  const [people, setPeople] = useState<MentionablePerson[]>([]);
  const userId = useAuth((s) => s.user?.id ?? null);
  const userName = useAuth((s) => s.user?.name ?? tr("editor.you"));

  const refresh = () => void useComments.getState().refresh();

  // Load the mentionable-people list once per design.
  useEffect(() => {
    if (!designId) return;
    let cancelled = false;
    void oc.mentionablePeople(designId).then((p) => { if (!cancelled) setPeople(p); }).catch(() => {});
    return () => { cancelled = true; };
  }, [designId]);

  async function postNew(body: string, mentions: string[]) {
    if (!designId) return;
    const anchor = draftAnchor ?? { kind: "design" as const };
    try {
      await oc.createComment(designId, { anchor, body, mentions });
      useComments.getState().setDraftAnchor(null);
      refresh();
    } catch {
      toast.error(tr("editor.could_not_post_the_comment"));
    }
  }

  return (
    <aside className="oc-scroll flex w-80 shrink-0 flex-col overflow-hidden border-s border-neutral-200 bg-surface">
      <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2.5">
        <MessageSquare size={18} className="text-brand-ink" />
        <span className="text-sm font-semibold text-neutral-800">{tr("editor.comments")}</span>
        {threads.length > 0 && (
          <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-neutral-500">{threads.length}</span>
        )}
        <IconButton className="ms-auto" aria-label={tr("editor.close_comments")} onClick={onClose}><X size={18} /></IconButton>
      </div>

      <div className="oc-scroll flex flex-nowrap gap-1 overflow-x-auto border-b border-neutral-100 px-3 py-2">
        {filters().map((f) => (
          <button
            key={f.id}
            onClick={() => useComments.getState().setFilter(f.id)}
            aria-pressed={filter === f.id}
            className={`shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium transition ${filter === f.id ? "bg-brand-50 text-brand-ink" : "text-neutral-500 hover:bg-neutral-100"}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {!designId ? (
        <div className="flex-1 grid place-items-center p-6 text-center text-sm text-neutral-400">
          {tr("editor.save_this_design_to_start_commenting")}
        </div>
      ) : (
        <>
          <div className="oc-scroll flex-1 space-y-2 overflow-y-auto p-3">
            {!canComment && (
              <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-800">You have view-only access; you can read comments but not post.</p>
            )}
            {loading && threads.length === 0 ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="animate-pulse rounded-xl border border-neutral-100 p-3">
                    <div className="flex gap-2.5">
                      <div className="h-7 w-7 shrink-0 rounded-full bg-neutral-100" />
                      <div className="flex-1 space-y-2 pt-0.5">
                        <div className="h-2.5 w-24 rounded bg-neutral-100" />
                        <div className="h-2.5 w-full rounded bg-neutral-100" />
                        <div className="h-2.5 w-2/3 rounded bg-neutral-100" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : threads.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <div className="grid h-12 w-12 place-items-center rounded-full bg-neutral-100 text-neutral-400">
                  <MessageSquare size={22} />
                </div>
                <p className="text-sm font-medium text-neutral-600">{tr("editor.no_comments_yet")}</p>
                <p className="max-w-[12rem] text-xs text-neutral-400">
                  {canComment ? tr("editor.leave_the_first_comment_or_click_the_canvas") : tr("editor.comments_will_show_up_here")}
                </p>
              </div>
            ) : (
              threads.map((t) => (
                <Thread key={t.id} thread={t} people={people} canComment={canComment} userId={userId} onChanged={refresh} />
              ))
            )}
          </div>

          {canComment && (
            <div className="border-t border-neutral-200 p-3">
              {draftAnchor && (
                <div className="mb-1.5 flex items-center justify-between rounded-lg bg-brand-50 px-2 py-1 text-[11px] text-brand-ink">
                  <span className="flex items-center gap-1"><MessageSquare size={11} /> {draftAnchor.kind === "element" ? tr("editor.commenting_on_an_element") : tr("editor.commenting_on_a_spot")}</span>
                  <button onClick={() => useComments.getState().setDraftAnchor(null)} className="font-medium hover:underline">{tr("editor.clear")}</button>
                </div>
              )}
              <div className="flex gap-2.5">
                <Avatar name={userName} id={userId} size={28} />
                <div className="min-w-0 flex-1">
                  <Composer
                    people={people}
                    placeholder={draftAnchor ? "Comment on this pin… use @ to mention" : "Add a comment… use @ to mention"}
                    submitLabel={tr("editor.comment")}
                    onSubmit={postNew}
                  />
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
