# ADR-0004: Tenancy — shared schema with forced row-level security, a non-bypassing role, and tenant-carrying composite keys

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-11 |
| **Decider** | CTO |
| **Consulted** | Backend Engineer (implements), QA & Security (has a block on this design) |
| **Affects** | `docs/TECH-SPEC.md` §6 (whole section), §9.1, §13.3 |
| **Reversibility** | **Expensive.** Changing the tenancy model after customer data exists means a migration of every table under live multi-tenant load. Treat as a one-time decision. |

## Context

Diagram Mapper stores the resource graphs of multiple paying customers' infrastructure in
one PostgreSQL database. A cross-tenant leak would expose one company's internal
architecture to another. For a security-adjacent developer tool sold on trust, that is not
a bug to be patched; it is the end of the product.

The approved constraint is **row-level tenant isolation in PostgreSQL**. My brief states
the design principle more sharply than the constraint does: *isolation enforced only in
application code will eventually leak; push it into the schema and the query layer.* This
is the right framing. Every code path that forgets a `WHERE tenant_id = ?` is a leak, and
over the lifetime of a product written by multiple agents across many sessions, some code
path will forget. A model whose safety depends on remembering is a model that fails.

So the question this ADR answers is not "how do we filter by tenant" but: **what is the
default behaviour of a query written by someone who forgot about tenancy entirely?** The
only acceptable answer is "it returns nothing".

Constraints: £60/month until first revenue (rules out per-tenant managed databases); six
agents, so the mechanism must be hard to misuse rather than merely documented; PostgreSQL
16 is already chosen (ADR-0002); and the worker, the Stripe webhook handler and migrations
all need legitimate access outside any single tenant's context.

## Options considered

### Option A — Application-level filtering (`WHERE tenant_id = ?` in every query)

The default in most SaaS codebases. A repository/service layer takes `tenantId` and adds
the predicate.

**Cost:** £0 and zero extra days. The cheapest option by a wide margin.

Rejected. The failure mode is a single omitted predicate anywhere in the system — in a
new endpoint, a migration script, a background job, a debugging query, an `IN` subquery
written in a hurry. The default behaviour of a forgotten filter is **return everything**,
which is precisely inverted from what we need. It can be mitigated with code review and
linting, but mitigation is probabilistic and the loss is unbounded. This option fails the
brief's stated principle directly, and it is the option the brief exists to rule out.

### Option B — Database-per-tenant

Each customer gets their own PostgreSQL database. Isolation is absolute and trivially
explainable to a security reviewer.

