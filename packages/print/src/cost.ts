// Cost quoting (F35 FR-8). Pure, deterministic assembly of a transparent
// `CostBreakdown`: base product cost (per size/quantity), substrate + finish
// option deltas, a quantity-tier discount, shipping, taxes, and an explicit
// platform subsidy line so at-cost pricing is visible. The client cannot alter
// the quote; this is the server-side source of truth (Section 10).

import type { CostBreakdown, PrintProduct } from "./types";
import { findSize } from "./catalog";

export interface QuoteOptions {
  shippingCents?: number;
  taxRate?: number; // 0..1, applied to (base + options) after discount
  subsidyCents?: number; // platform subsidy, deducted from total
  currency?: string;
}

/**
 * Quantity-tier multiplier applied to the per-unit base price. Higher volumes
 * print cheaper per unit, so the multiplier shrinks at the 10/50/100 tiers.
 * Returns 1 for quantities below the first tier.
 */
export function quantityTierMultiplier(qty: number): number {
  if (qty >= 100) return 0.7;
  if (qty >= 50) return 0.8;
  if (qty >= 10) return 0.9;
  return 1;
}

function baseUnitCents(product: PrintProduct, sizeId: string): number {
  const table = product.basePriceCents;
  if (table && typeof table[sizeId] === "number") return table[sizeId];
  // Fallback: first size in the table, else a flat default.
  if (table) {
    const first = Object.values(table)[0];
    if (typeof first === "number") return first;
  }
  return 1000;
}

/**
 * Build a transparent cost breakdown for one configured line.
 *
 * - `baseCents`  = unit base * quantity * quantityTierMultiplier(quantity), rounded.
 * - `optionsCents` = (substrate delta + finish delta) * quantity.
 * - `taxesCents` = round(taxRate * (base + options)).
 * - `subsidyCents` = the platform subsidy (recorded positive; deducted from total).
 * - `totalCents` = base + options + shipping + taxes - subsidy (never below 0).
 */
export function quote(
  product: PrintProduct,
  sizeId: string,
  substrateId: string,
  finishId: string | undefined,
  quantity: number,
  opts: QuoteOptions = {},
): CostBreakdown {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("quantity must be a positive integer");
  }
  if (!findSize(product, sizeId)) {
    throw new Error(`size ${sizeId} not found on product ${product.id}`);
  }
  const substrate = product.substrates.find((s) => s.id === substrateId);
  if (!substrate) throw new Error(`substrate ${substrateId} not found on product ${product.id}`);
  let finishDelta = 0;
  if (finishId !== undefined) {
    const finish = product.finishes.find((f) => f.id === finishId);
    if (!finish) throw new Error(`finish ${finishId} not found on product ${product.id}`);
    finishDelta = finish.priceDeltaCents;
  }

  const unit = baseUnitCents(product, sizeId);
  const tier = quantityTierMultiplier(quantity);
  const baseCents = Math.round(unit * quantity * tier);
  const optionsCents = (substrate.priceDeltaCents + finishDelta) * quantity;

  const shippingCents = Math.max(0, Math.round(opts.shippingCents ?? 0));
  const taxRate = opts.taxRate ?? 0;
  const taxesCents = Math.round(taxRate * (baseCents + optionsCents));
  const subsidyCents = Math.max(0, Math.round(opts.subsidyCents ?? 0));

  const totalCents = Math.max(
    0,
    baseCents + optionsCents + shippingCents + taxesCents - subsidyCents,
  );

  return {
    currency: opts.currency ?? "USD",
    baseCents,
    optionsCents,
    shippingCents,
    taxesCents,
    subsidyCents,
    totalCents,
  };
}
