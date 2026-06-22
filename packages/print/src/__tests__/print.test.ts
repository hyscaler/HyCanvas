import { describe, it, expect } from "vitest";
import { createBlankDesign, type DesignFile, type Node } from "@hc/schema";
import type { PreflightReport } from "@hc/export";
import {
  // geometry
  mmToPx,
  pxToMm,
  mmToPt,
  printRects,
  fitDesignToProduct,
  effectivePpi,
  qualityBadge,
  // preflight
  runPrintPreflight,
  evaluateGate,
  aggregateStatus,
  // catalog
  PRINT_CATALOG,
  filterCatalog,
  findProduct,
  findSize,
  VendorRegistry,
  MockVendor,
  // cost
  quote,
  quantityTierMultiplier,
  // mockup
  placeOnTemplate,
  mockupOutputSize,
  // order
  orderTransition,
  canTransition,
  canCancel,
  reorderItems,
  splitByAddress,
  orderTotal,
  OrderTransitionError,
  type PrintProduct,
  type MockupTemplate,
  type PrintOrderItem,
  type Address,
  type CostBreakdown,
} from "../index";

// --- helpers ----------------------------------------------------------------

function product(over: Partial<PrintProduct> = {}): PrintProduct {
  return {
    id: "bc",
    category: "business_card",
    name: "Business Cards",
    sizes: [{ id: "std", label: "85x55", widthMm: 85, heightMm: 55 }],
    substrates: [
      { id: "matte", label: "Matte", priceDeltaCents: 0 },
      { id: "soft", label: "Soft Touch", priceDeltaCents: 200 },
    ],
    finishes: [
      { id: "none", label: "None", priceDeltaCents: 0 },
      { id: "foil", label: "Foil", priceDeltaCents: 500 },
    ],
    sides: 2,
    requiredDpi: 300,
    colorSpace: "CMYK",
    iccProfile: "FOGRA39",
    bleedMm: 3,
    safeZoneMm: 3,
    regions: ["US", "GB"],
    productionDays: 3,
    basePriceCents: { std: 1000 },
    ...over,
  };
}

function imageNode(id: string, naturalWH: number, displayWH: number, x = 100, y = 100): Node {
  return {
    id,
    type: "image",
    transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: displayWH, height: displayWH },
    opacity: 1,
    blendMode: "normal",
    source: { assetId: "a1", naturalWidth: naturalWH, naturalHeight: naturalWH },
    fit: "cover",
  } as unknown as Node;
}

function address(over: Partial<Address> = {}): Address {
  return { name: "A", line1: "1 St", city: "Town", postalCode: "12345", country: "US", ...over };
}

function orderItem(id: string, over: Partial<PrintOrderItem> = {}): PrintOrderItem {
  return {
    id,
    designId: "d",
    productId: "bc",
    sizeId: "std",
    substrateId: "matte",
    quantity: 10,
    printFileKey: "key-" + id,
    shipping: { address: address() },
    ...over,
  };
}

// --- geometry ---------------------------------------------------------------

describe("unit conversions", () => {
  it("mmToPx / pxToMm round-trip at a dpi", () => {
    expect(mmToPx(25.4, 300)).toBeCloseTo(300, 6); // 1 inch
    expect(pxToMm(300, 300)).toBeCloseTo(25.4, 6);
    expect(pxToMm(mmToPx(50, 150), 150)).toBeCloseTo(50, 6);
    expect(pxToMm(10, 0)).toBe(0);
  });

  it("mmToPt converts mm to PostScript points", () => {
    expect(mmToPt(25.4)).toBeCloseTo(72, 6); // 1 inch = 72pt
    expect(mmToPt(0)).toBe(0);
  });
});

