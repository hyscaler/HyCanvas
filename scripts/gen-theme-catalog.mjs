// Regenerates backend/internal/aistudio/theme_catalog.json from the AUTHORED
// theme catalog (themeCatalog in packages/aistudio/src/themeCatalog.ts). The
// Go backend embeds the manifest to validate generation themeIds and to serve
// GET /v1/themes and the MCP list_themes tool; a vitest parity test fails
// until the two are deep-equal. Run after any themeCatalog change:
//   npm run gen:theme-catalog
// (Builds @hc/aistudio first so the manifest reflects the current source.)

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

execSync("npm run build -w packages/aistudio", { cwd: root, stdio: "inherit" });

const { themeCatalog } = await import(pathToFileURL(path.join(root, "packages/aistudio/dist/index.js")).href);
const out = path.join(root, "backend/internal/aistudio/theme_catalog.json");
writeFileSync(out, JSON.stringify(themeCatalog, null, 2) + "\n");
console.log(`[gen-theme-catalog] wrote ${themeCatalog.length} themes to ${out}`);
