import { describe, it, expect } from "vitest";
import { createBlankDesign, createNode, type DesignFile, type Node } from "@hc/schema";
import { applyToPoint, fromTransform } from "@hc/engine";
import {
  alignDeltas,
  applyCommand,
  decompose,
  detectEqualSpacing,
  distributeDeltas,
  evalExpression,
  flipNode,
  group,
  invertCommand,
  isolationHiddenSiblings,
  marqueeSelect,
  placeImageSize,
  replaceImageSource,
  moveTransform,
  order,
  parentSpaceDelta,
  resizeNode,
  rotateAboutCenter,
  rotateTransform,
  selectAll,
  selectSameType,
  SelectionModel,
  setHidden,
  setLocked,
  snap,
  tidyUpDeltas,
  ungroup,
  unionAABB,
  worldAABB,
  History,
  CommandRegistry,
  runCommand,
  serializeSelection,
  pasteOps,
  duplicateOps,
  removeSelectionOps,
  cut,
  captureStyle,
  pasteStyleOps,
  type Command,
  type EditCommand,
  type HandleId,
  type Transaction,
} from "../index";

function shape(id: string, x: number, y: number, w: number, h: number, extra?: Partial<Node>): Node {
  return createNode("shape", {
    id,
    transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: w, height: h },
    ...extra,
  } as Partial<Node>);
}

function designWith(...nodes: Node[]): DesignFile {
  const d = createBlankDesign();
  d.pages[0].children = nodes;
  return d;
}

describe("expression parser (FR-12)", () => {
  it("evaluates absolute arithmetic", () => {
    expect(evalExpression("100/2")).toBe(50);
    expect(evalExpression("(1+2)*3")).toBe(9);
    expect(evalExpression("100")).toBe(100);
  });
  it("applies relative nudges from current", () => {
    expect(evalExpression("+10", 5)).toBe(15);
    expect(evalExpression("-5", 10)).toBe(5);
    expect(evalExpression("*2", 4)).toBe(8);
    expect(evalExpression("/2", 10)).toBe(5);
  });
  it("returns null for invalid input (caller keeps prior value)", () => {
    expect(evalExpression("abc")).toBeNull();
    expect(evalExpression("")).toBeNull();
    expect(evalExpression("1+")).toBeNull();
  });
  it("rejects non-finite results like division by zero", () => {
    expect(evalExpression("100/0")).toBeNull();
    expect(evalExpression("/0", 5)).toBeNull();
  });
  it("rejects ambiguous compound relative expressions", () => {
    // Leading * / is relative only for a bare number; a compound is rejected.
    expect(evalExpression("*2+1", 4)).toBeNull();
    expect(evalExpression("/2-1", 10)).toBeNull();
  });
});

