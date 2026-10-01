// Layer panel drop maths.
//
// A page's children run back to front; the panel lists them front first, so
// "drop onto a row" means "put the dragged layer directly in front of that
// row's layer". The store's reorderLayer takes the layer's FINAL index in the
// children array, which is what this computes. Working in the panel's own
// order first (remove the dragged row, insert before the target) keeps the
// result the same whichever direction the drag went; computing on the array
// index alone landed a layer one step too far back when it moved down the list.

/** The final children index for dropping `dragId` onto the row of `targetId`
 *  (in front of it), or at the very back when `targetId` is null. Null when
 *  either id is not on the page or the drop changes nothing. */
export function layerDropIndex(childIds: readonly string[], dragId: string, targetId: string | null): number | null {
  const from = childIds.indexOf(dragId);
  if (from < 0) return null;
  const n = childIds.length;
  if (targetId === null) return from === 0 ? null : 0;
  if (targetId === dragId) return null;
  const frontFirst = [...childIds].reverse().filter((id) => id !== dragId);
  const k = frontFirst.indexOf(targetId);
  if (k < 0) return null;
  const to = n - 1 - k;
  return to === from ? null : to;
}
