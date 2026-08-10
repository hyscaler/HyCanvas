// Locale-aware number formatting (F38 FR-9).
import { describe, expect, it } from "vitest";
import { formatBytes, formatCompact, formatCurrency, formatNumber, formatPercent } from "./format";

describe("formatNumber", () => {
  it("uses the locale's own grouping and decimal separators", () => {
    // The same digits with the wrong separators are a different number, not a
    // cosmetic difference.
    expect(formatNumber(1234.5, "en-US")).toBe("1,234.5");
    expect(formatNumber(1234.5, "de-DE")).toBe("1.234,5");
    expect(formatNumber(1234.5, "fr-FR").replace(/ | /g, " ")).toBe("1 234,5");
  });

  it("survives a nonsense locale rather than throwing on a render path", () => {
    expect(formatNumber(42, "not a locale")).toBe("42");
  });
});

describe("formatBytes", () => {
  it("keeps the existing shape", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999, "en-US")).toBe("999 B");
    expect(formatBytes(336_800, "en-US")).toBe("329 KB"); // >= 10 rounds to whole units
    expect(formatBytes(1536, "en-US")).toBe("1.5 KB"); // < 10 keeps one decimal
    expect(formatBytes(2 * 1024 ** 3, "en-US")).toBe("2 GB");
  });

  it("localizes the decimal separator in the size itself", () => {
    // This is what the old hand-built string got wrong: a German user saw
    // "1.5 KB", and "." is their thousands separator, not a decimal point.
    expect(formatBytes(1536, "de-DE")).toBe("1,5 KB");
  });
});

describe("formatPercent", () => {
  it("takes a fraction, not a percentage", () => {
    expect(formatPercent(0.42, "en-US")).toBe("42%");
    expect(formatPercent(1, "en-US")).toBe("100%");
  });

  it("honours a digit count", () => {
    expect(formatPercent(0.4267, "en-US", 1)).toBe("42.7%");
  });
});

describe("formatCompact", () => {
  it("abbreviates the way the locale does", () => {
    expect(formatCompact(1200, "en-US")).toBe("1.2K");
    expect(formatCompact(3_400_000, "en-US")).toBe("3.4M");
  });
});

describe("formatCurrency", () => {
  it("places the symbol where the locale puts it", () => {
    expect(formatCurrency(1, "USD", "en-US")).toBe("$1.00");
    // Not a prefix to concatenate: German puts the symbol last.
    expect(formatCurrency(1, "EUR", "de-DE").replace(/ /g, " ")).toBe("1,00 €");
  });

  it("does not take a screen down over an unknown currency code", () => {
    expect(formatCurrency(5, "NOTACODE", "en-US")).toContain("5");
  });
});