describe("printRects (FR-2/FR-4 insets)", () => {
  it("nests bleed > trim > safe with correct insets", () => {
    const r = printRects(85, 55, 3, 4);
    // bleed box is outermost, origin top-left.
    expect(r.bleed).toEqual({ x: 0, y: 0, width: 91, height: 61 });
    // trim inset by bleedMm on all sides.
    expect(r.trim).toEqual({ x: 3, y: 3, width: 85, height: 55 });
    // safe inset a further safeZoneMm inside trim.
    expect(r.safe).toEqual({ x: 7, y: 7, width: 85 - 8, height: 55 - 8 });
  });

  it("clamps negative safe dimensions to zero and handles zero bleed", () => {
    const r = printRects(10, 10, 0, 8);
    expect(r.bleed).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(r.trim).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(r.safe.width).toBe(0); // 10 - 16 clamped
    expect(r.safe.height).toBe(0);
  });
});

describe("fitDesignToProduct (cover fit)", () => {
  it("cover-fits a design to the bleed box and centres it", () => {
    const p = product(); // size 85x55, bleed 3 -> bleed box 91x61 mm
    // square design 100x100 px -> cover scale = max(91/100, 61/100) = 0.91
    const fit = fitDesignToProduct(100, 100, p, "std");
    expect(fit.mode).toBe("cover");
    expect(fit.scale).toBeCloseTo(0.91, 6);
    // scaled 91x91; offsets centre in 91x61 box.
    expect(fit.offsetX).toBeCloseTo(0, 6);
    expect(fit.offsetY).toBeCloseTo((61 - 91) / 2, 6);
  });

  it("contain mode uses the smaller scale", () => {
    const p = product();
    const fit = fitDesignToProduct(100, 100, p, "std", "contain");
    expect(fit.scale).toBeCloseTo(0.61, 6); // min(0.91, 0.61)
  });

  it("throws on unknown size or non-positive design", () => {
    expect(() => fitDesignToProduct(100, 100, product(), "nope")).toThrow();
    expect(() => fitDesignToProduct(0, 100, product(), "std")).toThrow();
  });
});

describe("effectivePpi + qualityBadge", () => {
  it("computes ppi from natural vs rendered px", () => {
    // 600 natural px rendered at 300px @300dpi -> rendered = 1 inch -> 600 ppi
    expect(effectivePpi(600, 300, 300)).toBeCloseTo(600, 6);
    expect(effectivePpi(0, 300, 300)).toBe(0);
  });

  it("badge thresholds: good >= required, warn >= 75%, else fail", () => {
    expect(qualityBadge(300, 300)).toBe("good");
    expect(qualityBadge(400, 300)).toBe("good");
    expect(qualityBadge(250, 300)).toBe("warn"); // 250 >= 225
    expect(qualityBadge(225, 300)).toBe("warn");
    expect(qualityBadge(224, 300)).toBe("fail");
    expect(qualityBadge(10, 0)).toBe("good"); // no requirement
  });
});

// --- preflight --------------------------------------------------------------

