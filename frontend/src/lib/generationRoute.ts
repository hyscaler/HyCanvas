// Which door a generated deck goes through in the editor.
//
// The archetype composer (@hc/aistudio layoutDeck) is the default: it is the
// path the API and MCP take, and the one every design-quality rule lives in
// (forms, figures, tables, icons, pictures, motion, brand). The older
// layout-slot path materializes text boxes into a slide layout's placeholders
// and is right only when a TEMPLATE governs the document: its layouts were
// authored, and a deck that ignored them would not be the template's deck.
//
// The builtin slide layouts every presentation carries are not authored; they
// are the editor's own scaffolding. Grounding generation in them is what
// turned every generated deck into title-and-bullets pages, whatever the
// outline planned.

import { builtinMasterId, type SlideLayout } from "@hc/schema";

/** True when the document's layouts came from a template (or the user), not
 *  from the editor's builtin set. */
export function layoutsAreAuthored(layouts: SlideLayout[] | undefined | null): boolean {
  return !!layouts?.length && layouts.some((l) => l.masterId !== builtinMasterId);
}

/** Ground a generated deck in slot layouts only when a template governs the
 *  document: one adopted for this generation, or one the design was made
 *  from. Everything else composes through the archetype door. */
export function shouldGroundInLayouts(opts: { designType: string; docLayouts?: SlideLayout[] | null; templateAdopted?: boolean }): boolean {
  if (opts.designType !== "deck" && opts.designType !== "doc") return false;
  return !!opts.templateAdopted || layoutsAreAuthored(opts.docLayouts);
}
