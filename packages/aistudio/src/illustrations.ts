// The illustration drawings, supplied at run time.
//
// The drawings (illustrationset.ts) are about 1.1 MB of path data, more than
// any page needs before it composes a deck. Nothing in this package imports
// them: a host loads the set when it is about to compose and hands it over
// here. The editor imports it on demand (its own chunk); the server composer
// bundle registers it at startup. Until a set is provided, a page that names
// a drawing simply gets none, as for a drawing the set does not have.

import type { IllustrationDrawing } from "./illustrationset";

let drawings: Record<string, IllustrationDrawing> | null = null;

/** Hand the composer its illustration set (ILLUSTRATIONS from
 *  ./illustrationset). Safe to call more than once. */
export function provideIllustrations(set: Record<string, IllustrationDrawing>): void {
  drawings = set;
}

/** Whether a set has been provided. */
export function illustrationsReady(): boolean {
  return drawings !== null;
}

/** The drawing with this name, when a set is provided and has it. */
export function illustrationDrawing(name: string): IllustrationDrawing | undefined {
  return drawings?.[name];
}
