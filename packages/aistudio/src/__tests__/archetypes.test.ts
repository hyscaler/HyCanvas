import { describe, expect, it } from "vitest";
import { archetypes, normalizeOutline, type Archetype } from "../outline";
import { deriveDesignSystem, catalogEntryForSeed, catalogEntryForMood, designSystemSlots } from "../designSystem";
import { archetypeIsImpact, composeArchetypePage, keepLastWordCompany } from "../archetypes";
import { layoutDeck } from "../deck";
import { deckThemes } from "../theme";
import { qualityCheck } from "../quality";
import { contrastRatio } from "@hc/color";

const size = { width: 1920, height: 1080 };
const theme = deckThemes({ count: 1, seed: 3, kicker: "Coastal Restoration" })[0];

/** One fully populated page per archetype, so every form composes its own
 *  payload rather than a downgraded fallback. */
function pageFor(a: Archetype): Record<string, unknown> {
  const base = { title: "Why the shoreline is retreating", archetype: a, note: "" };
  switch (a) {
    case "cover": return { ...base, subhead: "A plan for the next five years", image: { subject: "a dune belt at dawn", treatment: "photo" } };
    case "section": return { ...base, subhead: "Part two", image: { subject: "marsh grass", treatment: "photo" } };
    case "statement": return { ...base, title: "Every metre of dune we rebuild buys a decade for the village behind it", subhead: "That is the whole case." };
    case "bigNumber": return { ...base, stat: { value: "40", unit: "%", label: "more erosion since 2019" }, subhead: "Measured across all six survey points, winter storms included." };
    case "bullets": return { ...base, points: ["Erosion is accelerating on the north shore", "Two villages have already relocated", "Insurance cover is being withdrawn"], image: { subject: "eroded cliff face", treatment: "photo" } };
    case "twoColumn": return { ...base, columns: [{ heading: "Hard defences", points: ["Fast to build", "Fail all at once", "Move the problem downshore"] }, { heading: "Living shoreline", points: ["Slower to establish", "Strengthens each season", "Habitat comes with it"] }] };
    case "threeUp": return { ...base, columns: [{ heading: "Dune belt", points: ["First line of defence"] }, { heading: "Marsh grass", points: ["Slows the water"] }, { heading: "Oyster reef", points: ["Breaks the swell"] }] };
    case "process": return { ...base, steps: [{ label: "Survey", detail: "Map the retreat line each season" }, { label: "Plant", detail: "Native grass in the lee of the dune" }, { label: "Fence", detail: "Sand fences trap what the wind carries" }, { label: "Monitor", detail: "Compare against the survey line" }] };
    case "quote": return { ...base, quote: { text: "We stopped fighting the sea and started working with it.", attribution: "Harbour master, Port Elin" } };
    case "imageCaption": return { ...base, subhead: "The dune belt after two growing seasons.", image: { subject: "restored dune with grass", treatment: "photo" } };
    case "chart": return { ...base, subhead: "Retreat slowed in every year the belt was maintained.", chart: { kind: "bar", categories: ["2021", "2022", "2023", "2024"], series: [{ name: "Retreat (m)", values: [4.1, 3.2, 1.9, 0.8] }] } };
    case "closing": return { ...base, title: "Fund the next five kilometres", subhead: "Decision needed by March", image: { subject: "volunteers planting grass", treatment: "photo" } };
    case "agenda": return { ...base, points: ["The problem", "What we tried", "What worked", "The ask"] };
  }
}

describe("the design system", () => {
  it("fixes every ink to AA against the ground it sits on", () => {
    for (const seed of [0, 1, 5, 11]) {
      const ds = deriveDesignSystem(theme, size, { seed, catalog: catalogEntryForSeed(seed) });
      const c = ds.colors;
      expect(contrastRatio(c.inkOnDeep, c.deep)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.ink, c.paper)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.mutedOnDeep, c.deep)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.mutedOnPaper, c.paper)).toBeGreaterThanOrEqual(4.5);
      // Accents carry rules and numerals: large-text threshold.
      expect(contrastRatio(c.accentOnPaper, c.paper)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(c.accentOnDeep, c.deep)).toBeGreaterThanOrEqual(3);
    }
  });

  it("derives a full system from a bare theme too, with a real type pairing", () => {
    const ds = deriveDesignSystem(theme, size, { seed: 2 });
    expect(ds.fonts.heading).not.toBe("system");
    expect(ds.fonts.body).not.toBe("system");
    expect(designSystemSlots(ds)).toHaveLength(6);
    expect(ds.unit).toBeGreaterThan(0);
    expect(ds.margin % ds.unit).toBe(0);
  });

  it("is deterministic", () => {
    const a = deriveDesignSystem(theme, size, { seed: 4 });
    const b = deriveDesignSystem(theme, size, { seed: 4 });
    expect(a).toEqual(b);
  });

  it("reads the outline's mood into a catalog style group", () => {
    expect(catalogEntryForMood("warm, community celebration", 3).style).toBe("warm");
    expect(catalogEntryForMood("dark, premium, luxury", 3).style).toBe("dark");
    expect(catalogEntryForMood("software platform, data", 3).style).toBe("tech");
    expect(catalogEntryForMood("clean, quiet", 3).style).toBe("minimal");
    // A tie goes to the stronger descriptor.
    expect(catalogEntryForMood("clean, energetic", 3).style).toBe("bold");
    // No recognizable words: the seed alone decides, exactly as before.
    expect(catalogEntryForMood("xyzzy", 5)).toEqual(catalogEntryForSeed(5));
    // Deterministic, and the seed still varies the pick within the group.
    expect(catalogEntryForMood("warm", 1)).toEqual(catalogEntryForMood("warm", 1));
  });
});