describe("runPrintPreflight (FR-5)", () => {
  it("flags a low-res image with the offending nodeId as an error", () => {
    const d = createBlankDesign({ width: 800, height: 600 }); // dpi 96
    // 100 src px at 200px @96dpi -> ~48 ppi, well under 300 (and under 75% -> error)
    d.pages[0].children = [imageNode("img", 100, 200, 50, 50)];
    d.pages[0].bleed = 3; // avoid the bleed error confusing this assertion
    const res = runPrintPreflight(d, product(), "std");
    const dpi = res.checks.find((c) => c.code === "dpi" && c.level !== "pass");
    expect(dpi).toBeDefined();
    expect(dpi!.nodeId).toBe("img");
    expect(dpi!.level).toBe("error");
    expect(res.status).toBe("error");
  });

  it("warns on a node outside the safe zone with its nodeId", () => {
    const d = createBlankDesign({ width: 800, height: 600 });
    d.pages[0].bleed = 3;
    // node flush to the top-left edge -> outside the safe inset.
    d.pages[0].children = [imageNode("edge", 4000, 100, 0, 0)];
    const res = runPrintPreflight(d, product(), "std");
    const sz = res.checks.find((c) => c.code === "safe_zone" && c.level === "warn");
    expect(sz).toBeDefined();
    expect(sz!.nodeId).toBe("edge");
  });

  it("flags missing bleed as an error via the reused export pass", () => {
    const d = createBlankDesign({ width: 800, height: 600 }); // no bleed on the page
    d.pages[0].children = [imageNode("img", 4000, 100, 100, 100)];
    const res = runPrintPreflight(d, product(), "std");
    const bleed = res.checks.find((c) => c.code === "bleed");
    expect(bleed!.level).toBe("error");
    expect(res.status).toBe("error");
  });

  it("surfaces a low-res image through an injected reused export report", () => {
    // Prove the reuse path: feed an export PreflightReport in and confirm the
    // print preflight surfaces it as a dpi check on the right node.
    const d = createBlankDesign({ width: 800, height: 600 });
    d.pages[0].bleed = 3;
    const report: PreflightReport = {
      lowResImages: [{ nodeId: "lowres", ppi: 90 }],
      outOfGamut: [],
      missingBleed: false,
      fontIssues: [],
    };
    const res = runPrintPreflight(d, product(), "std", { exportReport: report });
    const dpi = res.checks.find((c) => c.code === "dpi" && c.level !== "pass");
    expect(dpi!.nodeId).toBe("lowres");
    expect(dpi!.level).toBe("error"); // 90 < 300*0.75
  });

  it("warns on font issues from the reused export report", () => {
    const d = createBlankDesign({ width: 800, height: 600 });
    d.pages[0].bleed = 3;
    const report: PreflightReport = {
      lowResImages: [],
      outOfGamut: [],
      missingBleed: false,
      fontIssues: [{ fontId: "f1", reason: "no embedding" }],
    };
    const res = runPrintPreflight(d, product(), "std", { exportReport: report });
    const fe = res.checks.find((c) => c.code === "font_embed");
    expect(fe!.level).toBe("error");
    expect(fe!.message).toContain("f1");
  });

  it("passes a clean design (bleed set, high-res image, no font issues)", () => {
    const d = createBlankDesign({ width: 800, height: 600 });
    d.pages[0].bleed = 3;
    // 8000 src px at 100px @96dpi -> very high ppi.
    d.pages[0].children = [imageNode("img", 8000, 100, 100, 100)];
    const res = runPrintPreflight(d, product(), "std", {
      exportReport: { lowResImages: [], outOfGamut: [], missingBleed: false, fontIssues: [] },
    });
    // color_space warns (RGB design on CMYK product) so overall is warn, not error.
    expect(res.status).toBe("warn");
    expect(res.checks.find((c) => c.code === "bleed")!.level).toBe("pass");
  });
});

describe("aggregateStatus + evaluateGate (FR-6)", () => {
  it("aggregates error > warn > pass", () => {
    expect(aggregateStatus([{ code: "dpi", level: "pass", message: "", overridable: false }])).toBe("pass");
    expect(
      aggregateStatus([
        { code: "dpi", level: "pass", message: "", overridable: false },
        { code: "safe_zone", level: "warn", message: "", overridable: true },
      ]),
    ).toBe("warn");
    expect(
      aggregateStatus([
        { code: "safe_zone", level: "warn", message: "", overridable: true },
        { code: "bleed", level: "error", message: "", overridable: true },
      ]),
    ).toBe("error");
  });

  it("blocks on an error unless its code is overridden", () => {
    const res = {
      designId: "d",
      productId: "bc",
      sizeId: "std",
      status: "error" as const,
      ranAt: "",
      checks: [
        { code: "dpi" as const, level: "error" as const, message: "", nodeId: "img", overridable: true },
      ],
    };
    expect(evaluateGate(res).canOrder).toBe(false);
    const gated = evaluateGate(res, new Set(["dpi"] as const));
    expect(gated.canOrder).toBe(true);
    expect(gated.acknowledged).toHaveLength(1);
    expect(gated.blocking).toHaveLength(0);
  });

  it("never lets a non-overridable error pass", () => {
    const res = {
      designId: "d",
      productId: "bc",
      sizeId: "std",
      status: "error" as const,
      ranAt: "",
      checks: [{ code: "font_embed" as const, level: "error" as const, message: "", overridable: false }],
    };
    expect(evaluateGate(res, new Set(["font_embed"] as const)).canOrder).toBe(false);
  });

  it("requires acknowledgment of warnings before ordering", () => {
    const res = {
      designId: "d",
      productId: "bc",
      sizeId: "std",
      status: "warn" as const,
      ranAt: "",
      checks: [
        { code: "safe_zone" as const, level: "warn" as const, message: "", nodeId: "n", overridable: true },
        { code: "bleed" as const, level: "pass" as const, message: "", overridable: false },
      ],
    };
    expect(evaluateGate(res).canOrder).toBe(false); // warn not acknowledged
    expect(evaluateGate(res, new Set(["safe_zone"] as const)).canOrder).toBe(true);
  });
});

