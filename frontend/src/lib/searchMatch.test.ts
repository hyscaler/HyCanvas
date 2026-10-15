import { describe, expect, it } from "vitest";
import { matchParts, rankByTitle } from "./searchMatch";

describe("matchParts", () => {
  it("marks every case-insensitive occurrence and keeps the original casing", () => {
    expect(matchParts("Summer Sale summer", "SUMMER")).toEqual([
      { text: "Summer", match: true },
      { text: " Sale ", match: false },
      { text: "summer", match: true },
    ]);
  });

  it("returns the whole text unmarked for an empty query or no match", () => {
    expect(matchParts("Poster", "  ")).toEqual([{ text: "Poster", match: false }]);
    expect(matchParts("Poster", "flyer")).toEqual([{ text: "Poster", match: false }]);
  });

  it("trims the query, as the search does", () => {
    expect(matchParts("Q3 report", " report ")).toEqual([
      { text: "Q3 ", match: false },
      { text: "report", match: true },
    ]);
  });
});

describe("rankByTitle", () => {
  const t = (title: string) => ({ title });
  it("keeps only matches, ranked exact, prefix, then anywhere, stable within a rank", () => {
    const out = rankByTitle([t("Big launch"), t("Launch deck"), t("Other"), t("launch"), t("Launch plan")], "Launch");
    expect(out.map((x) => x.title)).toEqual(["launch", "Launch deck", "Launch plan", "Big launch"]);
  });
});
