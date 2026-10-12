import { z } from "zod";

/**
 * The environment schema (TECH-SPEC section 9.2). This is the only module allowed to read
 * process.env; the boundary check enforces it. Values are validated once, at process start.
 */
const nonEmpty = z.string().min(1);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  DATA_ENCRYPTION_KEY: nonEmpty,
  AUTH_SECRET: nonEmpty,
  GITHUB_APP_ID: nonEmpty,
  GITHUB_APP_PRIVATE_KEY: nonEmpty,
  GITHUB_WEBHOOK_SECRET: nonEmpty,
  STRIPE_SECRET_KEY: nonEmpty,
  STRIPE_WEBHOOK_SECRET: nonEmpty,
  ANTHROPIC_API_KEY: nonEmpty,
  SCAN_SCRATCH_ROOT: nonEmpty,
});
export type Env = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * Parse an environment record. Error messages name the missing or malformed variables and
 * never echo their values.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((i) => i.path.join(".")))].sort();
    throw new ConfigError(`Invalid or missing environment variables: ${names.join(", ")}`);
  }
  return result.data;
}

/** Subset used by tooling that only needs the database (migrations, db tests). */
export function databaseUrl(source: Record<string, string | undefined> = process.env): string {
  const result = z.object({ DATABASE_URL: z.string().url() }).safeParse(source);
  if (!result.success)
    throw new ConfigError("Invalid or missing environment variables: DATABASE_URL");
  return result.data.DATABASE_URL;
}

let cached: Env | undefined;
export function loadEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
