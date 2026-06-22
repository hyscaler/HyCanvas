// Print and mockups data model (F35 Section 6). These interfaces describe the
// print product catalog, mockup templates, pre-flight results, cost breakdowns,
// and the order/shipment records. The pure core in this package operates on a
// `DesignFile` plus a `PrintProduct` and produces print geometry,
// pre-flight results, quotes, mockup placement, and order-state transitions.
// Network, persistence, payment, and rasterization live in the runtime layer.

import type { Address as AddressType } from "./address";

export type PrintCategory =
  | "business_card"
  | "flyer"
  | "poster"
  | "sticker"
  | "mug"
  | "tshirt"
  | "packaging"
  | "signage"
  | "photo_book"
  | (string & {});

export type PrintColorSpace = "CMYK" | "RGB";

export interface PrintSize {
  id: string;
  label: string;
  widthMm: number;
  heightMm: number;
}

export interface PrintOption {
  id: string;
  label: string;
  priceDeltaCents: number;
}

export interface PrintProduct {
  id: string;
  category: PrintCategory;
  name: string;
  sizes: PrintSize[];
  substrates: PrintOption[]; // paper/material
  finishes: PrintOption[]; // matte/gloss/foil/lamination/etc.
  sides: 1 | 2;
  requiredDpi: number; // minimum effective DPI
  colorSpace: PrintColorSpace;
  iccProfile?: string; // profile id for the product
  bleedMm: number;
  safeZoneMm: number;
  regions: string[]; // available regions (ISO country codes)
  productionDays: number;
  // Optional per-size/quantity base price table (cents). Used by `quote`; when
  // absent a product-level base is used. Keyed by sizeId.
  basePriceCents?: Record<string, number>;
}

export interface MockupTemplate {
  id: string;
  productCategory: string;
  name: string;
  kind: "product" | "apparel" | "device" | "scene";
  // placement geometry: where/how the design maps onto the mockup
  surface: { warpMesh?: number[][]; maskKey: string; lightingKey?: string };
  // Optional output dimensions of the rendered mockup image (px).
  outputWidth?: number;
  outputHeight?: number;
  // Optional aspect ratio (w/h) of the template's printable surface; the design
  // is fitted into this before warping. Defaults to 1 when absent.
  surfaceAspect?: number;
}

export interface MockupRender {
  id: string;
  designId: string;
  pageId: string;
  templateId: string;
  imageKey: string; // S3 key of rendered preview
  width: number;
  height: number;
  createdAt: string;
}

export type PreflightCode =
  | "dpi"
  | "color_space"
  | "icc"
  | "bleed"
  | "safe_zone"
  | "font_embed"
  | "overprint";

export type PreflightLevel = "pass" | "warn" | "error";

export interface PreflightCheck {
  code: PreflightCode;
  level: PreflightLevel;
  message: string;
  nodeId?: string; // offending element, if any
  overridable: boolean;
}

export interface PreflightResult {
  designId: string;
  productId: string;
  sizeId: string;
  checks: PreflightCheck[];
  status: PreflightLevel;
  ranAt: string;
}

export type PrintOrderStatus =
  | "draft"
  | "submitted"
  | "in_production"
  | "shipped"
  | "delivered"
  | "canceled"
  | "problem";

export type ShipmentStatus = "pending" | "shipped" | "delivered" | "exception";

export interface ShipmentInfo {
  address: AddressType;
  method?: string;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  status?: ShipmentStatus;
}

export interface CostBreakdown {
  currency: string;
  baseCents: number;
  optionsCents: number;
  shippingCents: number;
  taxesCents: number;
  subsidyCents: number; // platform subsidy (at-cost), recorded as a negative-effect line
  totalCents: number;
}

export interface PrintOrderItem {
  id: string;
  designId: string;
  productId: string;
  sizeId: string;
  substrateId: string;
  finishId?: string;
  quantity: number;
  printFileKey: string; // generated PDF/X in S3
  shipping: ShipmentInfo;
  // Per-line cost, used by `orderTotal` aggregation.
  cost?: CostBreakdown;
}

export interface PrintOrder {
  id: string;
  workspaceId: string;
  createdBy: string;
  status: PrintOrderStatus;
  items: PrintOrderItem[];
  vendorId: string;
  vendorOrderId?: string;
  costBreakdown: CostBreakdown;
  createdAt: string;
  updatedAt: string;
}

export type { Address } from "./address";
