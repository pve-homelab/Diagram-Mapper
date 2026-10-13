import { defineConfig } from "vitest/config";

// One layer of shared config (ADR-0011): each package may add its own vitest.config.ts.
export default defineConfig({
  test: {
    projects: [
      "packages/*",
      // explain runs under node:test (its own `test` script), not vitest.
      "!packages/explain",
      "apps/*",
      { test: { name: "scripts", include: ["scripts/**/*.test.ts"] } },
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**", "apps/*/src/**"],
      exclude: ["**/*.test.ts"],
      // TECH-SPEC section 11: 85% on the parser and the graph, no global threshold theatre.
      thresholds: {
        "packages/graph/src/**": { lines: 85, functions: 85, branches: 85, statements: 85 },
        "packages/parser/src/**": { lines: 85, functions: 85, branches: 85, statements: 85 },
      },
    },
  },
});
