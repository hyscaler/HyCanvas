// Where a new whiteboard sticky goes.

/** The first spot for a w x h box, starting at (x, y) and stepping outwards
 *  ring by ring, that does not overlap a sticky already on the board, so a
 *  new note never hides the previous one (#93). Other nodes (frames, shapes,
 *  text) are not avoided: a sticky is meant to sit on top of them. */
export function freeStickySpot(
  others: { x: number; y: number; w: number; h: number }[],
  x: number,
  y: number,
  w: number,
  h: number,
  gap = 20,
): { x: number; y: number } {
  const hits = (px: number, py: number) =>
    others.some((o) => px < o.x + o.w && px + w > o.x && py < o.y + o.h && py + h > o.y);
  if (!hits(x, y)) return { x, y };
  const sx = w + gap;
  const sy = h + gap;
  for (let ring = 1; ring <= 12; ring++) {
    // Right first, then below, left and above, so notes fill a row.
    const cells: [number, number][] = [];
    for (let j = -ring + 1; j <= ring; j++) cells.push([ring, j]);
    for (let i = ring - 1; i >= -ring; i--) cells.push([i, ring]);
    for (let j = ring - 1; j >= -ring; j--) cells.push([-ring, j]);
    for (let i = -ring + 1; i <= ring; i++) cells.push([i, -ring]);
    cells.sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]) || Math.abs(a[0]) - Math.abs(b[0]) || b[0] - a[0]);
    for (const [i, j] of cells) {
      const px = x + i * sx;
      const py = y + j * sy;
      if (!hits(px, py)) return { x: px, y: py };
    }
  }
  return { x, y };
}
