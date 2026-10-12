import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Baseline schema. Tenant-scoped tables, roles and row-level security policies arrive in M1
 * (TECH-SPEC section 6, ADR-0004). `tenants` is the root of isolation and is not itself
 * tenant-scoped.
 */
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
