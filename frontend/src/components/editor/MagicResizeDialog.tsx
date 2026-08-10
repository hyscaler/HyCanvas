// Magic Resize: resize the current page into one or more new
// sizes, smartly re-laying out elements (geometric-mean scaling via @hc/editor
// resizePage, run by the store's magicResizePages). The user picks any number of
// size presets (or a custom size): one size resizes the current page in place;
// several create a re-flowed copy per size. Pure UI over the existing store action.

import { useState } from "react";
import { Wand2, X } from "lucide-react";
import { useEditor } from "@/store/editor";
import { useToast } from "@/components/ui/Toast";
import { tr } from "@/lib/i18n";

interface Preset { label: string; w: number; h: number }
const groups = (): { name: string; items: Preset[] }[] => [
  {
    name: tr("editor.social"),
    items: [
      { label: tr("editor.instagram_post"), w: 1080, h: 1080 },
      { label: tr("editor.instagram_story"), w: 1080, h: 1920 },
      { label: tr("editor.facebook_post"), w: 1200, h: 630 },
      { label: tr("editor.x_twitter_post"), w: 1600, h: 900 },
      { label: tr("editor.linkedin_post"), w: 1200, h: 627 },
      { label: tr("editor.youtube_thumbnail"), w: 1280, h: 720 },
    ],
  },
  {
    name: tr("editor.screen"),
    items: [
      { label: tr("editor.presentation_16_9"), w: 1920, h: 1080 },
      { label: tr("editor.presentation_4_3"), w: 1024, h: 768 },
      { label: tr("editor.widescreen"), w: 1280, h: 720 },
    ],
  },
  {
    name: tr("editor.print"),
    items: [
      { label: tr("editor.a4_portrait"), w: 794, h: 1123 },
      { label: tr("editor.a4_landscape"), w: 1123, h: 794 },
      { label: tr("editor.us_letter"), w: 816, h: 1056 },
      { label: tr("editor.poster"), w: 1080, h: 1350 },
    ],
  },
];

const keyOf = (p: { w: number; h: number }) => `${p.w}x${p.h}`;

// Magic Switch: one-click semantic format targets, including a
// multi-size set (a single design -> a social set). Each switches the page into
// the target format(s) in one action, reusing the smart reflow.
const formatSets = (): { label: string; emoji: string; sizes: { w: number; h: number }[] }[] => [
  { label: tr("editor.social_set"), emoji: "📱", sizes: [{ w: 1080, h: 1080 }, { w: 1080, h: 1920 }, { w: 1200, h: 630 }, { w: 1600, h: 900 }] },
  { label: tr("editor.story_reel"), emoji: "📲", sizes: [{ w: 1080, h: 1920 }] },
  { label: tr("editor.presentation"), emoji: "🖥", sizes: [{ w: 1920, h: 1080 }] },
  { label: tr("editor.document"), emoji: "📄", sizes: [{ w: 794, h: 1123 }] },
  { label: tr("editor.poster"), emoji: "🖼", sizes: [{ w: 1080, h: 1350 }] },
];

export function MagicResizeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [picked, setPicked] = useState<Record<string, { w: number; h: number }>>({});
  const [cw, setCw] = useState(1080);
  const [ch, setCh] = useState(1080);
  if (!open) return null;

  const toggle = (p: { w: number; h: number }) => {
    const k = keyOf(p);
    setPicked((prev) => {
      const next = { ...prev };
      if (next[k]) delete next[k];
      else next[k] = { w: p.w, h: p.h };
      return next;
    });
  };
  const addCustom = () => {
    if (cw > 0 && ch > 0) setPicked((prev) => ({ ...prev, [keyOf({ w: cw, h: ch })]: { w: cw, h: ch } }));
  };
  const targets = Object.values(picked);

  const apply = (sizes: { w: number; h: number }[], verb: string) => {
    if (!sizes.length) return;
    const ids = useEditor.getState().magicResizePages(sizes.map((s) => ({ width: s.w, height: s.h })));
    // A single size resizes the current page in place; multiple create a set.
    toast.success(sizes.length === 1 ? tr("editor.resized_this_page") : `${verb} ${ids.length} pages`);
    setPicked({});
    onClose();
  };
  const run = () => apply(targets, tr("editor.created"));

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div role="dialog" aria-label={tr("editor.magic_resize")} className="fixed left-1/2 top-1/2 z-50 max-h-[80vh] w-[26rem] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-neutral-200 bg-surface p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-base font-semibold text-neutral-900"><Wand2 size={16} className="text-brand-ink" /> {tr("editor.resize_and_switch")}</h2>
          <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-100"><X size={16} /></button>
        </div>
        {/* Magic Switch: one-click format targets (incl. a multi-size social set). */}
        <div className="mb-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">{tr("editor.switch_to_a_format")}</div>
          <div className="flex flex-wrap gap-1.5">
            {formatSets().map((f) => (
              <button
                key={f.label} onClick={() => apply(f.sizes, tr("editor.switched_to"))}
                title={f.sizes.map((s) => `${s.w}×${s.h}`).join(", ")}
                className="flex items-center gap-1 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-700 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-ink"
              >
                <span aria-hidden>{f.emoji}</span> {f.label}{f.sizes.length > 1 ? ` (${f.sizes.length})` : ""}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">{tr("editor.or_pick_exact_sizes")}</div>
        <p className="mb-2 text-xs text-neutral-500">{tr("editor.magic_resize_hint")}</p>

        {groups().map((g) => (
          <div key={g.name} className="mb-3">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">{g.name}</div>
            <div className="grid grid-cols-2 gap-1.5">
              {g.items.map((p) => {
                const active = !!picked[keyOf(p)];
                return (
                  <button
                    key={p.label} onClick={() => toggle(p)}
                    className={`flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-start text-xs transition ${active ? "border-brand-400 bg-brand-50 text-brand-ink" : "border-neutral-200 text-neutral-700 hover:bg-neutral-50"}`}
                  >
                    <span className="font-medium">{p.label}</span>
                    <span className="text-[10px] text-neutral-400">{p.w}×{p.h}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        <div className="mb-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">{tr("editor.custom_2")}</div>
          <div className="flex items-center gap-1.5">
            <input type="number" min={1} value={cw} onChange={(e) => setCw(Math.max(1, Number(e.target.value)))} className="w-20 rounded-lg border border-neutral-200 px-2 py-1.5 text-sm outline-none focus:border-brand-400" aria-label={tr("editor.custom_width")} />
            <span className="text-neutral-400">×</span>
            <input type="number" min={1} value={ch} onChange={(e) => setCh(Math.max(1, Number(e.target.value)))} className="w-20 rounded-lg border border-neutral-200 px-2 py-1.5 text-sm outline-none focus:border-brand-400" aria-label={tr("editor.custom_height")} />
            <button onClick={addCustom} className="rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50">{tr("editor.add")}</button>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-neutral-100 pt-3">
          <span className="text-xs text-neutral-500">{targets.length} selected</span>
          <button onClick={run} disabled={!targets.length} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-40">
            {tr("editor.resize")}
          </button>
        </div>
      </div>
    </>
  );
}

/** A button that opens the Magic Resize dialog (for the page properties panel). */
export function MagicResizeButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center justify-center gap-1.5 rounded-lg border border-neutral-200 px-2 py-2 text-xs font-medium text-neutral-700 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-ink"
      >
        <Wand2 size={14} /> {tr("editor.magic_resize")}
      </button>
      <MagicResizeDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
