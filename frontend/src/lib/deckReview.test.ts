import { describe, expect, it } from "vitest";
import { reviewTurnText } from "./deckReview";

describe("the review turn", () => {
  it("says a clean deck is clean", () => {
    expect(reviewTurnText([])).toMatch(/nothing to fix/i);
  });
  it("lists each finding on its own page-numbered line", () => {
    const text = reviewTurnText([
      { pageIndex: 2, findings: [{ kind: "overlap", detail: "The label wraps under the figure." }] },
      { pageIndex: 4, findings: [{ kind: "clipped", detail: "The last bullet is cut off." }, { kind: "empty", detail: "The right half is empty." }] },
    ]);
    expect(text).toMatch(/3 things to check/);
    expect(text).toContain("Page 3: The label wraps under the figure.");
    expect(text).toContain("Page 5: The right half is empty.");
  });
});
