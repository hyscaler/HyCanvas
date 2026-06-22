// @hc/docs markdown serialization (F31).
//
// GitHub-flavored markdown <-> block list. Round-trip is exact for headings,
// lists, fenced code, and paragraphs; tables, images, and inline links/marks are
// supported best-effort. Per project rules this module never emits a three-hyphen
// horizontal rule for a divider; a divider serializes as a blank-line separator.

import {
  type DocBlock,
  type ListItem,
  type RichText,
  type TableBlock,
  type TextMark,
  type TextRun,
  newCode,
  newHeading,
  newImage,
  newList,
  newListItem,
  newParagraph,
  newQuote,
  plainToRichText,
} from "./model";

// ---------------------------------------------------------------------------
// Inline run rendering
// ---------------------------------------------------------------------------

function hasMark(marks: TextMark[] | undefined, m: TextMark): boolean {
  if (!marks) return false;
  return marks.some((x) => x === m);
}

function runToMarkdown(run: TextRun): string {
  let text = run.text;
  // Wrap order (innermost first): code, then color/underline, emphasis last.
  if (hasMark(run.marks, "code")) text = "`" + text + "`";
  if (hasMark(run.marks, "strike")) text = "~~" + text + "~~";
  if (hasMark(run.marks, "italic")) text = "_" + text + "_";
  if (hasMark(run.marks, "bold")) text = "**" + text + "**";
  if (hasMark(run.marks, "underline")) text = "<u>" + text + "</u>";
  if (run.link) text = "[" + text + "](" + run.link + ")";
  return text;
}

function richToMarkdown(rt: RichText): string {
  return rt.runs.map(runToMarkdown).join("");
}

// ---------------------------------------------------------------------------
// Block -> markdown
// ---------------------------------------------------------------------------

function listItemToMarkdown(item: ListItem, style: string, index: number): string {
  const indent = "  ".repeat(Math.max(0, item.depth));
  const body = richToMarkdown(item.text);
  if (style === "numbered") return `${indent}${index + 1}. ${body}`;
  if (style === "checklist") {
    const box = item.checked ? "[x]" : "[ ]";
    return `${indent}- ${box} ${body}`;
  }
  return `${indent}- ${body}`;
}

function tableToMarkdown(block: TableBlock): string {
  const colCount = block.columns.length;
  const cellText = (row: { cells: RichText[] }, c: number): string =>
    row.cells[c] ? richToMarkdown(row.cells[c]) : "";

  const rows = block.rows;
  if (rows.length === 0 || colCount === 0) return "";

  const lines: string[] = [];
  const headerSource = rows[0];
  const bodyRows = block.headerRow ? rows.slice(1) : rows;

  // Header line (first row when headerRow, else blank header cells).
  const headerCells: string[] = [];
  for (let c = 0; c < colCount; c++) {
    headerCells.push(block.headerRow ? cellText(headerSource, c) : "");
  }
  lines.push("| " + headerCells.join(" | ") + " |");

  // Alignment separator row.
  const sep = block.columns.map((col) => {
    switch (col.align) {
      case "center":
        return ":---:";
      case "right":
        return "---:";
      default:
        return "---";
    }
  });
  lines.push("| " + sep.join(" | ") + " |");

  for (const row of bodyRows) {
    const cells: string[] = [];
    for (let c = 0; c < colCount; c++) cells.push(cellText(row, c));
    lines.push("| " + cells.join(" | ") + " |");
  }
  return lines.join("\n");
}

function blockToMarkdown(block: DocBlock): string {
  switch (block.type) {
    case "heading":
      return "#".repeat(block.level) + " " + richToMarkdown(block.text);
    case "paragraph":
      return richToMarkdown(block.text);
    case "quote":
      return "> " + richToMarkdown(block.text);
    case "callout": {
      const prefix = `[${block.tone}] `;
      return "> " + prefix + richToMarkdown(block.text);
    }
    case "list":
      return block.items
        .map((item, i) => listItemToMarkdown(item, block.style, i))
        .join("\n");
    case "code": {
      const lang = block.language ?? "";
      return "```" + lang + "\n" + block.code + "\n```";
    }
    case "divider":
      // Project rule: never emit a `---` horizontal rule. A divider is a blank
      // separator; block joining already inserts a blank line between blocks, so
      // an empty string keeps an extra gap without a rule.
      return "";
    case "image": {
      const alt = block.alt ?? "";
      return `![${alt}](${block.url})`;
    }
    case "chartEmbed":
      return `[chart:${block.chartId}]`;
    case "table":
      return tableToMarkdown(block);
    case "embed":
      return block.url;
  }
}

