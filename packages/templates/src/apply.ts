// Apply pipelines. Apply-to-new deep-copies the
// template into a fresh, decoupled design; apply-into-existing appends the
// template's (deep-copied) pages onto a clone of the target. Inherited stock
// attributions have their node ids remapped to the copy so credits stay correct.

import type { DesignFile } from "@hc/schema";
import type { AttributionEntry } from "@hc/stock";
import { deepCopyDesign, type DeepCopyOptions } from "./deepcopy";
import { readLockedRegions, remapLockedRegions, withLockedRegions } from "./lockedregions";

/** Remap an attribution entry's node ids through a deep-copy id map. */
export function remapAttributions(attrs: AttributionEntry[], idMap: Map<string, string>): AttributionEntry[] {
  return attrs.map((a) => ({
    ...a,
    nodeIds: a.nodeIds.map((id) => idMap.get(id) ?? id),
  }));
}

export interface ApplyResult {
  file: DesignFile;
  idMap: Map<string, string>;
  attributions: AttributionEntry[];
}

/**
 * Apply a template to a brand-new design (FR-5): a deep copy with fresh ids,
 * decoupled from the source, with inherited attributions remapped. The source
 * template is never mutated (FR-14). Brand locked-region ids are
 * remapped through the deep-copy id map and written onto the new design's meta,
 * so they point at the copied nodes rather than the template's originals.
 */
export function applyTemplateToNew(
  templateFile: DesignFile,
  attributions: AttributionEntry[] = [],
  opts: DeepCopyOptions = {},
): ApplyResult {
  const { file, idMap } = deepCopyDesign(templateFile, opts);
  const locked = remapLockedRegions(readLockedRegions(templateFile), idMap);
  return {
    file: withLockedRegions(file, locked),
    idMap,
    attributions: remapAttributions(attributions, idMap),
  };
}

/**
 * Append a template's pages into an existing design (FR-6). Returns a new file
 * (the target is not mutated) with the template's deep-copied pages added, plus
 * the merged-ready remapped attributions to fold into the design's credits.
 */
export function applyTemplateIntoExisting(
  target: DesignFile,
  templateFile: DesignFile,
  attributions: AttributionEntry[] = [],
  opts: DeepCopyOptions = {},
): ApplyResult {
  const clone: DesignFile = JSON.parse(JSON.stringify(target));
  const { file: copied, idMap } = deepCopyDesign(templateFile, opts);
  clone.pages.push(...copied.pages);
  // Merge the template's remapped locked regions onto the target's existing
  // ones so appended brand pages stay layout-locked too.
  const merged = [
    ...readLockedRegions(clone),
    ...remapLockedRegions(readLockedRegions(templateFile), idMap),
  ];
  const file = withLockedRegions(clone, merged);
  return { file, idMap, attributions: remapAttributions(attributions, idMap) };
}
