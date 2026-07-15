import { describe, it, expect } from "vitest";
import {
  createBlankDesign,
  createNode,
  KNOWN_NODE_TYPES,
  type DesignFile,
  type Node,
  type NodeType,
} from "@hc/schema";
import {
  applyToPoint,
  applyTextCase,
  canvasFontString,
  computeEffectivePpi,
  createScene,
  defaultViewport,
  effectBleed,
  decompose,
  fit,
  fitRect,
  fromTransform,
  identity,
  invert,
  isLowResolution,
  multiply,
  resolveLineAdvance,
  weightFromFontStyle,
  mountRenderer,
  pageToScreen,
  render,
  renderScene,
  screenToPage,
  tilesForRegion,
  tileCountForRegion,
  transformRect,
  zoomTo,
  valueScale,
  seriesMax,
  categoryCount,
  groupedBarLayout,
  stackedBase,
  stackedMax,
  radarPoint,
  tickCount,
  type AssetProvider,
  type AssetStatus,
  type CanvasLike,
  type RenderTarget,
} from "../index";
import type { ImageNode } from "@hc/schema";

const constructable = KNOWN_NODE_TYPES.filter(
  (t) => t !== "model3d",
) as Exclude<NodeType, "model3d">[];

// A CanvasRenderingContext2D-compatible recording double: every draw op is
// logged with the alpha/composite/fill in effect, and save/restore are counted.
interface Op {
  op: string;
  alpha: number;
  comp: string;
  fill: string;
  filter: string;
  fillIsGradient: boolean;
  /** Recorded text for fillText/strokeText, for asserting label content. */
  text?: string;
  /** Recorded x for fillText, for asserting alignment. */
  x?: number;
}
const gradientStub = { addColorStop() {} };
class RecordingCtx implements CanvasLike {
  ops: Op[] = [];
  saves = 0;
  restores = 0;
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  fillStyle: string | typeof gradientStub = "#000";
  strokeStyle: string | typeof gradientStub = "#000";
  lineWidth = 1;
  font = "10px sans-serif";
  textAlign = "left";
  filter = "none";
  throwOnFillText = false;

  private rec(op: string, text?: string, x?: number) {
    this.ops.push({
      op,
      alpha: this.globalAlpha,
      comp: this.globalCompositeOperation,
      fill: typeof this.fillStyle === "string" ? this.fillStyle : "[gradient]",
      filter: this.filter,
      fillIsGradient: typeof this.fillStyle === "object",
      text,
      x,
    });
  }
  createLinearGradient() {
    return gradientStub;
  }
  createRadialGradient() {
    return gradientStub;
  }
  createConicGradient() {
    return gradientStub;
  }
  drawImage() {
    this.rec("drawImage");
  }
  save() {
    this.saves++;
  }
  restore() {
    this.restores++;
  }
  setTransform() {}
  transform() {}
  clearRect() {}
  fillRect() {
    this.rec("fillRect");
  }
  strokeRect() {
    this.rec("strokeRect");
  }
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {
    this.rec("lineTo");
  }
  bezierCurveTo() {
    this.rec("bezierCurveTo");
  }
  quadraticCurveTo() {
    this.rec("quadraticCurveTo");
  }
  rect() {}
  ellipse() {}
  arc() {
    this.rec("arc");
  }
  fill() {
    this.rec("fill");
  }
  stroke() {
    this.rec("stroke");
  }
  clip() {
    this.rec("clip");
  }
  fillText(text: string, x?: number) {
    if (this.throwOnFillText) throw new Error("boom");
    this.rec("fillText", text, x);
  }
  strokeText(text: string) {
    this.rec("strokeText", text);
  }
}

function target(ctx: CanvasLike): RenderTarget {
  return { kind: "node", context: "2d", ctx, width: 800, height: 600 };
}

function n(type: Exclude<NodeType, "model3d">, init?: Partial<Node>): Node {
  return createNode(type, init);
}

describe("affine math", () => {
  it("multiply by identity is a no-op", () => {
    const m = fromTransform({ x: 5, y: 7, scaleX: 2, scaleY: 3, rotation: 0 });
    expect(multiply(identity(), m)).toEqual(m);
  });

  it("decompose is the inverse of fromTransform (skew-free)", () => {
    const t = { x: 10, y: 20, scaleX: 2, scaleY: 3, rotation: 35 };
    const d = decompose(fromTransform(t));
    expect(d.x).toBeCloseTo(10, 6);
    expect(d.y).toBeCloseTo(20, 6);
    expect(d.scaleX).toBeCloseTo(2, 6);
    expect(d.scaleY).toBeCloseTo(3, 6);
    expect(d.rotation).toBeCloseTo(35, 6);
  });

  it("invert composed with original yields identity (point round-trip)", () => {
    const m = fromTransform({ x: 10, y: 20, scaleX: 2, scaleY: 2, rotation: 30 });
    const inv = invert(m)!;
    const p = { x: 13, y: -4 };
    const round = applyToPoint(inv, applyToPoint(m, p));
    expect(round.x).toBeCloseTo(p.x, 6);
    expect(round.y).toBeCloseTo(p.y, 6);
  });

  it("transformRect gives the AABB of a 90deg-rotated box", () => {
    const m = fromTransform({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 90 });
    const r = transformRect(m, { x: 0, y: 0, width: 10, height: 4 });
    expect(r.width).toBeCloseTo(4, 6);
    expect(r.height).toBeCloseTo(10, 6);
  });
});

describe("viewport (FR-3, FR-12)", () => {
  it("page<->screen round-trips", () => {
    const vp = { zoom: 2, panX: 50, panY: 30, dpr: 1, width: 800, height: 600 };
    const p = { x: 123, y: 456 };
    const round = screenToPage(vp, pageToScreen(vp, p));
    expect(round.x).toBeCloseTo(p.x, 6);
    expect(round.y).toBeCloseTo(p.y, 6);
  });

  it("1:1 sets zoom to 1; fit never exceeds the min axis scale", () => {
    const vp = defaultViewport(800, 600);
    expect(fit(vp, { width: 400, height: 300 }, "1:1").zoom).toBe(1);
    const fitV = fit(vp, { width: 1600, height: 1200 }, "fit");
    expect(fitV.zoom).toBeLessThanOrEqual(0.5);
  });

  it("zoomTo keeps the focal page-point fixed on screen", () => {
    const vp = defaultViewport(800, 600);
    const focal = { x: 200, y: 100 };
    const before = screenToPage(vp, focal);
    const after = zoomTo(vp, 3, focal);
    const afterPage = screenToPage(after, focal);
    expect(afterPage.x).toBeCloseTo(before.x, 6);
    expect(afterPage.y).toBeCloseTo(before.y, 6);
  });
});