/** Serialize a block list to GitHub-flavored markdown. */
export function blocksToMarkdown(blocks: DocBlock[]): string {
  return blocks.map(blockToMarkdown).join("\n\n");
}

// ---------------------------------------------------------------------------
// Inline markdown -> runs
// ---------------------------------------------------------------------------

interface Token {
  text: string;
  marks: TextMark[];
  link?: string;
}

/**
 * Parse a single line of inline markdown into runs. Handles links, bold,
 * italic, strike, inline code, and <u> underline. The parser is intentionally
 * simple (no nested emphasis beyond one level) but round-trips the marks this
 * package emits.
 */
function parseInline(s: string): RichText {
  const runs: TextRun[] = [];
  let i = 0;
  let buf = "";

  const flush = (extra?: Partial<TextRun>) => {
    if (buf.length > 0) {
      runs.push({ text: buf });
      buf = "";
    }
    if (extra && extra.text !== undefined) {
      runs.push(extra as TextRun);
    }
  };

  const matchDelim = (open: string, close: string, mark: TextMark): boolean => {
    if (!s.startsWith(open, i)) return false;
    const end = s.indexOf(close, i + open.length);
    if (end === -1) return false;
    const inner = s.slice(i + open.length, end);
    flush({ text: inner, marks: [mark] });
    i = end + close.length;
    return true;
  };

  while (i < s.length) {
    // Link [text](url). The link text may itself carry emphasis/marks (for
    // example `[**bold**](url)`); parse it recursively so a styled link
    // round-trips as a run that carries both the link and the inner marks.
    if (s[i] === "[") {
      const close = s.indexOf("]", i);
      if (close !== -1 && s[close + 1] === "(") {
        const paren = s.indexOf(")", close + 2);
        if (paren !== -1) {
          const inner = s.slice(i + 1, close);
          const url = s.slice(close + 2, paren);
          flush();
          const innerRuns = parseInline(inner).runs;
          if (innerRuns.length === 0) {
            runs.push({ text: "", link: url });
          } else {
            for (const r of innerRuns) {
              runs.push({ ...r, link: url });
            }
          }
          i = paren + 1;
          continue;
        }
      }
    }
    // Underline <u>...</u>
    if (s.startsWith("<u>", i)) {
      const end = s.indexOf("</u>", i + 3);
      if (end !== -1) {
        flush({ text: s.slice(i + 3, end), marks: ["underline"] });
        i = end + 4;
        continue;
      }
    }
    if (matchDelim("**", "**", "bold")) continue;
    if (matchDelim("~~", "~~", "strike")) continue;
    if (matchDelim("`", "`", "code")) continue;
    if (matchDelim("_", "_", "italic")) continue;

    buf += s[i];
    i++;
  }
  flush();
  if (runs.length === 0) return { runs: [] };
  return { runs };
}

