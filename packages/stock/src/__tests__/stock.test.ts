import { describe, it, expect } from "vitest";
import { createBlankDesign, createNode, type DesignFile, type Node } from "@hc/schema";
import {
  assertAppAction,
  attributionText,
  canEditNode,
  checkAppAction,
  classifyEmbed,
  colorfulness,
  colorMatches,
  compileAttribution,
  createQrNode,
  filtersToQuery,
  parsePathData,
  qrValue,
  rebindQrValue,
  searchStock,
  stockToNodes,
  svgToNodes,
  validateEmbedUrl,
  withProvenance,
  type MiniApp,
  type NodeProvenance,
  type StockAsset,
} from "../index";

function stock(id: string, over: Partial<StockAsset> = {}): StockAsset {
  return {
    id,
    kind: "photo",
    title: id,
    tags: [],
    previewUrl: `https://cdn/${id}-t.jpg`,
    sourceUrl: `https://cdn/${id}.jpg`,
    format: "jpg",
    animated: false,
    dominantColors: [],
    license: { type: "hycanvas-free", attributionRequired: false },
    collectionIds: [],
    ...over,
  };
}

const idgen = () => { let i = 0; return () => `t-${++i}`; };

describe("catalog search (FR-1, FR-2, AC-1)", () => {
  const assets = [
    stock("sunset", { title: "Mountain Sunset", kind: "photo", orientation: "landscape", dominantColors: ["#dd6622"], license: { type: "cc0", attributionRequired: false }, tags: ["mountain", "sunset"] }),
    stock("portrait", { title: "City Portrait", kind: "photo", orientation: "portrait", dominantColors: ["#223344"] }),
    stock("clip", { title: "Beach Clip", kind: "video", durationMs: 8000, format: "mp4" }),
  ];

  it("maps query-string filters to a typed query", () => {
    const q = filtersToQuery({ q: "sunset", kind: "photo,video", orientation: "landscape", color: "#ff8800", durMin: "1000", durMax: "5000" });
    expect(q).toMatchObject({ text: "sunset", kind: ["photo", "video"], orientation: "landscape", color: "#ff8800" });
    expect(q.durationMs).toEqual({ min: 1000, max: 5000 });
  });

  it("filters by kind, orientation, color tolerance, and duration", () => {
    expect(searchStock(assets, { kind: "video" }).map((a) => a.id)).toEqual(["clip"]);
    expect(searchStock(assets, { orientation: "landscape" }).map((a) => a.id)).toEqual(["sunset"]);
    expect(searchStock(assets, { color: "#ee7711" }).map((a) => a.id)).toEqual(["sunset"]);
    // duration excludes the 8s video; durationless photos count as 0 and pass `max`.
    expect(searchStock(assets, { durationMs: { max: 5000 } }).map((a) => a.id)).toEqual(["sunset", "portrait"]);
    // composed with kind:video, the over-length clip is filtered out.
    expect(searchStock(assets, { kind: "video", durationMs: { max: 5000 } }).map((a) => a.id)).toEqual([]);
    expect(colorMatches(assets[0], "#dd6622")).toBe(true);
  });

  it("ranks text relevance (title over tag)", () => {
    const r = searchStock(assets, { text: "sunset" });
    expect(r[0].id).toBe("sunset");
  });

  it("browse (no text) leads with photos and the most colorful within a kind", () => {
    const browse = [
      stock("mono-icon", { kind: "icon", title: "A Mono Icon", dominantColors: ["#111111"] }),
      stock("emoji", { kind: "sticker", title: "Grin", dominantColors: ["#fcc21b", "#65471b"] }),
      stock("drawing", { kind: "illustration", title: "Drawing", dominantColors: ["#9b2c72"] }),
      stock("dull-photo", { title: "Dull Photo", dominantColors: ["#223344"] }),
      stock("vivid-photo", { title: "Vivid Photo", dominantColors: ["#dd6622", "#22aa66"] }),
    ];
    expect(searchStock(browse).map((a) => a.id)).toEqual(["vivid-photo", "dull-photo", "drawing", "emoji", "mono-icon"]);
    // Monochrome scores 0; vivid multi-color palettes score highest.
    expect(colorfulness(browse[0])).toBe(0);
    expect(colorfulness(browse[4])).toBeGreaterThan(colorfulness(browse[3]));
  });
});

