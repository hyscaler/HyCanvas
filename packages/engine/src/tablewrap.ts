// Word wrapping for a table cell. A cell used to draw its text on one line
// whatever its width, so a value longer than its column ran into the next
// cell; now it wraps like a paragraph, greedily by words, and a word wider
// than the cell stands alone and runs past it, as a paragraph's would.
// Mirrored by wrapCellLines in the Go raster (nodes_extra.go).

/** Break `text` into lines no wider than `maxWidth` under `measure`. */
export function wrapCellLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (!words.length) return [];
  const lines: string[] = [];
  let cur = words[0];
  for (let i = 1; i < words.length; i++) {
    const next = `${cur} ${words[i]}`;
    if (measure(next) <= maxWidth) cur = next;
    else { lines.push(cur); cur = words[i]; }
  }
  lines.push(cur);
  return lines;
}

/** The line pitch a cell sets its lines on, from the run's size. */
export function cellLineHeight(size: number): number {
  return size * 1.25;
}
