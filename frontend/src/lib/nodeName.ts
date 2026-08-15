// Human-readable node names for assistive surfaces (the offscreen canvas
// tree, the selection announcer, the reading-order pane). A node the user
// named keeps that name (content, never translated); an unnamed node falls
// back to its TYPE, translated - a Hindi screen-reader user should hear
// "आकृति", not the raw file-format token "shape".
//
// The keys are derived from the type at RENDER time via trOr, so an unknown
// or future node type degrades to its raw token instead of a missing-key
// artifact.

import { tr, trOr } from "./i18n";

export function nodeTypeName(type: string): string {
  return trOr(`editor.node_type_${type}`, type);
}

export function nodeDisplayName(node: { name?: string; type: string; locked?: boolean }): string {
  return node.name || nodeTypeName(node.type);
}

/** The display name plus the states a screen reader should hear (locked). */
export function nodeAnnouncedName(node: { name?: string; type: string; locked?: boolean }): string {
  const base = nodeDisplayName(node);
  return node.locked ? `${base}, ${tr("editor.locked_state")}` : base;
}