// --- catalog + vendor registry ----------------------------------------------

describe("catalog (FR-1/FR-14)", () => {
  it("seed catalog includes the required product categories", () => {
    const cats = new Set(PRINT_CATALOG.map((p) => p.category));
    for (const c of ["business_card", "flyer", "poster", "sticker", "mug", "tshirt"]) {
      expect(cats.has(c)).toBe(true);
    }
  });

  it("filters by category and region", () => {
    expect(filterCatalog(PRINT_CATALOG, { category: "poster" }).every((p) => p.category === "poster")).toBe(true);
    const inIndia = filterCatalog(PRINT_CATALOG, { region: "IN" });
    expect(inIndia.every((p) => p.regions.includes("IN"))).toBe(true);
    // poster is not available in IN in the seed.
    expect(inIndia.find((p) => p.category === "poster")).toBeUndefined();
  });

  it("findProduct / findSize resolve by id", () => {
    const bc = findProduct(PRINT_CATALOG, "business_card_std");
    expect(bc).toBeDefined();
    expect(findSize(bc!, "bc_85x55")).toBeDefined();
    expect(findSize(bc!, "nope")).toBeUndefined();
  });
});

describe("VendorRegistry (FR-14)", () => {
  it("resolves a vendor by region and capability", async () => {
    const reg = new VendorRegistry();
    reg.register(new MockVendor("v_us", ["US"], ["poster"]));
    reg.register(new MockVendor("v_eu", ["DE", "GB"], ["business_card", "foil"]));

    expect(reg.resolve({ region: "US" })!.id).toBe("v_us");
    expect(reg.resolve({ region: "DE" })!.id).toBe("v_eu");
    expect(reg.resolve({ region: "FR" })).toBeUndefined();
    expect(reg.resolve({ region: "DE", capability: "foil" })!.id).toBe("v_eu");
    expect(reg.resolve({ region: "US", capability: "foil" })).toBeUndefined();
    expect(reg.resolveAll({ region: "GB" })).toHaveLength(1);
  });

  it("MockVendor lists region products and echoes a vendor order id without network", async () => {
    const v = new MockVendor();
    const products = await v.listProducts("US");
    expect(products.length).toBeGreaterThan(0);
    const sub = await v.submitOrder({ id: "o1" } as never);
    expect(sub.vendorOrderId).toBe("mock-o1");
    const wh = v.parseWebhook({ vendorOrderId: "mock-o1", status: "shipped" });
    expect(wh).toMatchObject({ vendorOrderId: "mock-o1", status: "shipped" });
  });
});

// --- cost -------------------------------------------------------------------

describe("quantityTierMultiplier", () => {
  it("discounts at the 10/50/100 tiers", () => {
    expect(quantityTierMultiplier(1)).toBe(1);
    expect(quantityTierMultiplier(9)).toBe(1);
    expect(quantityTierMultiplier(10)).toBe(0.9);
    expect(quantityTierMultiplier(50)).toBe(0.8);
    expect(quantityTierMultiplier(100)).toBe(0.7);
  });
});

