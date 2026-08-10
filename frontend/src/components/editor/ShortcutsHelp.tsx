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
import { tr } from "@/lib/i18n";

// Resolve the platform's primary modifier glyph once at module load. On Apple
// platforms the canvas handler treats metaKey (Cmd) as the modifier; elsewhere
// Ctrl. Reading this here (module scope) keeps render pure.
const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
const MOD = IS_MAC ? "Cmd" : "Ctrl";

type Shortcut = { keys: string; label: string };
type Group = { title: string; items: Shortcut[] };

// Bindings sourced from Canvas.tsx TOOL_KEYS + keydown handler and CommandMenu.tsx.
const groups = (): Group[] => [
  {
    title: tr("editor.tools"),
    items: [
      { keys: "V", label: tr("editor.select") },
      { keys: "T", label: tr("editor.text") },
      { keys: "R", label: tr("editor.rectangle_drag_to_draw") },
      { keys: "E", label: tr("editor.ellipse_drag_to_draw") },
      { keys: "L", label: tr("editor.line") },
      { keys: "A", label: tr("editor.arrow") },
      { keys: "P", label: tr("editor.pen") },
      { keys: "B", label: tr("editor.pencil_freehand") },
    ],
  },
  {
    title: tr("editor.edit"),
    items: [
      { keys: `${MOD}+Z`, label: tr("editor.undo") },
      { keys: `Shift+${MOD}+Z`, label: tr("editor.redo") },
      { keys: `${MOD}+C`, label: tr("editor.copy") },
      { keys: `${MOD}+X`, label: tr("editor.cut") },
      { keys: `${MOD}+V`, label: tr("editor.paste") },
      { keys: `Shift+${MOD}+V`, label: tr("editor.paste_in_place") },
      { keys: `Alt+${MOD}+C`, label: tr("editor.copy_style") },
      { keys: `Alt+${MOD}+V`, label: tr("editor.paste_style") },
      { keys: `${MOD}+D`, label: tr("editor.duplicate") },
      { keys: `${MOD}+A`, label: tr("editor.select_all") },
      { keys: `${MOD}+G`, label: tr("editor.group") },
      { keys: `Shift+${MOD}+G`, label: tr("editor.ungroup") },
      { keys: "1–0", label: tr("editor.set_opacity_type_1_2_digits") },
      { keys: tr("editor.delete"), label: tr("editor.delete_selection") },
      { keys: tr("editor.esc"), label: tr("editor.cancel_drag_clear_selection") },
    ],
  },
  {
    title: tr("editor.arrange"),
    items: [
      { keys: `${MOD}+]`, label: tr("editor.bring_forward") },
      { keys: `${MOD}+[`, label: tr("editor.send_backward") },
    ],
  },
  {
    title: tr("editor.move"),
    items: [
      { keys: tr("editor.arrows"), label: tr("editor.nudge_1_px") },
      { keys: tr("editor.shift_arrows"), label: tr("editor.nudge_10_px") },
      { keys: tr("editor.alt_arrows"), label: tr("editor.resize_1_px") },
      { keys: ", / .", label: tr("editor.rotate_1_degree") },
      { keys: "Alt+, / .", label: tr("editor.rotate_15_degrees") }, // i18n-ignore: key chord
      { keys: tr("editor.alt_drag"), label: tr("editor.duplicate_and_drag") },
      { keys: tr("editor.alt_hover"), label: tr("editor.measure_to_element_page_edges") },
    ],
  },
  {
    title: tr("editor.zoom"),
    items: [
      { keys: `${MOD}+=`, label: tr("editor.zoom_in") },
      { keys: `${MOD}+-`, label: tr("editor.zoom_out") },
      { keys: `${MOD}+0`, label: tr("editor.fit_page") },
      { keys: tr("editor.shift_1"), label: tr("editor.fit_page") },
      { keys: tr("editor.shift_2"), label: tr("editor.zoom_to_selection") },
    ],
  },
  {
    title: tr("editor.other"),
    items: [
      { keys: `${MOD}+K`, label: tr("editor.command_menu") },
      { keys: `${MOD}+E`, label: tr("editor.export") },
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
    <Modal open={open} onClose={onClose} title={tr("editor.keyboard_shortcuts")} width="w-[40rem]">
      <div className="mb-4 flex justify-end">
        <button
          type="button"
          onClick={() => setCustomizing((v) => !v)}
          className={
            "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium shadow-sm " +
            (customizing
              ? "border-brand-400 bg-brand-50 text-brand-ink"
              : "border-neutral-200 bg-surface text-neutral-600 hover:bg-neutral-100")
          }
        >
          <SlidersHorizontal size={12} /> {customizing ? tr("editor.done") : tr("editor.customize")}
        </button>
      </div>
      {customizing && <ShortcutsCustomizer />}
      <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
        {groups().map((g) => (
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