describe("scene graph and bounds", () => {
  it("getBounds matches the transformed box; effect bleed enlarges it", () => {
    const design = createBlankDesign();
    const plain = n("shape", { id: "a", transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 40 } });
    design.pages[0].children = [plain];
    const b = createScene(design).getBounds("a")!;
    expect(b).toMatchObject({ x: 100, y: 100, width: 50, height: 40 });

    // A blur halo is ~3 standard deviations wide and `filter: blur(r)` uses r as
    // the std-dev, so a radius-8 blur bleeds ~24px past the box on each side.
    const blurred = n("shape", { id: "b", effects: [{ kind: "blur", radius: 8 }], transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 40 } });
    expect(effectBleed(blurred)).toBe(24);
    design.pages[0].children = [blurred];
    const bb = createScene(design).getBounds("b")!;
    expect(bb.x).toBe(76);
    expect(bb.width).toBe(98);
  });

  it("bounds include a glow's halo, a drop shadow's offset+blur, and a centered stroke's half-width (FR-27 culling)", () => {
    const design = createBlankDesign();
    // glow radius 10 renders as drop-shadow blur -> ~1.5 * radius = 15px halo.
    const glow = n("shape", { id: "g", effects: [{ kind: "glow", color: { srgb: { r: 1, g: 1, b: 1, a: 1 } }, radius: 10 }], transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 50 } });
    design.pages[0].children = [glow];
    const gb = createScene(design).getBounds("g")!;
    expect(gb.x).toBe(85); // 100 - 15
    expect(gb.width).toBe(80); // 50 + 2*15

    // drop shadow: |offset| + 1.5*blur + spread on the offset side.
    const shadow = n("shape", { id: "s", effects: [{ kind: "shadow", type: "drop", color: { srgb: { r: 0, g: 0, b: 0, a: 0.5 } }, offsetX: 4, offsetY: 0, blur: 6, spread: 0 }], transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 50 } });
    design.pages[0].children = [shadow];
    const sb = createScene(design).getBounds("s")!;
    expect(sb.width).toBe(76); // 50 + 2*(4 + 1.5*6) = 50 + 26

    // a centered stroke bleeds out half its width even with no effects.
    const stroked = n("shape", { id: "k", stroke: { fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }, width: 8, align: "center", cap: "round", join: "round" }, transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 50 } });
    design.pages[0].children = [stroked];
    const kb = createScene(design).getBounds("k")!;
    expect(kb.x).toBe(96); // 100 - 8/2
    expect(kb.width).toBe(58); // 50 + 2*4
  });
});

describe("hit-testing (FR-6, FR-7)", () => {
  function sceneWith(children: Node[]) {
    const d = createBlankDesign();
    d.pages[0].children = children;
    return createScene(d);
  }

  it("returns the node under the point and null over empty canvas", () => {
    const s = sceneWith([
      n("shape", { id: "s", transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 50 } }),
    ]);
    expect(s.hitTest({ x: 120, y: 120 })?.id).toBe("s");
    expect(s.hitTest({ x: 10, y: 10 })).toBeNull();
  });

  it("accounts for rotation", () => {
    const s = sceneWith([
      n("shape", { id: "r", transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 45 }, size: { width: 40, height: 40 } }),
    ]);
    // Just past the origin along the rotated axis is inside; far corner of the
    // unrotated box is now outside.
    expect(s.hitTest({ x: 100, y: 110 })?.id).toBe("r");
    expect(s.hitTest({ x: 139, y: 100 })).toBeNull();
  });

  it("descends into containers and returns the topmost child", () => {
    const child = n("shape", { id: "child", transform: { x: 10, y: 10, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 30, height: 30 } });
    const group = n("group", { id: "g", transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 200, height: 200 }, children: [child] });
    const s = sceneWith([group]);
    expect(s.hitTest({ x: 120, y: 120 })?.id).toBe("child");
  });

  it("respects true shape for an ellipse, and box when alpha is off", () => {
    const s = sceneWith([
      n("shape", { id: "e", shape: "ellipse", transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 100, height: 100 } } as Partial<Node>),
    ]);
    expect(s.hitTest({ x: 2, y: 2 })).toBeNull(); // corner: outside the ellipse
    expect(s.hitTest({ x: 2, y: 2 }, { alpha: false })?.id).toBe("e"); // inside the box
    expect(s.hitTest({ x: 50, y: 50 })?.id).toBe("e"); // center: inside
  });

  it("selects a connector by clicking its routed line (not the node's box)", () => {
    const s = sceneWith([
      n("sticky", { id: "a", transform: { x: 40, y: 140, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 120, height: 120 } } as Partial<Node>),
      n("sticky", { id: "b", transform: { x: 420, y: 140, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 120, height: 120 } } as Partial<Node>),
      n("connector", {
        id: "c",
        route: "elbow",
        start: { attach: { nodeId: "a", anchor: "auto" } },
        end: { attach: { nodeId: "b", anchor: "auto" } },
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        stroke: { fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }, width: 3, align: "center", cap: "round", join: "round" },
      } as Partial<Node>),
    ]);
    // Auto anchors resolve to a's right edge (160,200) and b's left edge (420,200):
    // a straight horizontal line at y=200 between them. A point ON it hits the connector.
    expect(s.hitTest({ x: 290, y: 200 })?.id).toBe("c");
    // A point off the line (and off both stickies) hits nothing - proving the
    // connector is not treated as a box at its own (origin) transform.
    expect(s.hitTest({ x: 290, y: 60 })).toBeNull();
    // Selection bounds follow the routed line (x 160..420 at y=200), NOT the
    // connector's origin box - so the selection indicator sits on the line.
    const cb = s.connectorBounds("c")!;
    expect(cb.x).toBeCloseTo(160);
    expect(cb.x + cb.width).toBeCloseTo(420);
    expect(cb.y).toBeCloseTo(200);
    expect(s.connectorBounds("a")).toBeNull(); // non-connector
  });

  it("hit-tests and bounds a connector along its WAYPOINT route, not the un-bent line (FR-8)", () => {
    const s = sceneWith([
      n("connector", {
        id: "wc",
        route: "straight",
        start: { point: { x: 100, y: 100 } },
        end: { point: { x: 300, y: 100 } },
        waypoints: [{ x: 200, y: 200 }], // a downward V via the bend
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        stroke: { fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }, width: 3, align: "center", cap: "round", join: "round" },
      } as Partial<Node>),
    ]);
    // A click near the bend hits; the midpoint of the un-bent a->b line (200,100)
    // is ~70px off the actual route and must NOT hit (proving waypoints are honored).
    expect(s.hitTest({ x: 200, y: 197 })?.id).toBe("wc");
    expect(s.hitTest({ x: 200, y: 100 })).toBeNull();
    // Bounds enclose the bend (y reaches 200), not just the endpoints' y=100.
    const cb = s.connectorBounds("wc")!;
    expect(cb.y + cb.height).toBeCloseTo(200);
  });

  it("skips locked nodes by default", () => {
    const s = sceneWith([
      n("shape", { id: "l", locked: true, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 50 } }),
    ]);
    expect(s.hitTest({ x: 10, y: 10 })).toBeNull();
    expect(s.hitTest({ x: 10, y: 10 }, { ignoreLocked: false })?.id).toBe("l");
  });

  it("hitTestRect intersect vs contain", () => {
    const s = sceneWith([
      n("shape", { id: "a", transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 50 } }),
      n("shape", { id: "b", transform: { x: 200, y: 200, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 50 } }),
    ]);
    const marquee = { x: -10, y: -10, width: 80, height: 80 };
    expect(s.hitTestRect(marquee, "intersect").map((x) => x.id)).toEqual(["a"]);
    expect(s.hitTestRect(marquee, "contain").map((x) => x.id)).toEqual(["a"]);
    const partial = { x: 25, y: 25, width: 100, height: 100 };
    expect(s.hitTestRect(partial, "intersect").map((x) => x.id)).toEqual(["a"]);
    expect(s.hitTestRect(partial, "contain")).toEqual([]); // overlaps but not contained
  });
});

