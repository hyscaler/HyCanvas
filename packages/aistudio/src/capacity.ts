// What the page will hold, told to the model before it writes.
//
// The composer sizes type from geometry and steps it down when copy runs
// long; the model, writing to character budgets, had no idea how much a
// line actually holds, so it wrote short and the deck read as thin. This
// works out, from the same constants the composer sets type with, how many
// characters one line of each slot holds at full size on the deck's page,
// and says so in the outline prompt. Mirrored in capacity.go (the Go door
// builds the outline prompt); a test in the composer package checks the two
// against each other for every page size.

/** The default page for each design type. Mirrors generateSizes on the API. */
export const designTypeSizes: Record<string, { width: number; height: number }> = {
  deck: { width: 1920, height: 1080 },
  doc: { width: 1240, height: 1754 },
  poster: { width: 1080, height: 1350 },
  social: { width: 1080, height: 1080 },
  "social-set": { width: 1080, height: 1080 },
};

export interface SlotCapacity {
  title: number;
  point: number;
  columnPoint: number;
  coverSubhead: number;
  statLabel: number;
}

/** Characters per line at full size, per slot. The type constants and the
 *  advances are the composer's own (archetypes.ts: T, ADVANCE, the list
 *  gutter); the geometry is the design system's. */
export function slotCapacity(width: number, height: number): SlotCapacity {
  const short = Math.min(width, height);
  const unit = Math.max(4, Math.round(short * 0.012));
  const margin = unit * 6;
  const gutter = unit * 2;
  const col = (width - 2 * margin - 11 * gutter) / 12;
  const full = width - 2 * margin;
  const six = 6 * col + 5 * gutter;
  const titlePx = height * 0.07;
  const pointPx = height * 0.034;
  const subPx = height * 0.034;
  const labelPx = height * 0.036;
  return {
    title: Math.floor(full / (titlePx * 0.55)),
    point: Math.floor((full - 1.6 * pointPx) / (pointPx * 0.5)),
    columnPoint: Math.floor((six - 6 * unit - 1.6 * pointPx) / (pointPx * 0.5)),
    coverSubhead: Math.floor(six / (subPx * 0.5)),
    statLabel: Math.floor((six - 6 * unit) / (labelPx * 0.55)),
  };
}

/** The sentence the outline prompt carries. */
export function capacityClause(designType: string, width: number, height: number): string {
  const c = slotCapacity(width, height);
  const what = designType === "deck" ? "deck" : designType === "doc" ? "document" : designType === "poster" ? "poster" : "post";
  return `This ${what} composes at ${width} by ${height}. At full size one line holds about ${c.title} characters of a title, ${c.point} of a bullet, ${c.columnPoint} of a column point, ${c.coverSubhead} of a cover subhead and ${c.statLabel} of a stat label; a title reads best on one or two lines and a bullet on one or two. Write to that width rather than well under it: a point far shorter than its line reads as thin, not concise.`;
}
