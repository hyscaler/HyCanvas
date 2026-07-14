// relayGridCells: photo-grid cells re-lay to a new grid size with spans
// preserved and filled images re-covering their cells.
import { describe, it, expect } from "vitest";
import { createNode, type Node, type Transform } from "@hc/schema";
import { relayGridCells, gridCellBox, type GridSpan } from "./editor";

function cellFrame(id: string, withImage = false): Node {
  return createNode("frame", {
    id,
    clip: true,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 10, height: 10 },
    children: withImage
      ? [createNode("image", {
          source: { assetId: "a1", naturalWidth: 100, naturalHeight: 100 },
          fit: "cover",
          transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
          size: { width: 10, height: 10 },
        } as Partial<Node>)]
      : [],
  } as Partial<Node>);
}

describe("relayGridCells", () => {
  it("re-lays spanned cells to the new size and re-covers filled images", () => {
    const spans: GridSpan[] = [
      { row: 0, col: 0, rowSpan: 2, colSpan: 1 },
      { row: 0, col: 1, rowSpan: 1, colSpan: 1 },
      { row: 1, col: 1, rowSpan: 1, colSpan: 1 },
    ];
    const children = [cellFrame("c1", true), cellFrame("c2"), cellFrame("c3")];
    const g = {
      rows: 2, cols: 2, gap: 8,
      cells: spans.map((sp, i) => ({ ...sp, childId: children[i].id })),
      children,
    };
    const size = { width: 408, height: 408 };
    relayGridCells(g, size);
    const feature = children[0] as unknown as { transform: Transform; size: { width: number; height: number }; children: Node[] };
    const expected = gridCellBox(size, 2, 2, 8, spans[0]);
    expect(feature.size.width).toBeCloseTo(expected.width, 5); // (408-8)/2 = 200
    expect(feature.size.height).toBeCloseTo(408, 5); // spans both rows + gap
    // The filled cell's image covers the whole cell again.
    const img = feature.children[0] as unknown as { size: { width: number; height: number } };
    expect(img.size.width).toBeCloseTo(feature.size.width, 5);
    expect(img.size.height).toBeCloseTo(feature.size.height, 5);
    // The second cell sits right of the gap.
    const c2 = children[1] as unknown as { transform: Transform };
    expect(c2.transform.x).toBeCloseTo(208, 5);
  });

  it("floors cell sizes at 1px when the grid is smaller than its gaps", () => {
    const children = [cellFrame("c1"), cellFrame("c2")];
    const g = {
      rows: 1, cols: 2, gap: 8,
      cells: [
        { row: 0, col: 0, rowSpan: 1, colSpan: 1, childId: "c1" },
        { row: 0, col: 1, rowSpan: 1, colSpan: 1, childId: "c2" },
      ],
      children,
    };
    relayGridCells(g, { width: 4, height: 4 });
    for (const c of children as unknown as { size: { width: number; height: number } }[]) {
      expect(c.size.width).toBeGreaterThanOrEqual(1);
      expect(c.size.height).toBeGreaterThanOrEqual(1);
    }
  });
});
