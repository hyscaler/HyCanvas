// Command palette: Cmd/Ctrl+K opens a fuzzy-searchable list of editor
// actions, ranked by @hc/commandmenu. Every action runs through the editor
// store so it participates in undo/redo. It also doubles as the AI command bar
// (F22 FR-13): a natural-language request is routed to the best-matching action
// by oc.aiText against a manifest of the registry, then executed through the
// same store path (so it stays undoable). The normal fuzzy search works
// alongside the AI mode. Inline argument entry and full rebindable shortcuts are
// deferred; common keys live on the canvas.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { search, type MenuItem } from "@hc/commandmenu";
import type { Node } from "@hc/schema";
import { useEditor } from "@/store/editor";
import { oc } from "@/lib/sdk";
import { useToast } from "@/components/ui/Toast";
import { promptText, alertText } from "@/lib/promptDialog";
import {
  buildCommandManifest,
  buildCommandBarSystem,
  parseCommandChoice,
} from "@/lib/aiCommandBar";
import { generateAltText, generateAltTextForAll } from "@/lib/altText";

interface Command extends MenuItem {
  run: () => void;
}

export function CommandMenu({ onExport, onShortcuts, workspaceId }: { onExport: () => void; onShortcuts: () => void; workspaceId: string | null }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Whether the AI route is currently resolving the typed request.
  const [asking, setAsking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Stable id prefix so listbox/option ids and aria-activedescendant line up and
  // remain unique if multiple palettes ever mount.
  const baseId = useId();
  const listId = `${baseId}-list`;
  const aiOptionId = `${baseId}-opt-ai`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const commands = useMemo<Command[]>(() => {
    const s = useEditor.getState;
    return [
      { id: "insert.rect", label: "Add rectangle", category: "Insert", keywords: ["shape", "box"], run: () => s().addNode("shape", { name: "Rectangle", shape: "rect", transform: { x: 300, y: 300, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 220, height: 150 }, fills: [{ type: "solid", color: { srgb: { r: 0.27, g: 0.51, b: 0.96, a: 1 } } }] } as Partial<Node>) },
      { id: "insert.ellipse", label: "Add ellipse", category: "Insert", keywords: ["circle"], run: () => s().addNode("shape", { name: "Ellipse", shape: "ellipse", transform: { x: 320, y: 320, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 200, height: 200 }, fills: [{ type: "solid", color: { srgb: { r: 0.2, g: 0.74, b: 0.55, a: 1 } } }] } as Partial<Node>) },
      { id: "insert.text", label: "Add text", category: "Insert", run: () => s().addNode("text", { name: "Text", transform: { x: 300, y: 320, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 320, height: 64 }, box: { mode: "fixed", width: 320, height: 64, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "top" }, content: [{ runs: [{ text: "Text", style: { fontFamily: "system", fontStyle: "SemiBold", fontSize: 48, axes: { wght: 600 }, fill: { type: "solid", color: { srgb: { r: 0.1, g: 0.12, b: 0.16, a: 1 } } } } }], style: { align: "left", direction: "auto" } }] } as Partial<Node>) },
      { id: "insert.image", label: "Add image from URL", category: "Insert", run: async () => { const t = await promptText({ title: "Add image", label: "Image URL", placeholder: "https://…", confirmText: "Add" }); if (!t) return; if (/^https?:\/\//i.test(t)) s().addImage(t); else await alertText("Please enter an http(s) image URL."); } },
      { id: "edit.delete", label: "Delete selection", category: "Edit", run: () => s().deleteSelection() },
      { id: "edit.group", label: "Group", category: "Edit", run: () => s().group() },
      { id: "edit.ungroup", label: "Ungroup", category: "Edit", run: () => s().ungroupSelection() },
      { id: "edit.findReplace", label: "Find & replace…", category: "Edit", keywords: ["replace", "search", "text"], run: async () => {
        const find = await promptText({ title: "Find & replace", label: "Find text", confirmText: "Next" });
        if (!find) return;
        const replace = await promptText({ title: "Find & replace", label: `Replace "${find}" with`, confirmText: "Replace all" });
        if (replace === null) return; // cancelled (empty string is a valid replacement)
        const n = s().findReplace(find, replace);
        await alertText(n ? `Replaced in ${n} text element(s).` : "No matches found.");
      } },
      { id: "edit.undo", label: "Undo", category: "Edit", shortcut: "Cmd+Z", run: () => s().undo() },
      { id: "edit.redo", label: "Redo", category: "Edit", shortcut: "Shift+Cmd+Z", run: () => s().redo() },
      { id: "arrange.front", label: "Bring to front", category: "Arrange", run: () => s().orderSelection("front") },
      { id: "arrange.back", label: "Send to back", category: "Arrange", run: () => s().orderSelection("back") },
      { id: "arrange.alignLeft", label: "Align left", category: "Arrange", run: () => s().alignSelection("left") },
      { id: "arrange.alignCenter", label: "Align center", category: "Arrange", run: () => s().alignSelection("hcenter") },
      { id: "arrange.alignRight", label: "Align right", category: "Arrange", run: () => s().alignSelection("right") },
      { id: "path.union", label: "Combine: Union", category: "Combine", keywords: ["boolean", "merge"], run: () => s().booleanSelection("union") },
      { id: "path.subtract", label: "Combine: Subtract", category: "Combine", keywords: ["boolean", "minus"], run: () => s().booleanSelection("subtract") },
      { id: "path.intersect", label: "Combine: Intersect", category: "Combine", keywords: ["boolean"], run: () => s().booleanSelection("intersect") },
      { id: "path.exclude", label: "Combine: Exclude", category: "Combine", keywords: ["boolean", "xor"], run: () => s().booleanSelection("exclude") },
      // AI alt-text (F22 FR-12): gated on workspaceId (the AI provider lives there).
      { id: "ai.altText", label: "Generate alt text for selected image", category: "AI", keywords: ["accessibility", "describe", "a11y"], run: () => void runAltText(false) },
      { id: "ai.altTextAll", label: "Generate alt text for all images", category: "AI", keywords: ["accessibility", "describe", "a11y", "bulk"], run: () => void runAltText(true) },
      { id: "file.export", label: "Export…", category: "File", keywords: ["download", "png", "svg"], shortcut: "Cmd+E", run: onExport },
      { id: "help.shortcuts", label: "Keyboard shortcuts", category: "Help", keywords: ["keys", "cheat sheet", "bindings", "hotkeys"], shortcut: "?", run: onShortcuts },
    ];
    // runAltText is defined below in the component; the closure captures it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onExport, onShortcuts, workspaceId]);

  // Alt-text runner shared by the AI menu actions and the AI router.
  async function runAltText(all: boolean): Promise<void> {
    if (!workspaceId) { toast.error("Open a saved design to use AI."); return; }
    try {
      if (all) {
        const { done, failed } = await generateAltTextForAll(workspaceId);
        if (!done && !failed) toast.success("No images to describe.");
        else if (failed) toast.success(`Alt text written for ${done} image${done === 1 ? "" : "s"} (${failed} failed).`);
        else toast.success(`Alt text written for ${done} image${done === 1 ? "" : "s"}.`);
      } else {
        const ok = await generateAltText(workspaceId);
        toast.success(ok ? "Alt text written." : "Select a single image first.");
      }
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : "Could not generate alt text.");
    }
  }

  const results = useMemo(() => search(query, commands, { limit: 8 }).map((r) => r.item as Command), [query, commands]);

  // The AI command-bar route is offered when there is a query, a workspace (so
  // the AI provider is reachable), and the normal fuzzy search found no exact
  // match (or as an always-available fallback at the bottom). We surface it as a
  // synthetic first row so the user can hit Enter to "Ask AI".
  const aiAvailable = !!workspaceId && query.trim().length > 0;

  // Ask the model to route the typed request to the best-matching command, then
  // execute it through the store (undoable). Falls back gracefully on no match,
  // malformed output, or no AI config.
  async function askAi(): Promise<void> {
    const q = query.trim();
    if (!q || !workspaceId || asking) return;
    setAsking(true);
    try {
      const manifest = buildCommandManifest(commands);
      const system = buildCommandBarSystem(manifest);
      const { text } = await oc.aiText({ workspaceId, prompt: q, system });
      const choice = parseCommandChoice(text, commands.map((c) => c.id));
      if (!choice.action) {
        toast.toast("No matching action for that request.", "info");
        return;
      }
      const cmd = commands.find((c) => c.id === choice.action);
      if (!cmd) {
        toast.toast("No matching action for that request.", "info");
        return;
      }
      setOpen(false);
      setQuery("");
      cmd.run();
      toast.success(`Ran: ${cmd.label}`);
    } catch {
      // No AI config (400) or provider failure (502), or any parse issue: degrade
      // to the normal palette so the user can still pick a command manually.
      toast.error("AI couldn't route that. Try picking a command directly.");
    } finally {
      setAsking(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Crop and present mode own the keyboard; don't open the command menu or
      // export under their overlays.
      const ed = useEditor.getState();
      if (ed.cropping || ed.presenting) return;
      const el = e.target as HTMLElement | null;
      const typing =
        el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || !!el?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setQuery("");
        setActive(0);
        return;
      }
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      // Cmd/Ctrl+E exports, but not while typing in a field.
      if (!typing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        onExport();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExport]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Keep the active row visible when arrowing through a long list. The AI row
  // (active === -1) sits at the top, so no scrolling is needed for it.
  useEffect(() => {
    if (!open) return;
    if (active < 0) return;
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`#${CSS.escape(optionId(active))}`);
    el?.scrollIntoView({ block: "nearest" });
    // optionId is stable for the component lifetime; only active/open drive this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open]);

  if (!open) return null;

  // The option the input points screen readers at via aria-activedescendant.
  const activeOptionId = active === -1 ? (aiAvailable ? aiOptionId : undefined) : optionId(active);

  const choose = (cmd: Command | undefined) => {
    if (!cmd) return;
    setOpen(false);
    cmd.run();
  };

  // Enter on the AI row (the synthetic first item, index -1) routes via AI; Enter
  // on a real result runs that command. We model the AI row as active === -1.
  const onEnter = () => {
    if (active < 0) {
      void askAi();
    } else {
      choose(results[active]);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-start bg-black/20 pt-32" onClick={() => setOpen(false)}>
      <div className="mx-auto w-[28rem] overflow-hidden rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={true}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          aria-label="Command palette"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // When a query is present, default focus to the AI row so Enter asks
            // AI; clearing the query resets to the first result.
            setActive(e.target.value.trim() && aiAvailable ? -1 : 0);
          }}
          onKeyDown={(e) => {
            const min = aiAvailable ? -1 : 0;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, min));
            } else if (e.key === "Enter") {
              e.preventDefault();
              onEnter();
            }
          }}
          placeholder="Type a command, or describe what you want…"
          className="w-full border-b border-neutral-200 px-4 py-3 text-sm outline-none"
        />
        <ul ref={listRef} id={listId} role="listbox" aria-label="Commands" className="max-h-72 overflow-y-auto py-1">
          {aiAvailable && (
            <li role="option" id={aiOptionId} aria-selected={active === -1}>
              <button
                tabIndex={-1}
                onMouseEnter={() => setActive(-1)}
                onClick={() => void askAi()}
                disabled={asking}
                className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm ${active === -1 ? "bg-brand-50" : ""} disabled:opacity-60`}
              >
                <Sparkles size={14} className="shrink-0 text-brand-600" />
                <span className="truncate">
                  <span className="text-brand-600">Ask AI · </span>
                  {asking ? "Thinking…" : `“${query.trim()}”`}
                </span>
              </button>
            </li>
          )}
          {results.length === 0 && !aiAvailable && <li className="px-4 py-2 text-sm text-neutral-400">No matching command</li>}
          {results.map((cmd, i) => (
            <li key={cmd.id} role="option" id={optionId(i)} aria-selected={i === active}>
              <button
                tabIndex={-1}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(cmd)}
                className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm ${i === active ? "bg-neutral-100" : ""}`}
              >
                <span>
                  <span className="text-neutral-400">{cmd.category} · </span>
                  {cmd.label}
                </span>
                {cmd.shortcut && <span className="text-xs text-neutral-400">{cmd.shortcut}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
