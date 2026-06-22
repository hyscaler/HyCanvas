// Brand panel (FR-1, FR-3, FR-4, FR-5, FR-11). Shows the
// design's active brand kit with one-tap apply: palette swatches (apply as a
// fill or text color), fonts (apply to the selected text), logos (place as an
// image), the brand voice (read-only), and curated collections (place assets).
// "Apply brand" sets the page/text defaults going forward; "Re-skin to brand"
// remaps the whole document to the nearest brand color/font as ONE undoable step
// and shows the mapping. Brand-admins (manage-brand) get a Controls section and
// can manage the kit contents; members consume only.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Palette, Type as TypeIcon, ImageIcon, Wand2, Lock, Unlock, Plus, Trash2,
  ShieldCheck, AlertTriangle, RotateCcw, History, GitBranch, RefreshCw, Sparkles,
} from "lucide-react";
import type { BrandKit, BrandKitVersion, BrandLintViolation, UploadedAsset, BrandUpdateSummary } from "@hc/sdk";
import type { Color } from "@hc/schema";
import { extractPalette, toHex, type Bitmap } from "@hc/color";
import { PanelShell, CollapsibleSection } from "./EditorPanels";
import { useEditor, type ReskinResult, type ReskinOverrides, type BrandFixTarget } from "@/store/editor";
import { useBrand, brandHexColors, brandFontFamilies } from "@/store/brand";
import { fonts } from "@/lib/fontProvider";
import { oc, resolveAssetUrl } from "@/lib/sdk";
import { useToast } from "@/components/ui/Toast";

/** Map a lint violation's typed fix to the store's BrandFixTarget, or null when
 *  there is no safe auto-fix (restore_logo / missing fix). */
function fixTargetOf(v: BrandLintViolation): BrandFixTarget | null {
  if (!v.fix || !v.nodeId) return null;
  if (v.fix.kind === "restore_logo") return null;
  return { nodeId: v.nodeId, fix: v.fix };
}

/** Human label for a violation kind, for grouping. */
const KIND_LABEL: Record<BrandLintViolation["kind"], string> = {
  "off-brand-color": "Off-brand colors",
  "off-brand-font": "Off-brand fonts",
  "logo-misuse": "Logo misuse",
  "low-contrast": "Low contrast",
  spacing: "Spacing",
};

