import { describe, expect, it } from "vitest";
import { normalizeOutline } from "../outline";
import { deriveDesignSystem, catalogEntryForSeed } from "../designSystem";
import { composeArchetypePage } from "../archetypes";
import { deckThemes } from "../theme";
import { illustrationDrawing, illustrationsReady, provideIllustrations } from "../illustrations";
import { ILLUSTRATIONS } from "../illustrationset";

// The drawings are supplied at run time so the editor can load them on demand
// (#77). Its own file, so the registry starts empty here.
describe("illustration registry", () => {
  const size = { width: 1920, height: 1080 };
  const theme = deckThemes({ count: 1, seed: 3, kicker: "Coastal Restoration" })[0];
  const ds = deriveDesignSystem(theme, size, { seed: 1, catalog: catalogEntryForSeed(1) });
  const item = normalizeOutline({
    title: "T",
    pages: [{ title: "Lift-off", archetype: "cover", note: "", subhead: "A plan", image: { subject: "a rocket", treatment: "illustration", illustration: "rocket" } }],
  }).pages[0];
  const names = (nodes: unknown[]) => (nodes as { name?: string }[]).map((n) => n.name);

  it("composes a picture stand-in for a named drawing until a set is provided, then the drawing", () => {
    expect(illustrationsReady()).toBe(false);
    expect(illustrationDrawing("CampaignLaunch")).toBeUndefined();
    const before = composeArchetypePage(item, ds, { index: 0, total: 4 });
    expect(names(before.nodes)).not.toContain("Illustration");
    expect(names(before.nodes)).toContain("Image");

    provideIllustrations(ILLUSTRATIONS);
    expect(illustrationsReady()).toBe(true);
    expect(illustrationDrawing("CampaignLaunch")?.layers.length).toBeGreaterThan(0);
    const after = composeArchetypePage(item, ds, { index: 0, total: 4 });
    expect(names(after.nodes)).toContain("Illustration");
  });
});
