// Entry for the server-side deck composer bundle
// (backend/internal/composer/composer.js). Bundled by
// scripts/build-composer.mjs and executed inside the Go binary by goja,
// giving the generation API the exact outline-to-pages composition the editor
// panel runs, with no browser and no Node runtime in the loop (F40 E03).
//
// The Go side calls the single global with the ComposeDeckInput JSON and gets
// the DesignFile JSON back; errors throw and surface as goja errors.

import "./composer-polyfill.mjs"; // MUST stay the first import (host shims)
import { composeDeckFile } from "../packages/aistudio/dist/index.js";

globalThis.__composeDeckFile = (inputJson) => JSON.stringify(composeDeckFile(JSON.parse(inputJson)));