/** sRGB Color -> #rrggbb (alpha dropped for the swatch button). */
function hexOf(c: Color): string {
  const ch = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${ch(c.srgb.r)}${ch(c.srgb.g)}${ch(c.srgb.b)}`;
}

export function BrandPanel({ workspaceId }: { workspaceId: string | null }) {
  const kit = useBrand((s) => s.kit);
  const canManage = useBrand((s) => s.canManage);
  const loading = useBrand((s) => s.loading);
  const designId = useBrand((s) => s.designId);
  const refresh = useBrand((s) => s.refresh);
  const pinnedVersion = useBrand((s) => s.pinnedVersion);
  const lockedRegions = useBrand((s) => s.lockedRegions);
  // Editor rev drives debounced live re-lint after edits (FR-8).
  const rev = useEditor((s) => s.rev);
  const selection = useEditor((s) => s.selection);

  const [kits, setKits] = useState<BrandKit[]>([]);
  const [reskin, setReskin] = useState<ReskinResult | null>(null);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [violations, setViolations] = useState<BrandLintViolation[] | null>(null);
  const [linting, setLinting] = useState(false);
  const [update, setUpdate] = useState<BrandUpdateSummary | null>(null);
  const toast = useToast();

  // Load the workspace's kits (for the selector) + an assetId -> url map (logos).
  useEffect(() => {
    let cancelled = false;
    if (!workspaceId) return;
    void (async () => {
      try {
        const [ks, assets] = await Promise.all([
          oc.listBrandKits(workspaceId),
          oc.listAssets(workspaceId),
        ]);
        if (cancelled) return;
        setKits(ks);
        const map: Record<string, string> = {};
        for (const a of assets as UploadedAsset[]) map[a.id] = a.url;
        setAssetUrls(map);
      } catch {
        /* membership/no-brand: leave empty */
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, kit?.id]);

  const swatches = useMemo(() => brandHexColors(kit), [kit]);
  const families = useMemo(() => brandFontFamilies(kit), [kit]);

  // Apply a brand color: to the selection's fills, or the page background if
  // nothing is selected (so a click is never a no-op).
  const applyColor = useCallback((hex: string) => {
    const st = useEditor.getState();
    if (st.selection.length > 0) st.setFillColorSel(hex);
    else st.setPageBackground({ type: "solid", color: srgbFromHex(hex) });
  }, []);

  const applyTextColor = useCallback((hex: string) => {
    const st = useEditor.getState();
    const fill = { type: "solid", color: srgbFromHex(hex) } as const;
    for (const id of st.selection) st.setTextStyle(id, { fill });
  }, []);

  const applyFont = useCallback((family: string) => {
    fonts.ensure(family);
    const st = useEditor.getState();
    for (const id of st.selection) st.setTextStyle(id, { fontFamily: family });
  }, []);

  const placeLogo = useCallback((assetId: string) => {
    const url = assetUrls[assetId];
    if (!url) { toast.error("Logo asset is unavailable."); return; }
    useEditor.getState().addImage(resolveAssetUrl(url));
  }, [assetUrls, toast]);

  // Re-skin: remap every color/font to the kit. One undo step (FR-3, AC-2). When
  // re-applied with per-color overrides (from the mapping UI), the previous
  // re-skin is first undone so the result is a single reversible operation built
  // from the original document, not stacked on top of the prior remap.
  const doReskin = useCallback((overrides?: ReskinOverrides) => {
    if (!kit) return;
    const palette: Color[] = [];
    for (const p of kit.palettes) for (const sw of p.colors) palette.push(sw.value);
    const fontFams = brandFontFamilies(kit);
    fontFams.forEach((f) => fonts.ensure(f));
    const st = useEditor.getState();
    if (overrides) st.undo(); // collapse the prior re-skin so overrides re-apply as one step
    const result = st.reskinToBrand({ palette, fonts: fontFams }, overrides);
    setReskin(result);
    if (result.colors.length === 0 && result.fonts.length === 0)
      toast.toast("Design is already on brand.", "info");
    else
      toast.success(`Re-skinned: ${result.colors.length} colors, ${result.fonts.length} fonts.`);
  }, [kit, toast]);

  // Apply brand: set defaults going forward (page bg = first brand color, the
  // selected text = brand body font). Lighter than re-skin (no remap).
  const applyBrandDefaults = useCallback(() => {
    if (!kit) return;
    const st = useEditor.getState();
    const firstHex = swatches[0];
    if (firstHex) st.setPageBackground({ type: "solid", color: srgbFromHex(firstHex) });
    const body = families[0];
    if (body) { fonts.ensure(body); for (const id of st.selection) st.setTextStyle(id, { fontFamily: body }); }
    toast.success("Applied brand defaults.");
  }, [kit, swatches, families, toast]);

  // --- brand linting (FR-7, FR-8) -------------------------------------------
  // Run lint on demand (Check brand) and reflect the result. Membership-gated
  // server-side; we surface violations grouped by kind below.
  const runLint = useCallback(async () => {
    if (!designId) return;
    setLinting(true);
    try {
      setViolations(await oc.brandLint(designId));
    } catch {
      toast.error("Couldn't run brand check.");
    } finally {
      setLinting(false);
    }
  }, [designId, toast]);

  // Live debounced re-lint after edits (FR-8): only while a kit is active and
  // only once the user has run a check at least once (violations !== null), so we
  // never lint unprompted. Keyed off the editor `rev`.
  useEffect(() => {
    if (!designId || !kit || violations === null) return;
    const t = setTimeout(() => {
      void oc.brandLint(designId).then(setViolations).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev, designId, kit?.id]);

  // Select + frame the offending node so the user can see what to fix (FR-7).
  const highlight = useCallback((v: BrandLintViolation) => {
    if (!v.nodeId) return;
    const st = useEditor.getState();
    st.select([v.nodeId]);
    st.zoomToSelection();
  }, []);

  // Apply one violation's fix through the editor store (undoable), then re-lint.
  const applyFix = useCallback((v: BrandLintViolation) => {
    const target = fixTargetOf(v);
    if (!target) {
      toast.toast("Adjust the logo manually to restore it on brand.", "info");
      return;
    }
    const n = useEditor.getState().applyBrandFixes([target]);
    if (n > 0) void runLint();
  }, [runLint, toast]);

  // Apply every auto-fixable violation as ONE undo step, then re-lint (FR-7).
  const fixAll = useCallback(() => {
    if (!violations) return;
    const targets = violations.map(fixTargetOf).filter((t): t is BrandFixTarget => t !== null);
    if (!targets.length) { toast.toast("No safe auto-fixes available.", "info"); return; }
    const n = useEditor.getState().applyBrandFixes(targets);
    if (n > 0) { toast.success(`Applied ${n} fix${n === 1 ? "" : "es"}.`); void runLint(); }
  }, [violations, runLint, toast]);

  // --- pin / track update check (FR-10) -------------------------------------
  const checkUpdates = useCallback(async () => {
    if (!designId) { setUpdate(null); return; }
    try {
      setUpdate(await oc.brandUpdates(designId));
    } catch {
      setUpdate(null);
    }
  }, [designId]);

  // Check for a tracked-kit update on load and whenever the kit changes. The
  // fetch + setState run in the Promise chain, not synchronously in the effect.
  useEffect(() => {
    let cancelled = false;
    if (!designId) {
      void Promise.resolve().then(() => { if (!cancelled) setUpdate(null); });
      return () => { cancelled = true; };
    }
    void oc.brandUpdates(designId)
      .then((u) => { if (!cancelled) setUpdate(u); })
      .catch(() => { if (!cancelled) setUpdate(null); });
    return () => { cancelled = true; };
  }, [designId, kit?.id]);

  if (!designId) {
    return (
      <PanelShell title="Brand">
        <p className="text-sm text-neutral-500">Open a saved design to use brand kits.</p>
      </PanelShell>
    );
  }

  return (
    <PanelShell title="Brand">
      {loading && <p className="text-sm text-neutral-400">Loading brand…</p>}

      {/* Kit selector (FR-2). */}
      {kits.length > 0 && (
        <div className="mb-4">
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Brand kit</label>
          <select
            value={kit?.id ?? ""}
            disabled={!canManage}
            onChange={(e) => void useBrand.getState().assign(e.target.value || null)}
            className="w-full rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-brand-400 disabled:opacity-60"
          >
            <option value="">No brand</option>
            {kits.map((k) => (
              <option key={k.id} value={k.id}>{k.name}{k.isDefault ? " (default)" : ""}</option>
            ))}
          </select>
          {!canManage && <p className="mt-1 text-[11px] text-neutral-400">Only brand admins can switch the kit.</p>}
        </div>
      )}

      {!kit && !loading && (
        <p className="text-sm text-neutral-500">
          No brand kit is set for this design.
          {canManage && workspaceId && " Create one below."}
        </p>
      )}

      {canManage && workspaceId && kits.length === 0 && !loading && (
        <div className="mb-3 flex flex-col gap-2">
          <button
            onClick={async () => {
              const k = await oc.createBrandKit(workspaceId, {});
              useBrand.getState().setKit(k);
              setKits([k]);
              await useBrand.getState().assign(k.id);
            }}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <Plus size={15} /> Create brand kit
          </button>
          <GenerateFromLogo
            workspaceId={workspaceId}
            onCreated={(k) => { useBrand.getState().setKit(k); setKits([k]); }}
          />
        </div>
      )}

      {kit && (
        <div className="flex flex-col gap-5">
          {/* Brand updated - review (FR-10). Shown only when a tracked kit has
              advanced past what the design reflects. Never mutates silently. */}
          {update?.hasUpdate && (
            <BrandUpdateBanner
              update={update}
              canManage={canManage}
              onApply={async () => {
                try {
                  // Record the latest version as reviewed so the banner clears
                  // (FR-10), then refresh the resolved brand + re-check updates.
                  await useBrand.getState().markReviewed();
                  await refresh();
                  await checkUpdates();
                  toast.success("Brand refreshed to the latest version.");
                } catch { toast.error("Couldn't apply the brand update."); }
              }}
              onPin={async () => {
                if (!designId || update.designVersion == null) return;
                try {
                  await oc.setDesignBrandVersion(designId, update.designVersion);
                  await refresh();
                  await checkUpdates();
                  toast.success("Pinned to the current version.");
                } catch { toast.error("Couldn't pin the version."); }
              }}
            />
          )}

          {/* Apply / re-skin (FR-3). Recolor/re-font the whole design, which would
              override brand locked regions, so this is gated to manage-brand
              users. Fillers don't see it. */}
          {canManage && (
            <div className="flex flex-col gap-2">
              <button onClick={applyBrandDefaults} className="flex items-center justify-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-100">
                <Wand2 size={15} /> Apply brand
              </button>
              <button onClick={() => doReskin()} className="flex items-center justify-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-700 hover:border-brand-300 hover:bg-brand-50">
                Re-skin to brand
              </button>
              {reskin && (reskin.colors.length > 0 || reskin.fonts.length > 0) && (
                <ReskinMapping
                  result={reskin}
                  brandSwatches={swatches}
                  onUndo={() => { useEditor.getState().undo(); setReskin(null); }}
                  onReapply={(overrides) => doReskin(overrides)}
                />
              )}
            </div>
          )}

          {/* Brand lint (FR-7, FR-8). */}
          <CollapsibleSection title="Brand check" icon={ShieldCheck}>
            <LintSection
              violations={violations}
              linting={linting}
              onCheck={() => void runLint()}
              onHighlight={highlight}
              onFix={applyFix}
              onFixAll={fixAll}
            />
          </CollapsibleSection>

          {/* Colors (FR-1, FR-4). */}
          <CollapsibleSection title="Colors" icon={Palette} defaultOpen right={kit.controls.lockColors ? <LockedBadge /> : undefined}>
            {swatches.length === 0 ? (
              <p className="text-xs text-neutral-400">No brand colors yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {swatches.map((hex) => (
                  <button
                    key={hex}
                    title={`${hex} (click: fill / shift: text color)`}
                    onClick={(e) => (e.shiftKey ? applyTextColor(hex) : applyColor(hex))}
                    className="h-8 w-8 rounded-lg border border-neutral-200 shadow-sm"
                    style={{ backgroundColor: hex }}
                  />
                ))}
              </div>
            )}
          </CollapsibleSection>

          {/* Fonts (FR-1, FR-4). */}
          <CollapsibleSection title="Fonts" icon={TypeIcon} defaultOpen right={kit.controls.lockFonts ? <LockedBadge /> : undefined}>
            {families.length === 0 ? (
              <p className="text-xs text-neutral-400">No brand fonts yet.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {kit.fonts.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => applyFont(f.fontFamily)}
                    className="flex items-center justify-between rounded-lg border border-neutral-200 px-3 py-2 text-left text-sm hover:border-brand-300 hover:bg-brand-50"
                    style={{ fontFamily: `'${f.fontFamily}', sans-serif` }}
                  >
                    <span className="truncate">{f.fontFamily}</span>
                    <span className="ml-2 shrink-0 text-[10px] uppercase tracking-wide text-neutral-300">{f.role}</span>
                  </button>
                ))}
              </div>
            )}
          </CollapsibleSection>

          {/* Logos (FR-1). */}
          {kit.logos.length > 0 && (
            <CollapsibleSection title="Logos" icon={ImageIcon} badge={kit.logos.length}>
              <div className="grid grid-cols-3 gap-2">
                {kit.logos.map((l) => (
                  <button
                    key={l.id}
                    onClick={() => placeLogo(l.assetId)}
                    title={`Place ${l.label}`}
                    className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 hover:border-brand-300"
                  >
                    {assetUrls[l.assetId] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={resolveAssetUrl(assetUrls[l.assetId])} alt={l.label} className="max-h-full max-w-full object-contain" />
                    ) : (
                      <span className="text-[10px] text-neutral-400">{l.label}</span>
                    )}
                  </button>
                ))}
              </div>
            </CollapsibleSection>
          )}

          {/* Voice (FR-1, read-only). */}
          {kit.voice && (
            <CollapsibleSection title="Voice" icon={Sparkles}>
              {kit.voice.tone.length > 0 && (
                <div className="mb-1.5 flex flex-wrap gap-1.5">
                  {kit.voice.tone.map((t) => (
                    <span key={t} className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600">{t}</span>
                  ))}
                </div>
              )}
              {kit.voice.sampleCopy && <p className="text-xs italic text-neutral-500">“{kit.voice.sampleCopy}”</p>}
            </CollapsibleSection>
          )}

          {/* Pin / track a specific version (FR-10, manage-brand only). */}
          {canManage && (
            <CollapsibleSection title="Version" icon={GitBranch}>
              <PinTrackControl
                designId={designId}
                pinnedVersion={pinnedVersion}
                latestVersion={kit.version}
                onChanged={async () => { await refresh(); await checkUpdates(); }}
              />
            </CollapsibleSection>
          )}

          {/* Locked regions (FR-6, AC-4, manage-brand only). */}
          {canManage && (
            <CollapsibleSection title="Locked regions" icon={Lock} badge={lockedRegions.length || undefined}>
              <LockedRegionsControl
                designId={designId}
                selection={selection}
                lockedRegions={lockedRegions}
                onChanged={() => void refresh()}
              />
            </CollapsibleSection>
          )}

          {/* Version history + restore (FR-9, manage-brand only). */}
          {canManage && (
            <CollapsibleSection title="Version history" icon={History}>
              <VersionHistory kitId={kit.id} onRestored={() => void refresh()} />
            </CollapsibleSection>
          )}

          {/* Brand controls + content management (manage-brand only). */}
          {canManage && (
            <CollapsibleSection title="Brand controls (admin)" icon={ShieldCheck}>
              <BrandControlsEditor kit={kit} workspaceId={workspaceId} onSaved={() => void refresh()} assetUrls={assetUrls} />
            </CollapsibleSection>
          )}
        </div>
      )}
    </PanelShell>
  );
}

/** "Brand updated - review" banner (FR-10). Surfaces what changed and offers to
 *  apply (refresh to latest) or pin the current version. Never auto-mutates. */
function BrandUpdateBanner({
  update,
  canManage,
  onApply,
  onPin,
}: {
  update: BrandUpdateSummary;
  canManage: boolean;
  onApply: () => void | Promise<void>;
  onPin: () => void | Promise<void>;
}) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
      <div className="mb-1 flex items-center gap-1.5 font-semibold">
        <RefreshCw size={13} /> Brand updated - review
      </div>
      <p className="mb-1.5 text-amber-700">
        The brand kit advanced to v{update.latestVersion} (this design reflects
        {update.designVersion == null ? " an older version" : ` v${update.designVersion}`}).
      </p>
      {update.changes.length > 0 && (
        <ul className="mb-2 list-disc pl-4 text-[11px] text-amber-700">
          {update.changes.map((c, i) => (<li key={i}>{c}</li>))}
        </ul>
      )}
      {canManage ? (
        <div className="flex gap-2">
          <button onClick={() => void onApply()} className="rounded-md bg-amber-600 px-2.5 py-1 font-medium text-white hover:bg-amber-700">Apply update</button>
          <button onClick={() => void onPin()} className="rounded-md border border-amber-300 bg-white px-2.5 py-1 font-medium text-amber-700 hover:bg-amber-100">Pin current</button>
        </div>
      ) : (
        <p className="text-[11px] text-amber-600">A brand admin can apply or pin this update.</p>
      )}
    </div>
  );
}

/** Brand-lint section (FR-7, FR-8): a Check button, grouped violations, per-item
 *  highlight + fix, and Fix all. */
function LintSection({
  violations,
  linting,
  onCheck,
  onHighlight,
  onFix,
  onFixAll,
}: {
  violations: BrandLintViolation[] | null;
  linting: boolean;
  onCheck: () => void;
  onHighlight: (v: BrandLintViolation) => void;
  onFix: (v: BrandLintViolation) => void;
  onFixAll: () => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<BrandLintViolation["kind"], BrandLintViolation[]>();
    for (const v of violations ?? []) {
      const arr = map.get(v.kind) ?? [];
      arr.push(v);
      map.set(v.kind, arr);
    }
    return [...map.entries()];
  }, [violations]);

  const fixable = (violations ?? []).filter((v) => fixTargetOf(v) !== null).length;
  const clean = violations !== null && violations.length === 0;

  return (
    <>
      <div className="flex justify-end">
        <button onClick={onCheck} disabled={linting} className="rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 hover:border-brand-300 hover:bg-brand-50 disabled:opacity-50">
          {linting ? "Checking…" : "Check brand"}
        </button>
      </div>

      {violations === null && <p className="text-xs text-neutral-400">Run a brand check to see violations. It then updates live as you edit.</p>}
      {clean && (
        <p className="flex items-center gap-1.5 rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700">
          <ShieldCheck size={13} /> On brand. No violations found.
        </p>
      )}

      {violations !== null && violations.length > 0 && (
        <div className="flex flex-col gap-3">
          {groups.map(([kind, items]) => (
            <div key={kind}>
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-neutral-500">
                <AlertTriangle size={12} className="text-amber-500" /> {KIND_LABEL[kind]} ({items.length})
              </div>
              <ul className="flex flex-col gap-1">
                {items.map((v) => {
                  const canFix = fixTargetOf(v) !== null;
                  return (
                    <li key={v.id} className="rounded-lg border border-neutral-100 bg-neutral-50 px-2 py-1.5 text-xs">
                      <button onClick={() => onHighlight(v)} disabled={!v.nodeId} className="block w-full text-left text-neutral-600 hover:text-brand-700 disabled:cursor-default disabled:hover:text-neutral-600" title={v.nodeId ? "Highlight on canvas" : undefined}>
                        {v.message}
                      </button>
                      <button onClick={() => onFix(v)} className="mt-1 text-[11px] font-medium text-brand-600 hover:underline">
                        {canFix ? "Fix" : "How to fix"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {fixable > 0 && (
            <button onClick={onFixAll} className="flex items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700">
              <Wand2 size={14} /> Fix all safe issues ({fixable})
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** Pin to a specific version or track the latest (FR-10). */
function PinTrackControl({
  designId,
  pinnedVersion,
  latestVersion,
  onChanged,
}: {
  designId: string;
  pinnedVersion: number | null;
  latestVersion: number;
  onChanged: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const versions = useMemo(() => Array.from({ length: latestVersion }, (_, i) => latestVersion - i), [latestVersion]);

  const set = useCallback(async (v: number | null) => {
    setBusy(true);
    try {
      await oc.setDesignBrandVersion(designId, v);
      await onChanged();
      toast.success(v == null ? "Now tracking the latest version." : `Pinned to v${v}.`);
    } catch {
      toast.error("Couldn't change the brand version.");
    } finally {
      setBusy(false);
    }
  }, [designId, onChanged, toast]);

  return (
    <>
      <p className="mb-2 text-[11px] text-neutral-500">
        {pinnedVersion == null ? "Tracking the latest version." : `Pinned to v${pinnedVersion}.`}
      </p>
      <select
        value={pinnedVersion == null ? "" : String(pinnedVersion)}
        disabled={busy}
        onChange={(e) => void set(e.target.value === "" ? null : Number(e.target.value))}
        className="w-full rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-brand-400 disabled:opacity-60"
      >
        <option value="">Track latest (v{latestVersion})</option>
        {versions.map((v) => (<option key={v} value={v}>Pin v{v}</option>))}
      </select>
    </>
  );
}

/** Mark/clear brand locked regions from the current selection (FR-6, AC-4). */
function LockedRegionsControl({
  designId,
  selection,
  lockedRegions,
  onChanged,
}: {
  designId: string;
  selection: string[];
  lockedRegions: string[];
  onChanged: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const save = useCallback(async (ids: string[]) => {
    setBusy(true);
    try {
      await oc.setDesignLockedRegions(designId, ids);
      // Reflect immediately in the gate so editing is blocked without a reload.
      useBrand.getState().setLockedRegions(ids);
      await onChanged();
    } catch {
      toast.error("Couldn't update locked regions.");
    } finally {
      setBusy(false);
    }
  }, [designId, onChanged, toast]);

  const lockSelection = useCallback(() => {
    if (!selection.length) return;
    void save([...new Set([...lockedRegions, ...selection])]);
  }, [selection, lockedRegions, save]);

  return (
    <>
      <p className="mb-2 text-[11px] text-neutral-500">
        {lockedRegions.length === 0 ? "No locked regions. Members can edit every element." : `${lockedRegions.length} locked region${lockedRegions.length === 1 ? "" : "s"}. Members cannot move or restyle them.`}
      </p>
      <div className="flex gap-2">
        <button
          onClick={lockSelection}
          disabled={busy || selection.length === 0}
          className="flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:border-brand-300 hover:bg-brand-50 disabled:opacity-50"
        >
          <Lock size={13} /> Lock selection ({selection.length})
        </button>
        {lockedRegions.length > 0 && (
          <button
            onClick={() => void save([])}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:border-brand-300 hover:bg-brand-50 disabled:opacity-50"
          >
            <Unlock size={13} /> Clear all
          </button>
        )}
      </div>
    </>
  );
}

/** Kit version history + restore (FR-9). Manage-brand only. */
function VersionHistory({ kitId, onRestored }: { kitId: string; onRestored: () => void | Promise<void> }) {
  const toast = useToast();
  const [versions, setVersions] = useState<BrandKitVersion[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Two-step restore confirm (matches the app's in-app dialog style): the first
  // click arms a version, the second within the window restores it.
  const [confirmVersion, setConfirmVersion] = useState<number | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedFor = useRef<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const list = await oc.listBrandKitVersions(kitId);
      setVersions(list);
      loadedFor.current = kitId;
    } catch {
      setVersions([]);
    } finally {
      setBusy(false);
    }
  }, [kitId]);

  // The body only mounts while the (collapsible) section is open, so load on
  // mount and whenever the kit changes.
  useEffect(() => {
    if (loadedFor.current !== kitId) void load();
  }, [kitId, load]);

  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);

  const restore = useCallback(async (version: number) => {
    if (confirmTimer.current) { clearTimeout(confirmTimer.current); confirmTimer.current = null; }
    setConfirmVersion(null);
    setBusy(true);
    try {
      const updated = await oc.restoreBrandKitVersion(kitId, version);
      useBrand.getState().setKit(updated);
      await onRestored();
      await load();
      toast.success(`Restored to v${version}.`);
    } catch {
      toast.error("Couldn't restore that version.");
    } finally {
      setBusy(false);
    }
  }, [kitId, onRestored, load, toast]);

  // Arm (first click) or restore (second click within the window).
  const onRestoreClick = useCallback((version: number) => {
    if (confirmVersion === version) { void restore(version); return; }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmVersion(version);
    confirmTimer.current = setTimeout(() => setConfirmVersion(null), 3500);
  }, [confirmVersion, restore]);

  return (
    <>
      {busy && !versions && <p className="text-xs text-neutral-400">Loading…</p>}
      {versions && versions.length === 0 && <p className="text-xs text-neutral-400">No versions recorded yet.</p>}
      {versions && versions.length > 0 && (
        <ul className="flex flex-col gap-1">
          {versions.map((v) => (
            <li key={v.id} className="flex items-center justify-between rounded-lg border border-neutral-100 bg-neutral-50 px-2 py-1.5 text-xs">
              <span className="text-neutral-600">
                v{v.version}
                <span className="ml-2 text-[10px] text-neutral-400">{new Date(v.createdAt).toLocaleString()}</span>
              </span>
              <button
                onClick={() => onRestoreClick(v.version)}
                disabled={busy}
                title={confirmVersion === v.version ? "Click again to restore (history is preserved)" : `Restore to v${v.version}`}
                className={`flex items-center gap-1 hover:underline disabled:opacity-50 ${confirmVersion === v.version ? "font-semibold text-red-600" : "text-brand-600"}`}
              >
                <RotateCcw size={12} /> {confirmVersion === v.version ? "Confirm restore" : "Restore"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Small "locked by brand" pill, used in a CollapsibleSection's right slot. */
function LockedBadge() {
  return (
    <span className="inline-flex items-center gap-0.5 rounded bg-amber-50 px-1 text-[10px] font-medium text-amber-700" title="Locked by brand">
      <Lock size={10} /> locked
    </span>
  );
}

/** Re-skin preview + per-mapping override. Each color row
 *  offers a control to keep the original or pick a different brand swatch; the
 *  whole document is re-applied with those overrides as ONE undo step. */
function ReskinMapping({
  result,
  brandSwatches,
  onUndo,
  onReapply,
}: {
  result: ReskinResult;
  brandSwatches: string[];
  onUndo: () => void;
  onReapply: (overrides: ReskinOverrides) => void;
}) {
  // Per-source-hex choice: a brand hex, or "keep". Defaults to the auto-mapped
  // target so the select reflects the current re-skin result.
  const [choices, setChoices] = useState<Record<string, string>>(() =>
    Object.fromEntries(result.colors.map((m) => [m.from, m.to])),
  );

  // The override map sent to the re-apply: only entries that differ from the
  // default nearest-color result (a different swatch, or "keep").
  const overrides = useMemo<ReskinOverrides>(() => {
    const out: ReskinOverrides = {};
    for (const m of result.colors) {
      const c = choices[m.from] ?? m.to;
      if (c !== m.to) out[m.from] = c;
    }
    return out;
  }, [choices, result.colors]);

  const dirty = Object.keys(overrides).length > 0;
  // Offer the original color as a "keep" option plus every brand swatch.
  const swatchOptions = useMemo(() => [...new Set(brandSwatches)], [brandSwatches]);

  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-2 text-xs">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium text-neutral-600">Re-skin mapping</span>
        <button onClick={onUndo} className="text-brand-600 hover:underline">Undo</button>
      </div>
      {result.colors.map((m) => {
        const choice = choices[m.from] ?? m.to;
        return (
          <div key={`c-${m.from}`} className="flex items-center gap-1.5 py-0.5">
            <span className="h-3 w-3 rounded border border-neutral-300" style={{ backgroundColor: m.from }} />
            <span className="text-neutral-400">→</span>
            <span
              className="h-3 w-3 rounded border border-neutral-300"
              style={{ backgroundColor: choice === "keep" ? m.from : choice }}
            />
            <span className="text-neutral-400">{m.from}</span>
            <select
              value={choice}
              onChange={(e) => setChoices((c) => ({ ...c, [m.from]: e.target.value }))}
              className="ml-auto rounded border border-neutral-200 bg-white px-1 py-0.5 text-[11px] outline-none focus:border-brand-400"
              title="Map this color to a brand swatch, or keep the original"
            >
              <option value="keep">Keep original</option>
              {swatchOptions.map((hex) => (
                <option key={hex} value={hex}>{hex}</option>
              ))}
            </select>
          </div>
        );
      })}
      {result.fonts.map((m) => (
        <div key={`f-${m.from}`} className="py-0.5 text-neutral-500">{m.from} → {m.to}</div>
      ))}
      {dirty && (
        <button
          onClick={() => onReapply(overrides)}
          className="mt-1.5 w-full rounded-md bg-brand-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-brand-700"
        >
          Re-apply with overrides
        </button>
      )}
    </div>
  );
}

/** Brand controls + minimal content management for brand admins (FR-4, FR-5). */
function BrandControlsEditor({
  kit,
  workspaceId,
  onSaved,
  assetUrls,
}: {
  kit: BrandKit;
  workspaceId: string | null;
  onSaved: () => void;
  assetUrls: Record<string, string>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const save = useCallback(
    async (patch: Parameters<typeof oc.updateBrandKit>[1]) => {
      setBusy(true);
      try {
        const updated = await oc.updateBrandKit(kit.id, patch);
        useBrand.getState().setKit(updated);
        onSaved();
      } catch {
        toast.error("Couldn't save brand kit.");
      } finally {
        setBusy(false);
      }
    },
    [kit.id, onSaved, toast],
  );

  const addColor = useCallback(
    (hex: string) => {
      const base = kit.palettes[0] ?? { id: `p-${crypto.randomUUID()}`, name: "Palette", colors: [] };
      const p = structuredClone(base);
      p.colors = [...p.colors, { id: `s-${crypto.randomUUID()}`, role: "accent", value: srgbFromHexFull(hex) }];
      const palettes = kit.palettes.length ? kit.palettes.map((x, i) => (i === 0 ? p : x)) : [p];
      void save({ palettes });
    },
    [kit.palettes, save],
  );

  return (
    <>
      <input
        defaultValue={kit.name}
        onBlur={(e) => { if (e.target.value.trim() && e.target.value !== kit.name) void save({ name: e.target.value.trim() }); }}
        className="mb-3 w-full rounded-lg border border-neutral-200 px-2 py-1.5 text-sm outline-none focus:border-brand-400"
        placeholder="Kit name"
      />
      <div className="mb-3 flex flex-col gap-2">
        <ControlToggle label="Lock colors to palette" checked={kit.controls.lockColors} disabled={busy} onChange={(v) => void save({ controls: { lockColors: v } })} />
        <ControlToggle label="Lock fonts to approved set" checked={kit.controls.lockFonts} disabled={busy} onChange={(v) => void save({ controls: { lockFonts: v } })} />
        <ControlToggle label="Restrict to brand templates" checked={kit.controls.restrictTemplates} disabled={busy} onChange={(v) => void save({ controls: { restrictTemplates: v } })} />
      </div>

      {/* Manage colors. */}
      <div className="mb-3">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Palette colors</span>
        <div className="flex flex-wrap items-center gap-2">
          {kit.palettes.flatMap((p) => p.colors).map((sw) => (
            <div key={sw.id} className="group relative">
              <span className="block h-7 w-7 rounded-lg border border-neutral-200" style={{ backgroundColor: hexOf(sw.value) }} />
              <button
                title="Remove"
                onClick={() => {
                  const palettes = kit.palettes.map((p) => ({ ...p, colors: p.colors.filter((c) => c.id !== sw.id) }));
                  void save({ palettes });
                }}
                className="absolute -right-1 -top-1 hidden rounded-full bg-white text-neutral-400 group-hover:block hover:text-red-500"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <input type="color" onChange={(e) => addColor(e.target.value)} className="oc-color h-7 w-7" title="Add color" />
        </div>
      </div>

      {/* Manage fonts (heading/body). */}
      <div className="mb-3">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Fonts</span>
        <BrandFontField role="heading" current={kit.fonts.find((f) => f.role === "heading")?.fontFamily ?? ""} onSet={(fam) => void save({ fonts: upsertFont(kit, "heading", fam) })} />
        <BrandFontField role="body" current={kit.fonts.find((f) => f.role === "body")?.fontFamily ?? ""} onSet={(fam) => void save({ fonts: upsertFont(kit, "body", fam) })} />
      </div>

      {/* Add a logo from uploads (FR-1). */}
      {workspaceId && (
        <AddLogoFromUploads workspaceId={workspaceId} assetUrls={assetUrls} onAdd={(assetId, label) => void save({ logos: [...kit.logos, { id: `l-${crypto.randomUUID()}`, label, assetId }] })} />
      )}

      {/* Voice (FR-1). */}
      <div className="mt-3">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Voice tone (comma separated)</span>
        <input
          defaultValue={(kit.voice?.tone ?? []).join(", ")}
          onBlur={(e) => {
            const tone = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
            void save({ voice: { tone, doSay: kit.voice?.doSay ?? [], dontSay: kit.voice?.dontSay ?? [], sampleCopy: kit.voice?.sampleCopy } });
          }}
          className="w-full rounded-lg border border-neutral-200 px-2 py-1.5 text-sm outline-none focus:border-brand-400"
          placeholder="friendly, confident"
        />
      </div>
    </>
  );
}

function ControlToggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex items-center justify-between text-sm text-neutral-700">
      <span>{label}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${checked ? "bg-brand-600" : "bg-neutral-300"}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? "left-4" : "left-0.5"}`} />
      </button>
    </label>
  );
}