describe("every archetype composes a clean page", () => {
  const ds = deriveDesignSystem(theme, size, { seed: 1, catalog: catalogEntryForSeed(1) });

  for (const a of archetypes) {
    it(`${a}: no overflow, no overlap, AA contrast, every node inside the page`, () => {
      const outline = normalizeOutline({ title: "T", pages: [pageFor(a)] });
      const item = outline.pages[0];
      expect(item.archetype).toBe(a); // the fixture payload must survive normalization
      const page = composeArchetypePage(item, ds, { index: 3, total: 10 });
      expect(page.archetype).toBe(a);
      expect(page.impact).toBe(archetypeIsImpact(a));
      expect(page.nodes.length).toBeGreaterThan(0);
      const q = qualityCheck({ background: page.background, nodes: page.nodes, size });
      // Nothing overlaps, nothing overflows, every text clears AA. A text box
      // taller than its text counts as an overlap here, on purpose.
      expect(q.issues, JSON.stringify(q.issues)).toEqual([]);
    });
  }

  it("tags every picture region the way the editor's image queue expects", () => {
    const outline = normalizeOutline({ title: "T", pages: [pageFor("imageCaption"), pageFor("bullets"), pageFor("cover")] });
    outline.pages.forEach((item, i) => {
      const page = composeArchetypePage(item, ds, { index: i, total: 3 });
      const slots = page.nodes.filter((n) => (n as { data?: { placeholderId?: string } }).data?.placeholderId);
      expect(slots.length).toBe(1);
      const d = (slots[0] as { data: { placeholderId: string; aiImagePrompt: string } }).data;
      expect(page.imagePrompts[d.placeholderId]).toBe(d.aiImagePrompt);
      expect(d.aiImagePrompt).toContain("no text");
    });
  });

  it("puts the number at display scale, not body scale", () => {
    const item = normalizeOutline({ title: "T", pages: [pageFor("bigNumber")] }).pages[0];
    const page = composeArchetypePage(item, ds, { index: 1, total: 4 });
    const figure = page.nodes.find((n) => n.name === "Figure") as { content: { runs: { style: { fontSize: number } }[] }[] } | undefined;
    expect(figure).toBeTruthy();
    expect(figure!.content[0].runs[0].style.fontSize).toBeGreaterThan(size.height * 0.15);
  });

  it("numbers steps because a process is a sequence, and only there", () => {
    const proc = composeArchetypePage(normalizeOutline({ title: "T", pages: [pageFor("process")] }).pages[0], ds, { index: 2, total: 5 });
    expect(proc.nodes.filter((n) => n.name === "Step")).toHaveLength(4);
    const cols = composeArchetypePage(normalizeOutline({ title: "T", pages: [pageFor("threeUp")] }).pages[0], ds, { index: 2, total: 5 });
    expect(cols.nodes.filter((n) => n.name === "Step")).toHaveLength(0);
  });

  it("mirrors for right-to-left decks", () => {
    const ltr = deriveDesignSystem(theme, size, { seed: 1, dir: "ltr" });
    const rtl = deriveDesignSystem(theme, size, { seed: 1, dir: "rtl" });
    const item = normalizeOutline({ title: "T", pages: [pageFor("bullets")] }).pages[0];
    const l = composeArchetypePage(item, ltr, { index: 0, total: 1 });
    const r = composeArchetypePage(item, rtl, { index: 0, total: 1 });
    const titleL = l.nodes.find((n) => n.name === "Title") as { transform: { x: number }; size: { width: number } };
    const titleR = r.nodes.find((n) => n.name === "Title") as { transform: { x: number }; size: { width: number } };
    expect(Math.round(titleR.transform.x)).toBe(Math.round(size.width - titleL.transform.x - titleL.size.width));
  });
});

