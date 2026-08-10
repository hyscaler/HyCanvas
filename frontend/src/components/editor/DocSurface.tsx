// F31 Docs editing surface: a block-based document editor.
//
// Mounts in EditorApp's main flex area as a flex-1, full-height, scrollable
// container. The document's content lives entirely under `doc.meta.doc` as a
// DocMeta-like object `{ kind: "doc"; blocks: DocBlock[]; blockOrder?: string[] }`.
// We read it (plus `rev`) from the editor store and persist edits through
// `setDocMeta({ doc: nextDocMeta })`, which shallow-merges into `doc.meta` as a
// single undoable step.
//
// Block content + transforms come from the framework-agnostic `@hc/docs` core;
// this file owns only the React rendering/editing chrome (Tailwind v4). Inline
// rich-text editing is MVP plain-text: we read a block's RichText as plain text
// and write it back through `plainToRichText`, preserving the RichText model on
// disk while keeping editing simple. Text persistence is debounced (commit on
// blur or after a short pause) so a burst of keystrokes is one undoable step.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Type,
  Heading1,
  Heading2,
  Heading3,
  List as ListIcon,
  ListOrdered,
  CheckSquare,
  Quote as QuoteIcon,
  Code2,
  Minus,
  Image as ImageIcon,
  Table as TableIcon,
  Info,
  TriangleAlert,
  CheckCircle2,
  Link2,
  GripVertical,
  ChevronUp,
  ChevronDown,
  Trash2,
  Sparkles,
  Download,
  FileText,
  FileType2,
  Loader2,
  Replace,
  AlignLeft,
  AlignCenter,
  AlignRight,
  X,
  Languages,
} from "lucide-react";
import {
  newParagraph,
  newHeading,
  newList,
  newListItem,
  newQuote,
  newCode,
  newDivider,
  newImage,
  newTable,
  newTableRow,
  newCallout,
  newEmbed,
  convertBlock,
  reorderBlocks,
  blocksToMarkdown,
  richTextToPlain,
  plainToRichText,
  type DocBlock,
  type DocBlockType,
  type ListBlock,
  type ListItem,
  type TableBlock,
  type CalloutBlock,
  type HeadingBlock,
} from "@hc/docs";
import { useEditor } from "@/store/editor";
import { oc } from "@/lib/sdk";
import type { DocExportResult } from "@hc/sdk";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/cn";
import { tr } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// Doc meta shape stored under doc.meta.doc
// ---------------------------------------------------------------------------

interface DocMetaLike {
  kind: "doc";
  blocks: DocBlock[];
  blockOrder?: string[];
  /** Document text direction. "auto" (default) resolves per block from its
   *  first strong character, which is what a mixed Hebrew/English doc needs. */
  direction?: "ltr" | "rtl" | "auto";
}

/** Read a possibly-untyped meta.doc into a normalized blocks array. */
function readBlocks(raw: unknown): DocBlock[] {
  if (!raw || typeof raw !== "object") return [];
  const meta = raw as Partial<DocMetaLike>;
  const blocks = Array.isArray(meta.blocks) ? meta.blocks : [];
  if (!Array.isArray(meta.blockOrder) || meta.blockOrder.length === 0) return blocks;
  // Honor an explicit blockOrder if present, falling back to array order for any
  // ids not listed (so a malformed order never drops content).
  const byId = new Map(blocks.map((b) => [b.id, b] as const));
  const ordered: DocBlock[] = [];
  const seen = new Set<string>();
  for (const id of meta.blockOrder) {
    const b = byId.get(id);
    if (b && !seen.has(id)) {
      ordered.push(b);
      seen.add(id);
    }
  }
  for (const b of blocks) if (!seen.has(b.id)) ordered.push(b);
  return ordered;
}

const TONE_ICON = { info: Info, warn: TriangleAlert, success: CheckCircle2 } as const;

// ---------------------------------------------------------------------------
// Block insert menu definitions
// ---------------------------------------------------------------------------

interface InserterOption {
  label: string;
  icon: typeof Type;
  make: () => DocBlock;
}

const inserters = (): InserterOption[] => [
  { label: tr("editor.text"), icon: Type, make: () => newParagraph("") },
  { label: tr("editor.heading_1"), icon: Heading1, make: () => newHeading(1, "") },
  { label: tr("editor.heading_2"), icon: Heading2, make: () => newHeading(2, "") },
  { label: tr("editor.heading_3"), icon: Heading3, make: () => newHeading(3, "") },
  { label: tr("editor.bullet_list"), icon: ListIcon, make: () => newList("bullet", [newListItem("")]) },
  { label: tr("editor.numbered_list"), icon: ListOrdered, make: () => newList("numbered", [newListItem("")]) },
  { label: tr("editor.checklist"), icon: CheckSquare, make: () => newList("checklist", [newListItem("")]) },
  { label: tr("editor.quote"), icon: QuoteIcon, make: () => newQuote("") },
  { label: tr("editor.code"), icon: Code2, make: () => newCode("", "text") },
  { label: tr("editor.divider"), icon: Minus, make: () => newDivider() },
  { label: tr("editor.image"), icon: ImageIcon, make: () => newImage({ url: "" }) },
  {
    label: tr("editor.table"),
    icon: TableIcon,
    make: () =>
      newTable(
        [{ align: "left" }, { align: "left" }],
        [
          newTableRow([plainToRichText(""), plainToRichText("")]),
          newTableRow([plainToRichText(""), plainToRichText("")]),
        ],
        true,
      ),
  },
  { label: tr("editor.callout"), icon: Info, make: () => newCallout("info", "") },
  { label: tr("editor.embed"), icon: Link2, make: () => newEmbed("") },
];

