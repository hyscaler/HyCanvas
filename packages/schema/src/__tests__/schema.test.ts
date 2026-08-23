import { describe, it, expect } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import {
  currentSchemaVersion,
  maxNestingDepth,
  knownNodeTypes,
  createNode,
  createBlankDesign,
  validate,
  migrate,
  migrations,
  needsMigration,
  getJsonSchema,
  fromDesignFile,
  toDesignFile,
  isUnknownNode,
  wrapUnknownNode,
  unwrapUnknownNode,
  collectIds,
  maxDepth,
  type DesignFile,
  type Node,
  type NodeType,
} from "../index";

const constructable = knownNodeTypes.filter(
  (t) => t !== "model3d",
) as Exclude<NodeType, "model3d">[];

/** A design containing one well-formed instance of every known node type. */
function fixtureAllNodes(): DesignFile {
  const design = createBlankDesign({ title: "Fixture", id: "design-1" });
  design.pages[0].children = constructable.map((t, i) =>
    createNode(t, { id: `node-${i}` }),
  );
  // Exercise the lossless extension slots and a reusable value type.
  design.meta = { brandKitId: "bk-1", locale: "en-US" };
  design.pages[0].data = { ns: { custom: true } };
  (design.pages[0].children[0] as Node).data = { plugin: { v: 1 } };
  (design.pages[0].children[0] as Node).effects = [
    { kind: "blur", radius: 4 },
    {
      kind: "shadow",
      type: "drop",
      color: { srgb: { r: 0, g: 0, b: 0, a: 0.5 } },
      offsetX: 2,
      offsetY: 2,
      blur: 4,
      spread: 0,
    },
  ];
  return design;
}

/** A chain of `leafDepth` nested groups with a text leaf at the bottom. */
function nestedGroups(leafDepth: number): Node {
  let node: Node = createNode("text", { id: "leaf" });
  for (let i = 0; i < leafDepth; i++) {
    node = createNode("group", { id: `g-${i}`, children: [node] });
  }
  return node;
}

describe("AC-1: every node type has a default that validates", () => {
  for (const type of constructable) {
    it(`createNode("${type}") produces a valid default`, () => {
      const design = createBlankDesign();
      design.pages[0].children = [createNode(type, { id: "n" })];
      const result = validate(design);
      expect(result).toEqual({ ok: true });
    });
  }

  it("reserved model3d type is not constructable", () => {
    // @ts-expect-error model3d is excluded from createNode's type parameter.
    expect(() => createNode("model3d")).toThrow();
  });
});

describe("AC-2: byte-faithful Yjs round trip", () => {
  it("a one-of-every-node design round-trips deep-equal", () => {
    const design = fixtureAllNodes();
    expect(validate(design)).toEqual({ ok: true });
    const round = toDesignFile(fromDesignFile(design));
    expect(round).toEqual(design);
  });

  it("preserves data and effects extension slots", () => {
    const design = fixtureAllNodes();
    const round = toDesignFile(fromDesignFile(design));
    expect(round.pages[0].data).toEqual({ ns: { custom: true } });
    expect(round.pages[0].children[0].effects).toEqual(
      design.pages[0].children[0].effects,
    );
  });
});

describe("AC-3: validate returns the exact JSON pointer", () => {
  it("points at a malformed nested field", () => {
    const design = createBlankDesign();
    design.pages[0].children = [
      createNode("group", {
        id: "g",
        children: [{ ...createNode("text", { id: "t" }), opacity: "bad" } as unknown as Node],
      }),
    ];
    const result = validate(design);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.pointer).toBe("/pages/0/children/0/children/0/opacity");
    }
  });

  it("flags a missing required file field", () => {
    const design = createBlankDesign() as unknown as Record<string, unknown>;
    delete design.dpi;
    const result = validate(design);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.pointer).toBe("/dpi");
  });

  it("flags duplicate node ids", () => {
    const design = createBlankDesign();
    design.pages[0].children = [
      createNode("shape", { id: "dup" }),
      createNode("shape", { id: "dup" }),
    ];
    const result = validate(design);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("duplicate node id");
  });
});

