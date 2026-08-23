// Print product catalog and vendor registry (F35 FR-1/FR-14). The seed catalog
// is a small, realistic set used in tests and as a default; runtime resolves the
// live catalog per region via the vendor adapters. The `VendorRegistry` mirrors
// the platform-connector / AI-adapter pattern so new vendors/regions
// register without touching the order flow.

import type { CostBreakdown, PrintProduct, PrintSize, ShipmentInfo } from "./types";
import type { PrintOrder } from "./types";

/** A small, realistic seed catalog. Prices are illustrative at-cost figures. */
export const printCatalog: PrintProduct[] = [
  {
    id: "business_card_std",
    category: "business_card",
    name: "Business Cards",
    sizes: [
      { id: "bc_85x55", label: "85 x 55 mm", widthMm: 85, heightMm: 55 },
      { id: "bc_89x51", label: "US 3.5 x 2 in", widthMm: 88.9, heightMm: 50.8 },
    ],
    substrates: [
      { id: "matte_350", label: "350gsm Matte", priceDeltaCents: 0 },
      { id: "gloss_350", label: "350gsm Gloss", priceDeltaCents: 50 },
      { id: "soft_touch_400", label: "400gsm Soft Touch", priceDeltaCents: 200 },
    ],
    finishes: [
      { id: "none", label: "No finish", priceDeltaCents: 0 },
      { id: "spot_uv", label: "Spot UV", priceDeltaCents: 300 },
      { id: "foil_gold", label: "Gold Foil", priceDeltaCents: 500 },
    ],
    sides: 2,
    requiredDpi: 300,
    colorSpace: "CMYK",
    iccProfile: "FOGRA39",
    bleedMm: 3,
    safeZoneMm: 3,
    regions: ["US", "GB", "DE", "IN"],
    productionDays: 3,
    basePriceCents: { bc_85x55: 1500, bc_89x51: 1500 },
  },
  {
    id: "flyer_std",
    category: "flyer",
    name: "Flyers",
    sizes: [
      { id: "a5", label: "A5 (148 x 210 mm)", widthMm: 148, heightMm: 210 },
      { id: "a4", label: "A4 (210 x 297 mm)", widthMm: 210, heightMm: 297 },
    ],
    substrates: [
      { id: "matte_170", label: "170gsm Matte", priceDeltaCents: 0 },
      { id: "gloss_250", label: "250gsm Gloss", priceDeltaCents: 80 },
    ],
    finishes: [{ id: "none", label: "No finish", priceDeltaCents: 0 }],
    sides: 2,
    requiredDpi: 300,
    colorSpace: "CMYK",
    iccProfile: "FOGRA39",
    bleedMm: 3,
    safeZoneMm: 4,
    regions: ["US", "GB", "DE", "IN", "AU"],
    productionDays: 4,
    basePriceCents: { a5: 2500, a4: 3500 },
  },
  {
    id: "poster_std",
    category: "poster",
    name: "Posters",
    sizes: [
      { id: "a2", label: "A2 (420 x 594 mm)", widthMm: 420, heightMm: 594 },
      { id: "a1", label: "A1 (594 x 841 mm)", widthMm: 594, heightMm: 841 },
    ],
    substrates: [
      { id: "matte_200", label: "200gsm Matte", priceDeltaCents: 0 },
      { id: "satin_240", label: "240gsm Satin", priceDeltaCents: 150 },
    ],
    finishes: [
      { id: "none", label: "No finish", priceDeltaCents: 0 },
      { id: "lamination", label: "Lamination", priceDeltaCents: 400 },
    ],
    sides: 1,
    requiredDpi: 150,
    colorSpace: "CMYK",
    iccProfile: "FOGRA39",
    bleedMm: 5,
    safeZoneMm: 5,
    regions: ["US", "GB", "DE"],
    productionDays: 5,
    basePriceCents: { a2: 1200, a1: 2200 },
  },
  {
    id: "sticker_std",
    category: "sticker",
    name: "Stickers",
    sizes: [
      { id: "sq50", label: "50 x 50 mm", widthMm: 50, heightMm: 50 },
      { id: "sq100", label: "100 x 100 mm", widthMm: 100, heightMm: 100 },
    ],
    substrates: [
      { id: "vinyl_white", label: "White Vinyl", priceDeltaCents: 0 },
      { id: "vinyl_clear", label: "Clear Vinyl", priceDeltaCents: 100 },
    ],
    finishes: [
      { id: "matte", label: "Matte", priceDeltaCents: 0 },
      { id: "gloss", label: "Gloss", priceDeltaCents: 0 },
    ],
    sides: 1,
    requiredDpi: 300,
    colorSpace: "CMYK",
    iccProfile: "FOGRA39",
    bleedMm: 2,
    safeZoneMm: 2,
    regions: ["US", "GB", "DE", "IN", "AU", "CA"],
    productionDays: 4,
    basePriceCents: { sq50: 800, sq100: 1200 },
  },
  {
    id: "mug_std",
    category: "mug",
    name: "Mugs",
    sizes: [{ id: "mug11", label: "11 oz", widthMm: 200, heightMm: 90 }],
    substrates: [{ id: "ceramic_white", label: "White Ceramic", priceDeltaCents: 0 }],
    finishes: [{ id: "gloss", label: "Gloss", priceDeltaCents: 0 }],
    sides: 1,
    requiredDpi: 150,
    colorSpace: "RGB",
    bleedMm: 0,
    safeZoneMm: 5,
    regions: ["US", "GB", "DE"],
    productionDays: 6,
    basePriceCents: { mug11: 900 },
  },
  {
    id: "tshirt_std",
    category: "tshirt",
    name: "T-Shirts",
    sizes: [
      { id: "s", label: "S", widthMm: 280, heightMm: 360 },
      { id: "m", label: "M", widthMm: 300, heightMm: 380 },
      { id: "l", label: "L", widthMm: 320, heightMm: 400 },
    ],
    substrates: [
      { id: "cotton_180", label: "180gsm Cotton", priceDeltaCents: 0 },
      { id: "cotton_organic", label: "Organic Cotton", priceDeltaCents: 300 },
    ],
    finishes: [{ id: "dtg", label: "Direct-to-Garment", priceDeltaCents: 0 }],
    sides: 2,
    requiredDpi: 150,
    colorSpace: "RGB",
    bleedMm: 0,
    safeZoneMm: 10,
    regions: ["US", "GB", "DE", "IN"],
    productionDays: 7,
    basePriceCents: { s: 1500, m: 1500, l: 1500 },
  },
];