describe("dirty-rect tiling (FR-4, AC-5)", () => {
  it("markDirty unions the node region and only its tiles repaint", () => {
    const d = createBlankDesign({ width: 2048, height: 2048 });
    d.pages[0].children = [
      n("shape", { id: "x", transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 50 } }),
    ];
    const s = createScene(d);
    expect(s.dirtyRegion()).toBeNull();
    s.markDirty("x");
    const region = s.dirtyRegion()!;
    expect(region).toMatchObject({ x: 100, y: 100, width: 50, height: 50 });

    const nodeTiles = tileCountForRegion(region, 256, 1);
    const pageTiles = tileCountForRegion({ x: 0, y: 0, width: 2048, height: 2048 }, 256, 1);
    expect(nodeTiles).toBe(1);
    expect(pageTiles).toBe(64);
    expect(nodeTiles).toBeLessThan(pageTiles); // repaint scales with change, not scene
  });

  it("tilesForRegion respects half-open tile boundaries", () => {
    expect(tilesForRegion({ x: 0, y: 0, width: 256, height: 256 }, 256, 1)).toHaveLength(1);
    expect(tilesForRegion({ x: 0, y: 0, width: 300, height: 300 }, 256, 1)).toHaveLength(4);
  });
});

describe("Canvas2D render path (FR-1, FR-2, FR-5, AC-1)", () => {
  function designAllNodes(): DesignFile {
    const d = createBlankDesign();
    d.pages[0].children = constructable.map((t, i) => n(t, { id: `n${i}` }));
    return d;
  }

  it("renders one of every node type without error, balanced save/restore", () => {
    const ctx = new RecordingCtx();
    const scene = createScene(designAllNodes());
    expect(() => renderScene(scene, ctx, defaultViewport(800, 600))).not.toThrow();
    expect(ctx.saves).toBe(ctx.restores);
    expect(ctx.saves).toBe(constructable.length);
  });

  it("draws an inert placeholder for an unknown node type (FR-2)", () => {
    const d = createBlankDesign();
    d.pages[0].children = [
      { id: "u", type: "hologram", transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 10, height: 10 }, opacity: 1, blendMode: "normal" } as unknown as Node,
    ];
    const ctx = new RecordingCtx();
    renderScene(createScene(d), ctx, defaultViewport(800, 600));
    expect(ctx.ops.some((o) => o.op === "fillRect")).toBe(true);
  });

  it("culls off-screen leaf nodes; cull:false paints them all (FR-27)", () => {
    const d = createBlankDesign();
    d.pages[0].background = undefined;
    d.pages[0].children = [
      n("shape", { id: "in", transform: { x: 10, y: 10, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 50 } }),
      n("shape", { id: "far", transform: { x: 100000, y: 100000, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 50 } }),
    ];
    const scene = createScene(d);
    const vp = defaultViewport(800, 600); // page rect 0..800 x 0..600 at zoom 1
    const culled = new RecordingCtx();
    renderScene(scene, culled, vp);
    expect(culled.saves).toBe(1); // only the in-view shape painted
    const all = new RecordingCtx();
    renderScene(scene, all, vp, { cull: false });
    expect(all.saves).toBe(2); // culling off -> both painted
  });

  it("skips nodes in opts.hiddenIds (private-mode visual hide, FR-15)", () => {
    const d = createBlankDesign();
    d.pages[0].background = undefined;
    d.pages[0].children = [
      n("shape", { id: "mine", transform: { x: 10, y: 10, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 50 } }),
      n("shape", { id: "theirs", transform: { x: 80, y: 10, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 50 } }),
    ];
    const ctx = new RecordingCtx();
    renderScene(createScene(d), ctx, defaultViewport(800, 600), { hiddenIds: new Set(["theirs"]) });
    expect(ctx.saves).toBe(1); // the hidden node is not painted; the other is
  });

  it("queryViewport returns only leaves intersecting the rect (FR-27)", () => {
    const d = createBlankDesign();
    d.pages[0].children = [
      n("shape", { id: "in", transform: { x: 10, y: 10, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 50 } }),
      n("shape", { id: "far", transform: { x: 5000, y: 5000, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 50 } }),
    ];
    const scene = createScene(d);
    expect(scene.queryViewport({ x: 0, y: 0, width: 800, height: 600 }).map((nn) => nn.id)).toEqual(["in"]);
  });

  it("draws an emoji/vote stamp's glyph centered (FR-21)", () => {
    const d = createBlankDesign();
    d.pages[0].background = undefined;
    d.pages[0].children = [
      n("stamp", {
        id: "st",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 40, height: 40 },
        kind: "vote",
        glyph: "🔥",
      } as unknown as Partial<Node>),
    ];
    const ctx = new RecordingCtx();
    renderScene(createScene(d), ctx, defaultViewport(800, 600));
    expect(ctx.ops.some((o) => o.op === "fillText" && o.text === "🔥")).toBe(true);
  });

  it("draws an ink stroke as a filled ribbon and multiplies a highlighter (FR-5)", () => {
    const d = createBlankDesign();
    d.pages[0].background = undefined;
    const pen = n("ink", {
      id: "ink-pen",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      points: [{ x: 0, y: 0, p: 0.2 }, { x: 20, y: 10, p: 0.9 }, { x: 40, y: 5, p: 0.5 }],
      smoothing: 0.5,
      brush: { width: 8, opacity: 1, color: { srgb: { r: 0, g: 0, b: 0, a: 1 } }, mode: "pen" },
    });
    const hl = n("ink", {
      id: "ink-hl",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      points: [{ x: 0, y: 0 }, { x: 30, y: 0 }],
      smoothing: 0.5,
      brush: { width: 16, opacity: 0.4, color: { srgb: { r: 1, g: 0.9, b: 0, a: 1 } }, mode: "highlighter" },
    });
    d.pages[0].children = [pen, hl];
    const ctx = new RecordingCtx();
    expect(() => renderScene(createScene(d), ctx, defaultViewport(800, 600))).not.toThrow();
    // The ribbon is filled, and the highlighter fill ran under "multiply" at <1 alpha.
    expect(ctx.ops.some((o) => o.op === "fill")).toBe(true);
    const hlFill = ctx.ops.find((o) => o.op === "fill" && o.comp === "multiply");
    expect(hlFill).toBeTruthy();
    expect(hlFill!.alpha).toBeCloseTo(0.4, 6);
    // The composite op is restored afterwards (no leak to later nodes).
    expect(ctx.globalCompositeOperation).toBe("source-over");
    expect(ctx.saves).toBe(ctx.restores);
  });

  it("routes a connector through waypoints and draws its label (FR-8)", () => {
    const d = createBlankDesign();
    d.pages[0].background = undefined;
    const conn = n("connector", {
      id: "cn",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      route: "straight",
      start: { point: { x: 0, y: 0 } },
      end: { point: { x: 200, y: 0 } },
      waypoints: [{ x: 60, y: 40 }, { x: 120, y: -30 }],
      label: { text: "approves", position: 0.5 },
    });
    d.pages[0].children = [conn];
    const ctx = new RecordingCtx();
    renderScene(createScene(d), ctx, defaultViewport(800, 600));
    // The polyline visited both waypoints (3 segments => at least 3 lineTo).
    expect(ctx.ops.filter((o) => o.op === "lineTo").length).toBeGreaterThanOrEqual(3);
    // The label text was drawn along the route.
    expect(ctx.ops.some((o) => o.op === "fillText" && o.text === "approves")).toBe(true);
  });

  it("multiplies opacity through nesting and applies blend mode", () => {
    const child = n("shape", { id: "c", opacity: 0.5, blendMode: "multiply", transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 10, height: 10 } });
    const group = n("group", { id: "g", opacity: 0.5, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: 50, height: 50 }, children: [child] });
    const d = createBlankDesign();
    d.pages[0].background = undefined; // focus on node ops, not the page fill
    d.pages[0].children = [group];
    const ctx = new RecordingCtx();
    renderScene(createScene(d), ctx, defaultViewport(800, 600));
    const fillOp = ctx.ops.find((o) => o.op === "fillRect");
    expect(fillOp?.alpha).toBeCloseTo(0.25, 6); // 0.5 * 0.5
    expect(fillOp?.comp).toBe("multiply");
  });

  it("isolates a node that throws during draw and reports it (Section 5)", () => {
    const d = createBlankDesign();
    d.pages[0].children = [
      n("text", {
        id: "t",
        content: [
          {
            runs: [
              {
                text: "hi",
                style: {
                  fontFamily: "system",
                  fontStyle: "Regular",
                  fontSize: 12,
                  fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } },
                },
              },
            ],
            style: { align: "left", direction: "auto" },
          },
        ],
      } as Partial<Node>),
    ];
    const ctx = new RecordingCtx();
    ctx.throwOnFillText = true;
    const errors: string[] = [];
    expect(() =>
      renderScene(createScene(d), ctx, defaultViewport(800, 600), {
        onError: (_e, id) => errors.push(id),
      }),
    ).not.toThrow();
    expect(errors).toEqual(["t"]);
    expect(ctx.ops.some((o) => o.op === "fillRect")).toBe(true); // placeholder drawn
  });

  it("keeps per-run colors on a center-aligned line (no single-style collapse)", () => {
    const d = createBlankDesign();
    const mk = (text: string, r: number, b: number) => ({
      text,
      style: {
        fontFamily: "system",
        fontStyle: "Regular",
        fontSize: 12,
        fill: { type: "solid", color: { srgb: { r, g: 0, b, a: 1 } } },
      },
    });
    d.pages[0].children = [
      n("text", {
        id: "t",
        content: [{ runs: [mk("Red ", 1, 0), mk("Blue", 0, 1)], style: { align: "center", direction: "auto" } }],
      } as Partial<Node>),
    ];
    const ctx = new RecordingCtx();
    renderScene(createScene(d), ctx, defaultViewport(800, 600));
    const textFills = new Set(ctx.ops.filter((o) => o.op === "fillText").map((o) => o.fill));
    expect(textFills.size).toBeGreaterThan(1); // both run colors emitted, not just the first
  });

  it("centers a tabbed line by the tab's true advance, not ~0", () => {
    // No measureText on the recording ctx, so widths are deterministic:
    // char = fontSize*0.55 = 11; a tab from x=11 jumps to the default stop
    // (em*4 = 80), so "a\tb" is 11 + 69 + 11 = 91 wide. Centered in a 400-wide
    // box => startX = (400-91)/2 = 154.5. (Before the fix the tab measured ~0,
    // giving width 22 and a wrong startX of ~189.)
    const d = createBlankDesign();
    const style = { fontFamily: "system", fontStyle: "Regular", fontSize: 20, fill: { type: "solid" as const, color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } } };
    d.pages[0].children = [
      n("text", {
        id: "t",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 400, height: 80 },
        box: { mode: "fixed", width: 400, height: 80, padding: { t: 0, r: 0, b: 0, l: 0 }, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "top" },
        content: [{ runs: [{ text: "a\tb", style }], style: { align: "center", direction: "auto" } }],
      } as Partial<Node>),
    ];
    const ctx = new RecordingCtx();
    renderScene(createScene(d), ctx, defaultViewport(800, 600));
    const aOp = ctx.ops.find((o) => o.op === "fillText" && o.text === "a");
    expect(aOp).toBeTruthy();
    expect(aOp!.x).toBeCloseTo(154.5, 1);
  });

  it("parses an SVG path and clips a custom-mask frame to it (scaled to the box)", () => {
    const d = createBlankDesign();
    d.pages[0].children = [
      n("frame", {
        id: "f",
        clip: true,
        maskShape: "custom",
        maskPath: "M50 0 L100 50 L50 100 L0 50 Z", // a diamond
        size: { width: 200, height: 200 },
        fills: [{ type: "solid", color: { srgb: { r: 0.5, g: 0.5, b: 0.5, a: 1 } } }],
      } as Partial<Node>),
    ];
    const ctx = new RecordingCtx();
    // moveTo/lineTo/clip should be exercised without throwing.
    expect(() => renderScene(createScene(d), ctx, defaultViewport(400, 400))).not.toThrow();
    expect(ctx.ops.some((o) => o.op === "lineTo")).toBe(true); // diamond edges built
  });

  it("strokes glyphs for text with an outline effect (and skips the box outline)", () => {
    const d = createBlankDesign();
    d.pages[0].children = [
      n("text", {
        id: "t",
        effects: [{ kind: "outline", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } }, width: 3 }],
        content: [{ runs: [{ text: "Hi", style: { fontFamily: "system", fontStyle: "Regular", fontSize: 40, fill: { type: "solid", color: { srgb: { r: 1, g: 1, b: 1, a: 1 } } } } }], style: { align: "left", direction: "auto" } }],
      } as Partial<Node>),
    ];
    const ctx = new RecordingCtx();
    renderScene(createScene(d), ctx, defaultViewport(400, 400));
    expect(ctx.ops.some((o) => o.op === "strokeText")).toBe(true); // glyph outline drawn
    expect(ctx.ops.some((o) => o.op === "strokeRect")).toBe(false); // not the box outline
  });

  it("keeps text effects when the text is curved (arc flow)", () => {
    const d = createBlankDesign();
    d.pages[0].children = [
      n("text", {
        id: "t",
        flow: { kind: "arc", curvature: 1 },
        textEffects: [
          { kind: "echo", offset: 4, count: 2, color: { type: "solid", color: { srgb: { r: 0, g: 0, b: 1, a: 1 } } } },
          { kind: "hollow", thickness: 2 },
          { kind: "highlight", color: { type: "solid", color: { srgb: { r: 1, g: 1, b: 0, a: 1 } } }, padding: 2, radius: 4 },
        ],
        content: [{ runs: [{ text: "Arc", style: { fontFamily: "system", fontStyle: "Regular", fontSize: 40, fill: { type: "solid", color: { srgb: { r: 1, g: 1, b: 1, a: 1 } } } } }], style: { align: "left", direction: "auto" } }],
      } as Partial<Node>),
    ];
    const ctx = new RecordingCtx();
    renderScene(createScene(d), ctx, defaultViewport(400, 400));
    // Hollow strokes each of the 3 glyphs; echo adds 2 offset fills per glyph
    // (hollow suppresses the base fill); the highlight band strokes an arc.
    expect(ctx.ops.filter((o) => o.op === "strokeText").length).toBe(3);
    expect(ctx.ops.filter((o) => o.op === "fillText").length).toBe(6);
    expect(ctx.ops.some((o) => o.op === "arc")).toBe(true);
    expect(ctx.ops.some((o) => o.op === "stroke")).toBe(true);
  });

  it("one-shot render() and a mounted renderer both paint and convert coords", () => {
    const scene = createScene(designAllNodes());
    const ctx = new RecordingCtx();
    expect(() => render(scene, target(ctx))).not.toThrow();

    const r = mountRenderer(scene, target(ctx), { preferGpu: false });
    r.fit("1:1");
    let frames = 0;
    r.on("frame", () => frames++);
    r.renderFrame();
    expect(frames).toBe(1);
    const round = r.screenToPage(r.pageToScreen({ x: 5, y: 9 }));
    expect(round.x).toBeCloseTo(5, 6);
    r.dispose();
  });

  it("setViewport ignores a non-positive zoom so coordinates stay finite", () => {
    const scene = createScene(designAllNodes());
    const r = mountRenderer(scene, target(new RecordingCtx()), { preferGpu: false });
    r.setViewport({ zoom: 1 });
    r.setViewport({ zoom: 0 }); // guarded: keeps the prior valid zoom
    expect(r.getViewport().zoom).toBe(1);
    expect(Number.isFinite(r.screenToPage({ x: 100, y: 100 }).x)).toBe(true);
  });
});