describe("layoutDeck", () => {
  it("composes a varied deck from one system and reports quality per page", () => {
    const outline = normalizeOutline({ title: "Coastal Restoration", pages: archetypes.map(pageFor) });
    const deck = layoutDeck(outline, theme, size, { seed: 7, catalog: catalogEntryForSeed(7) });
    expect(deck.pages).toHaveLength(archetypes.length);
    expect(new Set(deck.pages.map((p) => p.archetype)).size).toBe(archetypes.length);
    for (const p of deck.pages) {
      expect(p.quality.issues, `${p.archetype}: ${JSON.stringify(p.quality.issues)}`).toEqual([]);
    }
    // Reading pages carry the kicker; impact pages stay quiet.
    const kickers = deck.pages.filter((p) => p.nodes.some((n) => n.name === "Kicker"));
    expect(kickers.every((p) => !archetypeIsImpact(p.archetype))).toBe(true);
    expect(kickers.length).toBeGreaterThan(0);
  });

  it("is byte-for-byte deterministic", () => {
    const outline = normalizeOutline({ title: "Coastal Restoration", pages: archetypes.map(pageFor) });
    // Node ids are minted by the environment (a counter under goja and in the
    // parity test), so they are stripped here along with the quality report
    // that quotes them; everything else must be identical.
    const strip = (d: ReturnType<typeof layoutDeck>) => JSON.stringify(d.pages.map((p) => ({ ...p, quality: undefined, nodes: p.nodes.map((n) => ({ ...n, id: "x" })) })));
    expect(strip(layoutDeck(outline, theme, size, { seed: 7 }))).toBe(strip(layoutDeck(outline, theme, size, { seed: 7 })));
  });
});

describe("lists and widows", () => {
  const ds = deriveDesignSystem(theme, size, { seed: 1, catalog: catalogEntryForSeed(1) });
  type Para = { runs: { text: string }[]; style?: { list?: { type: string; level: number } } };
  const paragraphsOf = (nodes: { name?: string; content?: Para[] }[], name: string): Para[] =>
    nodes.filter((n) => n.name === name).flatMap((n) => n.content ?? []);

  it("sets points as real bullet list items, not a bullet character in the copy", () => {
    const item = normalizeOutline({ title: "T", pages: [pageFor("bullets")] }).pages[0];
    const page = composeArchetypePage(item, ds, { index: 1, total: 4 });
    const points = paragraphsOf(page.nodes as never, "Points");
    expect(points.length).toBe(3);
    for (const p of points) {
      expect(p.style?.list).toEqual({ type: "bullet", level: 0 });
      expect(p.runs[0].text.startsWith("•")).toBe(false);
    }
  });

  it("numbers an agenda and a long process through the list style", () => {
    const agenda = normalizeOutline({ title: "T", pages: [pageFor("agenda")] }).pages[0];
    const a = composeArchetypePage(agenda, ds, { index: 1, total: 4 });
    for (const p of paragraphsOf(a.nodes as never, "Agenda")) {
      expect(p.style?.list?.type).toBe("number");
      expect(/^\d/.test(p.runs[0].text)).toBe(false);
    }
    const five = { ...pageFor("process"), steps: ["Survey", "Plant", "Fence", "Monitor", "Report"].map((label) => ({ label })) };
    const process = normalizeOutline({ title: "T", pages: [five] }).pages[0];
    const pr = composeArchetypePage(process, ds, { index: 2, total: 4 });
    const steps = paragraphsOf(pr.nodes as never, "Steps");
    expect(steps.length).toBe(5);
    expect(steps.every((p) => p.style?.list?.type === "number")).toBe(true);
  });

  it("column points are list items too", () => {
    const item = normalizeOutline({ title: "T", pages: [pageFor("twoColumn")] }).pages[0];
    const page = composeArchetypePage(item, ds, { index: 1, total: 4 });
    const points = paragraphsOf(page.nodes as never, "Points");
    expect(points.length).toBe(6);
    expect(points.every((p) => p.style?.list?.type === "bullet")).toBe(true);
  });

  it("keeps a heading's last word company with a no-break space", () => {
    expect(keepLastWordCompany("Why the shoreline is retreating")).toBe("Why the shoreline is retreating");
    expect(keepLastWordCompany("Two words")).toBe("Two words");
    expect(keepLastWordCompany("One")).toBe("One");
    // Whitespace around the join: the run of spaces before the last word
    // collapses into the single no-break space, and trailing whitespace goes.
    expect(keepLastWordCompany("a b   c")).toBe("a b c");
    expect(keepLastWordCompany("a b c   ")).toBe("a b c");
    // A tab before the last word is not a space, so there is nothing to join.
    expect(keepLastWordCompany("a b\tc")).toBe("a b\tc");
    // The previous pattern backtracked quadratically here: the words are
    // TAB-separated, so the literal-space part of / +(\S+)\s*$/ can only
    // start inside the trailing space run, where \S+ always fails, and the
    // engine retries from every position in it. Tabs matter - with a space
    // before the run the match succeeds immediately and hides the problem.
    // Measured on the old pattern: 38ms at 10k, 139ms at 20k, 491ms at 40k.
    const adversarial = "one\ttwo\t" + "a".repeat(40000) + " ".repeat(40000);
    const t0 = Date.now();
    keepLastWordCompany(adversarial);
    expect(Date.now() - t0).toBeLessThan(250);
    const item = normalizeOutline({ title: "T", pages: [pageFor("bullets")] }).pages[0];
    const page = composeArchetypePage(item, ds, { index: 1, total: 4 });
    const title = paragraphsOf(page.nodes as never, "Title")[0];
    expect(title.runs[0].text).toBe("Why the shoreline is retreating");
    // Body copy is left alone.
    for (const p of paragraphsOf(page.nodes as never, "Points")) expect(p.runs[0].text).not.toContain(" ");
  });
});