describe("AC-4: forward migration is total and idempotent", () => {
  it("migrating a current-version file is a no-op identity", () => {
    const design = createBlankDesign();
    expect(design.schemaVersion).toBe(currentSchemaVersion);
    expect(needsMigration(design)).toBe(false);
    expect(migrate(design)).toBe(design);
  });

  it("composes a registered step to upgrade an older file, idempotently", () => {
    // Register a temporary v0 -> v1 step to exercise the chain without
    // polluting the global registry.
    migrations[0] = (file: any) => ({ ...file, schemaVersion: 1, meta: { ...file.meta, upgraded: true } });
    try {
      const old = { ...createBlankDesign(), schemaVersion: 0 } as DesignFile;
      expect(needsMigration(old)).toBe(true);
      const upgraded = migrate(old, 1);
      expect(upgraded.schemaVersion).toBe(1);
      expect(upgraded.meta.upgraded).toBe(true);
      expect(validate(upgraded)).toEqual({ ok: true });
      // Running again on the now-current file changes nothing.
      expect(migrate(upgraded, 1)).toBe(upgraded);
    } finally {
      delete migrations[0];
    }
  });

  it("throws a structured error when a step is missing", () => {
    const old = { ...createBlankDesign(), schemaVersion: 0 } as DesignFile;
    expect(() => migrate(old, 1)).toThrowError(/no migration registered/);
  });

  it("refuses to downgrade", () => {
    const design = createBlankDesign();
    expect(() => migrate(design, -1)).toThrowError(/forward-only/);
  });

  it("v14 -> v15 stamps the version and leaves path nodes untouched; contours validate", () => {
    const design = createBlankDesign();
    const path = createNode("path", {
      segments: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      closed: true,
      fills: [{ type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }],
    } as Partial<Node>);
    design.pages[0].children.push(path);
    const v14 = structuredClone({ ...design, schemaVersion: 14 }) as DesignFile;
    const out = migrate(v14);
    expect(out.schemaVersion).toBe(currentSchemaVersion);
    expect(out.pages[0].children[0]).toEqual(path); // additive: node byte-identical
    // A compound path (extra even-odd contours) is valid in the new version.
    (out.pages[0].children[0] as unknown as Record<string, unknown>).contours = [
      { segments: [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }], closed: true },
    ];
    expect(validate(out)).toEqual({ ok: true });
  });
});

describe("v1 -> v2 text migration", () => {
  it("converts a flat TextNode to the paragraph/run model and validates", () => {
    const v1 = {
      ...createBlankDesign(),
      schemaVersion: 1,
    } as unknown as DesignFile & { pages: { children: unknown[] }[] };
    v1.pages[0].children = [
      {
        id: "t",
        type: "text",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 200, height: 80 },
        opacity: 1,
        blendMode: "normal",
        content: [{ text: "Hi", fontId: "system", fontSize: 24, weight: 700, color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }],
        align: "center",
        verticalAlign: "middle",
        direction: "ltr",
        autoFit: "grow",
      },
    ];

    const out = migrate(v1 as unknown as DesignFile);
    expect(out.schemaVersion).toBe(currentSchemaVersion);
    expect(validate(out)).toEqual({ ok: true });

    const node = out.pages[0].children[0] as unknown as {
      box: { mode: string; verticalAlign: string };
      content: { runs: { style: { fontSize: number; axes?: Record<string, number>; fill: { type: string } } }[]; style: { align: string } }[];
      content_legacy?: unknown;
    };
    expect(node.box.mode).toBe("autoHeight"); // autoFit "grow"
    expect(node.box.verticalAlign).toBe("middle");
    const run = node.content[0].runs[0];
    expect(run.style.fontSize).toBe(24);
    expect(run.style.axes?.wght).toBe(700);
    expect(run.style.fill.type).toBe("solid");
    expect(node.content[0].style.align).toBe("center");
    // v1-only fields are gone.
    expect((node as Record<string, unknown>).align).toBeUndefined();
  });
});