describe("effect painting (FR-5)", () => {
  function renderOne(node: Node) {
    const d = createBlankDesign();
    d.pages[0].background = undefined; // focus on node ops, not the page fill
    d.pages[0].children = [node];
    const ctx = new RecordingCtx();
    renderScene(createScene(d), ctx, defaultViewport(800, 600));
    return ctx;
  }

  it("applies blur + drop-shadow as a CSS filter while painting the node", () => {
    const ctx = renderOne(
      n("shape", {
        id: "s",
        effects: [
          { kind: "blur", radius: 4 },
          { kind: "shadow", type: "drop", color: { srgb: { r: 0, g: 0, b: 0, a: 0.5 } }, offsetX: 2, offsetY: 3, blur: 5, spread: 0 },
        ],
      } as Partial<Node>),
    );
    const drawOp = ctx.ops.find((o) => o.op === "fillRect");
    expect(drawOp?.filter).toContain("blur(4px)");
    expect(drawOp?.filter).toContain("drop-shadow(2px 3px 5px");
    // Filter is cleared after the node's own content so children aren't re-filtered.
    expect(ctx.filter).toBe("none");
  });

  it("strokes an outline effect around the node box", () => {
    const ctx = renderOne(
      n("shape", { id: "o", effects: [{ kind: "outline", color: { srgb: { r: 1, g: 0, b: 0, a: 1 } }, width: 3 }] } as Partial<Node>),
    );
    expect(ctx.ops.some((o) => o.op === "strokeRect")).toBe(true);
  });
});