**Cost:** fatal at our scale. A managed database per tenant is £7–15/month each, so the
third customer breaches the £60/month envelope with nothing left for anything else.
Self-hosting many databases on one instance regains the cost but loses most of the
isolation claim. Operationally: migrations fan out across N databases with partial-failure
states, connection pools multiply, and cross-tenant operational queries ("how many scans
failed today?") require a fan-out job. Onboarding becomes a provisioning workflow rather
than an `INSERT`, which also breaks self-service signup.

Rejected on cost and operational load. Worth revisiting only for a future enterprise tier
where a customer pays for dedicated infrastructure — and that is a new ADR.

### Option C — Schema-per-tenant

One PostgreSQL database, one schema per tenant, selected via `search_path`.

**Cost:** moderate; no extra money. But: migrations must run per schema (N schemas × every
migration, with partial-failure recovery and a schema-version-drift problem); PostgreSQL
performance degrades with thousands of schemas as the catalogue grows; Drizzle and most
migration tooling assume one schema, so we would be fighting the tools; and — decisively —
isolation depends on `search_path` being set correctly, which is **the same class of
mistake as a forgotten `WHERE` clause**, only harder to audit because the bug is invisible
in the query text. A query against `nodes` with the wrong `search_path` silently reads
another tenant's data and looks completely correct in review.

Rejected: it buys real isolation strength over Option A but at material operational cost,
while still resting on correct per-request configuration — and Option D rests on correct
per-request configuration that **fails closed** instead of failing open.

### Option D — Shared schema, PostgreSQL row-level security (chosen, with two reinforcements)

One schema, `tenant_id uuid NOT NULL` on every tenant-scoped table, RLS policies keyed on
a transaction-local session variable, and the application connecting as a role that cannot
bypass policies.

**Cost:** ~4 days (schema, roles, policies, migrations, and the isolation test suite),
plus a permanent constraint that every tenant-scoped query must run inside a tenant
context, plus the PgBouncer constraint recorded below.

RLS alone would not be sufficient, and this is where most implementations of this pattern
go wrong:

- Without `FORCE ROW LEVEL SECURITY`, the **table owner bypasses its own policies**. If
  the application connects as the role that owns the tables — the default in nearly every
  tutorial and most real deployments — the policies are decorative. They exist, they pass
  review, and they do nothing.
- A role with `BYPASSRLS` (and any superuser) ignores policies entirely.
- RLS protects rows against *queries*, but nothing stops an application bug from
  *inserting* a child row that points at another tenant's parent, producing a cross-tenant
  reference inside otherwise-isolated data.

So the decision is RLS plus two independent reinforcements, chosen so that the three
mechanisms fail independently rather than sharing a single point of failure.

## Decision

**Shared schema with three independent isolation mechanisms**, exactly as specified in
`TECH-SPEC` §6.1 and §6.4. A single mistake in application code must not be sufficient to
leak data across tenants.

**1. Forced row-level security on every tenant-scoped table.**

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;   -- applies to the table owner too
CREATE POLICY tenant_isolation ON <t>
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

`FORCE` is not optional. `WITH CHECK` is not optional either — without it, RLS filters
reads but permits writing a row belonging to another tenant.

The **fail-closed property** is the core of the design: if `app.tenant_id` is unset,
`current_setting('app.tenant_id', true)` returns `NULL`, every policy predicate evaluates
to `NULL` rather than `TRUE`, and every query returns **zero rows** and rejects every
write. A developer who forgets tenancy entirely gets an empty result set — a loud, obvious
bug in development — rather than a silent cross-tenant read in production. The default
state of the system is "no access".

**2. A role that cannot bypass it.** Migrations run as `dm_migrator` (owns the tables).
The application connects as `dm_app`: `NOSUPERUSER`, `NOBYPASSRLS`, owner of no table,
granted only `SELECT/INSERT/UPDATE/DELETE` on the tables it needs. No `GRANT` to `PUBLIC`.
The worker uses `dm_worker` with the same constraints plus the queue schema. Credentials
for `dm_migrator` are not present in the application runtime's environment.

**3. Composite foreign keys carrying `tenant_id`.** Every parent table has
`UNIQUE (tenant_id, id)`; every child declares
`FOREIGN KEY (tenant_id, <parent>_id) REFERENCES <parent> (tenant_id, id)`. A row
therefore **cannot exist** pointing at a parent in a different tenant. This holds even if
a policy is accidentally dropped by a migration: cross-tenant data becomes
*unrepresentable*, not merely *unqueryable*. This is the mechanism that converts isolation
from a query-time filter into a **schema property** — which is exactly what the brief asks
for and what the other two mechanisms, on their own, do not deliver.

**The query layer property.** `packages/db` exports exactly one way to reach the database:

```ts
export async function withTenant<T>(
  tenantId: string, userId: string | null,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T>
```

It checks out a connection, opens a transaction, runs
`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)` —
`true` meaning **transaction-local**, so the setting is discarded at commit or rollback and
cannot leak to the next user of a pooled connection — and passes a handle to `fn`. The
handle is invalidated when `fn` returns.

There is **no exported pool, client, or `db` object.** Not as a convention: the module does
not export one, and the CI boundary test fails the build if anything outside `packages/db`
imports `pg` or `drizzle-orm`. It is not possible to write an unscoped query from
application code without first modifying `packages/db` — which is a reviewed change to a
CTO-owned package, not an ordinary feature commit.

**The escape hatch is enumerated, not general.** `withSystem()` exists for migrations, the
Stripe webhook handler (which must resolve a tenant *by Stripe customer id* before any
tenant context exists) and the retention sweep. It connects as `dm_app` with **no tenant
GUC set**, so RLS still returns zero rows from tenant-scoped tables. It is granted a small
set of individually reviewed `SECURITY DEFINER` functions — `resolve_tenant_by_stripe_customer`,
`claim_expired_snapshots` — and those functions are the **complete** list of RLS-privileged
code paths in the system. Adding one requires CTO review and a QA & Security read.

**Non-tenant-scoped tables are an exhaustive list**, not a judgement call: `users`
(global identity, with its own policy `id = current_setting('app.user_id', true)::uuid`),
`plans` (product catalogue, readable by `dm_app`, writable only by `dm_migrator`), and
`pgboss.*` (queue internals; payloads carry ids only, never customer configuration). Any
table not on that list MUST be tenant-scoped and RLS-forced, and the §13.3 test suite
**fails the build** if a new table appears that is neither on the list nor RLS-forced. The
list is maintained in the test, so adding a table without deciding its tenancy is
impossible.

**Constraint on future infrastructure:** connection pooling is `pg.Pool` with explicit
transactions. If PgBouncer or any external pooler is introduced it MUST run in
**transaction pooling** mode. In statement pooling mode, transaction-local session state
breaks and the isolation guarantee is void. This is recorded here because it is the kind of
infrastructure change made months later by someone optimising connection counts, with no
idea it is load-bearing for security.

**Tested, not asserted** (`TECH-SPEC` §13.3, in the required CI `db` job):

- every table in `information_schema` is either on the non-tenant list or has RLS enabled
  **and** forced, with both `USING` and `WITH CHECK` policies;
- a cross-tenant probe per tenant-scoped table: seed two tenants, set tenant A's context,
  assert reads of B's rows return zero rows and writes of a row with B's `tenant_id` are
  rejected;
- a no-context probe: with no GUC set, every tenant-scoped table returns zero rows and
  rejects writes;
- `dm_app` is asserted to have `rolbypassrls = false`, `rolsuper = false`, and to own no
  table;
- a composite-FK probe: inserting a child referencing a parent in another tenant fails at
  the database level **with the policy deliberately disabled**, proving mechanism 3 is
  independent of mechanism 1.

That last test is the one that makes this design more than a convention. It demonstrates
that two of the three mechanisms can fail and the data is still isolated.

## Cost

- **Money:** £0. One database, one schema.
- **Engineering:** ~4 days in M1 for schema, roles, policies, migrations and the isolation
  suite. The suite is roughly half of that and is the part that makes the design
  verifiable rather than merely designed.
- **Runtime:** one extra round trip per request for `set_config`, and a transaction around
  every tenant-scoped operation (which we want anyway). RLS adds a predicate to every
  query plan; with `tenant_id` as the leading column of the relevant indexes the planner
  handles this well, but index design must account for it.
- **Permanent constraints:** every tenant-scoped query runs inside `withTenant`; no
  external pooler in statement mode; no `BYPASSRLS` role in the application runtime; new
  `SECURITY DEFINER` functions require review.
- **Developer friction:** a forgotten tenant context produces a confusing "no rows" result
  rather than an error message naming the cause. Mitigated by `withTenant` being the only
  entry point, so the mistake is hard to make, and by a development-mode warning when a
  tenant-scoped table is queried with no GUC.
- **Licence:** none. RLS is core PostgreSQL.

## Consequences

- Tenant isolation is a property of the schema and the connection, not of application
  discipline. A new endpoint written by any agent inherits it by construction, which is
  the only way this holds up across many sessions and multiple authors.
- The privileged surface is small, enumerated and reviewable: two `SECURITY DEFINER`
  functions and `withSystem()`. A security review can read all of it in minutes — which is
  the practical difference between a design QA & Security can sign off and one they cannot.
- One database means one migration run, one backup, one connection pool, one place to look
  during an incident. **Blast radius:** PostgreSQL is a single point of failure for the
  whole product (accepted at launch, recorded in `TECH-SPEC` §15) — but it is not a
  *cross-tenant* failure mode. An outage affects everyone equally; it does not mix anyone's
  data.
- Per-tenant encryption keys, per-tenant backup/restore and per-tenant resource limits are
  **not** available. If an enterprise prospect requires any of those, it is a dedicated-
  deployment tier with its own ADR and its own price, not a retrofit.
- `withTenant` wrapping every request makes request-scoped auditing straightforward: the
  same place that sets the context writes the `audit_log` row.

## Consequence of being wrong

| If wrong about | Failure mode | Cost to undo | Earliest signal |
|---|---|---|---|
| RLS being sufficient (a policy gap, a missed table, a `SECURITY DEFINER` bug) | **Cross-tenant data leak.** Company A sees Company B's infrastructure. Unrecoverable commercially for a security-adjacent tool | Not a repair job — a breach-notification event. The code fix is hours; the trust is not recoverable | The §13.3 suite in required CI, which fails on any new table lacking forced RLS. This is why that test is a merge blocker and not a nightly |
| `FORCE` being applied (forgotten on a new table) | Owner-role queries silently bypass isolation; policies look present and do nothing | Hours to fix, unbounded if it shipped | `information_schema` assertion over **every** table, every PR |
| Composite FKs being worth the cost | Wider indexes, more verbose DDL, slightly more awkward migrations — a real but modest tax | Drop the constraints; days | Measured on real data volumes. Cheapest mistake in this ADR and the one I am most willing to be wrong about |
| Shared-schema at scale (noisy neighbours, index bloat, one tenant's 50k-node graph degrading others) | Performance coupling between tenants | Partitioning `nodes`/`edges` by `tenant_id` is additive — days, not a model change. Database-per-tenant is a rewrite — weeks | Query latency per tenant in the metrics; snapshot size distribution |
| Transaction-local `set_config` with pooling | If a future pooler runs in statement mode, session state crosses requests — **an isolation failure caused by an infrastructure change, not a code change** | Hours to reconfigure, but only once discovered, and the discovery mechanism is weak | Weak by nature. Mitigated by recording the constraint here and in §6.4 so it is discoverable by whoever adds the pooler. **This is the least-detectable risk in this ADR and I am naming it as such** |
| Enterprise isolation expectations | A prospect's security review requires physical separation we cannot offer | Dedicated deployment: weeks, and a pricing decision | First enterprise security questionnaire; Product's to surface |

The one risk without a strong signal is the pooler case. Everything else is caught by a
required CI job on every pull request, which is the point: isolation claims that are not
tested on every commit decay into isolation claims that used to be true.