describe("reparent + history coalescing", () => {
  it("reparent inserts at the recorded index and round-trips", () => {
    const d = designWith(shape("a", 0, 0, 10, 10), shape("b", 0, 0, 10, 10), shape("c", 0, 0, 10, 10));
    const t = { ...d.pages[0].children[2].transform };
    const cmd: EditCommand = {
      kind: "reparent",
      node: "c",
      fromParent: "page",
      toParent: "page",
      fromIndex: 2,
      toIndex: 0,
      beforeTransform: t,
      afterTransform: t,
    };
    applyCommand(d, cmd);
    expect(d.pages[0].children.map((n) => n.id)).toEqual(["c", "a", "b"]);
    applyCommand(d, invertCommand(cmd));
    expect(d.pages[0].children.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("commitCoalescing merges rapid same-key steps, splits past the window", () => {
    const d = designWith(shape("s", 0, 0, 10, 10));
    const h = new History(d);
    const base = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
    const op = (x: number): EditCommand => ({
      kind: "transform",
      nodes: ["s"],
      before: [{ ...base, x: x - 1 }],
      after: [{ ...base, x }],
    });
    const txn = (ts: number, x: number): Transaction => ({ id: "ignored", label: "move", ts, ops: [op(x)] });
    h.commitCoalescing(txn(1000, 5), "drag", 400);
    h.commitCoalescing(txn(1100, 6), "drag", 400); // within window -> merge
    expect(h.labels().length).toBe(1);
    h.commitCoalescing(txn(2000, 7), "drag", 400); // past window -> new step
    expect(h.labels().length).toBe(2);
  });
});

describe("transform ops (FR-6..FR-10)", () => {
  it("resize drags through the anchor: flips the axis and keeps the anchor fixed", () => {
    const node = createNode("shape", {
      shape: "rect",
      transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 50, height: 40 },
    } as Partial<Node>);
    // East handle dragged 70 left: raw width -20 -> mirrored across the left
    // edge (x=100): box spans [80,100], content flipped horizontally.
    const r = resizeNode(node, "e", -70, 0);
    expect(r.size.width).toBeCloseTo(20, 5);
    expect(r.transform.scaleX).toBe(-1);
    expect(r.transform.x).toBeCloseTo(100, 5); // local 0 still maps to the anchor
    // Rendered extent: local [0,20] under scaleX -1 spans [x-20, x] = [80,100].
    // West handle dragged 70 right: raw width -20 -> mirrored across the right
    // edge (x=150): box spans [150,170].
    const r2 = resizeNode(node, "w", 70, 0);
    expect(r2.size.width).toBeCloseTo(20, 5);
    expect(r2.transform.scaleX).toBe(-1);
    expect(r2.transform.x).toBeCloseTo(170, 5); // local 20 maps back to 150
    // South handle dragged 60 up: raw height -20 -> vertical mirror across the
    // top edge (y=100).
    const r3 = resizeNode(node, "s", 0, -60);
    expect(r3.size.height).toBeCloseTo(20, 5);
    expect(r3.transform.scaleY).toBe(-1);
    expect(r3.transform.y).toBeCloseTo(100, 5);
    // A non-crossing drag keeps positive scale (no accidental flips).
    const r4 = resizeNode(node, "e", -30, 0);
    expect(r4.size.width).toBeCloseTo(20, 5);
    expect(r4.transform.scaleX).toBe(1);
  });


  it("move respects axis lock", () => {
    const t = { x: 10, y: 20, scaleX: 1, scaleY: 1, rotation: 0 };
    expect(moveTransform(t, 5, 7)).toMatchObject({ x: 15, y: 27 });
    expect(moveTransform(t, 5, 7, "x")).toMatchObject({ x: 15, y: 20 });
    expect(moveTransform(t, 5, 7, "y")).toMatchObject({ x: 10, y: 27 });
  });

  it("rotation snaps to 15 degrees", () => {
    const t = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
    expect(rotateTransform(t, 7, true).rotation).toBe(0);
    expect(rotateTransform(t, 8, true).rotation).toBe(15);
    expect(rotateTransform(t, 7, false).rotation).toBe(7);
  });

  it("rotateAboutCenter keeps the box center fixed (spins in place)", () => {
    const t = { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 0 };
    const size = { width: 80, height: 40 };
    const before = applyToPoint(fromTransform(t), { x: 40, y: 20 });
    const nt = rotateAboutCenter(t, size, 90);
    expect(nt.rotation).toBe(90);
    const after = applyToPoint(fromTransform(nt), { x: 40, y: 20 });
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("flip keeps the box center fixed for a ROTATED node", () => {
    const node = createNode("shape", {
      id: "r",
      transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 30 },
      size: { width: 80, height: 40 },
    } as Partial<Node>);
    const center = (n: Node) => applyToPoint(fromTransform(n.transform), { x: 40, y: 20 });
    const before = center(node);
    node.transform = flipNode(node, "h");
    const after = center(node);
    expect(node.transform.scaleX).toBe(-1);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("parentSpaceDelta is identity for a top-level node, scaled inside a group", () => {
    const top = designWith(shape("s", 10, 10, 50, 50));
    expect(parentSpaceDelta(top, "s", 7, -3)).toMatchObject({ dx: 7, dy: -3 });

    const child = shape("c", 0, 0, 10, 10);
    const grp = {
      id: "g",
      type: "group",
      transform: { x: 0, y: 0, scaleX: 2, scaleY: 2, rotation: 0 },
      size: { width: 20, height: 20 },
      opacity: 1,
      blendMode: "normal",
      aspectLocked: true,
      children: [child],
    } as unknown as Node;
    const nested = designWith(grp);
    // A 20px page-space move is only 10px inside the 2x-scaled parent.
    const pd = parentSpaceDelta(nested, "c", 20, 20);
    expect(pd.dx).toBeCloseTo(10, 6);
    expect(pd.dy).toBeCloseTo(10, 6);
  });

  it("flip keeps the axis-aligned bounds (negative scale)", () => {
    const d = designWith(shape("s", 10, 20, 30, 40));
    const before = worldAABB(d, "s")!;
    d.pages[0].children[0].transform = flipNode(d.pages[0].children[0], "h");
    const after = worldAABB(d, "s")!;
    expect(d.pages[0].children[0].transform.scaleX).toBe(-1);
    expect(after).toEqual(before);
  });

  it("resize from a corner keeps the opposite anchor fixed", () => {
    const n = shape("s", 0, 0, 100, 50);
    const r = resizeNode(n, "se", 20, 10);
    expect(r.size).toEqual({ width: 120, height: 60 });
    expect(r.transform.x).toBeCloseTo(0, 6); // nw anchor unchanged
    expect(r.transform.y).toBeCloseTo(0, 6);
  });

  it("resize of a rotated node keeps the world anchor fixed", () => {
    const n = shape("s", 100, 100, 80, 40, {
      transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 90 },
    });
    const anchorBefore = applyToPoint(fromTransform(n.transform), { x: 0, y: 0 });
    const r = resizeNode(n, "se", 15, -5);
    const anchorAfter = applyToPoint(fromTransform(r.transform), { x: 0, y: 0 });
    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x, 6);
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y, 6);
  });

  it("aspect-locked resize preserves the ratio", () => {
    const n = shape("s", 0, 0, 100, 50);
    const r = resizeNode(n, "se", 50, 0, { aspect: true });
    expect(r.size.width / r.size.height).toBeCloseTo(100 / 50, 6);
  });

  it("decompose inverts fromTransform for translate+scale+rotation", () => {
    const t = { x: 30, y: -10, scaleX: 2, scaleY: 1.5, rotation: 40 };
    const round = decompose(fromTransform(t));
    expect(round.x).toBeCloseTo(30, 4);
    expect(round.scaleX).toBeCloseTo(2, 4);
    expect(round.scaleY).toBeCloseTo(1.5, 4);
    expect(round.rotation).toBeCloseTo(40, 4);
  });

  it("decompose round-trips a reflection (the matrix itself is reproduced)", () => {
    // A vertical flip must not turn into a horizontal one through decompose.
    const m = fromTransform({ x: 5, y: 6, scaleX: 1, scaleY: -1, rotation: 0 });
    const back = fromTransform(decompose(m));
    for (const k of ["a", "b", "c", "d", "e", "f"] as const) {
      expect(back[k]).toBeCloseTo(m[k], 6);
    }
  });
});

describe("command reversibility (FR-25, AC-11)", () => {
  function roundTrips(file: DesignFile, cmd: EditCommand, read: () => unknown) {
    const original = JSON.parse(JSON.stringify(read()));
    applyCommand(file, cmd);
    applyCommand(file, invertCommand(cmd));
    expect(read()).toEqual(original);
  }

  it("transform/opacity/blend/flag/rename/reorder all invert cleanly", () => {
    const d = designWith(shape("a", 0, 0, 10, 10), shape("b", 50, 50, 10, 10));
    roundTrips(
      d,
      {
        kind: "transform",
        nodes: ["a"],
        before: [d.pages[0].children[0].transform],
        after: [{ x: 5, y: 5, scaleX: 1, scaleY: 1, rotation: 30 }],
      },
      () => d.pages[0].children[0].transform,
    );
    roundTrips(d, { kind: "setOpacity", node: "a", before: 1, after: 0.3 }, () => d.pages[0].children[0].opacity);
    roundTrips(d, { kind: "setBlend", node: "a", before: "normal", after: "multiply" }, () => d.pages[0].children[0].blendMode);
    roundTrips(d, { kind: "setFlag", node: "a", flag: "locked", before: false, after: true }, () => !!d.pages[0].children[0].locked);
    roundTrips(d, { kind: "rename", node: "a", before: undefined, after: "Hero" }, () => d.pages[0].children[0].name ?? null);
    roundTrips(d, { kind: "reorder", node: "a", parent: "page", fromIndex: 0, toIndex: 1 }, () => d.pages[0].children.map((n) => n.id));
  });

  it("setFills/setStroke invert cleanly, including add-from-undefined (F09 FR-11)", () => {
    const d = designWith(shape("a", 0, 0, 10, 10));
    const node = () => d.pages[0].children[0] as unknown as Record<string, unknown>;
    const blue = { type: "solid", color: { srgb: { r: 0, g: 0, b: 1, a: 1 } } };
    const before = node().fills as unknown;
    // Applying a fill change and its inverse restores the prior fills array.
    roundTrips(d, { kind: "setFills", node: "a", before: before as never, after: [blue] as never }, () => node().fills ?? null);
    // A stroke set from undefined then inverted removes the stroke again.
    expect(node().stroke).toBeUndefined();
    const stroke = { fill: blue, width: 2, align: "center", cap: "butt", join: "miter" };
    applyCommand(d, { kind: "setStroke", node: "a", before: undefined, after: stroke as never });
    expect(node().stroke).toEqual(stroke);
    applyCommand(d, invertCommand({ kind: "setStroke", node: "a", before: undefined, after: stroke as never }));
    expect(node().stroke).toBeUndefined();
  });
});

describe("selection (FR-1..FR-4)", () => {
  it("toggle/add/clear", () => {
    const s = new SelectionModel();
    s.set(["a"]);
    s.toggle("b");
    expect(s.get()).toEqual(["a", "b"]);
    s.toggle("a");
    expect(s.get()).toEqual(["b"]);
    s.clear();
    expect(s.get()).toEqual([]);
  });
  it("selectAll skips hidden/locked; selectSameType filters by type", () => {
    const d = designWith(
      shape("a", 0, 0, 10, 10),
      shape("b", 0, 0, 10, 10, { locked: true }),
      createNode("text", { id: "t", content: [] } as Partial<Node>),
    );
    expect(selectAll(d).sort()).toEqual(["a", "t"]);
    expect(selectSameType(d, "a")).toEqual(["a"]);
  });
});

describe("snapping (FR-13, FR-14)", () => {
  it("snaps a moving box center to a static box center within threshold", () => {
    const moving = { x: 102, y: 0, width: 20, height: 20 };
    const stat = { x: 0, y: 0, width: 220, height: 20 }; // center at 110
    const r = snap(moving, [stat], { threshold: 6 });
    // moving center 112 -> snap to 110: dx = -2
    expect(r.dx).toBeCloseTo(-2, 6);
    expect(r.guidesX).toContain(110);
  });
  it("snaps to the grid", () => {
    // Box edges [2,3,4]; nearest grid line (step 8) is 0, reached via the left edge.
    const r = snap({ x: 2, y: 0, width: 2, height: 2 }, [], { grid: 8, threshold: 6 });
    expect(r.dx).toBeCloseTo(-2, 6); // left edge 2 -> 0
  });
  it("detects equal spacing for 3+ boxes", () => {
    const boxes = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 20, y: 0, width: 10, height: 10 },
      { x: 40, y: 0, width: 10, height: 10 },
    ];
    expect(detectEqualSpacing(boxes, "x")).toEqual({ equal: true, gap: 10 });
  });
});

