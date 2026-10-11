# ADR-0008: Background jobs — pg-boss on the application PostgreSQL

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-11 |
| **Decider** | CTO |
| **Consulted** | Backend Engineer (implements) |
| **Affects** | `docs/TECH-SPEC.md` §2.2, §2.4, §5, §6.2, §9.3 |
| **Reversibility** | Cheap. Job handlers are plain functions; only the enqueue call and the worker bootstrap are queue-specific. A swap is 1–2 days. |

## Context

Parsing a repository takes seconds to minutes: clone a tarball, parse every `.tf` file,
evaluate expressions, build the graph, validate invariants, persist. It cannot run inside
an HTTP request — the user would stare at a spinner past any sensible timeout, and a
dropped connection would lose the work. The specification gives the ingestion job a
10-minute wall-clock budget and at most two attempts (`TECH-SPEC` §5).

So a queue is required. The constraints are what make the choice interesting:

- **£60/month total** until first revenue. Hosting already has to fit in that.
- Six agents. Every infrastructure component is something all of them must understand and
  somebody must operate.
- Job volume at launch is tiny: a handful of scans per day, plus one daily retention
  sweep.
- PostgreSQL is already a dependency (ADR-0002) and already has transactions.

There is also a correctness requirement that most queue comparisons miss: the scan must
**not** be enqueued if the transaction that created the `scans` row rolls back, and the
`scans` row must not exist without a job. Two separate systems make that a distributed-
transaction problem; one system makes it a transaction.

## Options considered

### Option A — Managed queue (AWS SQS, Google Cloud Tasks, Upstash QStash)

Durable, scalable, operationally somebody else's problem.

**Cost:** SQS itself is nearly free at our volume, but it drags in a cloud account, IAM, a
second region/credential surface and a new vendor relationship — and it can only be
reached from a worker we are also paying to host. QStash has a free tier with request
limits. The real cost is not the line item: it is a second system that can be down
independently, cannot participate in our database transaction, and needs its own
monitoring.

Rejected. At a handful of jobs per day this is paying complexity for scale we do not have.

### Option B — Redis plus BullMQ

The default Node answer. Mature, good tooling, a usable dashboard.

**Cost:** a managed Redis instance is roughly £7–15/month — material against £60 when
hosting and the database also come out of it. Self-hosting Redis on the same box regains
the cost but adds a service to operate, monitor, back up and keep patched. BullMQ is MIT;
Redis itself moved to RSALv2/SSPL for new versions, which for a hosted service is a
licence question we would rather not open (Valkey exists, but that is another decision).

Rejected on cost, licence friction and **boring technology**: a second datastore with
different failure modes and different backup semantics, for job volume PostgreSQL will not
notice.

### Option C — pg-boss on the existing PostgreSQL (chosen)

A job queue implemented in PostgreSQL, using `SKIP LOCKED` for concurrent consumption.
Its own schema (`pgboss.*`) in the same database. MIT licensed.

**Cost:** £0 — no new component, no new money. Queue load shares the database's
connections and I/O, which matters at high throughput and not at ours. `pgboss.*` tables
join our migration and backup story automatically, which is a benefit, not a cost.

Crucially, it gives the transactional property: enqueueing inside the same transaction
that writes the `scans` row means the job and the row commit or roll back together. No
orphaned jobs, no orphaned scans, no reconciliation logic to write and test.

### Option D — Inngest, Trigger.dev, or a similar hosted durable-workflow service

Retries, observability, scheduling, step functions, a good developer experience.

**Cost:** free tiers exist with run limits; paid tiers start around £20/month and rise. All
of them require **our code to be invoked by their infrastructure**, which means a publicly
reachable endpoint — and public deployment requires CEO approval (and, for the free tiers,
accepting a third party in the execution path of customer data processing). That is a much
larger decision than "how do we run a background job", and it needs its own ADR and a
security review, not a dependency install.

Rejected: cost plus an unnecessary third party in the path of customer configuration.

### Option E — No queue: a long-lived HTTP request, or `setTimeout` in the web process

Simplest possible.

**Cost:** £0 and loses work on every deploy, every crash and every timeout. Scans vanish
with no record and no retry, and the web process's memory is consumed by parse work.

Rejected. Not viable for a minutes-long job, though worth naming because it is what a
"just ship it" instinct would reach for.

## Decision

**pg-boss on the application PostgreSQL instance**, with a dedicated worker process
`apps/worker` consuming two job types:

- `scan.ingest` — the parser pipeline (`TECH-SPEC` §5). 10-minute wall-clock budget,
  maximum **2 attempts**, and the second attempt is taken **only** for transient
  GitHub/network errors. A parse failure is never retried, because parsing is
  deterministic: retrying a deterministic failure is just a slower way to fail, and it
  doubles the cost of a bad repository.
- `retention.sweep` — daily; deletes snapshots beyond the four most recent per repository
  (ADR-0007 §5).

Implementation rules:

1. **Enqueue inside the transaction that creates the `scans` row.** Job and row commit
   together or not at all. This is the main reason the queue lives in the database.
2. **Job payloads carry identifiers only** — `scanId`, `tenantId`, `repositoryId`. Never
   customer configuration, never tokens. `pgboss.*` is therefore not a place customer data
   can leak to, which is why it is on the short list of non-tenant-scoped schemas in
   ADR-0004.
3. **The worker runs as `dm_worker`**: `NOSUPERUSER`, `NOBYPASSRLS`, owner of no table,
   granted the queue schema plus the tenant-scoped tables. It reaches tenant data only
   through `withTenant()`, exactly like the web tier. The worker is not privileged.
4. **Handlers are plain async functions** taking a typed payload. The pg-boss registration
   is a thin shell in `apps/worker`. Nothing in `packages/*` imports pg-boss — enforced by
   the CI boundary test — so the handlers are unit-testable without a queue and the queue
   is replaceable without touching them.
5. **Progress is reported on the `scans` row** (`status`, `stage`, `startedAt`), not read
   out of queue internals. The API serves scan status from our own table, so the UI never
   depends on the queue's schema. **Single source of truth** for "how is this scan going".
6. **Concurrency 1 per worker at launch.** Parsing is memory-hungry and our volume is
   trivial; raising it is a config change once we have measurements.

## Cost

- **Money:** £0. No new infrastructure, no new vendor.
- **Engineering:** ~3 days in M1 for the ingestion job, diagnostics and the retention
  sweep — most of which is the pipeline itself, not the queue.
- **Operational:** one more process to run and keep alive alongside the web app. Queue
  tables share the database's connection pool and I/O.
- **Licence:** MIT. No obligation.
- **What this makes harder:** very high throughput (thousands of jobs/minute would put real
  load on PostgreSQL); fan-out/step-function workflows; cross-region workers.

## Consequences

- One datastore, one backup, one migration run, one connection story, one place to look
  during an incident. For a six-agent team this is worth more than any feature a dedicated
  queue would add.
- Enqueue is transactional, which removes a whole class of bug (orphaned jobs, orphaned
  rows) without writing reconciliation code.
- **Blast radius:** if the worker dies, no new scans complete, but **existing graphs still
  render and chat still works** — jobs wait durably in PostgreSQL and resume when the
  worker returns. The customer sees "Analysis queued", with the queue age after 2 minutes
  and a support reference after 15. If PostgreSQL dies, everything is down anyway
  (ADR-0004), so the queue adds no new single point of failure. That is a genuine
  architectural simplification, not just a cost saving.
- Job state is queryable with ordinary SQL, which makes debugging a `SELECT` rather than a
  dashboard we do not have.
- No queue dashboard. Observability is our own structured logs plus the `scans` table.
  Acceptable at this volume; the first thing to miss at higher volume.

## Consequence of being wrong

| If wrong about | Failure mode | Cost to undo | Earliest signal |
|---|---|---|---|
| PostgreSQL handling queue load | Queue polling competes with application queries; API latency rises | Move to Option B/A behind the same handler functions — **1–2 days**, because handlers are queue-agnostic by design | Database CPU and query latency correlated with scan volume |
| Concurrency 1 being enough | Scans queue up behind each other at a busy moment; users wait | Config change, then a second worker process — hours | Queue age on the `scans` table; the 2-minute UI threshold surfaces it to users before it surfaces to us, which is backwards and worth watching |
| Never retrying parse failures | A genuinely transient parse failure (e.g. memory pressure) is reported as a permanent one | Hours — reclassify the error | `FILE_PARSE_ERROR` rates on repositories that later succeed |
| 10-minute budget | Large repositories are killed mid-parse and never produce a graph | Raising it is config; the real fix is parser performance | Timeout rate per repository size, from AIS-4's ceilings |
| Not needing a dashboard | Debugging a stuck job is slower than it should be | Days to add observability, or adopt Option D later | Time spent diagnosing the first stuck scan |

Every row here is recoverable in days, which is why this ADR is short. The decision that
mattered was keeping the queue inside the transaction boundary; the rest is operational
tuning on a component we can replace in an afternoon.