describe("quote (FR-8)", () => {
  it("assembles base + options + tax + shipping - subsidy = total", () => {
    const p = product(); // base 1000/unit for size std
    // qty 10 -> tier 0.9; substrate soft +200; finish foil +500.
    const q = quote(p, "std", "soft", "foil", 10, {
      shippingCents: 500,
      taxRate: 0.1,
      subsidyCents: 300,
    });
    const expectedBase = Math.round(1000 * 10 * 0.9); // 9000
    const expectedOptions = (200 + 500) * 10; // 7000
    const expectedTax = Math.round(0.1 * (expectedBase + expectedOptions)); // 1600
    expect(q.baseCents).toBe(expectedBase);
    expect(q.optionsCents).toBe(expectedOptions);
    expect(q.taxesCents).toBe(expectedTax);
    expect(q.shippingCents).toBe(500);
    expect(q.subsidyCents).toBe(300);
    expect(q.totalCents).toBe(expectedBase + expectedOptions + 500 + expectedTax - 300);
    expect(q.currency).toBe("USD");
  });

  it("tier discount lowers per-unit base as quantity grows", () => {
    const p = product();
    const q1 = quote(p, "std", "matte", undefined, 1);
    const q100 = quote(p, "std", "matte", undefined, 100);
    expect(q1.baseCents).toBe(1000);
    expect(q100.baseCents).toBe(Math.round(1000 * 100 * 0.7)); // 70000
    // per-unit at 100 is cheaper than at 1.
    expect(q100.baseCents / 100).toBeLessThan(q1.baseCents);
  });

  it("validates quantity, size, substrate, finish", () => {
    const p = product();
    expect(() => quote(p, "std", "matte", undefined, 0)).toThrow();
    expect(() => quote(p, "nope", "matte", undefined, 1)).toThrow();
    expect(() => quote(p, "std", "nope", undefined, 1)).toThrow();
    expect(() => quote(p, "std", "matte", "nope", 1)).toThrow();
  });

  it("total never drops below zero with a large subsidy", () => {
    const q = quote(product(), "std", "matte", undefined, 1, { subsidyCents: 999999 });
    expect(q.totalCents).toBe(0);
  });
});

// --- mockup -----------------------------------------------------------------

describe("placeOnTemplate (FR-3 geometry)", () => {
  const template: MockupTemplate = {
    id: "t1",
    productCategory: "tshirt",
    name: "Tee front",
    kind: "apparel",
    surface: { maskKey: "tee-front", lightingKey: "soft", warpMesh: [[0.1, 0.1], [0.9, 0.1]] },
    surfaceAspect: 1,
    outputWidth: 1000,
    outputHeight: 1500,
  };

  it("contain-fits the design and passes through mesh/mask/lighting", () => {
    // wide design (aspect 2) into a square surface -> limited by width.
    const pl = placeOnTemplate(2, template);
    expect(pl.transform.mode).toBe("contain");
    expect(pl.transform.scale).toBeCloseTo(1, 6); // width-limited
    expect(pl.maskKey).toBe("tee-front");
    expect(pl.lightingKey).toBe("soft");
    expect(pl.warpMesh).toEqual([[0.1, 0.1], [0.9, 0.1]]);
    // centred vertically (design half as tall as wide).
    expect(pl.transform.offsetY).toBeGreaterThan(0);
    expect(pl.transform.offsetX).toBeCloseTo(0, 6);
  });

  it("uses an identity mesh when the template has none and throws on bad aspect", () => {
    const t: MockupTemplate = { ...template, surface: { maskKey: "m" } };
    const pl = placeOnTemplate(1, t);
    expect(pl.warpMesh).toHaveLength(4);
    expect(() => placeOnTemplate(0, t)).toThrow();
  });

  it("mockupOutputSize honors template dims and defaults otherwise", () => {
    expect(mockupOutputSize(template)).toEqual({ width: 1000, height: 1500 });
    expect(mockupOutputSize({ ...template, outputWidth: undefined, outputHeight: undefined })).toEqual({
      width: 1200,
      height: 1200,
    });
  });
});

// --- order ------------------------------------------------------------------