describe("arrange (FR-16..FR-18)", () => {
  const items = [
    { id: "a", bounds: { x: 0, y: 0, width: 20, height: 10 } },
    { id: "b", bounds: { x: 100, y: 50, width: 40, height: 10 } },
  ];
  it("aligns left and horizontal-center to a target", () => {
    const target = { x: 0, y: 0, width: 200, height: 100 };
    expect(alignDeltas(items, "left", target).get("b")).toEqual({ dx: -100, dy: 0 });
    expect(alignDeltas(items, "hcenter", target).get("a")).toEqual({ dx: 90, dy: 0 });
  });
  it("distributes three items by gap", () => {
    const three = [
      { id: "a", bounds: { x: 0, y: 0, width: 10, height: 10 } },
      { id: "b", bounds: { x: 35, y: 0, width: 10, height: 10 } },
      { id: "c", bounds: { x: 90, y: 0, width: 10, height: 10 } },
    ];
    const d = distributeDeltas(three, "h", "gap");
    // span 100, sizes 30, gap = 70/2 = 35 -> b at 45
    expect(d.get("b")).toEqual({ dx: 10, dy: 0 });
  });
  it("orders children front/back/forward/backward", () => {
    const c = [shape("a", 0, 0, 1, 1), shape("b", 0, 0, 1, 1), shape("c", 0, 0, 1, 1)];
    expect(order(c, ["a"], "front").map((n) => n.id)).toEqual(["b", "c", "a"]);
    expect(order(c, ["c"], "back").map((n) => n.id)).toEqual(["c", "a", "b"]);
    expect(order(c, ["a"], "forward").map((n) => n.id)).toEqual(["b", "a", "c"]);
    expect(order(c, ["c"], "backward").map((n) => n.id)).toEqual(["a", "c", "b"]);
  });
  it("tidy-up rows items with uniform spacing", () => {
    const messy = [
      { id: "a", bounds: { x: 0, y: 5, width: 10, height: 10 } },
      { id: "b", bounds: { x: 30, y: 50, width: 10, height: 10 } },
    ];
    const d = tidyUpDeltas(messy);
    expect(d.get("a")).toEqual({ dx: 0, dy: 0 }); // first stays; top aligns to 5
    expect(d.get("b")!.dy).toBe(-45); // aligned to top of a
  });
});