describe("SVG path parsing (FR-5, AC-2)", () => {
  it("parses M/L/Z into a closed subpath", () => {
    const subs = parsePathData("M0 0 L10 0 L10 10 Z");
    expect(subs).toHaveLength(1);
    expect(subs[0].closed).toBe(true);
    expect(subs[0].segments.map((s) => [s.x, s.y])).toEqual([[0, 0], [10, 0], [10, 10]]);
  });

  it("handles relative commands and implicit lineto", () => {
    const subs = parsePathData("m5 5 l5 0 5 5");
    expect(subs[0].segments.map((s) => [s.x, s.y])).toEqual([[5, 5], [10, 5], [15, 10]]);
  });

  it("records cubic controls as cOut on prev and cIn on next", () => {
    const subs = parsePathData("M0 0 C1 2 3 4 5 6");
    const [a, b] = subs[0].segments;
    expect(a.cOut).toEqual({ x: 1, y: 2 });
    expect(b).toMatchObject({ x: 5, y: 6, cIn: { x: 3, y: 4 } });
  });

  it("splits multiple subpaths on repeated M", () => {
    const subs = parsePathData("M0 0 L1 1 M5 5 L6 6");
    expect(subs).toHaveLength(2);
  });
});

describe("svgToNodes (FR-5, AC-2)", () => {
  it("converts primitives into editable nodes with fills", () => {
    const svg = '<svg><rect x="2" y="3" width="20" height="10" fill="#ff0000"/><circle cx="50" cy="50" r="5" fill="none"/><path d="M0 0 L10 10" fill="#00ff00"/></svg>';
    const { nodes } = svgToNodes(svg, idgen());
    expect(nodes).toHaveLength(3);
    const rect = nodes[0] as unknown as { shape: string; transform: { x: number }; fills: { color: { srgb: { r: number } } }[] };
    expect(rect.shape).toBe("rect");
    expect(rect.transform.x).toBe(2);
    expect(rect.fills[0].color.srgb.r).toBe(1);
    const circle = nodes[1] as unknown as { shape: string; fills: unknown[] };
    expect(circle.shape).toBe("ellipse");
    expect(circle.fills).toHaveLength(0); // fill="none"
    expect(nodes[2].type).toBe("path");
  });

  it("flags arc approximation", () => {
    const { approximated } = svgToNodes('<svg><path d="M0 0 A5 5 0 0 1 10 10"/></svg>', idgen());
    expect(approximated).toBe(true);
  });

  it("keeps a compound path as ONE node whose extra subpaths become contours (holes)", () => {
    // A ring: outer square with an inner square that must cut a hole, not
    // become a second solid node stacked on top.
    const svg = '<svg><path d="M0 0 L100 0 L100 100 L0 100 Z M25 25 L75 25 L75 75 L25 75 Z" fill="#000000"/></svg>';
    const { nodes } = svgToNodes(svg, idgen());
    expect(nodes).toHaveLength(1);
    const p = nodes[0] as unknown as {
      type: string;
      closed: boolean;
      size: { width: number; height: number };
      segments: { x: number; y: number }[];
      contours?: { segments: { x: number; y: number }[]; closed: boolean }[];
    };
    expect(p.type).toBe("path");
    expect(p.closed).toBe(true);
    expect(p.segments.map((s) => [s.x, s.y])).toEqual([[0, 0], [100, 0], [100, 100], [0, 100]]);
    expect(p.contours).toHaveLength(1);
    expect(p.contours![0].closed).toBe(true);
    expect(p.contours![0].segments.map((s) => [s.x, s.y])).toEqual([[25, 25], [75, 25], [75, 75], [25, 75]]);
    // The node box spans every contour.
    expect(p.size).toEqual({ width: 100, height: 100 });
  });

  it("omits contours for a single-subpath path", () => {
    const { nodes } = svgToNodes('<svg><path d="M0 0 L10 0 L10 10 Z" fill="#000"/></svg>', idgen());
    expect((nodes[0] as unknown as { contours?: unknown[] }).contours).toBeUndefined();
  });

  it("imports <text> as an editable text box (content, size, color, weight)", () => {
    const svg = '<svg><text x="10" y="40" font-size="32" font-weight="700" fill="#0000ff" text-anchor="start">Hello &amp; world</text></svg>';
    const { nodes } = svgToNodes(svg, idgen());
    expect(nodes).toHaveLength(1);
    const t = nodes[0] as unknown as { type: string; content: { runs: { text: string; style: { fontSize: number; axes?: { wght: number }; fill: { color: { srgb: { b: number } } } } }[] }[]; transform: { x: number; y: number } };
    expect(t.type).toBe("text");
    expect(t.content[0].runs[0].text).toBe("Hello & world"); // entity decoded, tspans stripped
    expect(t.content[0].runs[0].style.fontSize).toBe(32);
    expect(t.content[0].runs[0].style.axes?.wght).toBe(700);
    expect(t.content[0].runs[0].style.fill.color.srgb.b).toBe(1);
    expect(t.transform.x).toBe(10); // text-anchor start -> left edge at x
  });

  it("reads fill/font from the CSS style attribute (how design tools commonly export text)", () => {
    const svg = '<svg><text x="0" y="20" style="font-size:48px;font-weight:700;fill:#00ff00;text-anchor:middle">Hi</text></svg>';
    const t = svgToNodes(svg, idgen()).nodes[0] as unknown as { content: { runs: { style: { fontSize: number; axes?: { wght: number }; fill: { color: { srgb: { g: number } } } } }[]; style: { align: string } }[] };
    expect(t.content[0].runs[0].style.fontSize).toBe(48);
    expect(t.content[0].runs[0].style.axes?.wght).toBe(700);
    expect(t.content[0].runs[0].style.fill.color.srgb.g).toBe(1);
    expect(t.content[0].style.align).toBe("center");
  });

  it("imports <image> as an image node and reports the asset url, preserving order", () => {
    const svg = '<svg><rect x="0" y="0" width="4" height="4"/><image x="5" y="6" width="80" height="60" href="https://ex.com/a.png"/></svg>';
    const { nodes, assets } = svgToNodes(svg, idgen());
    expect(nodes.map((n) => n.type)).toEqual(["shape", "image"]); // document order kept
    const img = nodes[1] as unknown as { type: string; source: { assetId: string }; size: { width: number; height: number } };
    expect(img.size).toEqual({ width: 80, height: 60 });
    expect(assets).toHaveLength(1);
    expect(assets[0].url).toBe("https://ex.com/a.png");
    expect(assets[0].assetId).toBe(img.source.assetId);
  });
});