describe("v2 -> v3 image migration", () => {
  it("converts a flat ImageNode to the source/fit model and validates", () => {
    const v2 = { ...createBlankDesign(), schemaVersion: 2 } as unknown as DesignFile & {
      pages: { children: unknown[] }[];
    };
    v2.pages[0].children = [
      {
        id: "img",
        type: "image",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 100, height: 80 },
        opacity: 1,
        blendMode: "normal",
        assetId: "a1",
        fit: "fill",
        crop: { x: 0, y: 0, width: 50, height: 40 },
      },
    ];
    const out = migrate(v2 as unknown as DesignFile);
    expect(out.schemaVersion).toBe(currentSchemaVersion);
    expect(validate(out)).toEqual({ ok: true });
    const node = out.pages[0].children[0] as unknown as {
      source: { assetId: string };
      fit: string;
      crop?: unknown;
      assetId?: unknown;
    };
    expect(node.source.assetId).toBe("a1");
    expect(node.fit).toBe("stretch"); // "fill" -> "stretch"
    expect(node.crop).toBeUndefined(); // un-normalizable v2 crop dropped
    expect(node.assetId).toBeUndefined();
  });
});

describe("v3 -> v4 color/fill migration (F09)", () => {
  it("converts legacy colors and fills to the unified model and validates", () => {
    const v3 = { ...createBlankDesign(), schemaVersion: 3 } as unknown as DesignFile & {
      pages: { children: unknown[]; background?: unknown }[];
    };
    v3.pages[0].background = { type: "solid", color: { space: "srgb", r: 1, g: 1, b: 1, a: 1 } };
    v3.pages[0].children = [
      {
        id: "s",
        type: "shape",
        shape: "rect",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 100, height: 80 },
        opacity: 1,
        blendMode: "normal",
        fills: [
          { type: "solid", color: { space: "cmyk", c: 0, m: 1, y: 1, k: 0, a: 1 } },
          { type: "linear", angle: 45, stops: [
            { offset: 0, color: { space: "srgb", r: 1, g: 0, b: 0, a: 1 } },
            { offset: 1, color: { space: "srgb", r: 0, g: 0, b: 1, a: 1 } },
          ] },
        ],
        stroke: { fill: { type: "solid", color: { space: "srgb", r: 0, g: 0, b: 0, a: 1 } }, width: 2, align: "center", cap: "butt", join: "miter" },
      },
    ];

    const out = migrate(v3 as unknown as DesignFile);
    expect(out.schemaVersion).toBe(currentSchemaVersion);
    expect(validate(out)).toEqual({ ok: true });

    const node = out.pages[0].children[0] as unknown as {
      fills: { type: string; gradient?: string; color?: { srgb: unknown; cmyk?: unknown }; stops?: { position: number }[] }[];
    };
    // cmyk solid -> srgb-canonical with authoritative cmyk preserved.
    expect(node.fills[0].type).toBe("solid");
    expect(node.fills[0].color!.cmyk).toEqual({ c: 0, m: 1, y: 1, k: 0 });
    expect(node.fills[0].color!.srgb).toMatchObject({ r: 1, g: 0, b: 0, a: 1 });
    // linear -> gradient with positioned stops.
    expect(node.fills[1].type).toBe("gradient");
    expect(node.fills[1].gradient).toBe("linear");
    expect(node.fills[1].stops!.map((s) => s.position)).toEqual([0, 1]);
  });

  it("is idempotent on an already-v4 file and preserves raw/data slots", () => {
    const current = createBlankDesign();
    current.pages[0].data = { plugin: { color: { space: "srgb", r: 9, g: 9, b: 9, a: 9 } } };
    // Running the v3 step on an already-current file leaves data untouched.
    const out = migrations[3]!(current as unknown as Record<string, unknown>) as unknown as DesignFile;
    expect(out.pages[0].data).toEqual({ plugin: { color: { space: "srgb", r: 9, g: 9, b: 9, a: 9 } } });
  });
});

describe("v8 -> v9 per-range hyperlinks (CharStyle.link)", () => {
  it("opens a legacy v8 text file unchanged and validates at v9, and accepts a run link", () => {
    const v8 = { ...createBlankDesign(), schemaVersion: 8 } as unknown as DesignFile & { pages: { children: unknown[] }[] };
    v8.pages[0].children = [
      {
        id: "t",
        type: "text",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 200, height: 80 },
        opacity: 1,
        blendMode: "normal",
        box: { mode: "fixed", width: 200, height: 80 },
        content: [
          {
            runs: [
              { text: "plain ", style: { fontFamily: "system", fontStyle: "Regular", fontSize: 16, fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } } } },
              { text: "linked", style: { fontFamily: "system", fontStyle: "Regular", fontSize: 16, fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }, link: "https://example.com" } },
            ],
            style: { align: "left", direction: "auto" },
          },
        ],
      },
    ];
    const out = migrate(v8 as unknown as DesignFile);
    expect(out.schemaVersion).toBe(currentSchemaVersion);
    expect(validate(out)).toEqual({ ok: true });
    const run = (out.pages[0].children[0] as unknown as { content: { runs: { style: { link?: string } }[] }[] }).content[0].runs[1];
    expect(run.style.link).toBe("https://example.com");
  });
});