describe("image placement math (F08)", () => {
  it("computeEffectivePpi: 600x400 at 8in on a 300dpi page is 75 PPI (AC-5)", () => {
    const d = createBlankDesign({ unit: "in", dpi: 300, width: 20, height: 20 });
    const img = n("image", {
      id: "i",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 8, height: 8 * (400 / 600) },
      source: { assetId: "a", naturalWidth: 600, naturalHeight: 400 },
    } as Partial<Node>) as ImageNode;
    expect(computeEffectivePpi(img, d)).toBeCloseTo(75, 4);
    expect(isLowResolution(img, d)).toBe(true); // < 150 print threshold
  });

  it("fitRect: contain letterboxes, cover crops via focal, none centers", () => {
    const contain = fitRect(200, 100, 100, 100, "contain");
    expect(contain.dest).toEqual({ x: 0, y: 25, width: 100, height: 50 });
    const cover = fitRect(200, 100, 100, 100, "cover", { x: 0.5, y: 0.5 });
    expect(cover.dest).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(cover.source.width).toBeCloseTo(0.5, 6);
    expect(cover.source.x).toBeCloseTo(0.25, 6);
    const none = fitRect(50, 50, 100, 100, "none");
    expect(none.dest).toEqual({ x: 25, y: 25, width: 50, height: 50 });
  });
});

