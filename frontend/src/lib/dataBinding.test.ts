import { describe, it, expect } from "vitest";
import { parseCsvMatrix } from "./csv";
import { tabularToChart } from "./magicDesign";

// The CSV->chart/table pipeline behind F27 live-data binding (refreshBinding):
// inline/remote CSV is parsed to a matrix, then mapped to chart series (or used
// directly as a table grid).
describe("live data binding pipeline (F27)", () => {
  it("maps CSV to chart categories + series", () => {
    const matrix = parseCsvMatrix("Month,Sales,Costs\nJan,10,4\nFeb,20,7\nMar,15,6");
    const chart = tabularToChart(matrix, "bar");
    expect(chart.categories).toEqual(["Jan", "Feb", "Mar"]);
    expect(chart.series.map((s) => s.name)).toEqual(["Sales", "Costs"]);
    expect(chart.series[0].values).toEqual([10, 20, 15]);
    expect(chart.series[1].values).toEqual([4, 7, 6]);
  });

  it("parses a CSV into a table grid (rows x cols)", () => {
    const grid = parseCsvMatrix("Name,Score\nAda,99\nGrace,98\n");
    expect(grid).toEqual([
      ["Name", "Score"],
      ["Ada", "99"],
      ["Grace", "98"],
    ]);
  });

  it("handles quoted fields with commas", () => {
    const grid = parseCsvMatrix('Item,Note\n"Pens, blue",ok');
    expect(grid[1]).toEqual(["Pens, blue", "ok"]);
  });
});