// ---------------------------------------------------------------------------
// Markdown -> blocks
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const BULLET_RE = /^(\s*)-\s+(.*)$/;
const CHECK_RE = /^(\s*)-\s+\[([ xX])\]\s+(.*)$/;
const NUMBERED_RE = /^(\s*)\d+\.\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const FENCE_RE = /^```(.*)$/;
const IMAGE_RE = /^!\[([^\]]*)\]\(([^)]*)\)\s*$/;
const TABLE_SEP_RE = /^\s*\|?[\s:|-]+\|?\s*$/;

function isTableRow(line: string): boolean {
  return line.trim().startsWith("|") && line.includes("|");
}

function splitTableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function parseTable(lines: string[], start: number): { block: TableBlock; next: number } | null {
  const header = lines[start];
  const sep = lines[start + 1];
  if (sep === undefined || !TABLE_SEP_RE.test(sep) || !sep.includes("|")) return null;

  const headerCells = splitTableCells(header);
  const aligns = splitTableCells(sep).map((s): TableBlock["columns"][number]["align"] => {
    const left = s.startsWith(":");
    const right = s.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });

  const columns = aligns.map((align) => ({ align }));
  const rows: TableBlock["rows"] = [];
  rows.push({ id: `r0`, cells: headerCells.map((c) => parseInline(c)) });

  let i = start + 2;
  let rIdx = 1;
  while (i < lines.length && isTableRow(lines[i]) && !TABLE_SEP_RE.test(lines[i])) {
    const cells = splitTableCells(lines[i]).map((c) => parseInline(c));
    rows.push({ id: `r${rIdx}`, cells });
    rIdx++;
    i++;
  }

  const block: TableBlock = {
    id: `t_${start}`,
    type: "table",
    headerRow: true,
    columns,
    rows,
  };
  return { block, next: i };
}

/** Parse a markdown document into a block list (common subset). */
export function markdownToBlocks(md: string): DocBlock[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: DocBlock[] = [];

  let i = 0;
  let listAccum: { style: "bullet" | "numbered" | "checklist"; items: ListItem[] } | null = null;

  const flushList = () => {
    if (listAccum) {
      blocks.push(newList(listAccum.style, listAccum.items));
      listAccum = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Blank line: ends any open list, otherwise skip.
    if (line.trim() === "") {
      flushList();
      i++;
      continue;
    }

    // Fenced code block.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushList();
      const lang = fence[1].trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push(newCode(body.join("\n"), lang || undefined));
      continue;
    }

    // Table (header row followed by a separator row).
    if (isTableRow(line)) {
      const parsed = parseTable(lines, i);
      if (parsed) {
        flushList();
        blocks.push(parsed.block);
        i = parsed.next;
        continue;
      }
    }

    // Heading.
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushList();
      const level = heading[1].length as 1 | 2 | 3;
      blocks.push(newHeading(level, parseInline(heading[2])));
      i++;
      continue;
    }

    // Image (own paragraph).
    const image = IMAGE_RE.exec(line);
    if (image) {
      flushList();
      blocks.push(newImage({ url: image[2], alt: image[1] || undefined }));
      i++;
      continue;
    }

    // Quote (and callout, encoded as `> [tone] ...`).
    const quote = QUOTE_RE.exec(line);
    if (quote) {
      flushList();
      blocks.push(newQuote(parseInline(quote[1])));
      i++;
      continue;
    }

    // Checklist item.
    const check = CHECK_RE.exec(line);
    if (check) {
      const depth = Math.floor(check[1].length / 2);
      const item = newListItem(parseInline(check[3]), depth);
      item.checked = check[2].toLowerCase() === "x";
      if (!listAccum || listAccum.style !== "checklist") {
        flushList();
        listAccum = { style: "checklist", items: [] };
      }
      listAccum.items.push(item);
      i++;
      continue;
    }

    // Bullet item.
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      const depth = Math.floor(bullet[1].length / 2);
      const item = newListItem(parseInline(bullet[2]), depth);
      if (!listAccum || listAccum.style !== "bullet") {
        flushList();
        listAccum = { style: "bullet", items: [] };
      }
      listAccum.items.push(item);
      i++;
      continue;
    }

    // Numbered item.
    const numbered = NUMBERED_RE.exec(line);
    if (numbered) {
      const depth = Math.floor(numbered[1].length / 2);
      const item = newListItem(parseInline(numbered[2]), depth);
      if (!listAccum || listAccum.style !== "numbered") {
        flushList();
        listAccum = { style: "numbered", items: [] };
      }
      listAccum.items.push(item);
      i++;
      continue;
    }

    // Plain paragraph (single line; markdown blocks are blank-line separated).
    flushList();
    blocks.push(newParagraph(parseInline(line)));
    i++;
  }

  flushList();
  return blocks;
}

// Re-exported for convenience/testing of inline parsing.
export { parseInline as parseInlineMarkdown };

// Used by callers that want a quick plain paragraph from text.
export function paragraphFromText(text: string): DocBlock {
  return newParagraph(plainToRichText(text));
}
