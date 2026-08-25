// F40 E10: the whole built-in theme catalog must pass the same contrast rules
// generated themes are validated against (ink/paper and ink/tint at AA 4.5,
// primary/paper at 3.0), so a picked theme can never produce unreadable text.
import { describe, expect, it } from "vitest";
import { themeCatalog, themeCatalogEntry } from "../themeCatalog";
import { themeContrastFailures, themeSlotNames } from "../themeGen";

describe("theme catalog (F40 E10)", () => {
  it("carries 30+ themes with unique ids and every style group", () => {
    expect(themeCatalog.length).toBeGreaterThanOrEqual(30);
    const ids = themeCatalog.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const styles = new Set(themeCatalog.map((t) => t.style));
    for (const s of ["professional", "editorial", "bold", "minimal", "warm", "tech", "dark"]) {
      expect(styles.has(s as never), s).toBe(true);
    }
  });

  it("every entry passes contrast validation as-is (repair would be a no-op)", () => {
    for (const t of themeCatalog) {
      const slots = Object.fromEntries(themeSlotNames.map((name, i) => [name, t.colors[i]])) as never;
      expect(themeContrastFailures(slots), t.id).toEqual([]);
    }
  });

  it("looks up by id", () => {
    expect(themeCatalogEntry("theme-slate")?.name).toBe("Slate");
    expect(themeCatalogEntry("nope")).toBeNull();
  });
});

// The Go backend embeds theme_catalog.json (validation of generation
// themeIds, GET /v1/themes, the MCP list_themes tool). It must stay
// deep-equal to the authored catalog, or a theme added on one side is
// unknown on the other. Regenerate after changing themeCatalog:
//   npm run gen:theme-catalog
describe("server theme-catalog parity", () => {
  it("theme_catalog.json matches themeCatalog exactly", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const manifestPath = fileURLToPath(
      new URL("../../../../backend/internal/aistudio/theme_catalog.json", import.meta.url),
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest).toEqual(JSON.parse(JSON.stringify(themeCatalog)));
  });
});
