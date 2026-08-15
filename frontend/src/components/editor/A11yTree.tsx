// Offscreen accessibility tree for the design canvas (F38).
//
// Canvas pixels are opaque to assistive technology, so this visually-hidden
// listbox mirrors the active page's objects in resolved reading order (the
// same order the Reading Order pane edits). A screen reader user tabs here
// from the canvas, browses with the arrow keys, and presses Enter/Space to
// select an object on the canvas. Decorative nodes are omitted, matching what
// a screen reader should skip.
//
// One tab stop, not one per object: the list uses aria-activedescendant with
// roving state so a sighted keyboard user passes through a single invisible
// stop instead of dozens.

import { useEffect, useRef, useState } from "react";
import { isDecorative, nodeAltText, resolveReadingOrder } from "@hc/schema";
import { useEditor } from "@/store/editor";
import { tr } from "@/lib/i18n";
import { nodeAnnouncedName } from "@/lib/nodeName";

export function A11yTree() {
  useEditor((s) => s.rev);
  const selection = useEditor((s) => s.selection);
  const activePage = useEditor((s) => s.activePage);
  const [active, setActive] = useState(0);
  const doc = useEditor.getState().doc;
  const page = doc.pages[Math.min(activePage, doc.pages.length - 1)];
  if (!page) return null;
  // Hidden nodes are invisible content and stay out; locked nodes stay IN
  // (unlike Tab-cycling, which skips what it cannot manipulate) because a
  // screen reader user should hear everything a sighted user can see.
  const rows = resolveReadingOrder(page).filter((n) => !isDecorative(n) && !n.hidden);
  const clamped = Math.min(active, Math.max(0, rows.length - 1));

  const move = (to: number) => setActive(Math.max(0, Math.min(to, rows.length - 1)));

  return (
    <div
      role="listbox"
      tabIndex={0}
      aria-label={tr("editor.page_objects_use_arrows_enter_selects")}
      aria-activedescendant={rows[clamped] ? `hc-a11y-obj-${rows[clamped].id}` : undefined}
      className="sr-only"
      data-testid="a11y-tree"
      onKeyDown={(e) => {
        // The canvas surface wraps this list and owns its own arrow/Enter keys
        // (nudge, edit). Keep list navigation local (stopPropagation) so
        // browsing objects never moves the selection on the canvas.
        const nav = (to: number) => {
          e.preventDefault();
          e.stopPropagation();
          move(to);
        };
        switch (e.key) {
          case "ArrowDown": nav(clamped + 1); return;
          case "ArrowUp": nav(clamped - 1); return;
          case "Home": nav(0); return;
          case "End": nav(rows.length - 1); return;
          case "Enter":
          case " ":
            e.preventDefault();
            e.stopPropagation();
            if (rows[clamped]) useEditor.getState().select([rows[clamped].id]);
            return;
        }
      }}
    >
      {rows.map((node, i) => {
        const alt = nodeAltText(node);
        // Translated type for unnamed nodes, plus the locked state: a screen
        // reader should know an object cannot be manipulated before trying.
        const name = nodeAnnouncedName(node);
        return (
          <div
            key={node.id}
            id={`hc-a11y-obj-${node.id}`}
            role="option"
            aria-selected={selection.includes(node.id)}
            onClick={() => {
              setActive(i);
              useEditor.getState().select([node.id]);
            }}
          >
            {i + 1}. {name}
            {alt ? `, ${alt}` : ""}
          </div>
        );
      })}
    </div>
  );
}

/** What a selection change should say. Exported for tests. */
export function selectionMessage(selection: string[]): string {
  if (selection.length === 0) return tr("editor.selection_cleared");
  if (selection.length > 1) return tr("editor.objects_selected", { count: selection.length });
  const doc = useEditor.getState().doc;
  let name = "";
  const walk = (nodes: { id: string; name?: string; type: string }[]): boolean => {
    for (const n of nodes) {
      if (n.id === selection[0]) {
        name = nodeAnnouncedName(n);
        return true;
      }
      const kids = (n as { children?: typeof nodes }).children;
      if (Array.isArray(kids) && walk(kids)) return true;
    }
    return false;
  };
  for (const page of doc.pages) if (walk(page.children as never)) break;
  return tr("editor.selected_name", { name });
}

/** Polite live region announcing selection changes, so a screen reader user
 *  hears the result of Tab-cycling or clicking without leaving the canvas.
 *  The region's text is written imperatively from a store subscription (a live
 *  region is a DOM side channel, not render output), which also skips the
 *  initial state: nothing is announced while the editor is still loading. */
export function SelectionAnnouncer() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let prev = useEditor.getState().selection;
    return useEditor.subscribe((s) => {
      if (s.selection === prev) return;
      // Page switches and loads replace an empty selection with a NEW empty
      // array; announcing "selection cleared" for those would be noise.
      const emptyToEmpty = s.selection.length === 0 && prev.length === 0;
      prev = s.selection;
      if (!emptyToEmpty && ref.current) ref.current.textContent = selectionMessage(s.selection);
    });
  }, []);

  return <div ref={ref} aria-live="polite" role="status" className="sr-only" data-testid="a11y-announcer" />;
}
