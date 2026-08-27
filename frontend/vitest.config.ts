import { createRequire } from "node:module";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

// Unit tests for pure frontend lib helpers (e.g. the CSV parser). These run
// outside the Next build (test files are excluded from tsconfig include) so the
// static export stays unaffected.
export default defineConfig({
  resolve: {
    alias: {
      // Match the app's "@/" path alias so store/lib modules load in tests.
      "@": resolve(__dirname, "src"),
      // Pin yjs to ONE module for everything vite processes. Combined with the
      // inline list below (which routes the CJS @hc/schema dist through vite so
      // its require("yjs") hits this alias too), tests get a single yjs
      // instance like the app. Two instances break instanceof checks in the
      // CRDT bridge; the tell is yjs's "Yjs was already imported" warning in
      // test output. See yjs issue #438.
      yjs: require.resolve("yjs"),
    },
  },
  test: {
    // .tsx files are component tests. They opt into jsdom per file with a
    // `@vitest-environment jsdom` docblock rather than switching the default,
    // so the much larger body of pure-node lib tests keeps running without a
    // DOM it does not need.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    server: {
      deps: {
        inline: [/@hc\/realtime/, /@hc\/schema/, /y-indexeddb/, /y-protocols/],
      },
    },
  },
});
