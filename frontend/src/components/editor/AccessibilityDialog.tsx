// Accessibility check: runs the @hc/a11y audit over the current design
// and lists fixable WCAG issues (low text contrast, missing image alt text, tiny
// text). Clicking an issue jumps to its page and selects the node so the user can
// fix it. Recomputed whenever the document changes (rev) or the dialog reopens.

import { useMemo, useState } from "react";
import { AlertTriangle, AlertCircle, CheckCircle2, Wand2 } from "lucide-react";
import type { DesignFile } from "@hc/schema";
import { checkAccessibility, type A11yIssue } from "@hc/a11y";
import { Modal } from "@/components/ui/Modal";
import { useEditor } from "@/store/editor";
import { usePresence } from "@/store/presence";
import { useBrand } from "@/store/brand";
import { generateAltText } from "@/lib/altText";
import { useToast } from "@/components/ui/Toast";
import { userMessage } from "@/lib/errors";
import { tr, trOr } from "@/lib/i18n";

// The list mirrors the shipped catalogs plus the RTL scripts the export path
// shapes. i18n-ignore: a language picker shows each language in its OWN name.
const docLanguages = (): { value: string; label: string }[] => [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "es-ES", label: "Español" },
  { value: "fr-FR", label: "Français" },
  { value: "de-DE", label: "Deutsch" },
  { value: "pt-BR", label: "Português (Brasil)" },
  { value: "hi-IN", label: "हिन्दी" },
  { value: "ja-JP", label: "日本語" },
  { value: "zh-CN", label: "中文 (简体)" },
  { value: "zh-HK", label: "繁體中文（香港）" },
  { value: "zh-TW", label: "繁體中文（台灣）" },
  { value: "ar-SA", label: "العربية" },
  { value: "he-IL", label: "עברית" },
];

const kindLabel = (): Record<A11yIssue["kind"], string> => ({
  contrast: tr("editor.contrast"),
  "alt-text": tr("editor.alt_text"),
  "small-text": tr("editor.small_text"),
  "touch-target": tr("editor.target_size"),
  "slide-title": tr("editor.slide_titles"),
  "reading-order": tr("editor.reading_order"),
});

/** Issues that point at a PAGE, not an element on it. */
const pageLevel = (kind: A11yIssue["kind"]) => kind === "slide-title" || kind === "reading-order";

/** One-click fixes (F28 completion C27), each a single undo step. Kinds with
 *  no safe automatic fix (touch targets are a design decision) offer none. */
function fixFor(i: A11yIssue): { label: string; run: (workspaceId: string | null) => Promise<boolean> } | null {
  const st = () => useEditor.getState();
  switch (i.kind) {
    case "contrast":
      return { label: tr("editor.fix_to_aa"), run: async () => st().fixTextContrast(i.nodeId) > 0 };
    case "small-text":
      return { label: tr("editor.raise_to_12px"), run: async () => st().raiseMinFontSize(i.nodeId) > 0 };
    case "reading-order":
      return { label: tr("editor.adopt_visual_order"), run: async () => { st().resetReadingOrder(i.pageIndex); return true; } };
    case "alt-text":
      return {
        label: tr("editor.describe_with_ai"),
        run: async (workspaceId) => {
          if (!workspaceId) return false;
          st().select([i.nodeId]);
          return generateAltText(workspaceId);
        },
      };
    case "slide-title": {
      // Adopt the title placeholder's text as the slide name when one exists;
      // otherwise there is nothing safe to invent - jump instead.
      return {
        label: tr("editor.use_title_text"),
        run: async () => {
          const doc = st().doc as unknown as {
            pages: { name?: string; layoutId?: string; children: { type: string; data?: { placeholderId?: string }; content?: { runs: { text: string }[] }[] }[] }[];
            layouts?: { id: string; masterId: string; placeholders: { id: string; role: string }[] }[];
            masters?: { id: string; placeholders?: { id: string; role: string }[] }[];
          };
          const pg = doc.pages[i.pageIndex];
          const layout = doc.layouts?.find((l) => l.id === pg?.layoutId);
          if (!pg || !layout) return false;
          const master = doc.masters?.find((m) => m.id === layout.masterId);
          const titleIds = new Set(
            [...layout.placeholders, ...(master?.placeholders ?? [])].filter((ph) => ph.role === "title").map((ph) => ph.id),
          );
          const titleNode = pg.children.find((n) => n.type === "text" && n.data?.placeholderId && titleIds.has(n.data.placeholderId));
          const text = titleNode?.content?.[0]?.runs.map((r) => r.text).join("").split("\n")[0].trim().slice(0, 80);
          if (!text) return false;
          st().setPageName(i.pageIndex, text);
          return true;
        },
      };
    }
    default:
      return null; // touch-target: resizing is a design decision
  }
}

