// The reorderable effect stack (F40 FR-17).
//
// "Any node or group carries an ordered, reorderable stack of operations...
// Reordering the stack changes the rendered result accordingly."
//
// Order was always load-bearing and never editable. `effectsFilter` composes
// CSS filter functions in array order and they apply left to right, so
// brightness-then-blur has never been the same picture as blur-then-brightness.
// The panel simply had no way to say which one you meant: it was built on
// `find(kind)`/`has(kind)`, which caps a node at one effect per kind and cannot
// express sequence at all.
//
// This is also the surface F40 calls the on-ramp: "the single highest-value
// entry point: it is a graph the user can understand as a list". The rows here
// are the same ops `lowerEffects` produces, in the same order, which is what
// makes the list genuinely BE the graph rather than a summary of it.
//
// Reordering is keyboard-first. Section 12 requires the linear stack to be
// fully operable without a pointer, and it is the accessible equivalent of the
// node-link view, so drag is an addition to the buttons rather than the way in.

import { ChevronDown, ChevronUp, Eye, EyeOff, Trash2 } from "lucide-react";
import type { Effect } from "@hc/schema";
import { useEditor } from "@/store/editor";
import { tr, trOr } from "@/lib/i18n";

interface Props {
  id: string;
  effects: readonly Effect[];
  /** Rendered under a row's header: the existing per-kind parameter controls. */
  renderParams?: (effect: Effect, index: number) => React.ReactNode;
}

/** A stable, human-readable summary so a collapsed row still says something. */
function describe(effect: Effect): string {
  switch (effect.kind) {
    case "blur":
      return `${Math.round(effect.radius)}px`;
    case "glow":
      return `${Math.round(effect.radius)}px`;
    case "outline":
      return `${Math.round(effect.width)}px`;
    case "shadow":
      return `${Math.round(effect.offsetX)}, ${Math.round(effect.offsetY)}`;
    case "adjustment":
      return String(effect.ops.length);
    default:
      return "";
  }
}

export function EffectStack({ id, effects, renderParams }: Props) {
  const st = useEditor.getState();
  if (effects.length === 0) return null;

  return (
    <ul className="space-y-1.5" aria-label={tr("editor.effect_stack")}>
      {effects.map((effect, i) => {
        // Absent means enabled: an effect authored before this field existed
        // must render, so only an explicit false switches one off.
        const on = effect.enabled !== false;
        return (
          <li key={i} className="rounded-lg border border-neutral-200 bg-surface px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className={`flex-1 truncate text-[11px] font-medium ${on ? "text-neutral-800" : "text-neutral-400"}`}>
                {trOr(`editor.effect_${effect.kind}`, effect.kind)}
                {describe(effect) && (
                  <span className="ms-1 font-normal text-neutral-400">{describe(effect)}</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => st.setEffectEnabled(id, i, !on)}
                aria-pressed={on}
                title={on ? tr("editor.disable_effect") : tr("editor.enable_effect")}
                className="rounded p-1 text-neutral-500 transition hover:bg-neutral-100"
              >
                {on ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
              <button
                type="button"
                onClick={() => st.moveEffect(id, i, i - 1)}
                disabled={i === 0}
                title={tr("editor.move_effect_up")}
                className="rounded p-1 text-neutral-500 transition hover:bg-neutral-100 disabled:opacity-30"
              >
                <ChevronUp size={13} />
              </button>
              <button
                type="button"
                onClick={() => st.moveEffect(id, i, i + 1)}
                disabled={i === effects.length - 1}
                title={tr("editor.move_effect_down")}
                className="rounded p-1 text-neutral-500 transition hover:bg-neutral-100 disabled:opacity-30"
              >
                <ChevronDown size={13} />
              </button>
              <button
                type="button"
                onClick={() => st.removeEffectAt(id, i)}
                title={tr("editor.remove_effect")}
                className="rounded p-1 text-neutral-500 transition hover:bg-neutral-100"
              >
                <Trash2 size={13} />
              </button>
            </div>
            {on && renderParams && <div className="mt-1.5">{renderParams(effect, i)}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/** The kinds the add menu offers, in the order they are most often reached for. */
export const addableEffects: Effect["kind"][] = ["shadow", "blur", "glow", "outline", "adjustment"];

export function AddEffectRow({ id }: { id: string }) {
  const st = useEditor.getState();
  return (
    <div className="flex flex-wrap gap-1">
      {addableEffects.map((kind) => (
        <button
          key={kind}
          type="button"
          onClick={() => st.addEffect(id, kind)}
          className="rounded-md border border-neutral-200 bg-surface px-2 py-1 text-[10px] font-medium text-neutral-600 transition hover:bg-neutral-100"
        >
          {`+ ${trOr(`editor.effect_${kind}`, kind)}`}
        </button>
      ))}
    </div>
  );
}