describe("deterministic frame state", () => {
  it("resets a dirty incoming context so the page background is unfiltered at full alpha", () => {
    const d = createBlankDesign();
    d.pages[0].background = { type: "solid", color: { srgb: { r: 1, g: 1, b: 1, a: 1 } } };
    d.pages[0].children = [];
    const ctx = new RecordingCtx();
    ctx.filter = "blur(9px)"; // leftover dirty state from a hypothetical prior caller
    ctx.globalAlpha = 0.2;
    ctx.globalCompositeOperation = "multiply";
    renderScene(createScene(d), ctx, defaultViewport(800, 600));
    const bg = ctx.ops.find((o) => o.op === "fillRect");
    expect(bg?.filter).toBe("none");
    expect(bg?.alpha).toBe(1);
    expect(bg?.comp).toBe("source-over");
  });
});

describe("gradient fills", () => {
  it("paints a linear-gradient fill with a CanvasGradient, not a flat color", () => {
    const d = createBlankDesign();
    d.pages[0].background = undefined; // focus on the gradient node fill
    d.pages[0].children = [
      n("shape", {
        id: "g",
        shape: "rect",
        fills: [
          {
            type: "gradient",
            gradient: "linear",
            angle: 90,
            stops: [
              { position: 0, color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } },
              { position: 1, color: { srgb: { r: 0, g: 0, b: 1, a: 1 } } },
            ],
          },
        ],
      } as Partial<Node>),
    ];
    const ctx = new RecordingCtx();
    renderScene(createScene(d), ctx, defaultViewport(800, 600));
    const fillOp = ctx.ops.find((o) => o.op === "fillRect");
    expect(fillOp?.fillIsGradient).toBe(true);
  });
});

describe("asset/font readiness (FR-11)", () => {
  class FakeAssets implements AssetProvider {
    statuses = new Map<string, AssetStatus>();
    images = new Map<string, unknown>();
    private cbs: ((id: string) => void)[] = [];
    status(id: string): AssetStatus {
      return this.statuses.get(id) ?? "loading";
    }
    image(id: string): unknown | null {
      return this.images.get(id) ?? null;
    }
    onChange(cb: (id: string) => void): () => void {
      this.cbs.push(cb);
      return () => {
        this.cbs = this.cbs.filter((c) => c !== cb);
      };
    }
    fire(id: string) {
      for (const cb of this.cbs) cb(id);
    }
  }

  function imageDesign(): DesignFile {
    const d = createBlankDesign();
    d.pages[0].background = undefined; // focus on the image placeholder fill
    d.pages[0].children = [
      n("image", {
        id: "img",
        transform: { x: 10, y: 20, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 40, height: 30 },
        source: { assetId: "asset-1", naturalWidth: 0, naturalHeight: 0 },
      } as Partial<Node>),
    ];
    return d;
  }

  it("draws the image when its asset is ready", () => {
    const assets = new FakeAssets();
    assets.statuses.set("asset-1", "ready");
    assets.images.set("asset-1", { fake: true });
    const ctx = new RecordingCtx();
    renderScene(createScene(imageDesign()), ctx, defaultViewport(800, 600), { assets });
    expect(ctx.ops.some((o) => o.op === "drawImage")).toBe(true);
  });

  it("shows a neutral placeholder while loading and a missing placeholder when dangling", () => {
    const loading = new FakeAssets();
    loading.statuses.set("asset-1", "loading");
    const c1 = new RecordingCtx();
    renderScene(createScene(imageDesign()), c1, defaultViewport(800, 600), { assets: loading });
    expect(c1.ops.find((o) => o.op === "fillRect")?.fill).toBe("rgba(0, 0, 0, 0.06)");

    const missing = new FakeAssets();
    missing.statuses.set("asset-1", "missing");
    const c2 = new RecordingCtx();
    renderScene(createScene(imageDesign()), c2, defaultViewport(800, 600), { assets: missing });
    expect(c2.ops.find((o) => o.op === "fillRect")?.fill).toBe("rgba(220, 38, 38, 0.10)");
  });

  it("invalidates only the referencing node's region and emits 'asset' when it resolves", () => {
    const assets = new FakeAssets();
    assets.statuses.set("asset-1", "loading");
    const scene = createScene(imageDesign());
    const r = mountRenderer(scene, target(new RecordingCtx()), { preferGpu: false }, assets);
    r.renderFrame(); // clears dirty
    expect(scene.dirtyRegion()).toBeNull();

    const events: unknown[] = [];
    r.on("asset", (e) => events.push(e));
    assets.statuses.set("asset-1", "ready");
    assets.fire("asset-1");

    expect(events).toEqual([{ assetId: "asset-1", nodeIds: ["img"] }]);
    const region = scene.dirtyRegion()!;
    expect(region).toMatchObject({ x: 10, y: 20, width: 40, height: 30 });
    r.dispose();
  });
});

describe("font helpers", () => {
  it("builds a canvas font string honoring family, weight, italic", () => {
    expect(canvasFontString({ fontFamily: "Inter", fontStyle: "Bold", fontSize: 24 }))
      .toBe('700 24px "Inter", system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif');
    expect(canvasFontString({ fontFamily: "system", fontStyle: "Italic", fontSize: 16 }))
      .toMatch(/^italic 400 16px system-ui/);
    // explicit variable axis overrides the named style weight
    expect(canvasFontString({ fontFamily: "Inter", fontStyle: "Regular", fontSize: 12, axes: { wght: 550 } }))
      .toContain("550 12px");
  });
  it("maps named weights and resolves line advance", () => {
    expect(weightFromFontStyle("SemiBold")).toBe(600);
    expect(weightFromFontStyle("Bold Italic")).toBe(700);
    expect(weightFromFontStyle(undefined)).toBe(400);
    expect(resolveLineAdvance(20, undefined)).toBe(24); // 1.2 default
    expect(resolveLineAdvance(20, 1.5)).toBe(30);
    expect(resolveLineAdvance(20, { mode: "absolute", value: 40 })).toBe(40);
  });
  it("applies case transforms", () => {
    expect(applyTextCase("hello", "upper")).toBe("HELLO");
    expect(applyTextCase("HELLO", "lower")).toBe("hello");
    expect(applyTextCase("hello world", "title")).toBe("Hello World");
    expect(applyTextCase("keep", "none")).toBe("keep");
  });
});