describe("v9 -> v10 whiteboard board node types (F30)", () => {
  it("opens a legacy v9 board unchanged and validates at v10", () => {
    const v9 = { ...createBlankDesign(), schemaVersion: 9 } as unknown as DesignFile & { pages: { children: unknown[] }[]; meta: Record<string, unknown> };
    v9.meta = { kind: "whiteboard" };
    v9.pages[0].children = [
      createNode("sticky", { id: "s1", text: "old note" }) as unknown,
      createNode("frame", { id: "f1" }) as unknown,
      createNode("connector", { id: "c1" }) as unknown,
    ];
    const out = migrate(v9 as unknown as DesignFile);
    expect(out.schemaVersion).toBe(currentSchemaVersion);
    expect(validate(out)).toEqual({ ok: true });
  });

  it("validates the new board node types as defaults", () => {
    const design = createBlankDesign();
    design.pages[0].children = [
      createNode("ink", { id: "ink-1" }),
      createNode("mindmap", { id: "mm-1" }),
      createNode("boardview", { id: "bv-1" }),
      createNode("diagramcode", { id: "dc-1" }),
      createNode("stamp", { id: "st-1" }),
    ];
    expect(validate(design)).toEqual({ ok: true });
  });

  it("accepts the additive optional fields on connector/sticky/frame", () => {
    const design = createBlankDesign();
    design.pages[0].children = [
      createNode("connector", {
        id: "c",
        label: { text: "approves", position: 0.5 },
        waypoints: [{ x: 20, y: 20 }, { x: 40, y: 60 }],
        jumpOver: true,
        start: { attach: { nodeId: "a", anchor: "right", port: "e0" } },
        end: { point: { x: 120, y: 0 } },
      }),
      createNode("sticky", { id: "s", text: "by me", authorId: "user-7", shape: "circle" }),
      createNode("frame", { id: "f", header: { title: "Ideas" }, collapsed: true }),
      createNode("ink", {
        id: "k",
        points: [{ x: 0, y: 0, p: 0.3, t: 0 }, { x: 5, y: 8, p: 0.7, t: 16 }],
        smoothing: 0.8,
        brush: { width: 6, opacity: 0.4, color: { srgb: { r: 1, g: 0.9, b: 0, a: 1 } }, mode: "highlighter" },
      }),
    ];
    expect(validate(design)).toEqual({ ok: true });
  });

  it("preserves a newer-than-v10 board node losslessly (UnknownNode round-trip)", () => {
    const design = createBlankDesign() as unknown as DesignFile & { pages: { children: unknown[] }[] };
    const future = {
      id: "future-1",
      type: "hologram", // a node type a newer client wrote
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 50, height: 50 },
      opacity: 1,
      blendMode: "normal",
      depth: 3,
    };
    design.pages[0].children = [future];
    expect(validate(design as unknown as DesignFile)).toEqual({ ok: true });
    const round = toDesignFile(fromDesignFile(design as unknown as DesignFile));
    expect(round.pages[0].children[0]).toEqual(future);
  });
});

