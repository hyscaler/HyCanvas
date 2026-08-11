// Masks render (F40 Phase 1 groundwork).
//
// Before this, `scene.ts` built no SceneNode for `MaskNode.child`, so the
// masked subject was invisible to render, hit test, bounds and the spatial
// index, and the mask node itself drew a placeholder box. All three Go
// backends matched. The only working masking anywhere was hard-edged frame
// clipping.

import { describe, expect, it } from "vitest";
import { createScene } from "../scene";
import { renderScene } from "../render2d";
import type { DesignFile, Node } from "@hc/schema";

/** Records the calls a mask depends on, in order. */
function recordingCtx() {
  const calls: string[] = [];
  const rec = (name: string) => (...args: unknown[]) => {
    calls.push(args.length ? `${name}(${args.join(",")})` : name);
  };
  const ctx = {
    calls,
    save: rec("save"), restore: rec("restore"), clip: rec("clip"),
    beginPath: rec("beginPath"), closePath: rec("closePath"),
    moveTo: rec("moveTo"), lineTo: rec("lineTo"), bezierCurveTo: rec("bezierCurveTo"),
    fillRect: rec("fillRect"), strokeRect: rec("strokeRect"), fill: rec("fill"), stroke: rec("stroke"),
    translate: rec("translate"), rotate: rec("rotate"), scale: rec("scale"), transform: rec("transform"),
    setTransform: rec("setTransform"), drawImage: rec("drawImage"), rect: rec("rect"),
    measureText: () => ({ width: 0 }), fillText: rec("fillText"),
    clearRect: rec("clearRect"), createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }), createPattern: () => null,
    arc: rec("arc"), ellipse: rec("ellipse"), quadraticCurveTo: rec("quadraticCurveTo"),
    roundRect: rec("roundRect"), setLineDash: rec("setLineDash"), clipPath: undefined,
    canvas: { width: 200, height: 200 },
    globalAlpha: 1, fillStyle: "", strokeStyle: "", lineWidth: 1, filter: "none",
    globalCompositeOperation: "source-over",
  };
  return ctx as unknown as Parameters<typeof renderScene>[1] & { calls: string[] };
}

const rect = (id: string): Node => ({
  id, type: "shape", shape: "rect",
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  size: { width: 100, height: 100 }, opacity: 1, blendMode: "normal",
  fills: [{ type: "solid", color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } }],
} as unknown as Node);

function maskNode(shape: unknown, child: Node = rect("subject")): Node {
  return {
    id: "m", type: "mask",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 100, height: 100 }, opacity: 1, blendMode: "normal",
    maskShape: shape, child,
  } as unknown as Node;
}

function fileWith(node: Node): DesignFile {
  return {
    schemaVersion: 19, id: "d", title: "t", assets: [], fonts: [], meta: {},
    pages: [{ id: "p1", width: 200, height: 200, children: [node] }],
  } as unknown as DesignFile;
}

const square = {
  fillRule: "nonzero",
  subpaths: [{ closed: true, anchors: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }] }],
};

describe("the masked subject exists in the scene", () => {
  it("builds a SceneNode for the child", () => {
    const scene = createScene(fileWith(maskNode(square)), 0);
    const mask = scene.root.children![0];
    expect(mask.children).toHaveLength(1);
    expect(mask.children![0].node.id).toBe("subject");
  });

  it("is findable by id, so hit test and selection can reach it", () => {
    const scene = createScene(fileWith(maskNode(square)), 0);
    expect(scene.getSceneNode("subject")).not.toBeNull();
  });
});