export function AccessibilityDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rev = useEditor((s) => s.rev);
  const toast = useToast();
  const workspaceId = useBrand((s) => s.workspaceId);
  const [fixing, setFixing] = useState<string | null>(null);
  const canEdit = usePresence.getState().canEdit() && !useEditor.getState().readonlyPreview();
  const issues = useMemo(
    () => checkAccessibility(useEditor.getState().doc as unknown as DesignFile),
    // Recompute on edits and each open; `open` keeps it fresh after fixes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rev, open],
  );
  const errors = issues.filter((i) => i.severity === "error").length;

  const jump = (i: A11yIssue) => {
    const st = useEditor.getState();
    // Activate AND scroll to the page (page-level issues point at a PAGE,
    // not a node, so this scroll is all the navigation they get).
    st.goToPage(i.pageIndex);
    if (!pageLevel(i.kind)) {
      st.select([i.nodeId]);
      st.zoomToSelection();
    }
    onClose();
  };

  const language = (useEditor.getState().doc as { language?: string }).language ?? "";

  return (
    <Modal open={open} onClose={onClose} title={tr("editor.accessibility_check")}>
      {/* Document language (F38 FR-8): announced to assistive technology and
          written as the tagged-PDF /Lang so screen readers pronounce the
          exported document correctly. Stored on the design file itself. */}
      <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-surface px-3 py-2">
        <div className="min-w-0">
          <span className="block text-sm font-medium text-neutral-800">{tr("editor.document_language")}</span>
          <span className="block text-xs text-neutral-400">{tr("editor.screen_readers_pronounce_exports_in_this_language")}</span>
        </div>
        <select
          value={language}
          // Mirrors setDocLanguage's own gate; without this the control looks
          // operable to a viewer and silently snaps back.
          disabled={!usePresence.getState().canEdit() || useEditor.getState().readonlyPreview()}
          onChange={(e) => useEditor.getState().setDocLanguage(e.target.value)}
          className="h-9 shrink-0 rounded-lg border border-neutral-200 bg-surface px-2 text-sm text-neutral-800 outline-none focus:border-brand-500 disabled:opacity-50"
        >
          <option value="">{tr("editor.not_set_exports_as_english")}</option>
          {docLanguages().map((l) => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
        </select>
      </div>
      {issues.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <CheckCircle2 size={36} className="text-emerald-500" />
          <p className="text-sm font-medium text-neutral-700">{tr("editor.no_accessibility_issues_found")}</p>
          <p className="max-w-xs text-xs text-neutral-400">{tr("editor.text_contrast_image_alt_text_text_size_and_s")}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-neutral-500">
            {issues.length} issue{issues.length > 1 ? "s" : ""}
            {errors > 0 ? ` · ${errors} need${errors > 1 ? "" : "s"} attention` : ""}. Click one to fix it.
          </p>
          <ul className="oc-scroll flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto">
            {issues.map((i, idx) => (
              <li key={`${i.nodeId}-${i.kind}-${idx}`} className="flex items-start gap-1.5">
                <button
                  onClick={() => jump(i)}
                  className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg border border-neutral-200 bg-surface px-3 py-2 text-start transition hover:border-brand-300 hover:bg-brand-50/40"
                >
                  {i.severity === "error" ? (
                    <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-500" />
                  ) : (
                    <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-500" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-neutral-800">{trOr(i.messageCode, i.message, i.messageParams)}</span>
                    <span className="block truncate text-xs text-neutral-400">
                      {/* Page-level issues are about the PAGE, not an element on it. */}
                      {pageLevel(i.kind)
                        ? `${kindLabel()[i.kind]} · slide ${i.pageIndex + 1}`
                        : `${kindLabel()[i.kind]} · ${i.nodeName || "element"} · page ${i.pageIndex + 1}`}
                    </span>
                  </span>
                </button>
                {/* One-click fix (C27): a real sibling button (never an
                    interactive element nested inside the jump button), one
                    undo step; the list recomputes on the store revision so
                    the row clears. */}
                {canEdit && (() => {
                  const fix = fixFor(i);
                  if (!fix) return null;
                  const key = `${i.nodeId}-${i.kind}`;
                  return (
                    <button
                      type="button"
                      disabled={!!fixing}
                      onClick={() => {
                        if (fixing) return;
                        setFixing(key);
                        void fix.run(workspaceId)
                          .then((ok) => { if (!ok) toast.error(tr("editor.nothing_to_fix_automatically_here")); })
                          .catch((err) => toast.error(userMessage(err, tr("editor.couldnt_apply_that_fix"))))
                          .finally(() => setFixing(null));
                      }}
                      className="mt-1 flex shrink-0 items-center gap-1 rounded-md border border-brand-200 bg-brand-50 px-2 py-1 text-xs font-medium text-brand-ink transition hover:bg-brand-100 disabled:opacity-50"
                      data-testid={`fix-${i.kind}`}
                    >
                      <Wand2 size={12} /> {fixing === key ? tr("editor.fixing") : fix.label}
                    </button>
                  );
                })()}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
