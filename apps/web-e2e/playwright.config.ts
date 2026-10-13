import { defineConfig, devices } from "@playwright/test";

/**
 * Two targets, one suite:
 *
 * - Local / CI (default): builds nothing itself; starts `next start` on the production build
 *   with DM_E2E_FIXTURES=1, so the F-06 rendering fixture is served. Run `pnpm build` first.
 * - Deployed preview: set E2E_BASE_URL. No server is started, fixtures are absent, and only
 *   specs tagged @deployed run (`pnpm e2e:preview`). This is how the header assertions are
 *   checked against the real deployed response (threat model F-14).
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const deployedUrl = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "tests",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // TEST-STRATEGY section 7: flaky is failing, no retries in the PR gate.
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: deployedUrl ?? `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  ...(deployedUrl
    ? {}
    : {
        webServer: {
          command: `pnpm --filter @diagram-mapper/web exec next start --port ${PORT} --hostname 127.0.0.1`,
          url: `http://127.0.0.1:${PORT}/api/v1/health`,
          reuseExistingServer: false,
          timeout: 60_000,
          env: { DM_E2E_FIXTURES: "1" },
        },
      }),
});
