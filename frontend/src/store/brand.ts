// Brand store. Holds the active resolved brand kit for the
// design open in the editor, whether the caller may manage it (manage-brand,
// FR-12), and the workspace id. The pickers consult the derived lock helpers
// (lockColors/lockFonts) to constrain a non-admin member's color/font options
// (FR-4, AC-3); the Brand panel renders the kit and exposes apply/re-skin.
//
// Realtime-path limitation: lock enforcement is client-side here (the pickers
// hide out-of-kit options); the durable save path re-checks server-side. The
// live Yjs/WebSocket path is client-constrained, same as collab/approval locks.

import { create } from "zustand";
import type { BrandKit, ResolvedBrand } from "@hc/sdk";
import { oc } from "@/lib/sdk";

interface BrandState {
  /** The design this brand belongs to, or null when no saved design is open. */
  designId: string | null;
  workspaceId: string | null;
  /** The active resolved kit, or null (no brand assigned/default/deleted). */
  kit: BrandKit | null;
  /** Whether the caller has manage-brand (admins are unconstrained). */
  canManage: boolean;
  loading: boolean;
  /** Brand-template locked-region node ids the design carries (FR-6, AC-4). The
   *  editor gates structural/style mutation of these for non-manage-brand users,
   *  mirroring the F17 collaborative-lock gate. */
  lockedRegions: string[];
  /** The pinned kit version (number) or null when the design tracks latest. */
  pinnedVersion: number | null;

  setDesign(designId: string | null, workspaceId: string | null): void;
  refresh(): Promise<void>;
  /** Replace the active kit locally (after an edit) without a round-trip. */
  setKit(kit: BrandKit | null): void;
  assign(brandKitId: string | null): Promise<void>;
  /** Mark the tracked kit's current version as reviewed (FR-10), clearing the
   *  "Brand updated - review" banner until the kit advances again. */
  markReviewed(): Promise<void>;
  /** Replace the locked-region node ids locally (after a save). */
  setLockedRegions(ids: string[]): void;
  /** Whether a node id is a brand locked region that this caller may NOT edit
   *  (FR-6, AC-4): it is in the locked set AND the caller lacks manage-brand
   *  (admins edit freely). Empty/no-kit => false (never blocks editing). */
  isLockedRegion(id: string): boolean;
}

export const useBrand = create<BrandState>((set, get) => ({
  designId: null,
  workspaceId: null,
  kit: null,
  canManage: false,
  loading: false,
  lockedRegions: [],
  pinnedVersion: null,

  setDesign: (designId, workspaceId) => {
    set({ designId, workspaceId, kit: null, canManage: false, lockedRegions: [], pinnedVersion: null });
    if (designId) void get().refresh();
  },

  refresh: async () => {
    const { designId } = get();
    if (!designId) return;
    set({ loading: true });
    try {
      const res: ResolvedBrand = await oc.getDesignBrand(designId);
      set({
        kit: res.kit,
        canManage: res.canManage,
        lockedRegions: res.lockedRegions ?? [],
        pinnedVersion: res.pinnedVersion ?? null,
      });
    } catch {
      // No access / no brand: fall back to no-brand quietly.
      set({ kit: null, canManage: false, lockedRegions: [], pinnedVersion: null });
    } finally {
      set({ loading: false });
    }
  },

  setKit: (kit) => set({ kit }),

  assign: async (brandKitId) => {
    const { designId } = get();
    if (!designId) return;
    const res = await oc.assignDesignBrand(designId, brandKitId);
    set({
      kit: res.kit,
      canManage: res.canManage,
      lockedRegions: res.lockedRegions ?? [],
      pinnedVersion: res.pinnedVersion ?? null,
    });
  },

  markReviewed: async () => {
    const { designId } = get();
    if (!designId) return;
    const res = await oc.markBrandReviewed(designId);
    set({
      kit: res.kit,
      canManage: res.canManage,
      lockedRegions: res.lockedRegions ?? [],
      pinnedVersion: res.pinnedVersion ?? null,
    });
  },

  setLockedRegions: (ids) => set({ lockedRegions: [...new Set(ids)] }),

  isLockedRegion: (id) => {
    const s = get();
    if (s.canManage || s.lockedRegions.length === 0) return false;
    return s.lockedRegions.includes(id);
  },
}));

/** Whether the COLOR picker must be constrained to the kit for this caller
 *  (FR-4, AC-3): a kit with lockColors on, the caller is NOT a brand admin, and
 *  the kit has at least one approved color to offer. */
export function colorsLockedFor(state: BrandState): boolean {
  const kit = state.kit;
  if (!kit || state.canManage || !kit.controls.lockColors) return false;
  return kit.palettes.some((p) => p.colors.length > 0);
}

/** Whether the FONT selector must be constrained to the kit (FR-4, AC-3). */
export function fontsLockedFor(state: BrandState): boolean {
  const kit = state.kit;
  if (!kit || state.canManage || !kit.controls.lockFonts) return false;
  return kit.fonts.length > 0;
}

/** The flat list of approved brand hex colors (for swatch-only pickers). */
export function brandHexColors(kit: BrandKit | null): string[] {
  if (!kit) return [];
  const out: string[] = [];
  for (const pal of kit.palettes)
    for (const sw of pal.colors) {
      const { r, g, b } = sw.value.srgb;
      const ch = (v: number) =>
        Math.round(Math.max(0, Math.min(1, v)) * 255)
          .toString(16)
          .padStart(2, "0");
      const hex = `#${ch(r)}${ch(g)}${ch(b)}`;
      if (!out.includes(hex)) out.push(hex);
    }
  return out;
}

/** The approved brand font families (for the constrained font selector). */
export function brandFontFamilies(kit: BrandKit | null): string[] {
  if (!kit) return [];
  return [...new Set(kit.fonts.map((f) => f.fontFamily))];
}
