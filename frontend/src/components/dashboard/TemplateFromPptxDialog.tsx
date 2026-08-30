// The one-click AI template builder (F40 E13): drop a PPTX, watch the deck
// import + layout extraction + theme derivation run, review the result
// (engine-rendered page previews, layout count, palette, fonts, and the
// honest losses list), name it, and save it as a workspace template - which
// then appears in the generation flows as a first-class base (E14).

import { useEffect, useRef, useState } from "react";
import { FileUp, Layers, Loader2 } from "lucide-react";
import type { DesignFile, Theme } from "@hc/schema";
import { createScene, renderScene, type CanvasLike, type Viewport } from "@hc/engine";
import { oc } from "@/lib/sdk";
import { imageAssets } from "@/lib/assetProvider";
import { buildTemplateFromPptx, type PptxTemplateResult } from "@/lib/templateFromPptx";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { userMessage } from "@/lib/errors";
import { tr } from "@/lib/i18n";

const THUMB_W = 168;
const THUMB_H = 96;

/** Engine-rendered preview of one page of the candidate template file. */
function PagePreview({ file, index }: { file: DesignFile; index: number }) {
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
        /* tainted image: preview stays white */
      }
    };
    paint();
    const off = imageAssets.onChange(() => paint());
    return off;
  }, [file, index]);
  return <canvas ref={ref} className="max-h-full max-w-full" />;
}

export function TemplateFromPptxDialog({ open, onClose, workspaceId, onSaved }: {
  open: boolean;
  onClose: () => void;
  workspaceId: string | null;
  onSaved?: () => void;
}) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [building, setBuilding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<PptxTemplateResult | null>(null);
  const [title, setTitle] = useState("");

  async function pick(files: FileList | null) {
    const f = files?.[0];
    if (!f || building) return;
    setBuilding(true);
    setResult(null);
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const built = await buildTemplateFromPptx(workspaceId, bytes, f.name);
      // Register the imported deck's assets so previews render its images.
      imageAssets.registerAll(((built.file.assets ?? []) as { id: string; url: string; kind?: string }[]).filter((a) => !imageAssets.url(a.id)));
      setResult(built);
      setTitle(built.suggestedTitle);
    } catch (e) {
      toast.error(userMessage(e, tr("dashboard.couldnt_read_that_pptx")));
    } finally {
      setBuilding(false);
    }
  }

  async function save() {
    if (!result || !workspaceId || saving || !title.trim()) return;
    setSaving(true);
    try {
      await oc.saveAsTemplate({
        workspaceId,
        file: result.file,
        title: title.trim(),
        category: "presentations",
        tags: ["pptx", "imported"],
        visibility: "workspace",
      });
      toast.success(tr("dashboard.template_created_from_pptx"));
      setResult(null);
      setTitle("");
      onSaved?.();
      onClose();
    } catch (e) {
      toast.error(userMessage(e, tr("dashboard.couldnt_save_the_template")));
    } finally {
      setSaving(false);
    }
  }

  const themeColors = (result?.theme?.colors ?? []).map((c: Theme["colors"][number]) => {
    const s = c.color.srgb;
    const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
    return `#${h(s.r)}${h(s.g)}${h(s.b)}`;
  });

  return (
    <Modal open={open} onClose={onClose} title={tr("dashboard.template_from_powerpoint")} width="w-[38rem]">
      <div className="flex flex-col gap-3">
        {!result && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-neutral-300 bg-neutral-50/60 px-6 py-10 text-center">
            {building ? (
              <>
                <Loader2 size={28} className="animate-spin text-brand-500" />
                <p className="text-sm text-neutral-600">{tr("dashboard.importing_and_analyzing_slides")}</p>
              </>
            ) : (
              <>
                <FileUp size={28} className="text-neutral-400" />
                <p className="max-w-sm text-sm text-neutral-600">{tr("dashboard.pptx_template_hint")}</p>
                <Button size="sm" onClick={() => fileRef.current?.click()}>{tr("dashboard.choose_pptx")}</Button>
                <input ref={fileRef} type="file" accept=".pptx" hidden onChange={(e) => { void pick(e.target.files); e.target.value = ""; }} />
              </>
            )}
          </div>
        )}

        {result && (
          <>
            {/* Page previews, engine-rendered so they cannot lie. */}
            <div className="oc-scroll-none flex gap-2 overflow-x-auto pb-1">
              {result.file.pages.slice(0, 12).map((pg, i) => (
                <span key={pg.id} className="grid shrink-0 place-items-center overflow-hidden rounded-lg border border-neutral-200 bg-white" style={{ width: THUMB_W, height: THUMB_H }}>
                  <PagePreview file={result.file} index={i} />
                </span>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-600">
              <span className="flex items-center gap-1"><Layers size={13} /> {tr("dashboard.layouts_extracted_count", { count: result.layoutCount })}</span>
              {result.theme && (
                <span className="flex items-center gap-1">
                  {themeColors.slice(0, 6).map((c, i) => (
                    <span key={i} className="h-3 w-3 rounded-full border border-black/10" style={{ backgroundColor: c }} />
                  ))}
                  {result.theme.fontHeading && <span className="ms-1 text-neutral-500">{[result.theme.fontHeading, result.theme.fontBody].filter(Boolean).join(" + ")}</span>}
                </span>
              )}
            </div>

            {result.losses.length > 0 && (
              <ul className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                {result.losses.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            )}

            <div className="flex items-center gap-2">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tr("dashboard.template_name")} aria-label={tr("dashboard.template_name")} maxLength={120} className="h-9 flex-1" />
              <Button size="sm" onClick={() => void save()} disabled={saving || !title.trim() || !workspaceId}>
                {saving ? tr("dashboard.saving_template") : tr("dashboard.save_as_workspace_template")}
              </Button>
            </div>
            <button onClick={() => { setResult(null); setTitle(""); }} className="self-start text-[11px] text-neutral-500 hover:underline">
              {tr("dashboard.pick_a_different_file")}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
