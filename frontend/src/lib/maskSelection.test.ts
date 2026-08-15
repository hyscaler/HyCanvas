// A masked object selects as one unit (F40 Phase 1 groundwork).
//
// This test spans two packages on purpose, which is why it lives here rather
// than in @hc/engine: the engine must not depend on @hc/editor, and the bug
// existed precisely in the gap between them.
//
// Making masks render required giving `MaskNode.child` a SceneNode. That also
// made it hittable, and children are tested before the parent's own surface,
// so hitTest began returning the subject. `locate()` only descends `children`,
// so it could not find that node, and every store action opens with
// `const loc = locate(doc, id); if (!loc) return;`. The result was a selection
// that silently ignored move, style, and delete: the click appeared to work
// and nothing after it did.

import { describe, expect, it } from "vitest";
import { createScene } from "@hc/engine";
import { locate } from "@hc/editor";
import type { DesignFile, Node } from "@hc/schema";

const subject: Node = {
  id: "subject", type: "shape", shape: "rect",
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  size: { width: 100, height: 100 }, opacity: 1, blendMode: "normal",
  fills: [{ type: "solid", color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } }],
} as unknown as Node;

const file = (): DesignFile => ({
  schemaVersion: 19, id: "d", title: "t", assets: [], fonts: [], meta: {},
  pages: [{ id: "p1", width: 200, height: 200, children: [{
    id: "m", type: "mask",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 100, height: 100 }, opacity: 1, blendMode: "normal",
    maskShape: { fillRule: "nonzero", subpaths: [{ closed: true, anchors: [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] }] },
    child: subject,
  }] }],
} as unknown as DesignFile);

describe("clicking a masked object", () => {
  it("selects the mask itself", () => {
    expect(createScene(file(), 0).hitTest({ x: 50, y: 50 })?.id).toBe("m");
  });

  it("yields a node the editor can locate, so edits are not dropped", () => {
    const f = file();
    const hit = createScene(f, 0).hitTest({ x: 50, y: 50 });
    expect(hit).not.toBeNull();
    expect(locate(f, hit!.id)).not.toBeNull();
  });

  it("never yields the subject, which locate() cannot find", () => {
    // Guards the specific regression rather than the general property: if the
    // hit test is ever changed to return the subject again, the selection goes
    // dead in exactly the same silent way.
    const f = file();
    expect(locate(f, "subject")).toBeNull();
    expect(createScene(f, 0).hitTest({ x: 50, y: 50 })?.id).not.toBe("subject");
  });
});
