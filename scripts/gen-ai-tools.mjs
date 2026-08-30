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
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

execSync("npm run build -w packages/aistudio", { cwd: root, stdio: "inherit" });

// import() needs a file:// URL: a raw absolute path breaks on Windows, where
// the drive letter parses as a URL scheme.
const { toolCatalog } = await import(pathToFileURL(path.join(root, "packages/aistudio/dist/index.js")).href);
const out = path.join(root, "backend/internal/aistudio/assistant_tools.json");
const tools = toolCatalog();
writeFileSync(out, JSON.stringify(tools, null, 2) + "\n");
console.log(`[gen-ai-tools] wrote ${tools.length} tools to ${out}`);
