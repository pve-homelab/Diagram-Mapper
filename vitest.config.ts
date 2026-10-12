import { defineConfig } from "vitest/config";

// One layer of shared config (ADR-0011): each package may add its own vitest.config.ts.
export default defineConfig({
  test: {
    projects: [
      "packages/*",
      "apps/*",
      { test: { name: "scripts", include: ["scripts/**/*.test.ts"] } },
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**", "apps/*/src/**"],
      exclude: ["**/*.test.ts"],
    },
  },
});
