// Keyboard-shortcuts cheat sheet: a Modal listing the editor's wired shortcuts,
// grouped by purpose. The bindings here mirror exactly what is handled in
// Canvas.tsx (TOOL_KEYS + the keydown handler) and CommandMenu.tsx (Cmd+K /
// Cmd+E), so the sheet never advertises a key that isn't actually wired. Keys
// are shown with the platform modifier symbol (Cmd vs Ctrl) resolved at render
// from a module helper (no impure reads in render).

import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { ShortcutsCustomizer } from "./ShortcutsEditor";

// Resolve the platform's primary modifier glyph once at module load. On Apple
// platforms the canvas handler treats metaKey (Cmd) as the modifier; elsewhere
// Ctrl. Reading this here (module scope) keeps render pure.
const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
const MOD = IS_MAC ? "Cmd" : "Ctrl";

type Shortcut = { keys: string; label: string };
type Group = { title: string; items: Shortcut[] };

// Bindings sourced from Canvas.tsx TOOL_KEYS + keydown handler and CommandMenu.tsx.
const GROUPS: Group[] = [
  {
    title: "Tools",
    items: [
      { keys: "V", label: "Select" },
      { keys: "T", label: "Text" },
      { keys: "R", label: "Rectangle (drag to draw)" },
      { keys: "E", label: "Ellipse (drag to draw)" },
      { keys: "L", label: "Line" },
      { keys: "A", label: "Arrow" },
      { keys: "P", label: "Pen" },
      { keys: "B", label: "Pencil (freehand)" },
    ],
  },
  {
    title: "Edit",
    items: [
      { keys: `${MOD}+Z`, label: "Undo" },
      { keys: `Shift+${MOD}+Z`, label: "Redo" },
      { keys: `${MOD}+C`, label: "Copy" },
      { keys: `${MOD}+X`, label: "Cut" },
      { keys: `${MOD}+V`, label: "Paste" },
      { keys: `${MOD}+D`, label: "Duplicate" },
      { keys: `${MOD}+A`, label: "Select all" },
      { keys: `${MOD}+G`, label: "Group" },
      { keys: `Shift+${MOD}+G`, label: "Ungroup" },
      { keys: "Delete", label: "Delete selection" },
      { keys: "Esc", label: "Clear selection / finish pen" },
    ],
  },
  {
    title: "Arrange",
    items: [
      { keys: `${MOD}+]`, label: "Bring forward" },
      { keys: `${MOD}+[`, label: "Send backward" },
    ],
  },
  {
    title: "Move",
    items: [
      { keys: "Arrows", label: "Nudge 1 px" },
      { keys: "Shift+Arrows", label: "Nudge 10 px" },
      { keys: "Alt+drag", label: "Duplicate and drag" },
    ],
  },
  {
    title: "Zoom",
    items: [
      { keys: `${MOD}+=`, label: "Zoom in" },
      { keys: `${MOD}+-`, label: "Zoom out" },
      { keys: `${MOD}+0`, label: "Fit page" },
      { keys: "Shift+1", label: "Fit page" },
      { keys: "Shift+2", label: "Zoom to selection" },
    ],
  },
  {
    title: "Other",
    items: [
      { keys: `${MOD}+K`, label: "Command menu" },
      { keys: `${MOD}+E`, label: "Export" },
      { keys: "?", label: "This shortcuts list" },
    ],
  },
];

function Keys({ combo }: { combo: string }) {
  // Render each token of a combo (split on "+") as its own key cap, keeping the
  // literal "+" separators between them.
  const parts = combo.split("+");
  return (
    <span className="flex shrink-0 items-center gap-1">
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span className="text-neutral-300">+</span>}
          <kbd className="rounded-md border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 text-[11px] font-medium text-neutral-600 shadow-sm">
            {p}
          </kbd>
        </span>
      ))}
    </span>
  );
}

export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [customizing, setCustomizing] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" width="w-[40rem]">
      <div className="mb-4 flex justify-end">
        <button
          type="button"
          onClick={() => setCustomizing((v) => !v)}
          className={
            "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium shadow-sm " +
            (customizing
              ? "border-blue-400 bg-blue-50 text-blue-600"
              : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-100")
          }
        >
          <SlidersHorizontal size={12} /> {customizing ? "Done" : "Customize"}
        </button>
      </div>
      {customizing && <ShortcutsCustomizer />}
      <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">{g.title}</h3>
            <ul className="space-y-1.5">
              {g.items.map((it) => (
                <li key={it.label} className="flex items-center justify-between gap-3 text-sm text-neutral-700">
                  <span className="truncate">{it.label}</span>
                  <Keys combo={it.keys} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}
