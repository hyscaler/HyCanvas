// An assistant reply, rendered from the light markdown models write in. No
// HTML is injected: the parser yields blocks and inline runs, and this maps
// them to elements, so a model's (or a read source's) text never reaches the
// page as markup.
import { useEffect, useState } from "react";
import { cutBlocks, parseChatMarkdown, type Inline } from "@/lib/chatMarkdown";

function Inlines({ runs }: { runs: Inline[] }) {
  return (
    <>
      {runs.map((r, i) => {
        switch (r.kind) {
          case "bold": return <strong key={i} className="font-semibold">{r.text}</strong>;
          case "italic": return <em key={i}>{r.text}</em>;
          case "code": return <code key={i} className="rounded bg-neutral-200/70 px-1 py-px font-mono text-[0.85em]">{r.text}</code>;
          case "link": return <a key={i} href={r.href} target="_blank" rel="noopener noreferrer" className="text-brand-ink underline underline-offset-2">{r.text}</a>;
          default: return <span key={i}>{r.text}</span>;
        }
      })}
    </>
  );
}

export function ChatMarkdown({ text, className, limit }: { text: string; className?: string; limit?: number }) {
  const parsed = parseChatMarkdown(text);
  const blocks = limit === undefined ? parsed : cutBlocks(parsed, limit);
  return (
    <div className={["space-y-2", className].filter(Boolean).join(" ")}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading":
            return <p key={i} className="font-semibold"><Inlines runs={b.inlines} /></p>;
          case "list":
            return b.ordered
              ? <ol key={i} className="list-decimal space-y-0.5 ps-5">{b.items.map((it, j) => <li key={j}><Inlines runs={it} /></li>)}</ol>
              : <ul key={i} className="list-disc space-y-0.5 ps-5">{b.items.map((it, j) => <li key={j}><Inlines runs={it} /></li>)}</ul>;
          case "code":
            return <pre key={i} className="overflow-x-auto rounded-lg bg-neutral-200/60 px-2.5 py-2 font-mono text-[12px] leading-5"><code>{b.text}</code></pre>;
          default:
            return <p key={i} className="whitespace-pre-wrap"><Inlines runs={b.inlines} /></p>;
        }
      })}
    </div>
  );
}

/** How many characters a reveal adds per frame: a reply arrives at reading
 *  pace rather than all at once, the way a chat shows an answer. */
const REVEAL_STEP = 6;

const reducedMotion = (): boolean => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** A reply revealed progressively on arrival, formatting intact; a reply
 *  that was already there (a restored conversation) and a reader who asked
 *  for reduced motion get it whole. */
export function RevealingMarkdown({ text, animate, className }: { text: string; animate: boolean; className?: string }) {
  const total = text.length;
  const [shown, setShown] = useState(() => (animate && !reducedMotion() ? 0 : total));
  const done = shown >= total;
  useEffect(() => {
    if (done) return;
    const id = window.setInterval(() => setShown((n) => Math.min(total, n + REVEAL_STEP)), 16);
    return () => window.clearInterval(id);
  }, [done, total]);
  return <ChatMarkdown text={text} className={className} limit={done ? undefined : shown} />;
}
