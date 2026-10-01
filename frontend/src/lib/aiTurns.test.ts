import { describe, expect, it } from "vitest";
import { mergeRestoredTurns } from "./aiTurns";

const u = (text: string) => ({ role: "user", text });
const a = (text: string) => ({ role: "assistant", text });

describe("mergeRestoredTurns", () => {
  it("keeps a prompt sent while the history was still loading", () => {
    // A brand-new design: the server has nothing, the dashboard brief already landed.
    expect(mergeRestoredTurns([], [u("Create a 7-slide investor update")])).toEqual([u("Create a 7-slide investor update")]);
  });

  it("takes the history when the panel is still empty", () => {
    expect(mergeRestoredTurns([u("earlier"), a("done")], [])).toEqual([u("earlier"), a("done")]);
  });

  it("puts the history first and does not show a persisted turn twice", () => {
    // The brief was persisted before the restore listed it, so it is in both.
    const restored = [u("earlier"), a("done"), u("Create a deck")];
    const current = [u("Create a deck"), a("Here is the outline")];
    expect(mergeRestoredTurns(restored, current)).toEqual([u("earlier"), a("done"), u("Create a deck"), a("Here is the outline")]);
  });

  it("returns the same array when nothing was added meanwhile", () => {
    const restored = [u("x")];
    expect(mergeRestoredTurns(restored, [])).toBe(restored);
  });
});