describe("grouping (FR-20, AC-8)", () => {
  it("group then ungroup preserves each child's world bounds (no jump)", () => {
    const d = designWith(shape("a", 10, 10, 30, 20), shape("b", 80, 60, 40, 40));
    const aBefore = worldAABB(d, "a")!;
    const bBefore = worldAABB(d, "b")!;

    const g = group(d, ["a", "b"])!;
    expect(g.groupId).toBeTruthy();
    expect(d.pages[0].children.length).toBe(1); // one group at top level
    expect(worldAABB(d, "a")).toEqual(aBefore); // child world unchanged
    expect(worldAABB(d, "b")).toEqual(bBefore);

    ungroup(d, g.groupId);
    expect(d.pages[0].children.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(worldAABB(d, "a")!.x).toBeCloseTo(aBefore.x, 6);
    expect(worldAABB(d, "b")!.y).toBeCloseTo(bBefore.y, 6);
  });

  it("the group box is the union of its members", () => {
    const d = designWith(shape("a", 10, 10, 30, 20), shape("b", 80, 60, 40, 40));
    const union = unionAABB(d, ["a", "b"])!;
    const g = group(d, ["a", "b"])!;
    expect(worldAABB(d, g.groupId)).toEqual(union);
  });
});

describe("image placement + replace (F08)", () => {
  it("placeImageSize fits the longest edge to ~80% of the smaller viewport axis", () => {
    const s = placeImageSize(1000, 500, 800, 600);
    expect(s.width).toBeCloseTo(480, 6); // 0.8 * 600
    expect(s.height).toBeCloseTo(240, 6); // aspect preserved
  });

  it("replaceImageSource keeps the crop on same aspect, resets it on mismatch", () => {
    const base = createNode("image", {
      id: "i",
      source: { assetId: "a", naturalWidth: 100, naturalHeight: 100 },
      crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
    } as Partial<Node>) as import("@hc/schema").ImageNode;

    const same = replaceImageSource(base, { assetId: "b", naturalWidth: 200, naturalHeight: 200 });
    expect(same.aspectChanged).toBe(false);
    expect(same.node.crop).toEqual({ x: 0, y: 0, width: 0.5, height: 0.5 });

    const diff = replaceImageSource(base, { assetId: "c", naturalWidth: 300, naturalHeight: 100 });
    expect(diff.aspectChanged).toBe(true);
    expect(diff.node.crop).toBeUndefined();
    expect(diff.node.source.assetId).toBe("c");
  });
});

describe("layer state (FR-22)", () => {
  it("setLocked/setHidden mutate and return reversible commands", () => {
    const d = designWith(shape("a", 0, 0, 10, 10));
    const cmd = setLocked(d, "a", true)!;
    expect(d.pages[0].children[0].locked).toBe(true);
    applyCommand(d, invertCommand(cmd));
    expect(d.pages[0].children[0].locked).toBe(false);
    setHidden(d, "a", true);
    expect(d.pages[0].children[0].hidden).toBe(true);
  });
  it("isolation lists sibling ids to hide", () => {
    const d = designWith(shape("a", 0, 0, 10, 10), shape("b", 0, 0, 10, 10), shape("c", 0, 0, 10, 10));
    expect(isolationHiddenSiblings(d, "b").sort()).toEqual(["a", "c"]);
    expect(isolationHiddenSiblings(d, null)).toEqual([]);
  });
});

describe("history transactions (F10 FR-7, AC-5)", () => {
  function fillShape(id: string): Node {
    return shape(id, 10, 10, 20, 20, { fills: [{ type: "solid", color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } }] } as Partial<Node>);
  }

  it("commits, undoes, and redoes a grouped transaction as one step", () => {
    const d = designWith(fillShape("a"));
    const h = new History(d);
    const txn: Transaction = {
      id: "t1",
      label: "Recolor + move",
      ops: [
        { kind: "setFills", node: "a", before: (d.pages[0].children[0] as unknown as { fills: unknown[] }).fills as never, after: [{ type: "solid", color: { srgb: { r: 0, g: 1, b: 0, a: 1 } } }] as never },
        { kind: "transform", nodes: ["a"], before: [d.pages[0].children[0].transform], after: [{ x: 99, y: 99, scaleX: 1, scaleY: 1, rotation: 0 }] },
      ],
    };
    h.commit(txn);
    expect(d.pages[0].children[0].transform.x).toBe(99);
    expect(h.canUndo()).toBe(true);
    h.undo();
    expect(d.pages[0].children[0].transform.x).toBe(10);
    expect((d.pages[0].children[0] as unknown as { fills: { color: { srgb: { r: number } } }[] }).fills[0].color.srgb.r).toBe(1);
    expect(h.canRedo()).toBe(true);
    h.redo();
    expect(d.pages[0].children[0].transform.x).toBe(99);
  });

  it("commit clears the redo stack", () => {
    const d = designWith(shape("a", 0, 0, 10, 10));
    const h = new History(d);
    h.commit({ id: "1", label: "rename", ops: [{ kind: "rename", node: "a", before: undefined, after: "X" }] });
    h.undo();
    expect(h.canRedo()).toBe(true);
    h.commit({ id: "2", label: "rename2", ops: [{ kind: "rename", node: "a", before: undefined, after: "Y" }] });
    expect(h.canRedo()).toBe(false);
  });
});

