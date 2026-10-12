import { databaseUrl } from "@diagram-mapper/config";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { runMigrations } from "./index.ts";

// The database suite must not silently skip in CI: REQUIRE_DB=1 turns "no database" into a
// failure (TEST-STRATEGY: a security gate that can be skipped is decoration).
const url = process.env.DATABASE_URL;
const required = process.env.REQUIRE_DB === "1";

describe.skipIf(!url && !required)("migrations", () => {
  it("apply cleanly from an empty database and are idempotent on re-run", async () => {
    const connectionString = databaseUrl();
    await runMigrations(connectionString);
    await runMigrations(connectionString);

    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const tables = await client.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public' order by 1",
      );
      expect(tables.rows.map((r) => r.table_name)).toEqual(["tenants"]);
      const applied = await client.query(
        'select count(*)::int as n from drizzle."__drizzle_migrations"',
      );
      expect(applied.rows[0]?.n).toBe(1);
    } finally {
      await client.end();
    }
  });
});
