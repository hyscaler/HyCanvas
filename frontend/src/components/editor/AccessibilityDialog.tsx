// Accessibility check: runs the @hc/a11y audit over the current design
// and lists fixable WCAG issues (low text contrast, missing image alt text, tiny
// text). Clicking an issue jumps to its page and selects the node so the user can
// fix it. Recomputed whenever the document changes (rev) or the dialog reopens.

import { useMemo } from "react";
import { AlertTriangle, AlertCircle, CheckCircle2 } from "lucide-react";
import type { DesignFile } from "@hc/schema";
import { checkAccessibility, type A11yIssue } from "@hc/a11y";
import { Modal } from "@/components/ui/Modal";
import { useEditor } from "@/store/editor";

const KIND_LABEL: Record<A11yIssue["kind"], string> = {
  contrast: "Contrast",
  "alt-text": "Alt text",
  "small-text": "Small text",
  "touch-target": "Target size",
};

export function AccessibilityDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rev = useEditor((s) => s.rev);
  const issues = useMemo(
    () => checkAccessibility(useEditor.getState().doc as unknown as DesignFile),
    // Recompute on edits and each open; `open` keeps it fresh after fixes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rev, open],
  );
  const errors = issues.filter((i) => i.severity === "error").length;

  const jump = (i: A11yIssue) => {
    const st = useEditor.getState();
    st.setActivePage(i.pageIndex);
    st.select([i.nodeId]);
    st.zoomToSelection();
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Accessibility check">
      {issues.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <CheckCircle2 size={36} className="text-emerald-500" />
          <p className="text-sm font-medium text-neutral-700">No accessibility issues found</p>
          <p className="max-w-xs text-xs text-neutral-400">Text contrast, image alt text, and text size all look good.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-neutral-500">
            {issues.length} issue{issues.length > 1 ? "s" : ""}
            {errors > 0 ? ` · ${errors} need${errors > 1 ? "" : "s"} attention` : ""}. Click one to fix it.
          </p>
          <ul className="oc-scroll flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto">
            {issues.map((i, idx) => (
              <li key={`${i.nodeId}-${i.kind}-${idx}`}>
                <button
                  onClick={() => jump(i)}
                  className="flex w-full items-start gap-2.5 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-left transition hover:border-brand-300 hover:bg-brand-50/40"
                >
                  {i.severity === "error" ? (
                    <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-500" />
                  ) : (
                    <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-500" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-neutral-800">{i.message}</span>
                    <span className="block truncate text-xs text-neutral-400">
                      {KIND_LABEL[i.kind]} · {i.nodeName || "element"} · page {i.pageIndex + 1}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
