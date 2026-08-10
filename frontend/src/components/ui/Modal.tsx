// Centered modal dialog with a dimmed backdrop. Closes on backdrop click and
// Escape. Replaces native prompt()/confirm() across the app. Implements dialog
// semantics (role="dialog", aria-modal), focus management (focus moves into the
// panel on open and is restored to the previously focused element on close), and
// a Tab/Shift+Tab focus trap that wraps within the panel.

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "./IconButton";
import { tr } from "@/lib/i18n";

// Selector for natively focusable, currently-enabled elements within the panel.
const FOCUSABLE =
  'a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), iframe, object, embed, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function Modal({
  open,
  onClose,
  title,
  ariaLabel,
  children,
  width = "w-[26rem]",
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  ariaLabel?: string;
  children: ReactNode;
  width?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Escape closes. Bound on the window so it works regardless of where focus is.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Focus management: on open, remember what was focused, move focus into the
  // panel, and restore focus on close/unmount. Runs only in the browser.
  useEffect(() => {
    if (!open) return;
    if (typeof document === "undefined") return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) {
      const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
      const first = focusables[0];
      if (first) first.focus();
      else panel.focus();
    }
    return () => {
      // Restore focus to the element that had it before the dialog opened, if it
      // is still in the document and focusable.
      if (previouslyFocused && typeof previouslyFocused.focus === "function" && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  // Tab/Shift+Tab focus trap, scoped to the panel. Wraps last->first and
  // first->last so focus never escapes the dialog.
  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (focusables.length === 0) {
      // Nothing focusable inside: keep focus on the panel itself.
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const activeEl = document.activeElement;
    if (e.shiftKey) {
      if (activeEl === first || activeEl === panel) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-neutral-900/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : (ariaLabel ?? tr("ui.dialog"))}
        tabIndex={-1}
        className={`${width} rounded-2xl bg-surface p-5 shadow-2xl outline-none`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onPanelKeyDown}
      >
        {title && (
          <div className="mb-4 flex items-center justify-between">
            <h2 id={titleId} className="text-base font-bold text-neutral-900">{title}</h2>
            <IconButton aria-label={tr("ui.close")} onClick={onClose}>
              <X size={18} />
            </IconButton>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
