// Shared display formatters.
//
// Numbers are locale-aware (F38 FR-9). "1,234.5" is what an English reader
// expects and "1.234,5" is what a German one does; the same digits with the
// wrong separators are not a cosmetic issue, they are a different number. All
// of these route through `Intl` with the locale actually in effect rather than
// building strings by hand.
//
// Dates and times live in `datetime.ts`, which additionally honours the
// account's timezone and clock preferences.

import { resolvedLocale } from "./locale";

/** The locale to format in. Callers may override for a specific surface. */
function tag(locale?: string): string {
  return locale || resolvedLocale();
}

/** Human-readable byte count (e.g. 1.5 KB, 329 KB, 2 GB): one decimal below
 *  ten units, whole numbers above. */
export function formatBytes(n: number, locale?: string): string {
  if (n <= 0) return `${formatNumber(0, locale)} B`;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  const rounded = v >= 10 || i === 0 ? Math.round(v) : Number(v.toFixed(1));
  return `${formatNumber(rounded, locale)} ${units[i]}`;
}

/** A plain number with the locale's grouping and decimal separators. */
export function formatNumber(n: number, locale?: string, options?: Intl.NumberFormatOptions): string {
  try {
    return new Intl.NumberFormat(tag(locale), options).format(n);
  } catch {
    return String(n);
  }
}

/**
 * A compact number for dense chrome: "1.2K", "3.4M". Locales abbreviate
 * differently (and some do not abbreviate at all), which is exactly why this
 * is not a hand-rolled divide-and-suffix.
 */
export function formatCompact(n: number, locale?: string): string {
  return formatNumber(n, locale, { notation: "compact", maximumFractionDigits: 1 });
}

/**
 * A percentage. Takes a FRACTION (0.42), not a percentage (42), because that is
 * what `Intl` expects and mixing the two silently produces a number 100 times
 * wrong.
 */
export function formatPercent(fraction: number, locale?: string, digits = 0): string {
  return formatNumber(fraction, locale, {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * Money, with the currency's own conventions. The symbol's position is part of
 * the locale, not a prefix to concatenate: "$1.00", "1,00 $" and "1,00 €" are
 * all correct in their own places.
 */
export function formatCurrency(amount: number, currency = "USD", locale?: string): string {
  try {
    return new Intl.NumberFormat(tag(locale), { style: "currency", currency }).format(amount);
  } catch {
    // An unknown currency code must not take a screen down with it.
    return `${formatNumber(amount, locale)} ${currency}`;
  }
}
