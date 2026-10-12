-- 0000_baseline: the isolation root. Tenant-scoped tables, roles and RLS arrive in M1.
-- Rollback (manual; migrations are forward-only): DROP TABLE "tenants";
--   then DELETE FROM drizzle."__drizzle_migrations" WHERE hash = '<this file hash>';
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
