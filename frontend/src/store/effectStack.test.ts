// The effect-stack store actions (F40 FR-17).
//
// These address effects BY INDEX. The panel was previously built on
// find(kind)/has(kind), which caps a node at one effect per kind and cannot
// express order, so the cases worth pinning are the ones that were previously
// unreachable: two effects of the same kind, and reordering them.

import { beforeEach, describe, expect, it } from "vitest";
import { useEditor } from "./editor";
import type { Effect, Node } from "@hc/schema";

function shape(effects?: Effect[]): Node {
  return {
    id: "s1", type: "shape", shape: "rect",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 50, height: 50 }, opacity: 1, blendMode: "normal",
    fills: [{ type: "solid", color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } }],
    ...(effects ? { effects } : {}),
  } as unknown as Node;
}
function eff(): Effect[] {
  const st = useEditor.getState();
  const n = st.doc.pages[st.activePage].children.find((c) => c.id === "s1") as unknown as { effects?: Effect[] };
  return n.effects ?? [];
}
beforeEach(() => {
  const st = useEditor.getState();
  const p = st.doc.pages[st.activePage];
  p.children.length = 0;
  p.children.push(shape());
  useEditor.setState({ selection: ["s1"], undoStack: [], redoStack: [] });
});

describe("adding", () => {
  it("allows more than one effect of the same kind", () => {
    // Unreachable through the old per-kind buttons, and an ordinary thing to
    // want: two blurs at different radii.
    const st = useEditor.getState();
    st.addEffect("s1", "blur");
    st.addEffect("s1", "blur");
    expect(eff().filter((e) => e.kind === "blur")).toHaveLength(2);
  });

  it("refuses duotone, which is authored by its own control", () => {
    useEditor.getState().addEffect("s1", "duotone");
    expect(eff()).toHaveLength(0);
  });
});

describe("reordering", () => {
  it("moves an effect and is one undo step", () => {
    const st = useEditor.getState();
    st.addEffect("s1", "blur");
    st.addEffect("s1", "shadow");
    expect(eff().map((e) => e.kind)).toEqual(["blur", "shadow"]);

    st.moveEffect("s1", 1, 0);
    expect(eff().map((e) => e.kind)).toEqual(["shadow", "blur"]);

    useEditor.getState().undo();
    expect(eff().map((e) => e.kind)).toEqual(["blur", "shadow"]);
  });

  it("ignores out-of-range and no-op moves", () => {
    const st = useEditor.getState();
    st.addEffect("s1", "blur");
    const before = JSON.stringify(eff());
    st.moveEffect("s1", 0, 0);
    st.moveEffect("s1", 0, 5);
    st.moveEffect("s1", -1, 0);
    expect(JSON.stringify(eff())).toBe(before);
  });
});

describe("enabling", () => {
  it("switches off without losing the parameters", () => {
    const st = useEditor.getState();
    st.addEffect("s1", "blur");
    const radius = (eff()[0] as { radius: number }).radius;
    st.setEffectEnabled("s1", 0, false);
    expect(eff()[0].enabled).toBe(false);
    expect((eff()[0] as { radius: number }).radius).toBe(radius);
  });

  it("switching back on CLEARS the key rather than writing true", () => {
    // Absent means enabled, so a round trip must leave the document exactly as
    // a file that never touched the stack, not carrying `enabled: true` noise.
    const st = useEditor.getState();
    st.addEffect("s1", "blur");
    const pristine = JSON.stringify(eff());
    st.setEffectEnabled("s1", 0, false);
    st.setEffectEnabled("s1", 0, true);
    expect(JSON.stringify(eff())).toBe(pristine);
    expect("enabled" in eff()[0]).toBe(false);
  });
});

describe("removing", () => {
  it("removes by position, not by kind", () => {
    const st = useEditor.getState();
    st.addEffect("s1", "blur");
    st.addEffect("s1", "shadow");
    st.addEffect("s1", "blur");
    st.removeEffectAt("s1", 0);
    // The other blur survives: a kind-keyed remove would have taken both.
    expect(eff().map((e) => e.kind)).toEqual(["shadow", "blur"]);
  });

  it("clears the array entirely rather than leaving an empty one", () => {
    const st = useEditor.getState();
    st.addEffect("s1", "blur");
    st.removeEffectAt("s1", 0);
    const n = useEditor.getState().doc.pages[useEditor.getState().activePage].children[0] as unknown as { effects?: Effect[] };
    expect(n.effects).toBeUndefined();
  });
});
