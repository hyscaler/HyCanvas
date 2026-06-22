// Order lifecycle (F35 FR-10/FR-12/FR-13). Pure state-machine and aggregation
// helpers: the canonical order-status transitions, cancellation eligibility,
// re-order cloning, split-by-address grouping, and order-total assembly. No
// persistence or vendor I/O.

import type { CostBreakdown, PrintOrderItem, PrintOrderStatus } from "./types";
import type { PrintOrder } from "./types";

export type OrderEvent = "submit" | "produce" | "ship" | "deliver" | "cancel" | "problem";

// Canonical legal transitions. `problem` is reachable from any active
// (non-terminal) status; terminal statuses (delivered/canceled) accept nothing.
const TRANSITIONS: Record<PrintOrderStatus, Partial<Record<OrderEvent, PrintOrderStatus>>> = {
  draft: { submit: "submitted", cancel: "canceled" },
  submitted: { produce: "in_production", cancel: "canceled", problem: "problem" },
  in_production: { ship: "shipped", problem: "problem" },
  shipped: { deliver: "delivered", problem: "problem" },
  delivered: {},
  canceled: {},
  problem: { submit: "submitted", cancel: "canceled" },
};

export class OrderTransitionError extends Error {
  constructor(
    public readonly status: PrintOrderStatus,
    public readonly event: OrderEvent,
  ) {
    super(`illegal order transition: cannot "${event}" from "${status}"`);
    this.name = "OrderTransitionError";
  }
}

/**
 * Apply an order event to the current status, returning the next status. Throws
 * `OrderTransitionError` for an illegal transition.
 */
export function orderTransition(status: PrintOrderStatus, event: OrderEvent): PrintOrderStatus {
  const next = TRANSITIONS[status]?.[event];
  if (!next) throw new OrderTransitionError(status, event);
  return next;
}

/** Whether an event is legal from the given status (no throw). */
export function canTransition(status: PrintOrderStatus, event: OrderEvent): boolean {
  return Boolean(TRANSITIONS[status]?.[event]);
}

/**
 * Cancellation is allowed only pre-production: a draft or submitted order (or one
 * stuck in `problem`) can be canceled; once in production or later it cannot
 * (FR-12).
 */
export function canCancel(status: PrintOrderStatus): boolean {
  return canTransition(status, "cancel");
}

/**
 * Clone a prior order's items for a re-order (FR-12). New item ids are minted via
 * `idFor` (default appends "-reorder" plus an index); the generated print-file
 * key is cleared so checkout regenerates it against the current design, and any
 * tracking state on the shipment is reset to a fresh address-only shipment.
 */
export function reorderItems(
  order: Pick<PrintOrder, "items">,
  idFor: (item: PrintOrderItem, index: number) => string = (it, i) => `${it.id}-reorder-${i}`,
): PrintOrderItem[] {
  return order.items.map((it, i) => ({
    ...it,
    id: idFor(it, i),
    printFileKey: "", // regenerated at checkout against the current design
    shipping: {
      address: it.shipping.address,
      // drop carrier/tracking/method/status from the prior shipment
    },
    cost: undefined,
  }));
}

/** A group of items sharing one destination address. */
export interface AddressGroup {
  /** A stable key derived from the address fields. */
  key: string;
  items: PrintOrderItem[];
}

function addressKey(item: PrintOrderItem): string {
  const a = item.shipping.address;
  return [a.name, a.line1, a.line2 ?? "", a.city, a.region ?? "", a.postalCode, a.country]
    .map((s) => s.trim().toLowerCase())
    .join("|");
}

/**
 * Split items into independent shipment groups by destination address (FR-13).
 * Order of groups follows first appearance; items within a group preserve order.
 */
export function splitByAddress(items: PrintOrderItem[]): AddressGroup[] {
  const groups = new Map<string, AddressGroup>();
  for (const item of items) {
    const key = addressKey(item);
    const existing = groups.get(key);
    if (existing) existing.items.push(item);
    else groups.set(key, { key, items: [item] });
  }
  return [...groups.values()];
}

const ZERO_BREAKDOWN: Omit<CostBreakdown, "currency"> = {
  baseCents: 0,
  optionsCents: 0,
  shippingCents: 0,
  taxesCents: 0,
  subsidyCents: 0,
  totalCents: 0,
};

/**
 * Sum the per-line `cost` breakdowns into one order-level `CostBreakdown`
 * (FR-13). Lines without a `cost` contribute zero. The currency is taken from
 * the first line that declares one (defaults to "USD"); mixed currencies throw.
 */
export function orderTotal(items: PrintOrderItem[]): CostBreakdown {
  let currency: string | undefined;
  const sum: Omit<CostBreakdown, "currency"> = { ...ZERO_BREAKDOWN };
  for (const item of items) {
    const c = item.cost;
    if (!c) continue;
    if (currency === undefined) currency = c.currency;
    else if (currency !== c.currency) {
      throw new Error(`mixed currencies in order: ${currency} vs ${c.currency}`);
    }
    sum.baseCents += c.baseCents;
    sum.optionsCents += c.optionsCents;
    sum.shippingCents += c.shippingCents;
    sum.taxesCents += c.taxesCents;
    sum.subsidyCents += c.subsidyCents;
    sum.totalCents += c.totalCents;
  }
  return { currency: currency ?? "USD", ...sum };
}
