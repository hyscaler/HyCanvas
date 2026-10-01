// A model name field with the provider's catalog under it.
//
// The browser's own datalist was the first cut and did not hold up: its
// popup matches on the start of a value only ("sonnet" finds nothing), cannot
// show the provider's label, and Chrome stops offering it once the field
// already carries a value that no option starts with. This list is in the
// page instead: it matches anywhere in the id or the label, opens on focus
// and on typing, moves with the arrow keys, picks with Enter or a click, and
// leaves free text alone, so a name the catalog does not carry still saves.

import { useId, useRef, useState } from "react";
import type { AiModelInfo } from "@hc/sdk";

/** How many matches the list shows at once; the rest need more letters. */
const SHOWN = 12;

/** The catalog entries whose id or label contains the query, in order. */
export function matchModels(models: AiModelInfo[], query: string, limit = SHOWN): AiModelInfo[] {
  const q = query.trim().toLowerCase();
  const out: AiModelInfo[] = [];
  for (const m of models) {
    if (q && !m.id.toLowerCase().includes(q) && !(m.label ?? "").toLowerCase().includes(q)) continue;
    out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

export function ModelSuggestInput({
  id,
  value,
  onChange,
  models,
  placeholder,
  className,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** The fetched catalog; an empty list leaves the field a plain text box. */
  models: AiModelInfo[];
  placeholder?: string;
  className: string;
  invalid?: boolean;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  // A click on an option fires after the input's blur; the flag keeps the
  // list open across that blur so the click lands.
  const picking = useRef(false);
  // A field that holds a catalog id exactly (a picked model) opens on the
  // WHOLE catalog, to browse or switch, with the current model highlighted;
  // anything else filters as typed.
  const exact = models.findIndex((m) => m.id === value.trim());
  const matches = open ? matchModels(models, exact >= 0 ? "" : value, exact >= 0 ? models.length : undefined) : [];
  const shown = matches.length > 0;
  const activeIndex = Math.min(active ?? Math.max(0, exact), Math.max(0, matches.length - 1));

  const pick = (m: AiModelInfo) => {
    onChange(m.id);
    setOpen(false);
    setActive(null);
  };

  return (
    <div className="relative">
      <input
        id={id}
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown ? `${listId}-${activeIndex}` : undefined}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(null); }}
        onFocus={() => setOpen(true)}
        onBlur={() => { if (!picking.current) setOpen(false); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) setOpen(true);
            else setActive(Math.min(activeIndex + 1, Math.max(0, matches.length - 1)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive(Math.max(activeIndex - 1, 0));
          } else if (e.key === "Enter" && shown) {
            e.preventDefault();
            pick(matches[activeIndex]);
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            setOpen(false);
          }
        }}
        className={className}
      />
      {shown && (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-lg border border-neutral-200 bg-surface py-1 shadow-lg ring-1 ring-black/5"
          onMouseDown={() => { picking.current = true; }}
          onMouseUp={() => { picking.current = false; }}
          onMouseLeave={() => { picking.current = false; }}
        >
          {matches.map((m, i) => (
            <li
              key={m.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(m)}
              className={`flex cursor-pointer flex-col px-3 py-1.5 ${i === activeIndex ? "bg-brand-50 text-brand-ink" : "text-neutral-800"}`}
            >
              <span className="truncate font-mono text-xs">{m.id}</span>
              {m.label && m.label !== m.id && <span className="truncate text-[11px] text-neutral-500">{m.label}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