describe("command registry (F10 FR-1, FR-11)", () => {
  const dupCmd: Command = {
    id: "selection.duplicate",
    label: "Duplicate",
    category: "Edit",
    enabled: (ctx) => ctx.selection.length > 0,
    run: (ctx, file) => duplicateOps(file, ctx.selection, { x: 5, y: 5 }, (() => { let i = 0; return () => `dup-${++i}`; })()).ops,
  };

  it("runs an enabled command as one undoable transaction", () => {
    const d = designWith(shape("a", 0, 0, 10, 10));
    const reg = new CommandRegistry();
    reg.register(dupCmd);
    const h = new History(d);
    const txn = runCommand(reg, "selection.duplicate", { selection: ["a"] }, d, h, undefined);
    expect(txn).not.toBeNull();
    expect(d.pages[0].children).toHaveLength(2);
    h.undo();
    expect(d.pages[0].children).toHaveLength(1);
  });

  it("ignores a disabled command and reports enablement", () => {
    const d = designWith(shape("a", 0, 0, 10, 10));
    const reg = new CommandRegistry();
    reg.register(dupCmd);
    const h = new History(d);
    expect(reg.isEnabled("selection.duplicate", { selection: [] }, d)).toBe(false);
    expect(runCommand(reg, "selection.duplicate", { selection: [] }, d, h, undefined)).toBeNull();
    expect(d.pages[0].children).toHaveLength(1);
  });
});