describe("v4 -> v5 image effects/adjustments migration (F24)", () => {
  it("opens a legacy v4 file unchanged in shape and validates at v5", () => {
    // A v4 file with an existing adjustment effect (the only kinds that existed
    // before F24) must still open: the migration only bumps the version.
    const v4 = { ...createBlankDesign(), schemaVersion: 4 } as unknown as DesignFile & {
      pages: { children: unknown[] }[];
    };
    v4.pages[0].children = [
      {
        id: "img",
        type: "image",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 100, height: 80 },
        opacity: 1,
        blendMode: "normal",
        source: { assetId: "a1", naturalWidth: 100, naturalHeight: 80 },
        fit: "cover",
        effects: [{ kind: "adjustment", ops: [{ name: "brightness", value: 1.2 }] }],
      },
    ];

    const out = migrate(v4 as unknown as DesignFile);
    expect(out.schemaVersion).toBe(currentSchemaVersion);
    expect(validate(out)).toEqual({ ok: true });
    const node = out.pages[0].children[0] as unknown as { effects: { kind: string; ops?: unknown[] }[] };
    // The legacy adjustment effect is preserved verbatim.
    expect(node.effects[0]).toEqual({ kind: "adjustment", ops: [{ name: "brightness", value: 1.2 }] });
  });

  it("accepts the new duotone effect kind and extended adjustment ops at v5", () => {
    const file = createBlankDesign() as unknown as DesignFile & { pages: { children: unknown[] }[] };
    file.pages[0].children = [
      {
        id: "img",
        type: "image",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 10, height: 10 },
        opacity: 1,
        blendMode: "normal",
        source: { assetId: "a1", naturalWidth: 10, naturalHeight: 10 },
        fit: "cover",
        effects: [
          {
            kind: "adjustment",
            ops: [
              { name: "exposure", value: 0.3 },
              { name: "warmth", value: -0.4 },
              { name: "vibrance", value: 0.5 },
            ],
          },
          { kind: "duotone", shadows: { srgb: { r: 0, g: 0, b: 0, a: 1 } }, highlights: { srgb: { r: 1, g: 1, b: 1, a: 1 } }, intensity: 0.8 },
        ],
      },
    ];
    expect(validate(file as unknown as DesignFile)).toEqual({ ok: true });
  });
});

describe("v5 -> v6 animation/interactivity migration (F25)", () => {
  it("lifts a legacy single entrance animation into animation.entrance", () => {
    const v5 = { ...createBlankDesign(), schemaVersion: 5 } as unknown as DesignFile & {
      pages: { children: unknown[] }[];
    };
    v5.pages[0].children = [
      {
        id: "s1",
        type: "shape",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 100, height: 80 },
        opacity: 1,
        blendMode: "normal",
        shape: "rect",
        fills: [{ type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }],
        // legacy F25 single-animation shape (slideR maps to the new "pan" preset)
        animations: [{ preset: "slideR", durationMs: 400, delayMs: 100 }],
      },
    ];

    const out = migrate(v5 as unknown as DesignFile);
    expect(out.schemaVersion).toBe(currentSchemaVersion);
    expect(validate(out)).toEqual({ ok: true });
    const node = out.pages[0].children[0] as unknown as {
      animation?: { entrance?: { preset: string; durationMs: number; delayMs: number; easing: string } };
      animations?: unknown[];
    };
    expect(node.animation?.entrance).toEqual({ preset: "pan", durationMs: 400, delayMs: 100, easing: "ease-out" });
    // the raw legacy array is preserved untouched (lossless)
    expect(node.animations).toEqual([{ preset: "slideR", durationMs: 400, delayMs: 100 }]);
  });

  it("is idempotent: a node already carrying animation is left alone", () => {
    const file = createBlankDesign() as unknown as DesignFile & { pages: { children: unknown[] }[] };
    const existing = { entrance: { preset: "rise", durationMs: 600, delayMs: 0, easing: "spring" } };
    file.pages[0].children = [
      {
        id: "s1",
        type: "shape",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 10, height: 10 },
        opacity: 1,
        blendMode: "normal",
        shape: "rect",
        fills: [{ type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }],
        animation: existing,
        animations: [{ preset: "fade", durationMs: 999, delayMs: 0 }],
      },
    ];
    const out = migrations[5](file);
    const node = out.pages[0].children[0] as unknown as { animation: unknown };
    expect(node.animation).toEqual(existing);
  });

  it("validates the new animation, interaction, transition, and motion shapes at v6", () => {
    const file = createBlankDesign() as unknown as DesignFile & { pages: (Record<string, unknown> & { children: unknown[] })[] };
    file.pages[0].transition = { type: "slide", direction: "left", durationMs: 350 };
    file.pages[0].children = [
      {
        id: "img",
        type: "image",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 10, height: 10 },
        opacity: 1,
        blendMode: "normal",
        source: { assetId: "a1", naturalWidth: 10, naturalHeight: 10 },
        fit: "cover",
        motion: { kind: "kenburns", intensity: 0.6 },
        animation: {
          entrance: { preset: "pop", durationMs: 500, delayMs: 0, easing: "ease-out" },
          emphasis: { preset: "pulse", durationMs: 1200, delayMs: 0, easing: "ease-in-out" },
          exit: { preset: "fade-out", durationMs: 300, delayMs: 0, easing: "linear" },
        },
        interaction: { trigger: "click", action: { kind: "navigate", to: "next" } },
      },
      {
        id: "btn",
        type: "shape",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 10, height: 10 },
        opacity: 1,
        blendMode: "normal",
        shape: "rect",
        fills: [{ type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }],
        interaction: { trigger: "click", action: { kind: "open-link", link: { kind: "url", target: "https://example.com" } } },
      },
    ];
    expect(validate(file as unknown as DesignFile)).toEqual({ ok: true });
  });

  it("accepts the additive presentation page fields (autoAdvanceMs, hidden) and an older file without them", () => {
    const withFields = createBlankDesign() as unknown as DesignFile & { pages: Record<string, unknown>[] };
    withFields.pages[0].autoAdvanceMs = 4000;
    withFields.pages[0].hidden = true;
    expect(validate(withFields as unknown as DesignFile)).toEqual({ ok: true });

    // An older file with neither field still validates (fields are optional).
    const older = createBlankDesign();
    expect(validate(older)).toEqual({ ok: true });
    expect(older.pages[0].autoAdvanceMs).toBeUndefined();
    expect(older.pages[0].hidden).toBeUndefined();
  });

  it("rejects a javascript: url in an open-link interaction action", () => {
    const file = createBlankDesign() as unknown as DesignFile & { pages: { children: unknown[] }[] };
    file.pages[0].children = [
      {
        id: "btn",
        type: "shape",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 10, height: 10 },
        opacity: 1,
        blendMode: "normal",
        shape: "rect",
        fills: [{ type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }],
        interaction: { trigger: "click", action: { kind: "open-link", link: { kind: "url", target: "javascript:alert(1)" } } },
      },
    ];
    const result = validate(file as unknown as DesignFile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.pointer).toBe("/pages/0/children/0/interaction/action/link/target");
  });

  it("rejects an image motion intensity outside the 0..1 contract", () => {
    const file = createBlankDesign() as unknown as DesignFile & { pages: { children: unknown[] }[] };
    file.pages[0].children = [
      {
        id: "img",
        type: "image",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 10, height: 10 },
        opacity: 1,
        blendMode: "normal",
        source: { assetId: "a1", naturalWidth: 10, naturalHeight: 10 },
        fit: "cover",
        motion: { kind: "kenburns", intensity: 1.5 },
      },
    ];
    const result = validate(file as unknown as DesignFile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.pointer).toBe("/pages/0/children/0/motion/intensity");
  });
});