describe("vector path rendering", () => {
  function renderNode(node: Node): RecordingCtx {
    const d = createBlankDesign();
    d.pages[0].children = [node];
    const ctx = new RecordingCtx();
    renderScene(createScene(d), ctx, { zoom: 1, panX: 0, panY: 0, dpr: 1, width: 400, height: 400 });
    return ctx;
  }
  it("draws straight segments with lineTo when there are no handles", () => {
    const p = n("path", { segments: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }], closed: false, fills: [{ type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }] });
    const ops = renderNode(p).ops.map((o) => o.op);
    expect(ops).toContain("lineTo");
    expect(ops).not.toContain("bezierCurveTo");
  });
  it("uses bezierCurveTo when an anchor carries a handle", () => {
    const p = n("path", {
      segments: [{ x: 0, y: 0, cOut: { x: 20, y: -20 } }, { x: 60, y: 0, cIn: { x: 40, y: -20 } }],
      closed: false,
      fills: [{ type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }],
    });
    const ops = renderNode(p).ops.map((o) => o.op);
    expect(ops).toContain("bezierCurveTo");
  });
});

describe("boolean node rendering", () => {
  it("renders the result subpaths and fills them", () => {
    const d = createBlankDesign();
    d.pages[0].children = [
      n("boolean", {
        op: "union",
        operands: [],
        result: { fillRule: "nonzero", subpaths: [{ closed: true, anchors: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }] }] },
        fills: [{ type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }],
      }),
    ];
    const ctx = new RecordingCtx();
    renderScene(createScene(d), ctx, { zoom: 1, panX: 0, panY: 0, dpr: 1, width: 400, height: 400 });
    const ops = ctx.ops.map((o) => o.op);
    expect(ops).toContain("lineTo");
    expect(ops).toContain("fill");
  });
});

describe("chart/table rendering with data", () => {
  function paintNode(node: Node): RecordingCtx {
    const d = createBlankDesign();
    d.pages[0].children = [node];
    const ctx = new RecordingCtx();
    renderScene(createScene(d), ctx, { zoom: 1, panX: 0, panY: 0, dpr: 1, width: 400, height: 400 });
    return ctx;
  }
  it("bar chart draws bars and a baseline", () => {
    const node = n("chart", { chartType: "bar", categories: ["A", "B"], series: [{ name: "s", values: [5, 10] }], options: {}, size: { width: 200, height: 120 } });
    const ops = paintNode(node).ops.map((o) => o.op);
    expect(ops).toContain("fillRect"); // bars
    expect(ops).toContain("stroke"); // baseline
  });
  it("table draws cell fills, text, and grid lines", () => {
    const node = n("table", {
      rows: 1, cols: 2, colWidths: [60, 60], rowHeights: [30],
      cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, align: "left", fill: { type: "solid", color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } }, content: [{ text: "Hi", fontId: "system", fontSize: 12, weight: 400 }] }],
      size: { width: 120, height: 30 },
    });
    const ops = paintNode(node).ops.map((o) => o.op);
    expect(ops).toContain("fillRect"); // cell fill
    expect(ops).toContain("fillText"); // cell text
    expect(ops).toContain("stroke"); // grid
  });
  it("a header-styled table fills the first row and draws header text", () => {
    const node = n("table", {
      rows: 2, cols: 1, colWidths: [60], rowHeights: [30, 30],
      cells: [
        { row: 0, col: 0, rowSpan: 1, colSpan: 1, align: "left", content: [{ text: "H", fontId: "system", fontSize: 12, weight: 400 }] },
        { row: 1, col: 0, rowSpan: 1, colSpan: 1, align: "left", content: [{ text: "x", fontId: "system", fontSize: 12, weight: 400 }] },
      ],
      headerStyle: { enabled: true, bold: true, fill: { type: "solid", color: { srgb: { r: 0.9, g: 0.9, b: 0.9, a: 1 } } } },
      size: { width: 60, height: 60 },
    });
    const ops = paintNode(node).ops.map((o) => o.op);
    expect(ops).toContain("fillRect"); // header fill
    expect(ops).toContain("fillText");
  });
  it("borderStyle.show=false suppresses the grid stroke", () => {
    const node = n("table", {
      rows: 1, cols: 1, colWidths: [60], rowHeights: [30],
      cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, align: "left", content: [] }],
      borderStyle: { show: false },
      size: { width: 60, height: 30 },
    });
    const ops = paintNode(node).ops.map((o) => o.op);
    expect(ops).not.toContain("stroke");
  });
  it("scatter chart plots points (filled markers + baseline)", () => {
    const node = n("chart", { chartType: "scatter", categories: ["A", "B", "C"], series: [{ name: "s", values: [5, 10, 3] }], options: {}, size: { width: 200, height: 120 } });
    const ops = paintNode(node).ops.map((o) => o.op);
    expect(ops).toContain("fill"); // ellipse markers
    expect(ops).toContain("stroke"); // baseline axis
  });
  it("radar chart strokes the axis web and series polygon", () => {
    const node = n("chart", { chartType: "radar", categories: ["A", "B", "C"], series: [{ name: "s", values: [5, 10, 3] }], options: {}, size: { width: 200, height: 200 } });
    const ops = paintNode(node).ops.map((o) => o.op);
    expect(ops).toContain("stroke");
  });
  it("a chart title and legend render as native text", () => {
    const node = n("chart", { chartType: "bar", categories: ["A"], series: [{ name: "Sales", values: [5] }], options: {}, style: { title: "Q1", legend: { show: true, position: "bottom" } }, size: { width: 200, height: 120 } });
    const ops = paintNode(node).ops.map((o) => o.op);
    expect(ops).toContain("fillText"); // title + legend label
  });
});

