// Keeps a horizontal strip (the editor's "Add page" button) clear of a fixed
// floating control (the zoom control). Both rects are in the same coordinate
// space. When the strip's vertical band meets the control, the strip is trimmed
// on the side the control sits on, so it never paints under or over it. If too
// little width would remain, the strip drops just below the control instead,
// where the user can scroll it back into view (the canvas pan is unbounded).

export interface Rect { left: number; top: number; width: number; height: number }

export function avoidRect(strip: Rect, control: Rect | null, gap = 8, minWidth = 120): Rect {
  if (!control) return strip;
  const cTop = control.top - gap;
  const cBottom = control.top + control.height + gap;
  const cLeft = control.left - gap;
  const cRight = control.left + control.width + gap;
  const sRight = strip.left + strip.width;
  const overlapsY = strip.top < cBottom && strip.top + strip.height > cTop;
  const overlapsX = strip.left < cRight && sRight > cLeft;
  if (!overlapsY || !overlapsX) return strip;
  // Room to the start side of the control (LTR: control on the right).
  const before = cLeft - strip.left;
  // Room to the end side of the control (RTL: control on the left).
  const after = sRight - cRight;
  if (before >= after && before >= minWidth) return { ...strip, width: before };
  if (after > before && after >= minWidth) return { ...strip, left: cRight, width: after };
  return { ...strip, top: cBottom };
}