describe("clipboard copy/paste (F10 FR-2..FR-4, AC-1, AC-2)", () => {
  const gen = () => { let i = 0; return () => `p-${++i}`; };

  it("paste centers the fragment bbox on `at` with fresh ids, and cascades", () => {
    const d = designWith(shape("a", 100, 100, 50, 50));
    const payload = serializeSelection(d, ["a"], { designId: "d1", pageId: "pg" })!;
    expect(payload.nodes[0].id).toBe("a");
    // bbox center is (125,125); centering it on (200,200) shifts by (+75,+75).
    const r1 = pasteOps(d, payload, { mode: "normal", at: { x: 200, y: 200 }, cascadeIndex: 0, idGen: gen() });
    expect(r1.nodeIds[0]).toBe("p-1");
    expect(r1.nodeIds[0]).not.toBe("a");
    r1.ops.forEach((op) => applyCommand(d, op));
    const pasted1 = d.pages[0].children.find((n) => n.id === "p-1")!;
    expect(pasted1.transform).toMatchObject({ x: 175, y: 175 });

    // second paste cascades by another 16px down-right.
    const r2 = pasteOps(d, payload, { mode: "normal", at: { x: 200, y: 200 }, cascadeIndex: 1, idGen: gen() });
    r2.ops.forEach((op) => applyCommand(d, op));
    const cascaded = d.pages[0].children.filter((n) => n.transform.x === 191 && n.transform.y === 191);
    expect(cascaded.length).toBe(1);
  });

  it("paste-in-place keeps the original coordinates", () => {
    const d = designWith(shape("a", 250, 175, 30, 30));
    const payload = serializeSelection(d, ["a"], { designId: "d1", pageId: "pg" })!;
    const r = pasteOps(d, payload, { mode: "in-place", idGen: gen() });
    r.ops.forEach((op) => applyCommand(d, op));
    const pasted = d.pages[0].children.find((n) => n.id !== "a")!;
    expect(pasted.transform).toMatchObject({ x: 250, y: 175 });
  });

  it("serializeSelection drops descendants of selected containers", () => {
    const child = shape("c", 5, 5, 10, 10);
    const grp = createNode("group", { id: "g", children: [child], transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 50 } } as Partial<Node>);
    const d = designWith(grp);
    const payload = serializeSelection(d, ["g", "c"], { designId: "d1", pageId: "pg" })!;
    expect(payload.nodes).toHaveLength(1);
    expect(payload.nodes[0].id).toBe("g");
  });

  it("delete (removeSelectionOps) removes and undo restores original order", () => {
    const d = designWith(shape("a", 0, 0, 10, 10), shape("b", 0, 0, 10, 10), shape("c", 0, 0, 10, 10));
    const h = new History(d);
    h.commit({ id: "del", label: "Delete", ops: removeSelectionOps(d, ["a", "c"]) });
    expect(d.pages[0].children.map((n) => n.id)).toEqual(["b"]);
    h.undo();
    expect(d.pages[0].children.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("pasting a photo grid remaps cell childIds to the fresh frame ids", () => {
    const cellFrame = createNode("frame", { id: "cell-1", clip: true, children: [], transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 100, height: 100 } } as Partial<Node>);
    const grid = createNode("grid", {
      id: "grid-1", rows: 1, cols: 1, gap: 8,
      cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, childId: "cell-1" }],
      children: [cellFrame],
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 100, height: 100 },
    } as Partial<Node>);
    const d = designWith(grid);
    const payload = serializeSelection(d, ["grid-1"], { designId: "d1", pageId: "pg" })!;
    const r = pasteOps(d, payload, { mode: "in-place", idGen: gen() });
    const pasted = r.nodes[0] as unknown as { children: { id: string }[]; cells: { childId?: string }[] };
    expect(pasted.children[0].id).not.toBe("cell-1");
    // The cell must reference the pasted frame, not the source frame, or a
    // later grid re-layout treats the cell as missing and rebuilds it empty.
    expect(pasted.cells[0].childId).toBe(pasted.children[0].id);
  });

  it("cut returns a payload and removal ops; paste of the payload round-trips", () => {
    const d = designWith(shape("a", 40, 40, 10, 10), shape("b", 0, 0, 10, 10));
    const { payload, ops } = cut(d, ["a"], { designId: "d1", pageId: "pg" });
    expect(payload!.nodes[0].id).toBe("a");
    ops.forEach((op) => applyCommand(d, op));
    expect(d.pages[0].children.map((n) => n.id)).toEqual(["b"]);
    const r = pasteOps(d, payload!, { mode: "in-place", idGen: gen() });
    r.ops.forEach((op) => applyCommand(d, op));
    const pasted = d.pages[0].children.find((n) => n.id !== "b")!;
    expect(pasted.transform).toMatchObject({ x: 40, y: 40 });
  });
});

