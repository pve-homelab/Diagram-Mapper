import { describe, expect, it } from "vitest";
import { ConfigError, databaseUrl, parseEnv } from "./index.ts";

const valid = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  DATA_ENCRYPTION_KEY: "k",
  AUTH_SECRET: "a",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "pem",
  GITHUB_WEBHOOK_SECRET: "w",
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
  ANTHROPIC_API_KEY: "x",
  SCAN_SCRATCH_ROOT: "/tmp/scan",
};

describe("parseEnv", () => {
  it("accepts a complete environment", () => {
    expect(parseEnv(valid).NODE_ENV).toBe("development");
  });

  it("names missing variables without echoing any values", () => {
    const { AUTH_SECRET: _a, STRIPE_SECRET_KEY: _s, ...rest } = valid;
    expect(() => parseEnv(rest)).toThrow(ConfigError);
    expect(() => parseEnv(rest)).toThrow(
      "Invalid or missing environment variables: AUTH_SECRET, STRIPE_SECRET_KEY",
    );
    try {
      parseEnv({ ...rest, DATABASE_URL: "not a url secret-ish" });
    } catch (e) {
      expect(String(e)).not.toContain("secret-ish");
    }
  });

  it("databaseUrl validates only what migrations need", () => {
    expect(databaseUrl({ DATABASE_URL: valid.DATABASE_URL })).toBe(valid.DATABASE_URL);
    expect(() => databaseUrl({})).toThrow(ConfigError);
  });
});
