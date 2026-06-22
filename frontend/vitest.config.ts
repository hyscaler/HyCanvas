import { defineConfig } from "vitest/config";

// Unit tests for pure frontend lib helpers (e.g. the CSV parser). These run
// outside the Next build (test files are excluded from tsconfig include) so the
// static export stays unaffected.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
