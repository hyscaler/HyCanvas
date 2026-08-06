// Live audience panel (doc 28): the interaction drawer a share-link viewer
// gets on a presented deck - emoji reactions, ask-a-question with upvotes,
// and voting on the presenter's polls. Anonymous-friendly: the viewer is
// identified only by a random client-held voter key (localStorage), used to
// de-duplicate votes. State refreshes on a short poll while the drawer is
// open (viewers hold no realtime socket).

import { useCallback, useEffect, useRef, useState } from "react";
import { Hand, Send, ThumbsUp, X, CheckCircle2 } from "lucide-react";
import type { AudienceState } from "@hc/sdk";
import { oc } from "@/lib/sdk";

const REACTIONS = ["👏", "❤️", "😂", "🎉", "🤯", "👍"];
const POLL_MS = 5000;

function voterKey(): string {
  try {
    const k = localStorage.getItem("oc-audience-key");
    if (k) return k;
    const fresh = crypto.randomUUID();
    localStorage.setItem("oc-audience-key", fresh);
    return fresh;
  } catch {
    return "anon"; // blocked storage: votes de-dupe per session only
  }
}

export function AudiencePanel({ token, password }: { token: string; password?: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<AudienceState | null>(null);
  const [name, setName] = useState("");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const key = useRef(voterKey());

  const refresh = useCallback(async () => {
    try {
      setState(await oc.audienceState(token, { voterKey: key.current, password }));
    } catch {
      // Interaction may simply be unavailable (revoked link); the drawer shows
      // an empty state rather than erroring the whole viewer.
    }
  }, [token, password]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [open, refresh]);

  // A transient "sent" note that clears itself.
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 1800);
    return () => clearTimeout(t);
  }, [note]);

  async function ask() {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await oc.audienceAsk(token, { name: name.trim() || undefined, text, password });
      setQuestion("");
      setNote("Question sent");
      await refresh();
    } catch {
      setNote("Couldn't send that");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Interact: react, ask a question, vote"
        aria-label="Open audience interaction"
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full bg-neutral-900/90 px-4 py-2.5 text-sm font-medium text-white shadow-xl backdrop-blur hover:bg-neutral-800"
      >
        <Hand size={16} /> Interact
      </button>
    );
  }

  return (
    <aside className="light fixed bottom-4 right-4 z-40 flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl">
      <header className="flex items-center justify-between border-b border-neutral-100 px-3 py-2">
        <span className="text-sm font-semibold text-neutral-800">Audience</span>
        <button onClick={() => setOpen(false)} aria-label="Close" className="rounded p-1 text-neutral-400 hover:bg-neutral-100">
          <X size={16} />
        </button>
      </header>

      <div className="oc-scroll flex-1 overflow-y-auto p-3">
        {/* Reactions: fire-and-forget; the presenter sees them float. */}
        <div className="mb-3 flex justify-between">
          {REACTIONS.map((e) => (
            <button
              key={e}
              onClick={() => {
                // Only claim it landed once it did; a rate-limited or dropped
                // reaction saying "Sent!" is just a lie to the attendee.
                void oc
                  .audienceReact(token, { emoji: e, password })
                  .then(() => setNote(`Sent ${e}`))
                  .catch(() => setNote("Could not send that reaction."));
              }}
              className="rounded-full p-1.5 text-xl transition hover:scale-125 hover:bg-neutral-100"
              aria-label={`React ${e}`}
            >
              {e}
            </button>
          ))}
        </div>

        {/* Open polls first: voting is the time-sensitive action. */}
        {(state?.polls ?? []).map((p) => {
          const total = p.counts.reduce((s, n) => s + n, 0);
          return (
            <div key={p.id} className="mb-3 rounded-xl border border-neutral-200 p-2.5">
              <p className="mb-1.5 text-sm font-medium text-neutral-800">
                {p.question}
                {!p.open && <span className="ml-1.5 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-neutral-500">closed</span>}
              </p>
              <div className="flex flex-col gap-1">
                {p.options.map((opt, i) => {
                  const pct = total ? Math.round((p.counts[i] / total) * 100) : 0;
                  const mine = p.myVote === i;
                  return (
                    <button
                      key={i}
                      disabled={!p.open}
                      onClick={() => {
                        void oc.audienceVotePoll(token, p.id, { voterKey: key.current, option: i, password }).then(refresh).catch(() => {});
                      }}
                      className={`relative overflow-hidden rounded-lg border px-2 py-1.5 text-left text-xs transition ${
                        mine ? "border-brand-400 font-semibold text-brand-ink" : "border-neutral-200 text-neutral-700 hover:border-neutral-300"
                      } ${!p.open ? "opacity-80" : ""}`}
                    >
                      <span className="absolute inset-y-0 left-0 bg-brand-100/70" style={{ width: `${pct}%` }} aria-hidden />
                      <span className="relative flex items-center justify-between">
                        <span className="truncate">{opt}</span>
                        <span className="ml-2 shrink-0 tabular-nums text-neutral-500">{pct}%</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Q&A: ask + upvote. */}
        <div className="mb-2">
          <div className="mb-1.5 flex gap-1.5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name (optional)"
              className="w-28 rounded-lg border border-neutral-200 px-2 py-1.5 text-xs outline-none focus:border-brand-400"
            />
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void ask(); }}
              placeholder="Ask a question…"
              className="min-w-0 flex-1 rounded-lg border border-neutral-200 px-2 py-1.5 text-xs outline-none focus:border-brand-400"
            />
            <button onClick={() => void ask()} disabled={busy || !question.trim()} aria-label="Send question" className="rounded-lg bg-neutral-900 px-2.5 text-white disabled:opacity-40">
              <Send size={13} />
            </button>
          </div>
          {(state?.questions ?? []).map((q) => (
            <div key={q.id} className="mb-1 flex items-start gap-2 rounded-lg bg-neutral-50 px-2 py-1.5">
              <button
                onClick={() => { void oc.audienceVoteQuestion(token, q.id, { voterKey: key.current, password }).then(refresh).catch(() => {}); }}
                disabled={q.voted}
                title={q.voted ? "You upvoted this" : "Upvote"}
                className={`mt-0.5 flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] tabular-nums ${q.voted ? "text-brand-ink" : "text-neutral-500 hover:bg-neutral-200"}`}
              >
                <ThumbsUp size={11} /> {q.votes}
              </button>
              <span className="min-w-0 flex-1 text-xs text-neutral-700">
                {q.text}
                <span className="mt-0.5 block text-[10px] text-neutral-400">
                  {q.authorName || "Anonymous"}
                  {q.answered && (
                    <span className="ml-1.5 inline-flex items-center gap-0.5 text-emerald-600"><CheckCircle2 size={10} /> answered</span>
                  )}
                </span>
              </span>
            </div>
          ))}
          {state && state.questions.length === 0 && (
            <p className="py-2 text-center text-xs text-neutral-400">No questions yet. Ask the first one!</p>
          )}
        </div>
      </div>

      {note && <div className="border-t border-neutral-100 bg-neutral-50 px-3 py-1.5 text-center text-[11px] text-neutral-500">{note}</div>}
    </aside>
  );
}
