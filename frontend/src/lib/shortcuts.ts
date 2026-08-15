// Active keyboard-shortcut scheme for the editor. Wraps the pure
// @hc/shortcuts model with browser persistence: the shipped DEFAULT_SCHEME merged
// with the user's per-command overrides (localStorage). The canvas keydown
// handler resolves events through commandForEvent(); the Shortcuts editor UI
// reads/writes overrides here and subscribes for live updates.

import {
  DEFAULT_SCHEME,
  resolveChord,
  normalizeChord,
  detectConflicts,
  type ShortcutScheme,
  type KeyEvent as ChordKeyEvent,
} from "@hc/shortcuts";
import { tr } from "@/lib/i18n";

const STORAGE_KEY = "oc.shortcuts.overrides.v1";

/** Commands the canvas keydown resolves through the scheme (so remapping them in
 *  the editor actually takes effect). Mirrors COMMAND_ACTIONS in Canvas.tsx. */
export const REMAPPABLE_COMMANDS = [
  "history.undo",
  "history.redo",
  "clipboard.copy",
  "clipboard.cut",
  "clipboard.pasteInPlace",
  "clipboard.copyStyle",
  "clipboard.pasteStyle",
  "selection.duplicate",
  "selection.selectAll",
  "selection.group",
  "selection.ungroup",
] as const;

export const PLATFORM: "mac" | "other" =
  typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)
    ? "mac"
    : "other";

/** Human labels + grouping for every command in the default scheme (UI only). */
export const COMMAND_LABELS: Record<string, { label: string; group: string }> = {
  "history.undo": { label: "Undo", group: "History" },
  "history.redo": { label: "Redo", group: "History" },
  "clipboard.copy": { label: "Copy", group: "Clipboard" },
  "clipboard.cut": { label: "Cut", group: "Clipboard" },
  "clipboard.paste": { label: "Paste", group: "Clipboard" },
  "clipboard.pasteInPlace": { label: "Paste in place", group: "Clipboard" },
  "clipboard.copyStyle": { label: "Copy style", group: "Clipboard" },
  "clipboard.pasteStyle": { label: "Paste style", group: "Clipboard" },
  "selection.duplicate": { label: "Duplicate", group: "Selection" },
  "selection.delete": { label: "Delete", group: "Selection" },
  "selection.selectAll": { label: "Select all", group: "Selection" },
  "selection.group": { label: "Group", group: "Selection" },
  "selection.ungroup": { label: "Ungroup", group: "Selection" },
  "commandMenu.open": { label: "Command menu", group: "General" },
};

function loadOverrides(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

let overrides: Record<string, string> = loadOverrides();
const listeners = new Set<() => void>();

function persist() {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    } catch {
      /* storage full or unavailable: keep the in-memory overrides */
    }
  }
  for (const l of listeners) l();
}

/** Subscribe to scheme changes (the editor UI re-renders on change). */
export function subscribeShortcuts(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The default chord for a command (ignores user overrides). */
export function defaultChord(commandId: string): string {
  return DEFAULT_SCHEME.bindings.find((b) => b.commandId === commandId)?.chord ?? "";
}

/** The effective chord for a command (override or default). */
export function getChord(commandId: string): string {
  return overrides[commandId] ?? defaultChord(commandId);
}

export function isCustomized(commandId: string): boolean {
  return overrides[commandId] !== undefined && overrides[commandId] !== defaultChord(commandId);
}

/** The active scheme = defaults with overrides applied. */
export function activeScheme(): ShortcutScheme {
  const bindings = DEFAULT_SCHEME.bindings.map((b) =>
    overrides[b.commandId] ? { ...b, chord: overrides[b.commandId] } : b,
  );
  return { id: Object.keys(overrides).length ? "custom" : "default", name: tr("app.editor_shortcuts"), bindings };
}

/** Set (and normalize) a command's chord. Throws if the chord is invalid. */
export function setChord(commandId: string, chord: string): void {
  const normalized = normalizeChord(chord); // throws on an empty/invalid chord
  if (normalized === defaultChord(commandId)) delete overrides[commandId];
  else overrides[commandId] = normalized;
  persist();
}

export function resetChord(commandId: string): void {
  delete overrides[commandId];
  persist();
}

export function resetAllShortcuts(): void {
  overrides = {};
  persist();
}

/** Conflicting bindings in the active scheme (same chord, same context). */
export function shortcutConflicts() {
  return detectConflicts(activeScheme());
}

/** Resolve a DOM keyboard event to a command id, or null. */
export function commandForEvent(e: KeyboardEvent): string | null {
  const ke: ChordKeyEvent = { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey };
  return resolveChord(ke, activeScheme(), PLATFORM)?.commandId ?? null;
}

/** Build a normalized chord string from a captured keydown (for the editor UI).
 *  Returns null while only modifiers are held (incomplete chord). */
export function captureChord(e: KeyboardEvent): string | null {
  const key = e.key.toLowerCase();
  if (key === "control" || key === "shift" || key === "alt" || key === "meta") return null;
  const mods: string[] = [];
  if (PLATFORM === "mac" ? e.metaKey : e.ctrlKey) mods.push("mod");
  if (PLATFORM === "mac" && e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  try {
    return normalizeChord([...mods, e.key].join("+"));
  } catch {
    return null;
  }
}

/** Pretty-print a chord for display (mod -> ⌘ on mac / Ctrl elsewhere). */
export function formatChord(chord: string): string {
  const map: Record<string, string> =
    PLATFORM === "mac"
      ? { mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" }
      : { mod: tr("app.ctrl"), ctrl: tr("app.ctrl"), alt: tr("app.alt"), shift: tr("app.shift") };
  return chord
    .split("+")
    .map((t) => map[t] ?? (t.length === 1 ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1)))
    .join(PLATFORM === "mac" ? "" : "+");
}