describe("v6 -> v7 chart/table styling migration (F27)", () => {
  it("opens a v6 chart and table unchanged and validates at v7", () => {
    const v6 = { ...createBlankDesign(), schemaVersion: 6 } as unknown as DesignFile & {
      pages: { children: unknown[] }[];
    };
    v6.pages[0].children = [
      {
        id: "c1",
        type: "chart",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 300, height: 200 },
        opacity: 1,
        blendMode: "normal",
        chartType: "bar",
        series: [{ name: "s", values: [1, 2, 3] }],
        categories: ["a", "b", "c"],
        options: {},
      },
      {
        id: "t1",
        type: "table",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 120, height: 40 },
        opacity: 1,
        blendMode: "normal",
        rows: 1,
        cols: 1,
        colWidths: [120],
        rowHeights: [40],
        cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, content: [] }],
      },
    ];

    const out = migrate(v6 as unknown as DesignFile);
    expect(out.schemaVersion).toBe(currentSchemaVersion);
    expect(validate(out)).toEqual({ ok: true });
    // Additive: no styling fields are injected; the old shapes survive intact.
    const chart = out.pages[0].children[0] as unknown as { style?: unknown };
    expect(chart.style).toBeUndefined();
  });

  it("validates the new chart styling and table formatting fields at v7", () => {
    const file = createBlankDesign() as unknown as DesignFile & { pages: { children: unknown[] }[] };
    file.pages[0].children = [
      {
        id: "c1",
        type: "chart",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 300, height: 200 },
        opacity: 1,
        blendMode: "normal",
        chartType: "barStacked",
        series: [
          { name: "s1", values: [1, 2], color: { srgb: { r: 0.4, g: 0.4, b: 0.9, a: 1 } } },
          { name: "s2", values: [3, 4] },
        ],
        categories: ["a", "b"],
        options: {},
        style: {
          title: "Sales",
          legend: { show: true, position: "bottom" },
          valueLabels: true,
          axes: { showX: true, showY: false, xLabel: "Month", yLabel: "USD" },
        },
      },
      {
        id: "t1",
        type: "table",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 120, height: 40 },
        opacity: 1,
        blendMode: "normal",
        rows: 1,
        cols: 1,
        colWidths: [120],
        rowHeights: [40],
        cells: [
          {
            row: 0, col: 0, rowSpan: 1, colSpan: 1,
            align: "center",
            fill: { type: "solid", color: { srgb: { r: 1, g: 1, b: 0, a: 1 } } },
            textColor: { srgb: { r: 0, g: 0, b: 1, a: 1 } },
            content: [],
          },
        ],
        headerStyle: { enabled: true, bold: true, fill: { type: "solid", color: { srgb: { r: 0.9, g: 0.9, b: 0.9, a: 1 } } }, textColor: { srgb: { r: 0, g: 0, b: 0, a: 1 } } },
        borderStyle: { show: true, width: 2, color: { srgb: { r: 0.5, g: 0.5, b: 0.5, a: 1 } } },
      },
    ];
    expect(validate(file as unknown as DesignFile)).toEqual({ ok: true });
  });

  it("accepts the new scatter and radar chart types", () => {
    for (const chartType of ["scatter", "radar", "barGrouped"] as const) {
      const file = createBlankDesign() as unknown as DesignFile & { pages: { children: unknown[] }[] };
      file.pages[0].children = [
        {
          id: "c1",
          type: "chart",
          transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
          size: { width: 300, height: 200 },
          opacity: 1,
          blendMode: "normal",
          chartType,
          series: [{ name: "s", values: [1, 2, 3] }],
          categories: ["a", "b", "c"],
          options: {},
        },
      ];
      expect(validate(file as unknown as DesignFile)).toEqual({ ok: true });
    }
  });
});

