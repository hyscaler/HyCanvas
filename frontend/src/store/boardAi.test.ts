// Board AI materialization (doc 30 Phase 3): insertDiagramSpec turns a
// normalized diagram into native stickies + connectors as one undo step;
// applyStickyClusters groups stickies into labeled frames behind them;
// insertSummaryNote drops a text note below existing content.
import { describe, expect, it } from "vitest";
import type { DesignFile, Node } from "@hc/schema";
import { useEditor } from "./editor";

function board(children: Node[] = []): DesignFile {
  return {
    schemaVersion: 1,
    id: "b1",
    title: "Board",
    docKind: "whiteboard",
    pages: [{ id: "p1", width: 1920, height: 1080, children }],
  } as unknown as DesignFile;
}

function stickyNode(id: string, text: string, x = 0, y = 0): Node {
  return {
    id,
    type: "sticky",
    text,
    fontScale: 1,
    align: "left",
    autoSize: true,
    fill: { type: "solid", color: { srgb: { r: 1, g: 0.9, b: 0.4, a: 1 } } },
    textColor: { srgb: { r: 0, g: 0, b: 0, a: 1 } },
    transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 170, height: 170 },
  } as unknown as Node;
}

const kids = () => useEditor.getState().doc.pages[0].children as Node[];

describe("insertDiagramSpec", () => {
  it("creates stickies + connectors, laid out, in one undo step", () => {
    useEditor.getState().loadDoc(board());
    const ok = useEditor.getState().insertDiagramSpec({
      kind: "flowchart",
      direction: "down",
      nodes: [
        { id: "a", label: "Plan" },
        { id: "b", label: "Build" },
        { id: "c", label: "Ship" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c", label: "done" },
      ],
    });
    expect(ok).toBe(true);
    const stickies = kids().filter((n) => n.type === "sticky");
    const connectors = kids().filter((n) => n.type === "connector");
    expect(stickies.map((n) => (n as unknown as { text: string }).text)).toEqual(["Plan", "Build", "Ship"]);
    expect(connectors).toHaveLength(2);
    // Connectors attach to the freshly minted sticky ids.
    const ids = new Set(stickies.map((n) => n.id));
    for (const c of connectors) {
      const cc = c as unknown as { start: { attach: { nodeId: string } }; end: { attach: { nodeId: string } } };
      expect(ids.has(cc.start.attach.nodeId)).toBe(true);
      expect(ids.has(cc.end.attach.nodeId)).toBe(true);
    }
    // The edge label survives.
    expect((connectors[1] as unknown as { label?: string }).label).toBe("done");
    // Layered layout: Plan sits above Build sits above Ship (direction down).
    const y = (id: string) => stickies.find((n) => (n as unknown as { text: string }).text === id)!.transform.y;
    expect(y("Plan")).toBeLessThan(y("Build"));
    expect(y("Build")).toBeLessThan(y("Ship"));

    useEditor.getState().undo();
    expect(kids()).toHaveLength(0); // one undo removes the whole diagram
  });
});

describe("applyStickyClusters", () => {
  it("frames each cluster and grids its stickies; one undo restores", () => {
    useEditor.getState().loadDoc(board([
      stickyNode("s1", "Slow builds", 10, 10),
      stickyNode("s2", "Flaky tests", 400, 10),
      stickyNode("s3", "Great snacks", 800, 10),
    ]));
    const ok = useEditor.getState().applyStickyClusters([
      { title: "CI pain", ids: ["s1", "s2", "ghost"] },
      { title: "Culture", ids: ["s3"] },
      { title: "Empty", ids: ["nope"] }, // no members: dropped
    ]);
    expect(ok).toBe(true);
    const frames = kids().filter((n) => n.type === "frame");
    expect(frames.map((f) => (f as unknown as { name?: string }).name)).toEqual(["CI pain", "Culture"]);
    // Frames paint behind the stickies (front of the children array).
    expect(kids()[0].type).toBe("frame");
    // Members moved inside their frame's bounds.
    const f1 = frames[0];
    const s1 = kids().find((n) => n.id === "s1")!;
    expect(s1.transform.x).toBeGreaterThanOrEqual(f1.transform.x);
    expect(s1.transform.x + 170).toBeLessThanOrEqual(f1.transform.x + f1.size.width + 1);

    useEditor.getState().undo();
    expect(kids().filter((n) => n.type === "frame")).toHaveLength(0);
    expect(kids().find((n) => n.id === "s1")!.transform.x).toBe(10); // position restored
  });
});

describe("insertSummaryNote", () => {
  it("adds a multi-line text note below existing content", () => {
    useEditor.getState().loadDoc(board([stickyNode("s1", "note", 0, 0)]));
    expect(useEditor.getState().insertSummaryNote("Themes:\nCI is slow")).toBe(true);
    const note = kids().find((n) => n.type === "text")!;
    expect(note).toBeTruthy();
    const paras = (note as unknown as { content: { runs: { text: string }[] }[] }).content;
    expect(paras.map((pp) => pp.runs[0].text)).toEqual(["Themes:", "CI is slow"]);
    expect(note.transform.y).toBeGreaterThan(170); // below the sticky
    expect(useEditor.getState().insertSummaryNote("   ")).toBe(false);
  });
});
