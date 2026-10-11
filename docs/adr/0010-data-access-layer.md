# ADR-0010: Data access — Drizzle plus `pg`, with the connection owned by `withTenant()`

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-12 |
| **Decider** | CTO |
| **Consulted** | Backend Engineer (implements), QA & Security Engineer (the isolation suite depends on this) |
| **Affects** | `docs/TECH-SPEC.md` §3, §6.3, §6.4, §13.3; `packages/db` |
| **Reversibility** | Moderate. Query call sites are mechanical to port, but the migration history and the `withTenant()` contract are not. Days to weeks, and it touches every query. |

## Context

ADR-0004 put tenant isolation in the schema rather than in application code: every
tenant-scoped table carries `tenant_id`, has `FORCE ROW LEVEL SECURITY`, and is reached
only by a role (`dm_app`, `dm_worker`) that **cannot** bypass RLS. The policy compares
`tenant_id` against a session setting:

```sql
CREATE POLICY tenant_isolation ON resources
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

That mechanism imposes two hard requirements on whatever sits between TypeScript and
PostgreSQL, and they are the whole of this decision:

1. **`SET LOCAL app.tenant_id` and the queries it protects must run on the same backend
   session, inside the same transaction.** If a layer can route a statement to a different
   pooled connection, the setting is absent, the policy evaluates against `NULL`, and the
   query returns nothing — or, with a differently-written policy, everything. The failure
   is silent and it is a cross-tenant leak.
2. **The migration tool must be able to express things no ORM models.** `CREATE ROLE`,
   `GRANT`, `ALTER TABLE … FORCE ROW LEVEL SECURITY`, `CREATE POLICY`, composite primary
   keys, partial and expression indexes, `jsonb` columns with check constraints, and the
   `pgboss` schema living alongside ours (ADR-0008). If the tool owns the migration format
   and cannot emit these, the security-critical half of the schema ends up in
   hand-maintained side files that drift from the generated half — two sources of truth for
   the one thing that must have exactly one.

Secondary, but real: `packages/db` must export **`withTenant(tenantId, fn)` as the only way
to obtain a query handle** (`TECH-SPEC` §2.3, §6.4). A library that encourages a global
client imported anywhere makes that contract unenforceable.

## Options considered

### Option A — Prisma

The most popular TypeScript ORM: a schema DSL, generated types, generated migrations, good
documentation, a studio GUI.

**Where it conflicts with ADR-0004.** RLS with Prisma is possible but it is a known
friction point: you need `$transaction` with `$executeRaw('SET LOCAL …')` as the first
statement, and you must be certain the interactive transaction is pinned. Prisma's own
guidance historically pointed people at client extensions for RLS; and when connecting
through a serverless driver or a proxy in non-transaction mode the pinning assumption can
quietly stop holding (see ADR-0009 rule 3). Our isolation property would then rest on a
behaviour we do not control, in the one place where a mistake is a breach rather than a bug.

**Where it conflicts with the migration requirement.** `schema.prisma` cannot express
roles, grants or policies. The standard answer is "write them in a raw SQL migration",
which works — but then the authoritative schema is split between the DSL and hand-written
SQL, and `prisma migrate` wants to own the directory it does not fully understand.

**Cost:** Apache-2.0, £0 in money. A Rust query-engine binary per platform (bigger images,
a native artefact to care about in CI and in the container). The real cost is the one above:
the security-critical schema sits outside the tool's model, and the connection-pinning
property we depend on is the tool's internal business rather than ours.

Rejected — not because Prisma is bad, but because our hardest requirement is exactly the
thing it abstracts away from us.

### Option B — Drizzle ORM plus `pg` (chosen)

A thin, SQL-shaped query builder. The schema is TypeScript; `drizzle-kit` **generates plain
`.sql` migration files that we may edit and extend**; and it is a wrapper over a
`node-postgres` pool that we create, configure and own.

**Against requirement 1:** `withTenant()` takes a client out of the pool, opens a
transaction, issues `SET LOCAL app.tenant_id`, passes the transaction-scoped handle to the
callback, and releases on exit. The pinning is ours, written in our code, and directly
testable — which is what makes `TECH-SPEC` §13.3's cross-tenant probe suite a real gate
rather than a hope.

**Against requirement 2:** generated SQL is checked in and editable, so `CREATE POLICY`,
`FORCE ROW LEVEL SECURITY`, roles and grants live in the same numbered migration sequence
as the tables they protect, reviewed in the same diff. One source of truth, one ordering.

**Cost:** Apache-2.0 (`drizzle-orm`, `drizzle-kit`) and MIT (`pg`); £0. Younger and
smaller-ecosystem than Prisma — fewer answers to search for, and a genuine maturity risk
named in the table below. Less magic means more SQL written by hand, which is a cost in
typing and a benefit in review. `drizzle-kit`'s generated diffs must be read, never
trusted blind, especially for anything touching a constraint.

### Option C — Kysely plus hand-written SQL migrations

A type-safe query builder, no schema ownership, no migration generation (a thin migration
runner only).

Genuinely close. It satisfies both requirements as well as Option B and is arguably more
predictable, because every statement is one you wrote. It lost on a narrow point: types
come from a `Database` interface you maintain **by hand** alongside the SQL, so a column
added in a migration and forgotten in the interface is a type that lies. With roughly a
dozen tables and the graph tables changing whenever `schemaVersion` moves, I would rather
the types be derived from one declaration than kept in sync by discipline. **Single source
of truth** decided this, not ergonomics.

**Cost:** MIT; £0. Hand-maintained types; no generated migrations.

### Option D — Raw `pg` with SQL template literals, no query builder

Maximum control, zero abstraction, no dependency to audit.

**Cost:** £0 and no types at all. Every result row is `any` until hand-validated, which for
a dozen tables and the graph write path means either a lot of zod at the database boundary
or a lot of unchecked casts. We already run zod at the API boundary (`TECH-SPEC` §7); doing
it again at the database boundary is work without a corresponding gain in safety.

Rejected on type safety, while noting that `packages/db` may and will drop to raw SQL for
individual queries — the bulk graph insert and the neighbourhood query are likely
candidates. That is a local choice inside the package, not a layer.

### Option E — TypeORM, Sequelize, MikroORM

Mature, broad, heavier. Active-record or data-mapper patterns, entity decorators, a
migration DSL with the same policy/role gap as Option A, plus connection management that
is more opinionated than our RLS requirement allows.

Rejected on the same grounds as Option A, with less to recommend them in exchange.

## Decision

**`drizzle-orm` over a `node-postgres` pool that `packages/db` owns, with checked-in SQL
migrations generated by `drizzle-kit` and hand-extended for roles, grants and policies.**

Implementation rules, all enforceable:

1. **`withTenant(tenantId, fn)` is the only exported way to get a query handle.** It
   acquires a client, `BEGIN`s, issues `SET LOCAL app.tenant_id = $1`, runs `fn` with the
   transaction handle, then commits or rolls back and releases. No exported pool, no
   exported `db` singleton, nothing that can be imported and used without a tenant. There is
   one deliberate exception, named below.
2. **`SET LOCAL`, never `SET`.** `SET LOCAL` dies with the transaction, so a released
   connection cannot carry one tenant's identity into the next request. A plain `SET` on a
   pooled connection is precisely the cross-tenant bug this design exists to prevent.
3. **The tenant id is bound as a parameter, never interpolated.** The policy casts
   `current_setting('app.tenant_id', true)::uuid`, so a non-UUID fails loudly rather than
   matching loosely.
4. **One documented exception:** `withSystem()`, for migrations, the retention sweep and
   platform-level tables (`tenants`, `pgboss.*`). It is a separate export with a comment
   naming every legitimate caller, it is never reachable from a route handler, and the CI
   boundary test fails if `apps/web` imports it. Pretending no such path is needed would
   only push it somewhere less visible.
5. **No ORM-managed pooling, no connection-level retry magic.** One pool per process, sized
   explicitly from `packages/config`, with the size written down against the host's
   `max_connections` (ADR-0009). The worker gets its own small pool.
6. **Migrations are forward-only, numbered, checked in, and reviewed as SQL.** Every
   migration that creates a tenant-scoped table **must**, in the same file, enable and force
   RLS and create its policy. CI fails on any tenant-scoped table without both — the check
   is a catalogue query (`pg_class.relrowsecurity`, `relforcerowsecurity`, `pg_policies`)
   against the migrated database, not a convention in a style guide.
7. **Drizzle types are derived from the schema declaration**; no hand-maintained row
   interfaces. Where a query drops to raw SQL, its result is validated with zod from
   `packages/graph` rather than cast.
8. **`packages/db` may not contain business logic** (`TECH-SPEC` §2.3). It owns connections,
   the tenant contract, and queries. Nothing else.

## Cost

- **Money:** £0. No new infrastructure, no new vendor. PostgreSQL was already decided
  (ADR-0002).
- **Engineering:** included in M1's 4-day "DB schema, roles, RLS, migrations, isolation
  tests" line. `withTenant()` itself is small; the isolation suite is most of the work, and
  it would be needed under every option.
- **Licence:** Apache-2.0 (`drizzle-orm`, `drizzle-kit`), MIT (`pg`). Permissive, no
  obligations, server-side only — nothing in the distributed client bundle, so no
  distribution-triggered terms. Must still pass the automated licence gate (`TECH-SPEC` §11)
  rather than being trusted from this document.
- **What this makes harder:** complex eager-loading of nested relations (we have little);
  database portability (we are PostgreSQL-specific on purpose — RLS, `jsonb`,
  `SKIP LOCKED`); and the comfort of a large ecosystem when something is odd.

## Consequences

- The isolation property is **ours, in our code, in one function**, and therefore testable:
  the §13.3 suite can open two tenants' handles and assert that each sees only its own rows,
  including a probe that forgets `withTenant()` entirely and must get zero rows rather than
  everything.
- Roles, policies and tables are created in the same reviewed migration, so a new
  tenant-scoped table cannot be merged without its policy. **Make the invariant checkable.**
- Engineers write more SQL. For a graph store whose two hot queries are a bulk insert and a
  neighbourhood expansion, that is the right side of the trade.
- **Blast radius:** a bug in `withTenant()` is a cross-tenant data leak — the most severe
  failure this product has. It is ~40 lines, it is covered by the isolation suite, and
  changes to it require CTO review plus a QA & Security read (ADR-0004). Concentrating the
  risk in one small, heavily-tested function is the point of the design, not a weakness of
  it.
- If Drizzle were abandoned tomorrow, the migrations are plain SQL and the queries are
  SQL-shaped, so Option C is a mechanical port with the schema and the security model
  untouched. That is why a younger library is an acceptable risk here.

## Consequence of being wrong

| If wrong about | Failure mode | Cost to undo | Earliest signal |
|---|---|---|---|
| Drizzle's maturity | A blocking bug or an abandoned project mid-build | Port to Kysely (Option C): weeks of mechanical query rewriting, **schema and migrations unchanged** | Unresolved upstream issues on paths we depend on; release cadence stalling |
| `withTenant()` being used consistently | A query runs outside it, the policy sees no setting, and the result is empty or — if a policy is ever written permissively — leaked | Hours per site, if found. **Severe if not found**, hence the no-exported-pool rule and the forgot-the-wrapper probe test | The probe test; empty-result bug reports; the catalogue check in CI |
| Generated migration diffs being reviewable | `drizzle-kit` emits a destructive or constraint-dropping statement that review misses | Data loss or a dropped constraint. Mitigated by SQL review, forward-only migrations, and the nightly backup (ADR-0009) | The diff itself — which is why generated SQL is read, never applied unread |
| Not needing a heavier ORM | Hand-written SQL for relational reads becomes tedious as features grow | Adopt a richer layer alongside, or push the query into a view — days | Repeated multi-join queries appearing in `packages/db` |
| Explicit pooling being sufficient | Connection exhaustion under load | Resize the pool or add a pooler in transaction mode — hours, **with the §13.3 suite re-run against it**, because a pooler is exactly where requirement 1 can break | `too many connections` errors; pool wait time |

The expensive row is the second one, and the whole decision — no exported pool, `SET LOCAL`
not `SET`, a single tenant entry point, a test that deliberately forgets it — is arranged
to make that row detectable in CI rather than in production.
