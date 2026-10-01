// Pick slides from a multi-page template. A presentation kit carries every
// layout a deck needs (cover, agenda, section, figures, chart, team, closing
// and so on); a deck rarely needs all of them at once, so the templates panel
// opens this picker for any template with more than one page and inserts
// only the ticked slides, through the same store path as applying the whole
// template: resized to this design's page size, one undo step, refused in a
// read-only view.

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { migrate, slideTitle, type DesignFile } from "@hc/schema";
import type { TemplateSummary } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { imageAssets } from "@/lib/assetProvider";
import { useEditor } from "@/store/editor";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { tr } from "@/lib/i18n";
import { ForeignThumb, THUMB_H, THUMB_W } from "./ReuseSlidesDialog";

/** The panel mounts this per open, so every open starts from the initial
 *  state: nothing loaded, nothing ticked. */
export function TemplateSlidesDialog({ template, onClose }: { template: TemplateSummary; onClose: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<DesignFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    // The template endpoint serves the stored file verbatim; a user-saved
    // template from an older build needs the forward migration first.
    oc.getTemplateFile(template.id)
      .then((raw) => migrate(raw))
      .then((f) => {
        if (cancelled) return;
        // Never repoint an asset id this document already resolves: the open
        // canvas would briefly show the template's picture instead.
        imageAssets.registerAll((f.assets ?? []).filter((a) => !imageAssets.url(a.id)));
        setFile(f);
      })
      .catch(() => {
        if (!cancelled) {
          toast.error(tr("editor.could_not_apply_the_template"));
          onClose();
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.id]);

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
    // A file of just the ticked pages goes through the whole-template path,
    // so a kit slide lands exactly as the full kit would: resized to this
    // design's page size, after the active page, one undo step.
    const subset: DesignFile = { ...file, pages: indices.map((i) => file.pages[i]) };
    if (useEditor.getState().applyTemplateFile(subset, template.title)) {
      toast.success(tr("editor.inserted_n_slides", { count: indices.length }));
      onClose();
    } else {
      toast.error(tr("editor.templates_cant_be_added_in_a_read_only_view"));
    }
  }

  const all = file ? file.pages.length : 0;
  const allOn = all > 0 && selected.size === all;

  return (
    <Modal open onClose={onClose} title={tr("editor.pick_slides_from", { title: template.title })} width="w-[42rem]">
      <div className="flex max-h-[70vh] min-h-72 flex-col">
        {loading && <div className="grid flex-1 place-items-center"><Spinner /></div>}
        {file && !loading && (
          <>
            <p className="mb-2 text-xs text-neutral-500">{tr("editor.pick_slides_hint")}</p>
            <div className="oc-scroll min-h-0 flex-1 overflow-y-auto">
              <div className="flex flex-wrap gap-2.5 p-1">
                {file.pages.map((pg, i) => {
                  const on = selected.has(i);
                  return (
                    <button
                      key={pg.id}
                      onClick={() => toggle(i)}
                      aria-pressed={on}
                      data-testid={`template-slide-${i}`}
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
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-neutral-600">
                <input type="checkbox" checked={allOn} onChange={(e) => setSelected(e.target.checked ? new Set(file.pages.map((_, i) => i)) : new Set())} />
                {tr("editor.select_all")}
              </label>
              <Button size="sm" className="ms-auto" disabled={!selected.size} onClick={insert}>
                {tr("editor.insert_n_slides", { count: selected.size })}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