export interface CatalogFilter {
  category?: string;
  region?: string; // ISO country code
}

/** Filter a catalog by category and/or region availability (FR-1/FR-14). */
export function filterCatalog(catalog: PrintProduct[], filter: CatalogFilter = {}): PrintProduct[] {
  return catalog.filter((p) => {
    if (filter.category && p.category !== filter.category) return false;
    if (filter.region && !p.regions.includes(filter.region)) return false;
    return true;
  });
}

/** Find a product by id. */
export function findProduct(catalog: PrintProduct[], id: string): PrintProduct | undefined {
  return catalog.find((p) => p.id === id);
}

/** Find a size on a product by id. */
export function findSize(product: PrintProduct, sizeId: string): PrintSize | undefined {
  return product.sizes.find((s) => s.id === sizeId);
}

// --- Vendor adapter layer (FR-10/FR-14) ------------------------------------

export interface QuoteItem {
  productId: string;
  sizeId: string;
  substrateId: string;
  finishId?: string;
  quantity: number;
}

/**
 * A fulfillment vendor adapter. Implementations are pure adapters over a remote
 * vendor API; the registry resolves them by region/capability. The methods are
 * async by contract (the runtime layer makes network calls); the registry and
 * `MockVendor` below are fully testable without any network.
 */
export interface VendorAdapter {
  id: string;
  /** Regions this vendor serves (ISO country codes). */
  regions: string[];
  /** Named capabilities this vendor supports (e.g. category ids, "foil"). */
  capabilities: string[];
  listProducts(region: string): Promise<PrintProduct[]>;
  quote(items: QuoteItem[], region: string): Promise<CostBreakdown>;
  submitOrder(order: PrintOrder): Promise<{ vendorOrderId: string }>;
  cancelOrder(vendorOrderId: string): Promise<void>;
  parseWebhook(payload: unknown): { vendorOrderId: string; status: string; shipment?: ShipmentInfo };
}

export interface VendorResolveQuery {
  region: string;
  capability?: string;
}

/**
 * Registry of fulfillment vendors. New vendors/regions register here without
 * touching the order flow (FR-14).
 */
export class VendorRegistry {
  private readonly vendors = new Map<string, VendorAdapter>();

  register(vendor: VendorAdapter): void {
    this.vendors.set(vendor.id, vendor);
  }

  unregister(vendorId: string): void {
    this.vendors.delete(vendorId);
  }

  get(vendorId: string): VendorAdapter | undefined {
    return this.vendors.get(vendorId);
  }

  list(): VendorAdapter[] {
    return [...this.vendors.values()];
  }

  /** All vendors serving `region` (and supporting `capability` when given). */
  resolveAll(query: VendorResolveQuery): VendorAdapter[] {
    return this.list().filter((v) => {
      if (!v.regions.includes(query.region)) return false;
      if (query.capability && !v.capabilities.includes(query.capability)) return false;
      return true;
    });
  }

  /** The first vendor serving `region` (and `capability`), or undefined. */
  resolve(query: VendorResolveQuery): VendorAdapter | undefined {
    return this.resolveAll(query)[0];
  }
}

/**
 * A no-network stub vendor for tests and local dev. `quote` returns a trivial,
 * deterministic breakdown; order submission echoes a synthetic vendor order id.
 */
export class MockVendor implements VendorAdapter {
  constructor(
    public readonly id: string = "mock",
    public readonly regions: string[] = ["US", "GB", "DE", "IN"],
    public readonly capabilities: string[] = ["business_card", "flyer", "poster", "sticker"],
  ) {}

  async listProducts(region: string): Promise<PrintProduct[]> {
    return filterCatalog(printCatalog, { region });
  }

  async quote(items: QuoteItem[], _region: string): Promise<CostBreakdown> {
    const baseCents = items.reduce((sum, it) => sum + 1000 * it.quantity, 0);
    return {
      currency: "USD",
      baseCents,
      optionsCents: 0,
      shippingCents: 0,
      taxesCents: 0,
      subsidyCents: 0,
      totalCents: baseCents,
    };
  }

  async submitOrder(order: PrintOrder): Promise<{ vendorOrderId: string }> {
    return { vendorOrderId: `mock-${order.id}` };
  }

  async cancelOrder(_vendorOrderId: string): Promise<void> {
    // no-op
  }

  parseWebhook(payload: unknown): { vendorOrderId: string; status: string; shipment?: ShipmentInfo } {
    const p = (payload ?? {}) as Record<string, unknown>;
    return {
      vendorOrderId: String(p.vendorOrderId ?? ""),
      status: String(p.status ?? "submitted"),
      shipment: p.shipment as ShipmentInfo | undefined,
    };
  }
}
