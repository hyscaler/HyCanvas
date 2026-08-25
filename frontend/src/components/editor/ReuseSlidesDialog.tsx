// Reuse slides from another deck (F28 completion C38): pick one of the
// workspace's other designs, tick the slides you want, and insert copies after
// the current slide. Copies are id-regenerated (intra-slide references
// rewritten), their assets carried (colliding ids reminted), and optionally
// restyled to this document's theme via the exact slot-by-slot remap - all in
// one undo step through the store's importPagesFrom.

import { useEffect, useRef, useState } from "react";
import { Check, Layers } from "lucide-react";
import { migrate, slideTitle, type DesignFile, type Theme } from "@hc/schema";
import { createScene, renderScene, type CanvasLike, type Viewport } from "@hc/engine";
import type { HomeItem } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { imageAssets } from "@/lib/assetProvider";
import { useEditor } from "@/store/editor";
import { useBrand } from "@/store/brand";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { tr } from "@/lib/i18n";

const THUMB_W = 148;
const THUMB_H = 90;

/** A thumbnail of one page of a FOREIGN design file (SlideThumb renders only
 *  the open document). Same engine path, so the preview cannot lie. */
function ForeignThumb({ file, index }: { file: DesignFile; index: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const pg = file.pages[index];
    if (!canvas || !pg) return;
    const scale = Math.min(THUMB_W / pg.width, THUMB_H / pg.height);
    const cw = Math.max(1, Math.round(pg.width * scale));
    const ch = Math.max(1, Math.round(pg.height * scale));
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const paint = () => {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, cw, ch);
      try {
        renderScene(createScene(file, index), ctx as unknown as CanvasLike, { zoom: scale, panX: 0, panY: 0, dpr: 1, width: cw, height: ch } as Viewport, { assets: imageAssets });
      } catch {
        /* a cross-origin image can throw; the thumb stays white */
      }
    };
    paint();
    // Repaint as the foreign deck's images finish loading.
    const off = imageAssets.onChange(() => paint());
    return off;
  }, [file, index]);
  return <canvas ref={ref} className="max-h-full max-w-full" />;
}

export function ReuseSlidesDialog({ open, onClose, currentDesignId }: { open: boolean; onClose: () => void; currentDesignId: string | null }) {
  const toast = useToast();
  const workspaceId = useBrand((s) => s.workspaceId);
  const [decks, setDecks] = useState<HomeItem[] | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [file, setFile] = useState<DesignFile | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [matchTheme, setMatchTheme] = useState(true);

  // The design list loads on mount (the caller mounts this dialog per open,
  // so every open starts from the initial state - no sync resets needed); the
  // current design is not a source for itself (duplicate-page covers that).
  useEffect(() => {
    if (!open || !workspaceId) return;
    let cancelled = false;
    oc.search(workspaceId, undefined, "design")
      .then((items) => {
        if (cancelled) return;
        setDecks(items.filter((it) => it.kind === "design" && it.id !== currentDesignId));
      })
      .catch(() => { if (!cancelled) setDecks([]); });
    return () => { cancelled = true; };
  }, [open, workspaceId, currentDesignId]);

  async function pickDeck(id: string) {
    setPickedId(id);
    setFile(null);
    setSelected(new Set());
    setLoadingFile(true);
    try {
      const f = migrate(await oc.getDesignFile(id));
      // Register the foreign deck's assets for the previews - but never
      // repoint an id THIS document already resolves (a collision would
      // briefly repaint the open canvas with the other deck's image).
      imageAssets.registerAll((f.assets ?? []).filter((a) => !imageAssets.url(a.id)));
      setFile(f);
    } catch {
      toast.error(tr("editor.couldnt_open_that_design"));
      setPickedId(null);
    } finally {
      setLoadingFile(false);
    }
  }

  function toggle(i: number) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function insert() {
    if (!file || !selected.size) return;
    const indices = [...selected].sort((a, b) => a - b);
    const n = useEditor.getState().importPagesFrom(file, indices, { matchTheme });
    if (n > 0) {
      toast.success(tr("editor.inserted_n_slides", { count: n }));
      onClose();
    } else {
      toast.error(tr("editor.couldnt_insert_those_slides"));
    }
  }

  const destTheme = (useEditor.getState().doc as unknown as { theme?: Theme }).theme;
  const srcTheme = (file as unknown as { theme?: Theme } | null)?.theme;
  const themeChoice = !!destTheme && !!srcTheme && destTheme.id !== srcTheme.id;

  return (
    <Modal open={open} onClose={onClose} title={tr("editor.reuse_slides")} width="w-[42rem]">
      <div className="flex max-h-[70vh] min-h-72 gap-3">
        {/* Deck list */}
        <div className="oc-scroll w-52 shrink-0 overflow-y-auto border-e border-neutral-100 pe-2">
          {decks === null && <div className="grid place-items-center py-8"><Spinner /></div>}
          {decks !== null && decks.length === 0 && (
            <p className="px-1 py-4 text-xs text-neutral-400">{tr("editor.no_other_designs_in_this_workspace")}</p>
          )}
          <ul className="flex flex-col gap-1">
            {(decks ?? []).map((d) => (
              <li key={d.id}>
                <button
                  onClick={() => void pickDeck(d.id)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm transition ${
                    pickedId === d.id ? "bg-brand-50 text-brand-ink" : "text-neutral-700 hover:bg-neutral-50"
                  }`}
                >
                  <Layers size={14} className="shrink-0 text-neutral-400" />
                  <span className="min-w-0 flex-1 truncate">{d.title || tr("editor.untitled")}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Slide picker */}
        <div className="flex min-w-0 flex-1 flex-col">
          {!pickedId && (
            <p className="grid flex-1 place-items-center px-6 text-center text-sm text-neutral-400">
              {tr("editor.pick_a_design_to_browse_its_slides")}
            </p>
          )}
          {pickedId && loadingFile && <div className="grid flex-1 place-items-center"><Spinner /></div>}
          {file && !loadingFile && (
            <>
              <div className="oc-scroll min-h-0 flex-1 overflow-y-auto">
                <div className="flex flex-wrap gap-2.5 p-1">
                  {file.pages.map((pg, i) => {
                    const on = selected.has(i);
                    return (
                      <button
                        key={pg.id}
                        onClick={() => toggle(i)}
                        aria-pressed={on}
                        data-testid={`reuse-slide-${i}`}
                        className={`relative rounded-lg border-2 p-0.5 transition ${on ? "border-brand-500" : "border-neutral-200 hover:border-neutral-300"}`}
                      >
                        <span className="grid place-items-center overflow-hidden rounded bg-white" style={{ width: THUMB_W, height: THUMB_H }}>
                          <ForeignThumb file={file} index={i} />
                        </span>
                        <span className="mt-0.5 block max-w-full truncate px-0.5 text-start text-[10px] text-neutral-500" style={{ maxWidth: THUMB_W }}>
                          {i + 1} · {slideTitle(pg, i)}
                        </span>
                        {on && (
                          <span className="absolute -end-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-brand-600 text-white shadow">
                            <Check size={12} />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="mt-2 flex shrink-0 items-center gap-3 border-t border-neutral-100 pt-2.5">
                {themeChoice && (
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-neutral-600">
                    <input type="checkbox" checked={matchTheme} onChange={(e) => setMatchTheme(e.target.checked)} />
                    {tr("editor.match_this_documents_theme")}
                  </label>
                )}
                <Button size="sm" className="ms-auto" disabled={!selected.size} onClick={insert}>
                  {tr("editor.insert_n_slides", { count: selected.size })}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
