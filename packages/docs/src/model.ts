// @hc/docs block model (F31).
//
// A "doc" is a DesignFile whose `meta.kind === "doc"`. Its content is an ordered
// list of typed content blocks stored in meta (NOT scene-graph nodes). The block
// model is defined here, framework-agnostic, with plain TS interfaces, a
// discriminated union, constructors, and pure text/array helpers.

import { newId as schemaNewId } from "@hc/schema";

// ---------------------------------------------------------------------------
// Inline rich text (produced/edited by the text engine at runtime; modeled plainly here)
// ---------------------------------------------------------------------------

export type TextMark =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "code"
  | { color: string };

export interface TextRun {
  text: string;
  marks?: TextMark[];
  link?: string;
}

export interface RichText {
  runs: TextRun[];
}

// ---------------------------------------------------------------------------
// Block types
// ---------------------------------------------------------------------------

export type DocBlockType =
  | "paragraph"
  | "heading"
  | "list"
  | "quote"
  | "code"
  | "divider"
  | "image"
  | "chartEmbed"
  | "table"
  | "callout"
  | "embed";

export interface DocBlockBase {
  id: string;
  type: DocBlockType;
}

export interface ParagraphBlock extends DocBlockBase {
  type: "paragraph";
  text: RichText;
}

export interface HeadingBlock extends DocBlockBase {
  type: "heading";
  level: 1 | 2 | 3;
  text: RichText;
}

export interface ListItem {
  id: string;
  text: RichText;
  checked?: boolean;
  depth: number;
}

export interface ListBlock extends DocBlockBase {
  type: "list";
  style: "bullet" | "numbered" | "checklist";
  items: ListItem[];
}

export interface QuoteBlock extends DocBlockBase {
  type: "quote";
  text: RichText;
}

export interface CodeBlock extends DocBlockBase {
  type: "code";
  language?: string;
  code: string;
}

export interface DividerBlock extends DocBlockBase {
  type: "divider";
}

export interface ImageBlock extends DocBlockBase {
  type: "image";
  assetId: string;
  url: string;
  caption?: RichText;
  alt?: string;
}

export interface ChartEmbedBlock extends DocBlockBase {
  type: "chartEmbed";
  chartId: string;
}

export interface TableColumn {
  align: "left" | "center" | "right";
}

export interface TableRow {
  id: string;
  cells: RichText[];
}

export interface TableBlock extends DocBlockBase {
  type: "table";
  headerRow: boolean;
  columns: TableColumn[];
  rows: TableRow[];
}

export interface CalloutBlock extends DocBlockBase {
  type: "callout";
  icon?: string;
  tone: "info" | "warn" | "success";
  text: RichText;
}

export interface EmbedBlock extends DocBlockBase {
  type: "embed";
  url: string;
  provider?: string;
}

export type DocBlock =
  | ParagraphBlock
  | HeadingBlock
  | ListBlock
  | QuoteBlock
  | CodeBlock
  | DividerBlock
  | ImageBlock
  | ChartEmbedBlock
  | TableBlock
  | CalloutBlock
  | EmbedBlock;

