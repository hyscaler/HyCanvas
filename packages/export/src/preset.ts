// Export presets. A preset stores a reusable request with
// no design-specific data, so applying it reproduces all settings across any
// design. These are pure transforms; persistence and sharing are the API layer.

import type { ExportPreset, ExportRequest } from "./types";

/** Build a preset from a concrete request by dropping its `designId`. */
export function toPreset(
  request: ExportRequest,
  meta: { id: string; name: string; scope: "user" | "workspace" },
): ExportPreset {
  const { designId: _designId, ...rest } = request;
  void _designId;
  return { id: meta.id, name: meta.name, scope: meta.scope, request: rest };
}

/** Apply a preset to a design, reproducing every stored setting (AC-7). */
export function applyPreset(preset: ExportPreset, designId: string): ExportRequest {
  // Deep-clone so the returned request never aliases the stored preset.
  return { ...JSON.parse(JSON.stringify(preset.request)), designId };
}
