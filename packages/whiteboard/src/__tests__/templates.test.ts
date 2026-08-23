import { describe, it, expect } from "vitest";
import { validate, createBlankDesign } from "@hc/schema";
import { whiteboardTemplates, buildTemplate } from "../templates";

describe("templates", () => {
  it("lists all eight templates", () => {
    const ids = whiteboardTemplates.map((t) => t.id).sort();
    expect(ids).toEqual(
      [
        "brainstorm",
        "retro",
        "flowchart",
        "mindmap",
        "kanban",
        "userJourney",
        "swot",
        "orgChart",
      ].sort(),
    );
  });

  it("throws on an unknown template id", () => {
    expect(() => buildTemplate("nope")).toThrow();
  });

  for (const t of whiteboardTemplates) {
    it(`builds non-empty, valid, uniquely-ided nodes for ${t.id}`, () => {
      const { nodes } = buildTemplate(t.id);
      expect(nodes.length).toBeGreaterThan(0);

      // unique ids across the produced node set
      const ids = nodes.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);

      // the produced nodes validate as a DesignFile page
      const design = createBlankDesign({ title: t.id });
      design.pages[0].children = nodes;
      const res = validate(design);
      expect(res.ok, `template ${t.id} should validate: ${JSON.stringify(res)}`).toBe(true);

      // each node carries a position + size
      for (const n of nodes) {
        expect(n.transform).toBeDefined();
        expect(n.size.width).toBeGreaterThan(0);
        expect(n.size.height).toBeGreaterThan(0);
      }
    });
  }

  it("connector-bearing templates wire to real node ids", () => {
    const { nodes } = buildTemplate("orgChart");
    const ids = new Set(nodes.map((n) => n.id));
    const connectors = nodes.filter((n) => n.type === "connector");
    expect(connectors.length).toBeGreaterThan(0);
    for (const c of connectors) {
      const conn = c as { start: { attach?: { nodeId: string } }; end: { attach?: { nodeId: string } } };
      expect(ids.has(conn.start.attach!.nodeId)).toBe(true);
      expect(ids.has(conn.end.attach!.nodeId)).toBe(true);
    }
  });
});