// Block types offered by the per-block "change type" switcher. Only text-bearing
// types convert cleanly via convertBlock; we expose that compatible set.
const convertTypes = (): { type: DocBlockType; label: string }[] => [
  { type: "paragraph", label: tr("editor.text") },
  { type: "heading", label: tr("editor.heading") },
  { type: "quote", label: tr("editor.quote") },
  { type: "callout", label: tr("editor.callout") },
  { type: "list", label: tr("editor.list") },
  { type: "code", label: tr("editor.code") },
];

const aiActions = () => [
  { key: "rewrite", label: "Rewrite", prompt: "Rewrite the following text to read more clearly while keeping its meaning" },
  { key: "shorten", label: tr("editor.make_shorter"), prompt: "Shorten the following text, keeping the key points" },
  { key: "expand", label: "Expand", prompt: "Expand the following text with more detail and supporting context" },
  { key: "grammar", label: tr("editor.fix_grammar"), prompt: "Fix any spelling and grammar mistakes in the following text, changing nothing else" },
  { key: "summarize", label: "Summarize", prompt: "Summarize the following text in one or two sentences" },
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DocSurface(props: { workspaceId?: string; designId?: string }): React.ReactElement {
  const metaDoc = useEditor((s) => s.doc.meta.doc as unknown);
  // Subscribe to rev so external mutations (undo/redo, remote) re-render us.
  useEditor((s) => s.rev);
  const toast = useToast();

  const blocks = useMemo(() => readBlocks(metaDoc), [metaDoc]);
  const aiEnabled = Boolean(props.workspaceId);

  // Read the LIVE blocks from the store (not the closed-over render snapshot) so
  // a commit always builds on the latest document. A debounced flush from one
  // block must not clobber a concurrent edit committed by another block.
  const liveBlocks = useCallback(() => readBlocks(useEditor.getState().doc.meta.doc as unknown), []);

  // Persist a new block list as one undoable step. The existing meta is
  // SPREAD, not rebuilt: rebuilding from known fields would silently drop any
  // optional key (direction today, whatever a newer client wrote tomorrow),
  // which is exactly the data-loss shape the file-format rules forbid.
  const commit = useCallback((next: DocBlock[]) => {
    const prev = (useEditor.getState().doc.meta.doc ?? {}) as Record<string, unknown>;
    const meta: DocMetaLike = { ...prev, kind: "doc", blocks: next, blockOrder: next.map((b) => b.id) };
    useEditor.getState().setDocMeta({ doc: meta });
  }, []);

  // Per-document text direction, persisted in meta so it travels with the file.
  const direction = ((useEditor.getState().doc.meta.doc as Partial<DocMetaLike> | undefined)?.direction ?? "auto") as
    "ltr" | "rtl" | "auto";
  const setDirection = useCallback((dir: "ltr" | "rtl" | "auto") => {
    const prev = (useEditor.getState().doc.meta.doc ?? {}) as Record<string, unknown>;
    useEditor.getState().setDocMeta({ doc: { ...prev, direction: dir } });
  }, []);

  // Mutate the live block list via an updater, so every commit path reads the
  // current document at flush time (mirrors SheetSurface.commitGrid /
  // VideoSurface.persist reading live state) and never drops a concurrent edit.
  const mutate = useCallback(
    (fn: (cur: DocBlock[]) => DocBlock[]) => {
      commit(fn(liveBlocks()));
    },
    [commit, liveBlocks],
  );

  // First-mount initialization: ensure at least one empty paragraph exists.
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    if (blocks.length === 0) {
      commit([newParagraph("")]);
    }
    // Intentionally run once; we read the current blocks snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- block mutation helpers ----------------------------------------------

  const replaceBlock = useCallback(
    (id: string, next: DocBlock) => {
      mutate((cur) => cur.map((b) => (b.id === id ? next : b)));
    },
    [mutate],
  );

  const insertAfter = useCallback(
    (index: number, block: DocBlock) => {
      mutate((cur) => {
        const next = cur.slice();
        next.splice(index + 1, 0, block);
        return next;
      });
    },
    [mutate],
  );

  const deleteBlock = useCallback(
    (id: string) => {
      mutate((cur) => {
        const next = cur.filter((b) => b.id !== id);
        // Never leave a fully empty document; keep one paragraph.
        return next.length > 0 ? next : [newParagraph("")];
      });
    },
    [mutate],
  );

  const moveBlock = useCallback(
    (from: number, to: number) => {
      mutate((cur) => {
        if (to < 0 || to >= cur.length) return cur;
        const order = reorderBlocks(cur.map((b) => b.id), from, to);
        const byId = new Map(cur.map((b) => [b.id, b] as const));
        return order.map((id) => byId.get(id)!).filter(Boolean);
      });
    },
    [mutate],
  );

  const changeType = useCallback(
    (id: string, toType: DocBlockType) => {
      mutate((cur) => {
        const block = cur.find((b) => b.id === id);
        if (!block) return cur;
        return cur.map((b) => (b.id === id ? convertBlock(block, toType) : b));
      });
    },
    [mutate],
  );

  // --- export to markdown ---------------------------------------------------

  const exportMarkdown = useCallback(() => {
    const md = blocksToMarkdown(blocks);
    const title = useEditor.getState().doc.title || "document";
    const safe = title.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "document";
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safe}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [blocks]);

  // --- export to DOCX / PDF (server render job) -----------------------------

  const designId = props.designId;
  const [docExporting, setDocExporting] = useState<"docx" | "pdf" | null>(null);
  const exportDoc = useCallback(
    async (format: "docx" | "pdf") => {
      if (!designId || docExporting) return;
      setDocExporting(format);
      try {
        const { jobId } = await oc.startDocExport(designId, format);
        for (let i = 0; i < 400; i++) {
          const job = await oc.getJob<DocExportResult>(jobId);
          if (job.status === "completed") {
            const title = useEditor.getState().doc.title || "document";
            const safe = title.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "document";
            const a = document.createElement("a");
            a.href = oc.docExportDownloadUrl(designId, jobId);
            a.download = `${safe}.${format}`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            toast.success(`Exported ${format.toUpperCase()}.`);
            return;
          }
          if (job.status === "failed") {
            toast.error(job.error || tr("editor.export_failed"));
            return;
          }
          await new Promise((r) => setTimeout(r, 1200));
        }
        toast.error(tr("editor.export_timed_out"));
      } catch {
        toast.error(tr("editor.export_failed"));
      } finally {
        setDocExporting(null);
      }
    },
    [designId, docExporting, toast],
  );

  // --- inline AI ------------------------------------------------------------

  const [aiBusy, setAiBusy] = useState<string | null>(null); // blockId currently running

  const runAi = useCallback(
    async (block: DocBlock, prompt: string) => {
      if (!props.workspaceId) return;
      const text = blockPlainText(block);
      if (!text.trim()) {
        toast.toast(tr("editor.this_block_has_no_text_for_ai_to_work_on"), "info");
        return;
      }
      setAiBusy(block.id);
      try {
        const res = await oc.aiText({
          workspaceId: props.workspaceId,
          system: "You are a concise writing assistant. Reply with only the revised text, no preamble, quotes, or explanation.",
          prompt: `${prompt}:\n\n${text}`,
        });
        const out = (res?.text ?? "").trim();
        if (!out) {
          toast.error(tr("editor.the_assistant_returned_nothing_try_again"));
          return;
        }
        // Re-read the LIVE block by id at apply time: the user may have typed
        // during the async call, so applying to the render-time `block` snapshot
        // would discard those edits. Writing the AI text onto the current block
        // (same id) preserves the block's latest type while replacing its text.
        const live = liveBlocks().find((b) => b.id === block.id);
        if (!live) {
          toast.error(tr("editor.that_block_no_longer_exists"));
          return;
        }
        replaceBlock(live.id, setBlockPlainText(live, out));
        toast.success(tr("editor.applied_ai_suggestion"));
      } catch {
        toast.error(tr("editor.ai_request_failed_please_try_again"));
      } finally {
        setAiBusy(null);
      }
    },
    [props.workspaceId, replaceBlock, liveBlocks, toast],
  );

  // ---------------------------------------------------------------------------

  return (
    <div className="light flex flex-1 flex-col overflow-hidden bg-neutral-100">
      <DocToolbar
        direction={direction}
        onDirectionChange={setDirection}
        aiEnabled={aiEnabled}
        onExport={exportMarkdown}
        onExportDoc={designId ? exportDoc : undefined}
        docExporting={docExporting}
      />
      <div className="flex-1 overflow-y-auto">
        {/* Explicit direction sets the whole page; "auto" lets each block
            resolve from its own first strong character (native dir=auto). */}
        <div className="mx-auto my-10 w-full max-w-[760px] px-4" dir={direction === "auto" ? undefined : direction}>
          <div className="rounded-2xl bg-surface px-12 py-14 shadow-sm ring-1 ring-neutral-200">
            {blocks.length === 0 ? (
              <p className="text-sm text-neutral-400">{tr("editor.loading_document")}</p>
            ) : (
              <div className="flex flex-col">
                {blocks.map((block, i) => (
                  <BlockRow
                    key={block.id}
                    block={block}
                    index={i}
                    count={blocks.length}
                    aiEnabled={aiEnabled}
                    aiBusy={aiBusy === block.id}
                    onChange={(next) => replaceBlock(block.id, next)}
                    onInsertAfter={(b) => insertAfter(i, b)}
                    onDelete={() => deleteBlock(block.id)}
                    onMove={(dir) => moveBlock(i, i + dir)}
                    onChangeType={(t) => changeType(block.id, t)}
                    onAi={(p) => runAi(block, p)}
                  />
                ))}
                <TrailingInserter onInsert={(b) => insertAfter(blocks.length - 1, b)} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top toolbar
// ---------------------------------------------------------------------------

function DocToolbar({
  aiEnabled,
  onExport,
  onExportDoc,
  docExporting,
  direction,
  onDirectionChange,
}: {
  aiEnabled: boolean;
  onExport: () => void;
  onExportDoc?: (format: "docx" | "pdf") => void;
  docExporting: "docx" | "pdf" | null;
  direction: "ltr" | "rtl" | "auto";
  onDirectionChange: (d: "ltr" | "rtl" | "auto") => void;
}): React.ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 bg-surface px-4 py-2">
      <span className="text-sm font-semibold text-neutral-700">{tr("editor.document")}</span>
      <div className="flex-1" />
      <button
        type="button"
        onClick={() => onDirectionChange(direction === "auto" ? "rtl" : direction === "rtl" ? "ltr" : "auto")}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-700"
        title={tr("editor.text_direction_auto_follows_the_text_itself")}
      >
        <Languages size={14} />
        {direction === "auto" ? tr("editor.direction_auto") : direction === "rtl" ? tr("editor.direction_rtl") : tr("editor.direction_ltr")}
      </button>
      <span
        className={cn(
          "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium",
          aiEnabled ? "text-brand-ink" : "text-neutral-400",
        )}
        title={aiEnabled ? tr("editor.inline_ai_is_available_per_block") : tr("editor.ai_needs_a_workspace")}
      >
        <Sparkles size={14} />
        {aiEnabled ? tr("editor.ai_ready") : tr("editor.ai_unavailable")}
      </span>
      <Button variant="secondary" size="sm" onClick={onExport}>
        <Download size={15} />
        {tr("editor.markdown")}
      </Button>
      {onExportDoc && (
        <>
          <Button
            variant="secondary"
            size="sm"
            disabled={docExporting !== null}
            onClick={() => onExportDoc("docx")}
            title={tr("editor.export_as_a_word_document")}
          >
            {docExporting === "docx" ? <Loader2 size={15} className="animate-spin" /> : <FileText size={15} />}
            DOCX
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={docExporting !== null}
            onClick={() => onExportDoc("pdf")}
            title={tr("editor.export_as_a_pdf")}
          >
            {docExporting === "pdf" ? <Loader2 size={15} className="animate-spin" /> : <FileType2 size={15} />}
            PDF
          </Button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Block row: hover controls + the block body
// ---------------------------------------------------------------------------

function BlockRow({
  block,
  index,
  count,
  aiEnabled,
  aiBusy,
  onChange,
  onInsertAfter,
  onDelete,
  onMove,
  onChangeType,
  onAi,
}: {
  block: DocBlock;
  index: number;
  count: number;
  aiEnabled: boolean;
  aiBusy: boolean;
  onChange: (next: DocBlock) => void;
  onInsertAfter: (b: DocBlock) => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  onChangeType: (t: DocBlockType) => void;
  onAi: (prompt: string) => void;
}): React.ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [inserterOpen, setInserterOpen] = useState(false);

  const supportsText = blockSupportsText(block);

  return (
    <div className="group relative">
      {/* Left gutter controls (visible on hover) */}
      <div className="absolute -left-11 top-0 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
        <IconButton
          size="sm"
          aria-label={tr("editor.insert_block_below")}
          onClick={() => setInserterOpen((v) => !v)}
        >
          <Plus size={16} />
        </IconButton>
        <span className="cursor-grab text-neutral-300" aria-hidden>
          <GripVertical size={16} />
        </span>
      </div>

      {inserterOpen && (
        <Popover onClose={() => setInserterOpen(false)} className="left-0 top-7">
          <InserterList
            onPick={(make) => {
              onInsertAfter(make());
              setInserterOpen(false);
            }}
          />
        </Popover>
      )}

      {/* Right per-block controls */}
      <div className="absolute -right-2 top-0 z-10 flex translate-x-full items-center gap-0.5 pl-1 opacity-0 transition group-hover:opacity-100">
        {supportsText && aiEnabled && (
          <div className="relative">
            <IconButton
              size="sm"
              aria-label={tr("editor.ask_ai_2")}
              active={aiOpen}
              disabled={aiBusy}
              onClick={() => setAiOpen((v) => !v)}
            >
              <Sparkles size={15} className={aiBusy ? "animate-pulse" : ""} />
            </IconButton>
            {aiOpen && (
              <Popover onClose={() => setAiOpen(false)} className="right-0 top-9">
                <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                  {tr("editor.ask_ai_2")}
                </div>
                {aiActions().map((a) => (
                  <MenuItem
                    key={a.key}
                    onClick={() => {
                      setAiOpen(false);
                      onAi(a.prompt);
                    }}
                  >
                    <Sparkles size={14} className="text-brand-500" />
                    {a.label}
                  </MenuItem>
                ))}
              </Popover>
            )}
          </div>
        )}
        <div className="relative">
          <IconButton size="sm" aria-label={tr("editor.block_menu")} active={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
            <Replace size={15} />
          </IconButton>
          {menuOpen && (
            <Popover onClose={() => setMenuOpen(false)} className="right-0 top-9">
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                {tr("editor.turn_into")}
              </div>
              {convertTypes().map((c) => (
                <MenuItem
                  key={c.type}
                  active={block.type === c.type}
                  onClick={() => {
                    setMenuOpen(false);
                    onChangeType(c.type);
                  }}
                >
                  {c.label}
                </MenuItem>
              ))}
              <div className="my-1 h-px bg-neutral-100" />
              <MenuItem disabled={index === 0} onClick={() => { setMenuOpen(false); onMove(-1); }}>
                <ChevronUp size={14} /> {tr("editor.move_up")}
              </MenuItem>
              <MenuItem disabled={index === count - 1} onClick={() => { setMenuOpen(false); onMove(1); }}>
                <ChevronDown size={14} /> {tr("editor.move_down")}
              </MenuItem>
              <div className="my-1 h-px bg-neutral-100" />
              <MenuItem danger onClick={() => { setMenuOpen(false); onDelete(); }}>
                <Trash2 size={14} /> {tr("editor.delete")}
              </MenuItem>
            </Popover>
          )}
        </div>
      </div>

      <div className="py-1">
        <BlockBody block={block} onChange={onChange} onInsertAfter={onInsertAfter} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Block body renderers
// ---------------------------------------------------------------------------

function BlockBody({
  block,
  onChange,
  onInsertAfter,
}: {
  block: DocBlock;
  onChange: (next: DocBlock) => void;
  onInsertAfter: (b: DocBlock) => void;
}): React.ReactElement {
  switch (block.type) {
    case "paragraph":
      return (
        <TextEditable
          value={richTextToPlain(block.text)}
          placeholder={tr("editor.type_here_or_use_the_to_add_a_block")}
          className="text-[15px] leading-7 text-neutral-800"
          onCommit={(t) => onChange({ ...block, text: plainToRichText(t) })}
          onEnter={() => onInsertAfter(newParagraph(""))}
        />
      );
    case "heading": {
      const h = block as HeadingBlock;
      const size =
        h.level === 1 ? "text-3xl font-bold" : h.level === 2 ? "text-2xl font-semibold" : "text-xl font-semibold";
      return (
        <TextEditable
          value={richTextToPlain(h.text)}
          placeholder={`Heading ${h.level}`}
          className={cn("leading-tight text-neutral-900", size)}
          onCommit={(t) => onChange({ ...h, text: plainToRichText(t) })}
          onEnter={() => onInsertAfter(newParagraph(""))}
        />
      );
    }
    case "quote":
      return (
        <div className="border-l-4 border-neutral-300 pl-4">
          <TextEditable
            value={richTextToPlain(block.text)}
            placeholder={tr("editor.quote")}
            className="text-[15px] italic leading-7 text-neutral-600"
            onCommit={(t) => onChange({ ...block, text: plainToRichText(t) })}
            onEnter={() => onInsertAfter(newParagraph(""))}
          />
        </div>
      );
    case "callout":
      return <CalloutBody block={block} onChange={onChange} />;
    case "code":
      return (
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-neutral-900">
          <div className="flex items-center justify-between border-b border-neutral-700 px-3 py-1">
            <input
              value={block.language ?? ""}
              placeholder={tr("editor.language")}
              onChange={(e) => onChange({ ...block, language: e.target.value })}
              className="w-32 bg-transparent text-xs text-neutral-300 placeholder:text-neutral-500 focus:outline-none"
            />
            <Code2 size={13} className="text-neutral-500" />
          </div>
          <TextEditable
            value={block.code}
            placeholder={tr("editor.code")}
            multiline
            className="px-3 py-2 font-mono text-[13px] leading-6 text-neutral-100"
            onCommit={(t) => onChange({ ...block, code: t })}
          />
        </div>
      );
    case "divider":
      // A rendered rule (div border), never the literal characters.
      return <div className="my-3 h-px w-full bg-neutral-200" role="separator" />;
    case "list":
      return <ListBody block={block} onChange={onChange} />;
    case "image":
      return <ImageBody block={block} onChange={onChange} />;
    case "table":
      return <TableBody block={block} onChange={onChange} />;
    case "chartEmbed":
      return (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-500">
          Chart embed (chart {block.chartId || "unset"}). Chart picker deferred.
        </div>
      );
    case "embed":
      return <EmbedBody block={block} onChange={onChange} />;
    default:
      return <div className="text-sm text-red-500">{tr("editor.unknown_block")}</div>;
  }
}

function CalloutBody({
  block,
  onChange,
}: {
  block: CalloutBlock;
  onChange: (next: DocBlock) => void;
}): React.ReactElement {
  const tones = {
    info: "border-brand-300 bg-brand-50 text-brand-ink",
    warn: "border-amber-300 bg-amber-50 text-amber-700",
    success: "border-emerald-300 bg-emerald-50 text-emerald-700",
  } as const;
  const Icon = TONE_ICON[block.tone];
  return (
    <div className={cn("flex gap-3 rounded-lg border-l-4 px-4 py-3", tones[block.tone])}>
      <div className="mt-0.5 flex flex-col gap-1">
        <Icon size={16} />
        <select
          value={block.tone}
          onChange={(e) => onChange({ ...block, tone: e.target.value as CalloutBlock["tone"] })}
          className="cursor-pointer rounded bg-surface/60 text-[10px] focus:outline-none"
          aria-label={tr("editor.callout_tone")}
        >
          <option value="info">{tr("editor.info")}</option>
          <option value="warn">{tr("editor.warn")}</option>
          <option value="success">{tr("editor.success")}</option>
        </select>
      </div>
      <TextEditable
        value={richTextToPlain(block.text)}
        placeholder={tr("editor.callout_text")}
        className="flex-1 text-[15px] leading-7"
        onCommit={(t) => onChange({ ...block, text: plainToRichText(t) })}
      />
    </div>
  );
}

function ListBody({
  block,
  onChange,
}: {
  block: ListBlock;
  onChange: (next: DocBlock) => void;
}): React.ReactElement {
  const setItems = (items: ListItem[]) => onChange({ ...block, items });
  const updateItem = (id: string, next: Partial<ListItem>) =>
    setItems(block.items.map((it) => (it.id === id ? { ...it, ...next } : it)));
  const addAfter = (id: string) => {
    const idx = block.items.findIndex((it) => it.id === id);
    const next = block.items.slice();
    next.splice(idx + 1, 0, newListItem(""));
    setItems(next);
  };
  const removeItem = (id: string) => {
    if (block.items.length <= 1) return;
    setItems(block.items.filter((it) => it.id !== id));
  };

  return (
    <ul className="flex flex-col gap-1">
      {block.items.map((item, i) => (
        <li key={item.id} className="flex items-start gap-2">
          {block.style === "checklist" ? (
            <input
              type="checkbox"
              checked={Boolean(item.checked)}
              onChange={(e) => updateItem(item.id, { checked: e.target.checked })}
              className="mt-1.5 h-4 w-4 shrink-0 cursor-pointer accent-brand-600"
            />
          ) : block.style === "numbered" ? (
            <span className="mt-0.5 w-5 shrink-0 text-right text-[15px] text-neutral-500">{i + 1}.</span>
          ) : (
            <span className="mt-0.5 w-5 shrink-0 text-center text-[15px] text-neutral-500">&bull;</span>
          )}
          <TextEditable
            value={richTextToPlain(item.text)}
            placeholder={tr("editor.list_item")}
            className={cn(
              "flex-1 text-[15px] leading-7 text-neutral-800",
              item.checked && "text-neutral-400 line-through",
            )}
            onCommit={(t) => updateItem(item.id, { text: plainToRichText(t) })}
            onEnter={() => addAfter(item.id)}
            onBackspaceEmpty={() => removeItem(item.id)}
          />
        </li>
      ))}
    </ul>
  );
}

function ImageBody({
  block,
  onChange,
}: {
  block: Extract<DocBlock, { type: "image" }>;
  onChange: (next: DocBlock) => void;
}): React.ReactElement {
  return (
    <figure className="flex flex-col gap-2">
      {block.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={block.url}
          alt={block.alt ?? ""}
          className="max-h-[420px] w-full rounded-lg object-contain"
        />
      ) : (
        <div className="grid h-40 place-items-center rounded-lg border border-dashed border-neutral-300 bg-neutral-50 text-neutral-400">
          <ImageIcon size={28} />
        </div>
      )}
      <input
        value={block.url}
        placeholder={tr("editor.paste_an_image_url_asset_upload_deferred")}
        onChange={(e) => onChange({ ...block, url: e.target.value })}
        className="w-full rounded border border-neutral-200 px-2 py-1 text-xs text-neutral-600 focus:border-brand-400 focus:outline-none"
      />
      <input
        value={block.alt ?? ""}
        placeholder={tr("editor.alt_text_describe_the_image_for_screen_reade")}
        aria-label={tr("editor.image_alt_text")}
        onChange={(e) => onChange({ ...block, alt: e.target.value || undefined })}
        className="w-full rounded border border-neutral-200 px-2 py-1 text-xs text-neutral-600 focus:border-brand-400 focus:outline-none"
      />
      <input
        value={richTextToPlain(block.caption ?? { runs: [] })}
        placeholder={tr("editor.caption")}
        onChange={(e) =>
          onChange({ ...block, caption: e.target.value ? plainToRichText(e.target.value) : undefined })
        }
        className="w-full bg-transparent text-center text-xs italic text-neutral-500 focus:outline-none"
      />
    </figure>
  );
}

function EmbedBody({
  block,
  onChange,
}: {
  block: Extract<DocBlock, { type: "embed" }>;
  onChange: (next: DocBlock) => void;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm text-neutral-600">
        <Link2 size={15} />
        {block.url ? (
          <a href={block.url} target="_blank" rel="noopener noreferrer" className="truncate text-brand-ink hover:underline">
            {block.url}
          </a>
        ) : (
          <span className="text-neutral-400">{tr("editor.no_url_yet")}</span>
        )}
      </div>
      <input
        value={block.url}
        placeholder="https://example.com (preview deferred; safe link fallback)"
        onChange={(e) => onChange({ ...block, url: e.target.value })}
        className="w-full rounded border border-neutral-200 px-2 py-1 text-xs focus:border-brand-400 focus:outline-none"
      />
    </div>
  );
}

function TableBody({
  block,
  onChange,
}: {
  block: TableBlock;
  onChange: (next: DocBlock) => void;
}): React.ReactElement {
  const cols = block.columns.length;

  const setCell = (rowIdx: number, colIdx: number, text: string) => {
    const rows = block.rows.map((r, ri) =>
      ri === rowIdx ? { ...r, cells: r.cells.map((c, ci) => (ci === colIdx ? plainToRichText(text) : c)) } : r,
    );
    onChange({ ...block, rows });
  };
  const addColumn = () => {
    onChange({
      ...block,
      columns: [...block.columns, { align: "left" }],
      rows: block.rows.map((r) => ({ ...r, cells: [...r.cells, plainToRichText("")] })),
    });
  };
  const addRow = () => {
    onChange({ ...block, rows: [...block.rows, newTableRow(Array.from({ length: cols }, () => plainToRichText("")))] });
  };
  // Guard: never remove the last remaining row/column so the table stays valid.
  const removeRow = (rowIdx: number) => {
    if (block.rows.length <= 1) return;
    onChange({ ...block, rows: block.rows.filter((_, ri) => ri !== rowIdx) });
  };
  const removeColumn = (colIdx: number) => {
    if (cols <= 1) return;
    onChange({
      ...block,
      columns: block.columns.filter((_, ci) => ci !== colIdx),
      rows: block.rows.map((r) => ({ ...r, cells: r.cells.filter((_, ci) => ci !== colIdx) })),
    });
  };
  // Cycle a column's alignment left -> center -> right -> left.
  const cycleAlign = (colIdx: number) => {
    const order: TableBlock["columns"][number]["align"][] = ["left", "center", "right"];
    const cur = block.columns[colIdx]?.align ?? "left";
    const nextAlign = order[(order.indexOf(cur) + 1) % order.length];
    onChange({
      ...block,
      columns: block.columns.map((c, ci) => (ci === colIdx ? { ...c, align: nextAlign } : c)),
    });
  };

  const alignClass = (a: "left" | "center" | "right") =>
    a === "center" ? "text-center" : a === "right" ? "text-right" : "text-left";
  const AlignIcon = (a: "left" | "center" | "right") =>
    a === "center" ? AlignCenter : a === "right" ? AlignRight : AlignLeft;

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-lg border border-neutral-200">
        <table className="w-full border-collapse text-sm">
          <thead>
            {/* Per-column controls: alignment toggle + remove column. */}
            <tr>
              {block.columns.map((col, ci) => (
                <th key={ci} className="border-b border-neutral-100 px-1 py-1">
                  <div className="flex items-center justify-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => cycleAlign(ci)}
                      title={`Column alignment: ${col.align} (click to change)`}
                      aria-label={`Column ${ci + 1} alignment: ${col.align}`}
                      className="grid h-6 w-6 place-items-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
                    >
                      {(() => {
                        const Icon = AlignIcon(col.align);
                        return <Icon size={14} />;
                      })()}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeColumn(ci)}
                      disabled={cols <= 1}
                      title={tr("editor.remove_column")}
                      aria-label={`Remove column ${ci + 1}`}
                      className="grid h-6 w-6 place-items-center rounded text-neutral-400 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <X size={13} />
                    </button>
                  </div>
                </th>
              ))}
              {/* Spacer header cell over the per-row remove buttons. */}
              <th className="w-8 border-b border-neutral-100" aria-hidden />
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, ri) => {
              const isHeader = block.headerRow && ri === 0;
              return (
                <tr key={row.id} className="border-b border-neutral-100 last:border-0">
                  {row.cells.map((cell, ci) => (
                    <td
                      key={ci}
                      className={cn(
                        "border-r border-neutral-100 last:border-0 px-2 py-1",
                        alignClass(block.columns[ci]?.align ?? "left"),
                        isHeader && "bg-neutral-50 font-semibold",
                      )}
                    >
                      <input
                        value={richTextToPlain(cell)}
                        onChange={(e) => setCell(ri, ci, e.target.value)}
                        placeholder={isHeader ? tr("editor.header") : ""}
                        className={cn("w-full bg-transparent focus:outline-none", alignClass(block.columns[ci]?.align ?? "left"))}
                      />
                    </td>
                  ))}
                  {/* Per-row remove control. */}
                  <td className="w-8 px-1 py-1 align-middle">
                    <button
                      type="button"
                      onClick={() => removeRow(ri)}
                      disabled={block.rows.length <= 1}
                      title={tr("editor.remove_row")}
                      aria-label={`Remove row ${ri + 1}`}
                      className="grid h-6 w-6 place-items-center rounded text-neutral-400 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <Minus size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={addRow}>
          <Plus size={14} /> {tr("editor.row")}
        </Button>
        <Button variant="ghost" size="sm" onClick={addColumn}>
          <Plus size={14} /> {tr("editor.column")}
        </Button>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-neutral-500">
          <input
            type="checkbox"
            checked={block.headerRow}
            onChange={(e) => onChange({ ...block, headerRow: e.target.checked })}
            className="h-3.5 w-3.5 accent-brand-600"
          />
          {tr("editor.header_row")}
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editable text (auto-growing textarea) with debounced commit
// ---------------------------------------------------------------------------

function TextEditable({
  value,
  placeholder,
  className,
  multiline,
  onCommit,
  onEnter,
  onBackspaceEmpty,
}: {
  value: string;
  placeholder?: string;
  className?: string;
  multiline?: boolean;
  onCommit: (text: string) => void;
  onEnter?: () => void;
  onBackspaceEmpty?: () => void;
}): React.ReactElement {
  // `draft` holds the in-progress edit WHILE FOCUSED. When not focused we render
  // `value` directly (mirrors SheetSurface's editing/raw split), so an external
  // change (AI result, undo/redo, remote peer) shows immediately the moment the
  // field is not being typed into, with no setState-in-effect reconciliation.
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest committed `value` from the store, kept current via an effect (refs
  // may be mutated in effects, not during render). A debounced flush compares the
  // text it captured against THIS, so a stale draft can never clobber a newer
  // external value: if `value` moved on (AI/undo/remote) the flush is dropped.
  const latestValue = useRef(value);
  useEffect(() => {
    latestValue.current = value;
  }, [value]);

  const display = focused ? draft : value;

  // Auto-grow on whatever text is shown (draft while focused, value otherwise).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [display]);

  const flush = useCallback(
    (text: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      // Only commit if the text differs from the LATEST committed value. This
      // both avoids a redundant undo step and stops a stale debounced flush from
      // overwriting a newer external value that arrived after it was scheduled.
      if (text !== latestValue.current) onCommit(text);
    },
    [onCommit],
  );

  const scheduleCommit = useCallback(
    (text: string) => {
      if (timer.current) clearTimeout(timer.current);
      // Debounce so a burst of keystrokes is a single undoable commit.
      timer.current = setTimeout(() => flush(text), 600);
    },
    [flush],
  );

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={display}
      placeholder={placeholder}
      // Each block resolves its own direction from its first strong character,
      // so a Hebrew paragraph inside an English doc lays out right-to-left.
      // An explicit document-level dir on the page container overrides this.
      dir="auto"
      spellCheck
      className={cn(
        "w-full resize-none overflow-hidden bg-transparent placeholder:text-neutral-300 focus:outline-none",
        className,
      )}
      onFocus={() => {
        // Seed the draft from the current value so editing starts from the latest
        // external state, then switch to showing the draft.
        setDraft(value);
        setFocused(true);
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        scheduleCommit(e.target.value);
      }}
      onBlur={() => {
        flush(draft);
        setFocused(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !multiline && onEnter) {
          e.preventDefault();
          flush(draft);
          onEnter();
        } else if (e.key === "Backspace" && draft.length === 0 && onBackspaceEmpty) {
          e.preventDefault();
          onBackspaceEmpty();
        }
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Inserter UI + popover primitives
// ---------------------------------------------------------------------------

function TrailingInserter({ onInsert }: { onInsert: (b: DocBlock) => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative mt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-neutral-400 transition hover:bg-neutral-50 hover:text-neutral-600"
      >
        <Plus size={16} />
        {tr("editor.add_a_block")}
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} className="left-0 top-10">
          <InserterList
            onPick={(make) => {
              onInsert(make());
              setOpen(false);
            }}
          />
        </Popover>
      )}
    </div>
  );
}

function InserterList({ onPick }: { onPick: (make: () => DocBlock) => void }): React.ReactElement {
  return (
    <div className="max-h-72 w-52 overflow-y-auto">
      {inserters().map((opt) => {
        const Icon = opt.icon;
        return (
          <MenuItem key={opt.label} onClick={() => onPick(opt.make)}>
            <Icon size={15} className="text-neutral-500" />
            {opt.label}
          </MenuItem>
        );
      })}
    </div>
  );
}

function Popover({
  children,
  onClose,
  className,
}: {
  children: React.ReactNode;
  onClose: () => void;
  className?: string;
}): React.ReactElement {
  // Click-away to dismiss.
  useEffect(() => {
    const onDown = () => onClose();
    // Defer so the opening click does not immediately close it.
    const id = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);
  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        "absolute z-20 rounded-xl border border-neutral-200 bg-surface p-1 shadow-lg",
        className,
      )}
    >
      {children}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  active,
  danger,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-40",
        danger ? "text-red-600 hover:bg-red-50" : "text-neutral-700 hover:bg-neutral-100",
        active && "bg-brand-50 text-brand-ink",
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Block text bridge helpers (plain-text MVP over the RichText model)
// ---------------------------------------------------------------------------

function blockSupportsText(block: DocBlock): boolean {
  return (
    block.type === "paragraph" ||
    block.type === "heading" ||
    block.type === "quote" ||
    block.type === "callout" ||
    block.type === "code" ||
    block.type === "list"
  );
}

/** Read a block's editable plain text (for AI input). */
function blockPlainText(block: DocBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "quote":
    case "callout":
      return richTextToPlain(block.text);
    case "code":
      return block.code;
    case "list":
      return block.items.map((i) => richTextToPlain(i.text)).join("\n");
    default:
      return "";
  }
}

/** Write plain text back into a block, preserving the RichText structure. */
function setBlockPlainText(block: DocBlock, text: string): DocBlock {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "quote":
    case "callout":
      return { ...block, text: plainToRichText(text) };
    case "code":
      return { ...block, code: text };
    case "list": {
      const lines = text.split("\n");
      const items: ListItem[] = lines.map((line, i) => {
        const existing = block.items[i];
        return existing
          ? { ...existing, text: plainToRichText(line) }
          : newListItem(line);
      });
      return { ...block, items: items.length > 0 ? items : block.items };
    }
    default:
      return block;
  }
}