describe("the mask clips what it contains", () => {
  it("clips before painting the child and restores after", () => {
    const ctx = recordingCtx();
    renderScene(createScene(fileWith(maskNode(square)), 0), ctx, { x: 0, y: 0, width: 200, height: 200, zoom: 1 });
    const clipAt = ctx.calls.indexOf("clip(nonzero)");
    const childAt = ctx.calls.findIndex((c) => c.startsWith("fillRect"));
    expect(clipAt).toBeGreaterThanOrEqual(0);
    expect(childAt).toBeGreaterThan(clipAt);
  });

  it("honours evenodd", () => {
    const ctx = recordingCtx();
    renderScene(createScene(fileWith(maskNode({ ...square, fillRule: "evenodd" })), 0), ctx, { x: 0, y: 0, width: 200, height: 200, zoom: 1 });
    expect(ctx.calls).toContain("clip(evenodd)");
  });

  it("traces curves as curves, not as a polyline", () => {
    // A mask edge IS the visible boundary of its contents, so flattening it
    // shows as faceting on every rounded mask.
    const curved = {
      fillRule: "nonzero",
      subpaths: [{ closed: true, anchors: [
        { x: 0, y: 0, outHandle: { x: 25, y: -10 } },
        { x: 50, y: 0, inHandle: { x: 25, y: 10 } },
      ] }],
    };
    const ctx = recordingCtx();
    renderScene(createScene(fileWith(maskNode(curved)), 0), ctx, { x: 0, y: 0, width: 200, height: 200, zoom: 1 });
    expect(ctx.calls.some((c) => c.startsWith("bezierCurveTo"))).toBe(true);
  });
});

describe("a broken mask shape fails safe", () => {
  it("clips nothing rather than everything when the shape is unusable", () => {
    // Both outcomes are wrong; one hides the artwork and the other merely
    // fails to trim it. The subject must still be drawn.
    for (const bad of [undefined, { subpaths: [], fillRule: "nonzero" }, { subpaths: [{ closed: true, anchors: [{ x: 1, y: 1 }] }], fillRule: "nonzero" }]) {
      const ctx = recordingCtx();
      renderScene(createScene(fileWith(maskNode(bad)), 0), ctx, { x: 0, y: 0, width: 200, height: 200, zoom: 1 });
      expect(ctx.calls.some((c) => c.startsWith("clip"))).toBe(false);
      expect(ctx.calls.some((c) => c.startsWith("fillRect"))).toBe(true);
    }
  });
});

describe("boolean operands stay inputs", () => {
  it("does not add operands to the scene as drawable children", () => {
    // They are consumed into the boolean's geometry. Painting them would draw
    // each operand on top of the combined result.
    const b = {
      id: "b", type: "boolean", op: "union",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 100, height: 100 }, opacity: 1, blendMode: "normal",
      operands: [rect("op1"), rect("op2")],
    } as unknown as Node;
    const scene = createScene(fileWith(b), 0);
    expect(scene.root.children![0].children ?? []).toHaveLength(0);
  });
});

describe("a mask selects as one object", () => {
  // Giving the subject a SceneNode made it hittable, and children are tested
  // before the parent's own surface, so the hit test started returning the
  // subject. `@hc/editor`'s locate() only descends `children`, so it could not
  // find that node, and every store action begins by locating the id and
  // bailing when that fails: the click produced a selection that silently
  // ignored move, style, and delete.

  function scene(child = rect("subject")) {
    return createScene(fileWith(maskNode(square, child)), 0);
  }

  it("returns the mask, not its subject", () => {
    expect(scene().hitTest({ x: 25, y: 25 })?.id).toBe("m");
  });

  it("is only clickable where its subject actually paints", () => {
    // Like a group: an empty corner of the mask's box is not an invisible
    // click target. The subject here is 20x20 in a 100x100 mask.
    const small = {
      ...(rect("subject") as unknown as Record<string, unknown>),
      size: { width: 20, height: 20 },
    } as unknown as Node;
    const s = scene(small);
    expect(s.hitTest({ x: 10, y: 10 })?.id).toBe("m");
    expect(s.hitTest({ x: 80, y: 80 })).toBeNull();
  });

  it("respects lock on the mask itself", () => {
    const locked = { ...(maskNode(square) as unknown as Record<string, unknown>), locked: true } as unknown as Node;
    expect(createScene(fileWith(locked), 0).hitTest({ x: 25, y: 25 })).toBeNull();
  });

  it("keeps the subject out of the selectable-leaf index", () => {
    // Presence interest-management and the AI agent's off-screen context read
    // this; both should see one object, not two.
    const ids = scene().queryViewport({ x: 0, y: 0, width: 200, height: 200 }).map((n) => n.id);
    expect(ids).toContain("m");
    expect(ids).not.toContain("subject");
  });

  it("still renders the subject", () => {
    // The whole point of the change that caused this: not selectable is not
    // the same as not drawn.
    expect(scene().getSceneNode("subject")).not.toBeNull();
  });
});

