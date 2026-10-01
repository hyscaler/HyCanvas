import { describe, expect, it } from "vitest";
import { layerDropIndex } from "./layerOrder";

// children [a, b, c] is listed c, b, a (front first).
const ids = ["a", "b", "c"];

describe("layerDropIndex", () => {
  it("puts a layer dragged down the list directly in front of the target", () => {
    // c dropped onto a: between b and a in the list, so children a, c, b.
    expect(layerDropIndex(ids, "c", "a")).toBe(1);
  });
  it("puts a layer dragged up the list directly in front of the target", () => {
    // a dropped onto c: the top of the list, so the front of the page.
    expect(layerDropIndex(ids, "a", "c")).toBe(2);
    // a dropped onto b: children b, a, c.
    expect(layerDropIndex(ids, "a", "b")).toBe(1);
  });
  it("is a no-op when the layer already sits in front of the target", () => {
    expect(layerDropIndex(ids, "b", "a")).toBeNull();
    expect(layerDropIndex(ids, "c", "b")).toBeNull();
    expect(layerDropIndex(ids, "b", "b")).toBeNull();
  });
  it("sends a layer to the back when dropped past the last row", () => {
    expect(layerDropIndex(ids, "c", null)).toBe(0);
    expect(layerDropIndex(ids, "a", null)).toBeNull();
  });
  it("ignores ids that are not on the page", () => {
    expect(layerDropIndex(ids, "zz", "a")).toBeNull();
    expect(layerDropIndex(ids, "a", "zz")).toBeNull();
  });
});