function BrandFontField({ role, current, onSet }: { role: string; current: string; onSet: (fam: string) => void }) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <span className="w-16 shrink-0 text-xs text-neutral-500">{role}</span>
      <input
        defaultValue={current}
        key={current}
        onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== current) { fonts.ensure(v); onSet(v); } }}
        className="flex-1 rounded-lg border border-neutral-200 px-2 py-1.5 text-sm outline-none focus:border-brand-400"
        placeholder="Font family"
      />
    </div>
  );
}

function AddLogoFromUploads({ workspaceId, assetUrls, onAdd }: { workspaceId: string; assetUrls: Record<string, string>; onAdd: (assetId: string, label: string) => void }) {
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<UploadedAsset[]>([]);
  useEffect(() => {
    if (!open) return;
    void oc.listAssets(workspaceId).then((a) => setAssets(a as UploadedAsset[])).catch(() => setAssets([]));
  }, [open, workspaceId]);
  return (
    <div className="mb-3">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">
        <Plus size={12} /> Add logo from uploads
      </button>
      {open && (
        <div className="mt-2 grid grid-cols-4 gap-1.5">
          {assets.length === 0 && <span className="col-span-4 text-[11px] text-neutral-400">No uploads.</span>}
          {assets.map((a) => (
            <button
              key={a.id}
              onClick={() => { onAdd(a.id, a.filename ?? "Logo"); setOpen(false); }}
              className="flex aspect-square items-center justify-center overflow-hidden rounded border border-neutral-200 hover:border-brand-300"
              title={a.filename ?? "asset"}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={resolveAssetUrl(assetUrls[a.id] ?? a.url)} alt={a.filename ?? ""} className="max-h-full max-w-full object-contain" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Auto-generate a brand kit from a logo (FR-1 empty-state UX). Fully
 * client-side: the user picks a logo image, we decode it to a canvas, extract a
 * small dominant-color palette via @hc/color's median-cut helper, pair it with
 * sensible default heading/body fonts, upload the logo as an asset, then create
 * a brand kit pre-filled with the palette + logo + fonts. No backend image
 * decoding. Gated to manage-brand by the caller (only rendered for admins).
 */
function GenerateFromLogo({
  workspaceId,
  onCreated,
}: {
  workspaceId: string;
  onCreated: (kit: BrandKit) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleFile = useCallback(async (file: File) => {
    if (typeof document === "undefined") return;
    setBusy(true);
    try {
      // Decode to a data URL, then to an <img> so we can sample pixels.
      const dataUrl: string = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = () => rej(r.error);
        r.readAsDataURL(file);
      });
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const el = new Image();
        el.onload = () => res(el);
        el.onerror = () => rej(new Error("decode failed"));
        el.src = dataUrl;
      });

      // Sample at a modest size (longest side ~128px) for a fast, stable palette.
      const SAMPLE = 128;
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      let palette: string[] = [];
      if (w && h) {
        const scale = Math.min(1, SAMPLE / Math.max(w, h));
        const sw = Math.max(1, Math.round(w * scale));
        const sh = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement("canvas");
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(img, 0, 0, sw, sh);
          const bmp: Bitmap = ctx.getImageData(0, 0, sw, sh);
          palette = extractPalette(bmp, 6).map(toHex);
        }
      }
      // Dedup while preserving order; always offer at least one swatch.
      palette = [...new Set(palette)];

      // Upload the logo as a workspace asset so it round-trips as a brand logo.
      const asset = await oc.uploadAsset(workspaceId, {
        filename: file.name,
        dataBase64: dataUrl.split(",")[1] ?? "",
      });

      // Create the kit, then fill it with the extracted palette + logo + default
      // heading/body fonts (the text engine's registry resolves these family names).
      const created = await oc.createBrandKit(workspaceId, { name: "Brand from logo" });
      const filled = await oc.updateBrandKit(created.id, {
        palettes:
          palette.length > 0
            ? [
                {
                  id: `p-${crypto.randomUUID()}`,
                  name: "Logo palette",
                  colors: palette.map((hex, i) => ({
                    id: `s-${crypto.randomUUID()}`,
                    role: i === 0 ? "primary" : i === 1 ? "secondary" : "accent",
                    value: srgbFromHexFull(hex),
                  })),
                },
              ]
            : [],
        fonts: [
          { id: `f-${crypto.randomUUID()}`, role: "heading", fontFamily: "Inter" },
          { id: `f-${crypto.randomUUID()}`, role: "body", fontFamily: "Inter" },
        ],
        logos: [{ id: `l-${crypto.randomUUID()}`, label: file.name || "Logo", assetId: asset.id }],
      });

      onCreated(filled);
      await useBrand.getState().assign(filled.id);
      toast.success(`Brand kit generated from logo (${palette.length} colors).`);
    } catch {
      toast.error("Couldn't generate a brand kit from that logo.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }, [workspaceId, onCreated, toast]);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-60"
      >
        <Sparkles size={15} /> {busy ? "Generating…" : "Generate from logo"}
      </button>
    </>
  );
}

// --- color helpers ----------------------------------------------------------
function srgbFromHex(hex: string): Color {
  return srgbFromHexFull(hex);
}
function srgbFromHexFull(hex: string): Color {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6), 16);
  const r = Number.isNaN(n) ? 0 : (n >> 16) & 255;
  const g = Number.isNaN(n) ? 0 : (n >> 8) & 255;
  const b = Number.isNaN(n) ? 0 : n & 255;
  return { srgb: { r: r / 255, g: g / 255, b: b / 255, a: 1 } };
}

/** Upsert a heading/body font into the kit's fonts array by role. */
function upsertFont(kit: BrandKit, role: string, family: string): BrandKit["fonts"] {
  const existing = kit.fonts.find((f) => f.role === role);
  if (existing) return kit.fonts.map((f) => (f.role === role ? { ...f, fontFamily: family } : f));
  return [...kit.fonts, { id: `f-${crypto.randomUUID()}`, role, fontFamily: family }];
}