describe("AC-5: unknown node types survive losslessly", () => {
  const unknownNode = {
    id: "u1",
    type: "hologram",
    transform: { x: 1, y: 2, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 10, height: 10 },
    opacity: 1,
    blendMode: "normal",
    futureField: { nested: [1, 2, 3] },
  } as unknown as Node;

  it("validate accepts an unknown type (never dropped)", () => {
    const design = createBlankDesign();
    design.pages[0].children = [unknownNode];
    expect(validate(design)).toEqual({ ok: true });
  });

  it("round-trips identically through the Yjs bridge", () => {
    const design = createBlankDesign();
    design.pages[0].children = [unknownNode];
    const round = toDesignFile(fromDesignFile(design));
    expect(round).toEqual(design);
  });

  it("wraps into UnknownNode and unwraps to the original", () => {
    expect(isUnknownNode(unknownNode)).toBe(true);
    const wrapped = wrapUnknownNode(unknownNode as unknown as Record<string, unknown>);
    expect(wrapped.raw).toEqual(unknownNode);
    expect(wrapped.id).toBe("u1");
    expect(unwrapUnknownNode(wrapped)).toEqual(unknownNode);
    // Idempotent.
    expect(wrapUnknownNode(wrapped as unknown as Record<string, unknown>)).toBe(wrapped);
  });

  it("a known, well-formed node is not unknown", () => {
    expect(isUnknownNode(createNode("text"))).toBe(false);
  });
});

describe("AC-6: nesting depth limit", () => {
  it(`rejects depth >= ${maxNestingDepth} with a pointer`, () => {
    const design = createBlankDesign();
    design.pages[0].children = [nestedGroups(maxNestingDepth)];
    const result = validate(design);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("nesting depth");
  });

  it(`accepts depth < ${maxNestingDepth}`, () => {
    const design = createBlankDesign();
    design.pages[0].children = [nestedGroups(maxNestingDepth - 1)];
    expect(validate(design)).toEqual({ ok: true });
  });
});