describe("stock insertion (FR-5, AC-2)", () => {
  it("inserts a photo as an image node with an AssetRef and provenance", () => {
    const r = stockToNodes(stock("p", { width: 800, height: 600 }), idgen());
    expect(r.nodes[0].type).toBe("image");
    expect(r.assetRef).toMatchObject({ id: "p", kind: "image", url: "https://cdn/p.jpg" });
    const prov = (r.nodes[0] as unknown as { data: { provenance: NodeProvenance } }).data.provenance;
    expect(prov).toMatchObject({ origin: "stock", stockAssetId: "p" });
  });

  it("inserts an icon's SVG as editable vector nodes (no AssetRef)", () => {
    const icon = stock("ic", { kind: "icon", format: "svg", svg: '<svg><path d="M0 0 L10 0 L10 10 Z" fill="#123456"/></svg>' });
    const r = stockToNodes(icon, idgen());
    expect(r.assetRef).toBeUndefined();
    expect(r.nodes[0].type).toBe("path");
  });

  it("inserts video/audio as their media nodes", () => {
    expect(stockToNodes(stock("v", { kind: "video", format: "mp4" }), idgen()).nodes[0].type).toBe("video");
    expect(stockToNodes(stock("a", { kind: "audio", format: "mp3" }), idgen()).nodes[0].type).toBe("audio");
  });
});

