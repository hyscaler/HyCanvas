// The light markdown an assistant reply is written in, parsed to blocks the
// chat renders: paragraphs, headings, bullet and numbered lists, fenced code,
// with bold, italic, inline code and links inside. A model answers with
// "**Tranche plan:** four tranches" and the chat used to show the asterisks.
// Pure and small on purpose: no HTML is produced, so nothing a model (or a
// source it read) writes can reach the page as markup.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "heading"; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "code"; text: string };

const BULLET = /^\s{0,3}(?:[-*•]|\d{1,3}[.)])\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,3}[.)]\s+/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const FENCE = /^\s{0,3}```/;

/** Only web links become anchors; anything else stays text. */
const SAFE_HREF = /^https?:\/\/[^\s<>"']+$/i;

/** Inline markup within one run of text. */
export function parseInlines(text: string): Inline[] {
  const out: Inline[] = [];
  // Tokens, longest first: code, bold, italic (asterisk or underscore),
  // markdown links, bare web links.
  // Emphasis opens and closes on a non-space character, so "2 * 3 * 4"
  // and a stray asterisk stay text.
  const re = /(`[^`\n]+`)|(\*\*(?!\s)[^*\n]+?(?<!\s)\*\*)|(__(?!\s)[^_\n]+?(?<!\s)__)|(\*(?!\s)[^*\n]+?(?<!\s)\*)|(\b_(?!\s)[^_\n]+?(?<!\s)_\b)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>"')\]]+)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    const [whole] = m;
    if (m[1]) out.push({ kind: "code", text: whole.slice(1, -1) });
    else if (m[2] || m[3]) out.push({ kind: "bold", text: whole.slice(2, -2) });
    else if (m[4] || m[5]) out.push({ kind: "italic", text: whole.slice(1, -1) });
    else if (m[6]) {
      const label = whole.slice(1, whole.indexOf("]("));
      const href = m[7];
      out.push(SAFE_HREF.test(href) ? { kind: "link", text: label, href } : { kind: "text", text: label });
    } else if (m[8]) {
      // A trailing full stop or comma belongs to the sentence, not the URL.
      const trimmed = whole.replace(/[.,;:!?]+$/, "");
      out.push({ kind: "link", text: trimmed, href: trimmed });
      if (trimmed.length < whole.length) out.push({ kind: "text", text: whole.slice(trimmed.length) });
    }
    last = m.index + whole.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out.length ? out : [{ kind: "text", text }];
}

/** The reply as blocks. Lines inside a paragraph keep their breaks. */
export function parseChatMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    blocks.push({ kind: "paragraph", inlines: parseInlines(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const h = HEADING.exec(line);
    if (h) { flush(); blocks.push({ kind: "heading", inlines: parseInlines(h[1].trim()) }); continue; }
    if (BULLET.test(line)) {
      flush();
      const ordered = ORDERED.test(line);
      const items: Inline[][] = [];
      while (i < lines.length && BULLET.test(lines[i]) && ORDERED.test(lines[i]) === ordered) {
        items.push(parseInlines(BULLET.exec(lines[i])![1].trim()));
        i++;
      }
      i--;
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

/** True when the text carries any markup worth parsing; plain prose renders
 *  as one paragraph either way, this just lets a caller skip the work. */
export function hasMarkdown(text: string): boolean {
  return /(\*\*|`|^\s{0,3}(?:[-*•]|\d{1,3}[.)]|#{1,6})\s|\[[^\]]+\]\(https?:|https?:\/\/)/m.test(text);
}

/** The blocks cut to the first `limit` characters of visible text, so a
 *  reply can be revealed progressively while keeping its formatting. */
export function cutBlocks(blocks: Block[], limit: number): Block[] {
  let left = Math.max(0, limit);
  const out: Block[] = [];
  const cutInlines = (runs: Inline[]): Inline[] => {
    const res: Inline[] = [];
    for (const r of runs) {
      if (left <= 0) break;
      if (r.text.length <= left) { res.push(r); left -= r.text.length; }
      else { res.push({ ...r, text: r.text.slice(0, left) }); left = 0; }
    }
    return res;
  };
  for (const b of blocks) {
    if (left <= 0) break;
    if (b.kind === "code") {
      out.push(b.text.length <= left ? b : { kind: "code", text: b.text.slice(0, left) });
      left -= b.text.length;
    } else if (b.kind === "list") {
      const items: Inline[][] = [];
      for (const it of b.items) {
        if (left <= 0) break;
        items.push(cutInlines(it));
      }
      out.push({ ...b, items });
    } else {
      out.push({ ...b, inlines: cutInlines(b.inlines) });
    }
  }
  return out;
}
