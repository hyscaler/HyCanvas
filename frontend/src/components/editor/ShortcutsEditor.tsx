// Shortcuts customizer: lets the user rebind the remappable editor
// commands. Records a chord from the next keypress, normalizes + persists it via
// the @hc/shortcuts-backed lib, surfaces live conflicts, and supports per-command
// and global reset. Embedded inside the keyboard-shortcuts modal.

import { useEffect, useReducer, useState } from "react";
import { RotateCcw, Circle } from "lucide-react";
import {
  REMAPPABLE_COMMANDS,
  COMMAND_LABELS,
  getChord,
  setChord,
  resetChord,
  resetAllShortcuts,
  isCustomized,
  formatChord,
  captureChord,
  shortcutConflicts,
  subscribeShortcuts,
} from "@/lib/shortcuts";

export function ShortcutsCustomizer() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const [recording, setRecording] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-render when the scheme changes (any window/tab via the lib's listeners).
  useEffect(() => subscribeShortcuts(() => force()), []);

  // While recording a command, capture the next chord in the capture phase so it
  // beats the canvas keydown handler, then persist it.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const chord = captureChord(e);
      if (!chord) return; // only modifiers held so far; keep listening
      try {
        setChord(recording, chord);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const conflicts = shortcutConflicts();
  const conflictCmds = new Set(conflicts.flatMap((c) => c.commandIds));
  const anyCustom = REMAPPABLE_COMMANDS.some((id) => isCustomized(id));

  return (
    <div className="mb-5 rounded-xl border border-neutral-200 bg-neutral-50/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-neutral-800">Customize shortcuts</h3>
          <p className="text-[11px] text-neutral-500">Click a key, then press the new combination. Esc cancels.</p>
        </div>
        <button
          type="button"
          onClick={() => resetAllShortcuts()}
          disabled={!anyCustom}
          className="flex items-center gap-1.5 rounded-md border border-neutral-200 bg-surface px-2.5 py-1 text-[11px] font-medium text-neutral-600 enabled:hover:bg-neutral-100 disabled:opacity-40"
        >
          <RotateCcw size={12} /> Reset all
        </button>
      </div>

      {conflicts.length > 0 && (
        <p className="mb-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700">
          {conflicts.length} conflict{conflicts.length === 1 ? "" : "s"}: the same key is bound to more than one command.
        </p>
      )}
      {error && <p className="mb-2 rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">{error}</p>}

      <ul className="space-y-1">
        {REMAPPABLE_COMMANDS.map((id) => {
          const meta = COMMAND_LABELS[id];
          const chord = getChord(id);
          const inConflict = conflictCmds.has(id);
          const rec = recording === id;
          return (
            <li key={id} className="flex items-center justify-between gap-3 text-sm text-neutral-700">
              <span className="truncate">{meta?.label ?? id}</span>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setRecording(rec ? null : id);
                  }}
                  className={
                    "flex min-w-[5rem] items-center justify-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium shadow-sm " +
                    (rec
                      ? "border-blue-400 bg-blue-50 text-blue-600"
                      : inConflict
                        ? "border-amber-300 bg-amber-50 text-amber-700"
                        : "border-neutral-200 bg-surface text-neutral-600 hover:bg-neutral-100")
                  }
                >
                  {rec ? (
                    <>
                      <Circle size={9} className="animate-pulse fill-current" /> Press keys
                    </>
                  ) : (
                    formatChord(chord)
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => resetChord(id)}
                  disabled={!isCustomized(id)}
                  title="Reset to default"
                  className="rounded-md p-1 text-neutral-400 enabled:hover:bg-neutral-200 enabled:hover:text-neutral-600 disabled:opacity-30"
                >
                  <RotateCcw size={12} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
