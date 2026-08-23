// Regenerates backend/internal/aistudio/assistant_tools.json from the
// AUTHORED assistant tool catalog (toolCatalog() in
// packages/aistudio/src/assistant.ts). The Go backend embeds the manifest to
// derive its allowed action set and system-prompt tool list; a vitest parity
// test (packages/aistudio/src/__tests__/assistant.test.ts) fails until the two
// are deep-equal. Run after any toolCatalog() change:
//   npm run gen:ai-tools
// (Builds @hc/aistudio first so the manifest reflects the current source.)

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

execSync("npm run build -w packages/aistudio", { cwd: root, stdio: "inherit" });

const { toolCatalog } = await import(path.join(root, "packages/aistudio/dist/index.js"));
const out = path.join(root, "backend/internal/aistudio/assistant_tools.json");
writeFileSync(out, JSON.stringify(toolCatalog(), null, 2) + "\n");
console.log(`[gen-ai-tools] wrote ${toolCatalog().length} tools to ${out}`);