describe("connector rendering", () => {
  // Two boxes plus a connector attached to both; render and inspect the ops.
  function paintConnector(route: "straight" | "elbow" | "curved", caps?: { startCap?: { kind: string; size: number }; endCap?: { kind: string; size: number } }): RecordingCtx {
    const a = createNode("sticky", { id: "a", size: { width: 100, height: 100 }, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } } as Partial<Node>);
    const b = createNode("sticky", { id: "b", size: { width: 100, height: 100 }, transform: { x: 400, y: 200, scaleX: 1, scaleY: 1, rotation: 0 } } as Partial<Node>);
    const conn = createNode("connector", {
      id: "c",
      route,
      start: { attach: { nodeId: "a", anchor: "auto" } },
      end: { attach: { nodeId: "b", anchor: "auto" } },
      ...(caps ?? {}),
    } as Partial<Node>);
    const d = createBlankDesign();
    d.pages[0].children = [a, b, conn];
    const ctx = new RecordingCtx();
    renderScene(createScene(d), ctx, { zoom: 1, panX: 0, panY: 0, dpr: 1, width: 800, height: 400 });
    return ctx;
  }

  it("draws a stroked polyline between two attached boxes (not a placeholder)", () => {
    const ops = paintConnector("elbow").ops.map((o) => o.op);
    expect(ops).toContain("lineTo"); // routed segments
    expect(ops).toContain("stroke"); // the line itself
    // A connector with resolved endpoints must NOT fall back to a placeholder box.
    expect(ops).not.toContain("strokeRect");
  });

  it("a curved route uses a quadratic curve when available", () => {
    const ops = paintConnector("curved").ops.map((o) => o.op);
    expect(ops).toContain("quadraticCurveTo");
    expect(ops).toContain("stroke");
  });

  it("an arrow end cap draws a filled wedge", () => {
    const ops = paintConnector("straight", { endCap: { kind: "arrow", size: 10 } }).ops.map((o) => o.op);
    expect(ops).toContain("stroke"); // the line
    expect(ops).toContain("fill"); // the arrowhead
  });
});

describe("chart layout/scale helpers", () => {
  const series = [
    { name: "s1", values: [10, 20, 0] },
    { name: "s2", values: [5, 5, 30] },
  ];
  it("seriesMax is the largest value across all series", () => {
    expect(seriesMax(series)).toBe(30);
  });
  it("categoryCount is the larger of categories and the longest series", () => {
    expect(categoryCount(["a", "b"], series)).toBe(3);
    expect(categoryCount(["a", "b", "c", "d"], series)).toBe(4);
  });
  it("valueScale maps the data domain onto pixels with a zero baseline", () => {
    const scale = valueScale(series.map((s) => s.values), 100);
    expect(scale(0)).toBe(0);
    expect(scale(30)).toBe(100);
    expect(scale(15)).toBe(50);
  });
  it("valueScale never divides by zero on an all-zero domain", () => {
    const scale = valueScale([[0, 0]], 100);
    expect(scale(0)).toBe(0);
    expect(Number.isFinite(scale(5))).toBe(true);
  });
  it("groupedBarLayout splits each category slot across series without overlap", () => {
    const a = groupedBarLayout(120, 3, 2, 1, 0); // slot 1, series 0
    const b = groupedBarLayout(120, 3, 2, 1, 1); // slot 1, series 1
    expect(b.x).toBeGreaterThan(a.x);
    expect(a.x + a.width).toBeLessThanOrEqual(b.x + 1e-9);
    expect(a.width).toBeCloseTo(b.width);
  });
  it("stackedBase accumulates the series below and stackedMax is the tallest stack", () => {
    expect(stackedBase(series, 2, 0)).toBe(0);
    expect(stackedBase(series, 2, 1)).toBe(0); // series 0 value at cat 2 is 0
    expect(stackedBase(series, 0, 1)).toBe(10); // series 0 value at cat 0
    expect(stackedMax(series, 3)).toBe(30); // cat 2: 0 + 30
  });
  it("radarPoint places axis 0 at the top and scales radius by value", () => {
    const top = radarPoint(50, 50, 40, 0, 4, 10, 10); // full radius, top
    expect(top.x).toBeCloseTo(50);
    expect(top.y).toBeCloseTo(10); // cy - radius
    const center = radarPoint(50, 50, 40, 0, 4, 0, 10); // zero value -> center
    expect(center.x).toBeCloseTo(50);
    expect(center.y).toBeCloseTo(50);
  });
  it("tickCount clamps to a small legible range", () => {
    expect(tickCount(0)).toBe(2); // floor
    expect(tickCount(48)).toBe(2); // ~1 rounded up to the floor
    expect(tickCount(240)).toBe(5);
    expect(tickCount(10000)).toBe(8); // cap
  });
});

describe("chart Y axis + legend", () => {
  function paintNode(node: Node): RecordingCtx {
    const d = createBlankDesign();
    d.pages[0].children = [node];
    const ctx = new RecordingCtx();
    renderScene(createScene(d), ctx, { zoom: 1, panX: 0, panY: 0, dpr: 1, width: 400, height: 400 });
    return ctx;
  }
  it("draws Y tick labels for a value-axis chart when showY is not disabled", () => {
    const node = n("chart", { chartType: "bar", categories: ["A", "B"], series: [{ name: "s", values: [5, 10] }], options: {}, size: { width: 200, height: 120 } });
    const texts = paintNode(node).ops.filter((o) => o.op === "fillText").map((o) => o.text);
    expect(texts).toContain("10"); // top tick == maxV
    expect(texts).toContain("0"); // baseline tick
  });
  it("omits Y ticks when axes.showY is false", () => {
    const node = n("chart", { chartType: "bar", categories: ["A"], series: [{ name: "s", values: [10] }], options: {}, style: { axes: { showY: false } }, size: { width: 200, height: 120 } });
    const texts = paintNode(node).ops.filter((o) => o.op === "fillText").map((o) => o.text);
    expect(texts).not.toContain("0");
  });
  it("does not draw a Y axis for pie charts", () => {
    const node = n("chart", { chartType: "pie", series: [{ name: "s", values: [1, 2, 3] }], options: {}, size: { width: 200, height: 200 } });
    const texts = paintNode(node).ops.filter((o) => o.op === "fillText").map((o) => o.text);
    expect(texts).not.toContain("0");
  });
  it("truncates a long legend label with an ellipsis to stay in its band", () => {
    const longName = "An extremely long series name that would overrun the legend band";
    const node = n("chart", { chartType: "bar", categories: ["A"], series: [{ name: longName, values: [5] }], options: {}, style: { legend: { show: true, position: "right" } }, size: { width: 200, height: 120 } });
    const labels = paintNode(node).ops.filter((o) => o.op === "fillText").map((o) => String(o.text));
    const drawn = labels.find((t) => t.startsWith("An ") && t.endsWith("…"));
    expect(drawn).toBeTruthy(); // a shortened, ellipsized legend label was drawn
    expect(drawn).not.toBe(longName); // it was shortened
    expect(drawn!.length).toBeLessThan(longName.length);
  });
});
