// Emit the published JSON Schema (draft 2020-12) to schema.json.
// Run after build: `npm run build -w packages/schema && npm run gen:schema -w packages/schema`.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getJsonSchema } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "schema.json");
writeFileSync(out, JSON.stringify(getJsonSchema(), null, 2) + "\n");
console.log(`Wrote ${out}`);
