// Shipping address (F35 FR-9). Personal data, workspace-isolated at the query
// layer; the pure core only models the shape and a structural validity check.

export interface Address {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string; // state/province
  postalCode: string;
  country: string; // ISO country code
  phone?: string;
}

/**
 * Structural address validity (FR-9). Not a postal-database lookup: it checks
 * that the required fields are present and the country looks like an ISO code.
 * Region-specific postal validation is the runtime layer's concern.
 */
export function isValidAddress(a: Partial<Address> | undefined | null): a is Address {
  if (!a) return false;
  const required: (keyof Address)[] = ["name", "line1", "city", "postalCode", "country"];
  for (const f of required) {
    const v = a[f];
    if (typeof v !== "string" || v.trim() === "") return false;
  }
  // ISO 3166-1 alpha-2 country code.
  return /^[A-Za-z]{2}$/.test((a.country ?? "").trim());
}