describe("duplicate + power-duplicate (F10 FR-5, AC-3)", () => {
  it("clones with a repeated offset and is undoable", () => {
    const d = designWith(shape("a", 0, 0, 20, 20));
    const h = new History(d);
    const idg = (() => { let i = 0; return () => `d-${++i}`; })();
    const r = duplicateOps(d, ["a"], { x: 12, y: 8 }, idg);
    h.commit({ id: "1", label: "Duplicate", ops: r.ops });
    const clone = d.pages[0].children.find((n) => n.id === r.nodeIds[0])!;
    expect(clone.transform).toMatchObject({ x: 12, y: 8 });
    h.undo();
    expect(d.pages[0].children).toHaveLength(1);
  });

  it("dedups selection roots: a group and its child clone only the group", () => {
    const child = shape("c", 5, 5, 10, 10);
    const grp = createNode("group", { id: "g", children: [child], transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 50 } } as Partial<Node>);
    const d = designWith(grp);
    const r = duplicateOps(d, ["g", "c"], { x: 5, y: 5 }, (() => { let i = 0; return () => `z-${++i}`; })());
    expect(r.ops).toHaveLength(1);
    expect(r.ops[0].kind).toBe("insert");
  });
});

describe("copy-style / paste-style (F10 FR-6, AC-4)", () => {
  it("transfers fill/effects/opacity and reports applied fields, skipping text fills", () => {
    const src = shape("src", 0, 0, 10, 10, {
      fills: [{ type: "solid", color: { srgb: { r: 0.2, g: 0.4, b: 0.6, a: 1 } } }],
      opacity: 0.5,
      effects: [{ kind: "blur", radius: 3 }],
    } as Partial<Node>);
    const txt = createNode("text", { id: "txt" }) as Node;
    const tgt = shape("tgt", 50, 50, 10, 10);
    const d = designWith(src, txt, tgt);

    const clip = captureStyle(d, "src")!;
    expect(clip.fills).toBeDefined();
    expect(clip.opacity).toBe(0.5);

    const res = pasteStyleOps(d, ["tgt", "txt"], clip);
    res.ops.forEach((op) => applyCommand(d, op));
    // shape target receives fill + effects + opacity
    expect(res.applied["tgt"]).toContain("fill");
    expect(res.applied["tgt"]).toContain("opacity");
    expect((d.pages[0].children[2] as unknown as { fills: unknown[] }).fills).toHaveLength(1);
    // text target does not receive a node-level fill (handled per run, deferred)
    expect(res.applied["txt"] ?? []).not.toContain("fill");
  });
});
