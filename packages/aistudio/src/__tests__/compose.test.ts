// F40 E03: the headless composer's Node-side half of the golden parity claim.
// This file must stay ISOLATED (its own test file, composing exactly once):
// node ids come from module counters and the shimmed crypto.randomUUID, so any
// earlier compose in the same module graph would shift every id. The Go test
// (backend/internal/composer) asserts the goja run equals the same fixture.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const testdata = path.resolve(__dirname, "../../../../backend/internal/composer/testdata");

describe("composeDeckFile parity fixture", () => {
  it("composes the committed input to the committed expected file", async () => {
    // The same deterministic shim the goja entry installs, BEFORE the compose
    // module graph loads (createNode reads crypto.randomUUID at call time).
    let uuidSeq = 0;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: () => `n-${++uuidSeq}` },
    });
    const { composeDeckFile } = await import("../compose");
    const input = JSON.parse(readFileSync(path.join(testdata, "compose-input.json"), "utf8"));
    const expected = JSON.parse(readFileSync(path.join(testdata, "compose-expected.json"), "utf8"));
    const got = JSON.parse(JSON.stringify(composeDeckFile(input)));
    expect(got).toEqual(expected);
  });
});

describe("layout-grounded composition (F40 E14)", () => {
  it("materializes a template's layout system: linked pages, placeholder boxes, record theme", async () => {
    let uuidSeq = 0;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: () => `t-${++uuidSeq}` },
    });
    const { composeDeckFile } = await import("../compose");
    const layoutSet = {
      masters: [{ id: "m1", name: "M", placeholders: [] }],
      layouts: [
        {
          id: "l-title", masterId: "m1", name: "Title",
          background: { type: "solid", color: { srgb: { r: 0.05, g: 0.08, b: 0.2, a: 1 } } },
          placeholders: [
            { id: "ph-t", role: "title", rect: { x: 100, y: 300, width: 1720, height: 200 } },
            { id: "ph-pic", role: "picture", rect: { x: 100, y: 550, width: 400, height: 300 } },
          ],
        },
        {
          id: "l-content", masterId: "m1", name: "Title and content",
          placeholders: [
            { id: "ph-t", role: "title", rect: { x: 100, y: 80, width: 1720, height: 140 } },
            { id: "ph-c", role: "content", rect: { x: 100, y: 280, width: 1720, height: 640 } },
          ],
        },
      ],
    };
    const themeRecord = {
      id: "tpl-theme", name: "Uploaded",
      colors: [
        { id: "c0", name: "primary", color: { srgb: { r: 0.2, g: 0.3, b: 0.8, a: 1 } } },
        { id: "c1", name: "accent", color: { srgb: { r: 0.5, g: 0.6, b: 0.9, a: 1 } } },
        { id: "c2", name: "deep", color: { srgb: { r: 0.05, g: 0.08, b: 0.3, a: 1 } } },
      ],
      fontHeading: "Poppins",
      fontBody: "Inter",
    };
    const file = composeDeckFile({
      outline: {
        title: "Template Deck",
        pages: [
          { title: "Template Deck", points: [], visualRole: "cover" },
          { title: "Points", points: ["one", "two", "three"], visualRole: "content" },
        ],
      },
      width: 1920,
      height: 1080,
      layoutSet: layoutSet as never,
      themeRecord: themeRecord as never,
    }) as never as {
      masters: unknown[]; layouts: { id: string }[]; theme: { id: string };
      pages: { layoutId?: string; background?: { type: string }; children: { data?: { placeholderId?: string }; content: { runs: { text: string; style: { fontFamily: string } }[] }[] }[] }[];
    };
    // The layout system rides into the file; pages are layout-linked.
    expect(file.layouts.map((l) => l.id)).toEqual(["l-title", "l-content"]);
    expect(file.theme.id).toBe("tpl-theme");
    expect(file.pages[0].layoutId).toBe("l-title");
    expect(file.pages[1].layoutId).toBe("l-content");
    // The cover uses the layout's OWN background; boxes are placeholder-tagged
    // and wear the record's fonts; picture slots are skipped headlessly.
    expect(file.pages[0].background?.type).toBe("solid");
    const cover = file.pages[0].children;
    expect(cover).toHaveLength(1);
    expect(cover[0].data?.placeholderId).toBe("ph-t");
    expect(cover[0].content[0].runs[0].style.fontFamily).toBe("Poppins");
    const content = file.pages[1].children.find((n) => n.data?.placeholderId === "ph-c")!;
    expect(content.content).toHaveLength(3);
    expect(content.content[0].runs[0].text).toContain("one");
    expect(content.content[0].runs[0].style.fontFamily).toBe("Inter");
  });
});