/** doc-kind meta extension stored on `DesignFile.meta`. */
export interface DocMeta {
  kind: "doc";
  blockOrder: string[];
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * Fresh block/item id. Reuses @hc/schema's `newId` (UUID v4) so doc ids are
 * consistent with the rest of the open format. The optional `seed` produces a
 * deterministic id, which keeps tests stable when desired.
 */
export function newId(seed?: string | number): string {
  if (seed !== undefined) return `b_${seed}`;
  return schemaNewId();
}

// ---------------------------------------------------------------------------
// RichText helpers
// ---------------------------------------------------------------------------

/** Concatenate all run text into a single plain string. */
export function richTextToPlain(rt: RichText): string {
  return rt.runs.map((r) => r.text).join("");
}

/** Wrap a plain string as a single unstyled run. */
export function plainToRichText(s: string): RichText {
  return { runs: [{ text: s }] };
}

function emptyRich(): RichText {
  return { runs: [] };
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function newParagraph(text?: RichText | string): ParagraphBlock {
  return {
    id: newId(),
    type: "paragraph",
    text: typeof text === "string" ? plainToRichText(text) : text ?? emptyRich(),
  };
}

export function newHeading(level: 1 | 2 | 3, text?: RichText | string): HeadingBlock {
  return {
    id: newId(),
    type: "heading",
    level,
    text: typeof text === "string" ? plainToRichText(text) : text ?? emptyRich(),
  };
}

export function newList(
  style: ListBlock["style"] = "bullet",
  items: ListItem[] = [],
): ListBlock {
  return { id: newId(), type: "list", style, items };
}

export function newListItem(text?: RichText | string, depth = 0): ListItem {
  return {
    id: newId(),
    text: typeof text === "string" ? plainToRichText(text) : text ?? emptyRich(),
    depth,
  };
}

export function newQuote(text?: RichText | string): QuoteBlock {
  return {
    id: newId(),
    type: "quote",
    text: typeof text === "string" ? plainToRichText(text) : text ?? emptyRich(),
  };
}

export function newCode(code = "", language?: string): CodeBlock {
  return { id: newId(), type: "code", code, language };
}

export function newDivider(): DividerBlock {
  return { id: newId(), type: "divider" };
}

export function newImage(init: {
  assetId?: string;
  url: string;
  caption?: RichText;
  alt?: string;
}): ImageBlock {
  return {
    id: newId(),
    type: "image",
    assetId: init.assetId ?? "",
    url: init.url,
    caption: init.caption,
    alt: init.alt,
  };
}

export function newChartEmbed(chartId: string): ChartEmbedBlock {
  return { id: newId(), type: "chartEmbed", chartId };
}

export function newTable(
  columns: TableColumn[] = [{ align: "left" }],
  rows: TableRow[] = [],
  headerRow = true,
): TableBlock {
  return { id: newId(), type: "table", headerRow, columns, rows };
}

export function newTableRow(cells: RichText[] = []): TableRow {
  return { id: newId(), cells };
}

export function newCallout(
  tone: CalloutBlock["tone"] = "info",
  text?: RichText | string,
  icon?: string,
): CalloutBlock {
  return {
    id: newId(),
    type: "callout",
    tone,
    icon,
    text: typeof text === "string" ? plainToRichText(text) : text ?? emptyRich(),
  };
}

export function newEmbed(url: string, provider?: string): EmbedBlock {
  return { id: newId(), type: "embed", url, provider };
}

// ---------------------------------------------------------------------------
// Conversion between compatible block types
// ---------------------------------------------------------------------------

const TEXT_BLOCK_TYPES: ReadonlySet<DocBlockType> = new Set([
  "paragraph",
  "heading",
  "quote",
  "callout",
]);

/** Read the inline text of any text-bearing block as plain text. */
function blockPlainText(block: DocBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "quote":
    case "callout":
      return richTextToPlain(block.text);
    case "list":
      return block.items.map((i) => richTextToPlain(i.text)).join("\n");
    case "code":
      return block.code;
    default:
      return "";
  }
}

/** Read the inline RichText of a single-text block, preserving runs. */
function blockRichText(block: DocBlock): RichText {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "quote":
    case "callout":
      return block.text;
    case "list":
      // Flatten items into one run sequence separated by newlines.
      return {
        runs: block.items.flatMap((item, i) =>
          i === 0 ? item.text.runs : [{ text: "\n" }, ...item.text.runs],
        ),
      };
    case "code":
      return plainToRichText(block.code);
    default:
      return emptyRich();
  }
}

/**
 * Convert a block between compatible text block types, preserving text.
 * Supports paragraph <-> heading <-> quote <-> callout and list <-> paragraph
 * (by joining lines into one paragraph, or splitting paragraph lines into list
 * items). The block id is preserved across conversion.
 */
export function convertBlock(block: DocBlock, toType: DocBlockType): DocBlock {
  if (block.type === toType) return block;
  const id = block.id;

  // Any text-bearing block (incl. list and code) -> code: join its text into the
  // code body, preserving the text. blockPlainText already handles every source.
  if (toType === "code" && (TEXT_BLOCK_TYPES.has(block.type) || block.type === "list" || block.type === "code")) {
    return { id, type: "code", code: blockPlainText(block) };
  }

  // list -> paragraph: join item lines into one paragraph.
  if (block.type === "list" && toType === "paragraph") {
    return { id, type: "paragraph", text: blockRichText(block) };
  }

  // paragraph (or other text block, incl. code) -> list: split text lines into items.
  if (toType === "list" && (TEXT_BLOCK_TYPES.has(block.type) || block.type === "code")) {
    const plain = blockPlainText(block);
    const lines = plain.split("\n");
    const items: ListItem[] = lines.map((line) => ({
      id: newId(),
      text: plainToRichText(line),
      depth: 0,
    }));
    return { id, type: "list", style: "bullet", items };
  }

  // Among the single-text block types (and code as a source), move the RichText
  // across, preserving runs. Code carries only plain text, so it maps via
  // blockRichText (which wraps the code body as a single run).
  if (
    (TEXT_BLOCK_TYPES.has(block.type) || block.type === "code") &&
    TEXT_BLOCK_TYPES.has(toType)
  ) {
    const text = blockRichText(block);
    switch (toType) {
      case "paragraph":
        return { id, type: "paragraph", text };
      case "heading":
        return { id, type: "heading", level: 1, text };
      case "quote":
        return { id, type: "quote", text };
      case "callout":
        return { id, type: "callout", tone: "info", text };
    }
  }

  // list -> heading/quote/callout: join then wrap.
  if (block.type === "list" && TEXT_BLOCK_TYPES.has(toType)) {
    const text = blockRichText(block);
    switch (toType) {
      case "heading":
        return { id, type: "heading", level: 1, text };
      case "quote":
        return { id, type: "quote", text };
      case "callout":
        return { id, type: "callout", tone: "info", text };
      case "paragraph":
        return { id, type: "paragraph", text };
    }
  }

  // Incompatible conversion: return the original block unchanged.
  return block;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** Pure array move: return a new order with the item at `fromIndex` moved to
 *  `toIndex`. Out-of-range indices are clamped; the input is not mutated. */
export function reorderBlocks(
  order: string[],
  fromIndex: number,
  toIndex: number,
): string[] {
  const next = order.slice();
  if (next.length === 0) return next;
  const from = Math.max(0, Math.min(fromIndex, next.length - 1));
  const to = Math.max(0, Math.min(toIndex, next.length - 1));
  if (from === to) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