describe("attribution compilation (FR-14, AC-7)", () => {
  function design(): DesignFile {
    const d = createBlankDesign();
    const lic = { type: "cc-by" as const, attributionRequired: true, attributionText: "Photo by X", attributionUrl: "https://x" };
    const prov: NodeProvenance = { origin: "stock", stockAssetId: "s1", license: lic };
    const n1 = withProvenance(createNode("shape", { id: "n1" } as Partial<Node>), prov);
    const n2 = withProvenance(createNode("shape", { id: "n2" } as Partial<Node>), prov);
    const free = withProvenance(createNode("shape", { id: "n3" } as Partial<Node>), { origin: "stock", stockAssetId: "s2", license: { type: "cc0", attributionRequired: false } });
    d.pages[0].children = [n1, n2, free];
    return d;
  }

  it("compiles one entry per attribution-required asset with contributing node ids", () => {
    const entries = compileAttribution(design());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ assetId: "s1", attributionText: "Photo by X" });
    expect(entries[0].nodeIds.sort()).toEqual(["n1", "n2"]);
    expect(attributionText(entries)).toContain("Photo by X (https://x)");
  });
});

describe("mini-app scopes (FR-8, AC-8)", () => {
  const app: Pick<MiniApp, "scopes"> = { scopes: ["insert-node", "edit-own-nodes"] };

  it("allows in-scope actions and denies out-of-scope with a reason", () => {
    expect(checkAppAction(app, "insert-node").allowed).toBe(true);
    const denied = checkAppAction(app, "network");
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("network");
    expect(() => assertAppAction(app, "read-selection")).toThrow();
  });

  it("restricts edits to owned nodes", () => {
    const owned = new Set(["a"]);
    expect(canEditNode(app, owned, "a")).toBe(true);
    expect(canEditNode(app, owned, "b")).toBe(false);
  });
});

describe("embed classification (FR-12, AC-6)", () => {
  it("classifies known providers and flags generic", () => {
    expect(classifyEmbed("https://www.youtube.com/watch?v=abc")).toBe("youtube");
    expect(classifyEmbed("https://vimeo.com/123")).toBe("vimeo");
    expect(classifyEmbed("https://example.com/x")).toBe("generic");
  });

  it("validates allowed providers and rejects private/unknown", () => {
    expect(validateEmbedUrl("https://youtu.be/abc").ok).toBe(true);
    expect(validateEmbedUrl("https://127.0.0.1/x").ok).toBe(false);
    expect(validateEmbedUrl("http://youtube.com/x").ok).toBe(false); // https only
    expect(validateEmbedUrl("https://example.com/x").ok).toBe(false); // generic
    expect(validateEmbedUrl("https://example.com/x", { allowGeneric: true }).ok).toBe(true);
  });
});

describe("QR node (FR-10, AC-5)", () => {
  it("creates a bound QR node and rebinds its value", () => {
    const node = createQrNode("https://oc/x", { ecLevel: "H" });
    expect(node.type).toBe("qr");
    expect(qrValue(node)).toBe("https://oc/x");
    expect((node as unknown as { ecLevel: string }).ecLevel).toBe("H");
    const rebound = rebindQrValue(node, "https://oc/y");
    expect(qrValue(rebound)).toBe("https://oc/y");
    expect(qrValue(node)).toBe("https://oc/x"); // original unchanged
  });
});