describe("AC-7: published JSON Schema matches the runtime validator", () => {
  const ajv = new Ajv2020({ strict: false, allowUnionTypes: true });
  const jsonSchema = getJsonSchema();
  const ajvValidate = ajv.compile(jsonSchema);

  it("declares draft 2020-12", () => {
    expect(jsonSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("accepts the same valid fixture as validate()", () => {
    const design = fixtureAllNodes();
    expect(validate(design)).toEqual({ ok: true });
    expect(ajvValidate(design)).toBe(true);
  });

  it("rejects the same malformed fixture as validate()", () => {
    const design = createBlankDesign();
    design.pages[0].children = [
      { ...createNode("text", { id: "t" }), opacity: "bad" } as unknown as Node,
    ];
    expect(validate(design).ok).toBe(false);
    expect(ajvValidate(design)).toBe(false);
  });
});

describe("Section 10: URL-scheme enforcement for untrusted strings", () => {
  function withEmbed(src: string): DesignFile {
    const design = createBlankDesign();
    design.pages[0].children = [createNode("embed", { id: "e", src } as Partial<Node>)];
    return design;
  }
  function withLink(kind: string, target: string): DesignFile {
    const design = createBlankDesign();
    design.pages[0].children = [
      createNode("shape", { id: "s", link: { kind, target } } as unknown as Partial<Node>),
    ];
    return design;
  }

  it("rejects a javascript: embed src", () => {
    const result = validate(withEmbed("javascript:alert(1)"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.pointer).toBe("/pages/0/children/0/src");
  });

  it("rejects a data: embed src", () => {
    expect(validate(withEmbed("data:text/html,<script>")).ok).toBe(false);
  });

  it("accepts an https embed src and an empty (default) src", () => {
    expect(validate(withEmbed("https://youtube.com/embed/abc")).ok).toBe(true);
    expect(validate(withEmbed("")).ok).toBe(true); // createNode default
  });

  it("rejects a javascript: hyperlink target", () => {
    const result = validate(withLink("url", "javascript:alert(1)"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.pointer).toBe("/pages/0/children/0/link/target");
  });

  it("accepts http(s) url links, mailto/email, and internal page/anchor", () => {
    expect(validate(withLink("url", "https://example.com")).ok).toBe(true);
    expect(validate(withLink("email", "mailto:a@b.com")).ok).toBe(true);
    expect(validate(withLink("email", "a@b.com")).ok).toBe(true);
    expect(validate(withLink("page", "page-2")).ok).toBe(true);
    expect(validate(withLink("anchor", "section-3")).ok).toBe(true);
  });
});

describe("visitor utilities", () => {
  it("collectIds returns ids in document order", () => {
    const design = createBlankDesign();
    design.pages[0].children = [
      createNode("group", {
        id: "a",
        children: [createNode("text", { id: "b" })],
      }),
      createNode("shape", { id: "c" }),
    ];
    expect(collectIds(design.pages[0].children)).toEqual(["a", "b", "c"]);
  });

  it("maxDepth reflects container nesting", () => {
    const design = createBlankDesign();
    design.pages[0].children = [nestedGroups(3)];
    expect(maxDepth(design.pages[0].children)).toBe(3);
  });
});

describe("v18: document language", () => {
  it("v17 -> v18 stamps the version and promotes a legacy meta.language", () => {
    const design = createBlankDesign();
    design.meta.language = "ar-SA"; // where importers wrote it pre-v18
    const v17 = structuredClone({ ...design, schemaVersion: 17 }) as DesignFile;
    const out = migrate(v17);
    expect(out.schemaVersion).toBe(currentSchemaVersion);
    expect(out.language).toBe("ar-SA");
    // COPIED up, never removed: older readers keep finding it where they look.
    expect(out.meta.language).toBe("ar-SA");
    expect(validate(out)).toEqual({ ok: true });
  });

  it("v17 -> v18 without a legacy value adds nothing", () => {
    const v17 = structuredClone({ ...createBlankDesign(), schemaVersion: 17 }) as DesignFile;
    const out = migrate(v17);
    expect(out.schemaVersion).toBe(currentSchemaVersion);
    expect("language" in out).toBe(false);
    expect(validate(out)).toEqual({ ok: true });
  });

  it("a set language validates and an absent one stays optional", () => {
    const design = createBlankDesign();
    expect(validate(design)).toEqual({ ok: true });
    design.language = "hi-IN";
    expect(validate(design)).toEqual({ ok: true });
  });
});