describe("orderTransition (FR-11) state machine", () => {
  it("allows the canonical lifecycle transitions", () => {
    expect(orderTransition("draft", "submit")).toBe("submitted");
    expect(orderTransition("submitted", "produce")).toBe("in_production");
    expect(orderTransition("in_production", "ship")).toBe("shipped");
    expect(orderTransition("shipped", "deliver")).toBe("delivered");
    expect(orderTransition("submitted", "problem")).toBe("problem");
    expect(orderTransition("problem", "submit")).toBe("submitted"); // resubmit to alternate vendor
  });

  it("rejects illegal transitions", () => {
    expect(() => orderTransition("delivered", "cancel")).toThrow(OrderTransitionError);
    expect(() => orderTransition("draft", "ship")).toThrow();
    expect(() => orderTransition("in_production", "cancel")).toThrow(); // post-production cancel
    expect(canTransition("shipped", "produce")).toBe(false);
  });
});

describe("canCancel (FR-12)", () => {
  it("only pre-production statuses can cancel", () => {
    expect(canCancel("draft")).toBe(true);
    expect(canCancel("submitted")).toBe(true);
    expect(canCancel("problem")).toBe(true);
    expect(canCancel("in_production")).toBe(false);
    expect(canCancel("shipped")).toBe(false);
    expect(canCancel("delivered")).toBe(false);
  });
});

describe("reorderItems (FR-12)", () => {
  it("clones items with new ids, cleared print file and tracking", () => {
    const items = [
      orderItem("a", {
        printFileKey: "old",
        shipping: {
          address: address(),
          carrier: "ups",
          trackingNumber: "1Z",
          method: "express",
          status: "shipped",
        },
        cost: { currency: "USD", baseCents: 1, optionsCents: 0, shippingCents: 0, taxesCents: 0, subsidyCents: 0, totalCents: 1 },
      }),
    ];
    const cloned = reorderItems({ items });
    expect(cloned[0].id).not.toBe("a");
    expect(cloned[0].printFileKey).toBe("");
    expect(cloned[0].shipping.carrier).toBeUndefined();
    expect(cloned[0].shipping.trackingNumber).toBeUndefined();
    expect(cloned[0].shipping.address).toEqual(items[0].shipping.address);
    expect(cloned[0].cost).toBeUndefined();
    // original is untouched.
    expect(items[0].id).toBe("a");
    expect(items[0].printFileKey).toBe("old");
  });
});

describe("splitByAddress (FR-13)", () => {
  it("groups items by destination address", () => {
    const items = [
      orderItem("a", { shipping: { address: address({ name: "Alice", line1: "1 A St" }) } }),
      orderItem("b", { shipping: { address: address({ name: "Bob", line1: "2 B St" }) } }),
      orderItem("c", { shipping: { address: address({ name: "Alice", line1: "1 A St" }) } }),
    ];
    const groups = splitByAddress(items);
    expect(groups).toHaveLength(2);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "c"]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["b"]);
  });
});

describe("orderTotal (FR-13)", () => {
  function cost(over: Partial<CostBreakdown>): CostBreakdown {
    return { currency: "USD", baseCents: 0, optionsCents: 0, shippingCents: 0, taxesCents: 0, subsidyCents: 0, totalCents: 0, ...over };
  }

  it("sums per-line breakdowns", () => {
    const items = [
      orderItem("a", { cost: cost({ baseCents: 1000, shippingCents: 200, totalCents: 1200 }) }),
      orderItem("b", { cost: cost({ baseCents: 500, taxesCents: 50, totalCents: 550 }) }),
      orderItem("c"), // no cost -> contributes zero
    ];
    const total = orderTotal(items);
    expect(total.baseCents).toBe(1500);
    expect(total.shippingCents).toBe(200);
    expect(total.taxesCents).toBe(50);
    expect(total.totalCents).toBe(1750);
    expect(total.currency).toBe("USD");
  });

  it("throws on mixed currencies", () => {
    const items = [
      orderItem("a", { cost: cost({ currency: "USD", totalCents: 1 }) }),
      orderItem("b", { cost: cost({ currency: "EUR", totalCents: 1 }) }),
    ];
    expect(() => orderTotal(items)).toThrow(/mixed currencies/);
  });
});
