# ADR-0009: Hosting inside the GBP 60/month envelope

| | |
|---|---|
| **Status** | **Proposed — the CEO decides.** Nothing in this ADR has been purchased, registered or deployed. |
| **Date** | 2026-10-12 |
| **Decider** | **CEO** (spend and public deployment are explicitly out of my authority) |
| **Consulted** | Backend Engineer (operates it), QA & Security Engineer (data residency, backup/restore evidence) |
| **Affects** | `docs/TECH-SPEC.md` §2.1, §3, §12, §15 |
| **Reversibility** | Cheap, by construction. Two Node processes and one PostgreSQL database with no provider-specific APIs. A move is hours of work plus a `pg_dump`/`pg_restore`. |

## Context

The approved constraint is **running costs under GBP 60/month until the first paying
customer** (`pricinples and contraints.md`). Everything we deploy comes out of that one
number, and some of it is already spoken for: the Anthropic API for paid-plan explanations
is metered against the same envelope (`TECH-SPEC` §8.6), and the free tier deliberately
uses the customer's own key so that it costs us nothing.

What has to run:

| Process | Shape | Why it cannot be merged away |
|---|---|---|
| `apps/web` | Next.js 15, HTTP, long-lived | Serves the UI and the API, including SSE scan progress |
| `apps/worker` | pg-boss consumer, long-lived | Parse jobs take **up to 10 minutes** of wall clock (ADR-0008, `TECH-SPEC` §5) |
| PostgreSQL 16 | Stateful, needs backups | The graph store, the queue, the tenancy boundary (ADR-0004, ADR-0008) |

Two properties of that table decide this ADR, and both are consequences of earlier
decisions rather than preferences:

1. **A 10-minute job rules out ordinary serverless functions for the worker.** Platform
   function timeouts are measured in seconds to a few minutes. The worker needs a process
   that stays alive.
2. **RLS needs a real connection, not a statement router.** `withTenant()` sets
   `app.tenant_id` with `SET LOCAL` inside a transaction (ADR-0004, `TECH-SPEC` §6.4). Any
   hosting arrangement that silently multiplexes statements across backend sessions — some
   HTTP/serverless database proxies in non-transaction mode do exactly this — breaks the
   tenancy boundary in a way that is invisible until it leaks. **Session-pinned
   transactions are a hard requirement, not a nice-to-have.**

There is also a requirement that is not about money: **local development and CI must work
with no cloud account and no paid key at all** (`TECH-SPEC` §12). Five agents have to build
and test this before anybody pays for anything. That is already true today and no option
below may change it.

### Prices in this document are unverified list prices

Everything below is a list price I read as an engineering input, **as of 2026-10-12**, at
£1 ≈ €1.17 ≈ $1.27. I have not opened an account, entered a card, or confirmed a quote with
any provider, and I am not authorised to. Treat every number as an estimate to be checked
at purchase time by the CEO. VAT is excluded and adds 20% for a UK customer on most of
these.

## Options considered

### Option A — One small VPS running everything in Docker Compose (recommended)

A single 2 vCPU / 4 GB instance in an EU or UK region: `apps/web`, `apps/worker`,
PostgreSQL 16 and a reverse proxy terminating TLS, all from one `docker compose` file that
is nearly identical to the local development one.

| Line item | Estimate / month |
|---|---|
| VPS, 2 vCPU / 4 GB / 40 GB (e.g. Hetzner CX22 class, €4.59) | ~£4 |
| Provider snapshot backups (typically ~20% of instance price) | ~£1 |
| Off-box `pg_dump` to object storage, a few GB | ~£1 |
| Domain (annual, amortised) — **CEO decides separately** | ~£1 |
| TLS (Let's Encrypt) | £0 |
| Error tracking / uptime (free tiers only at launch) | £0 |
| **Total** | **~£7** |

Leaves roughly £50/month of the envelope for the Anthropic API, which is where the money
should go: AI spend is the only cost that buys the customer anything.

**Cost beyond money.** We operate it. Patching the host, renewing nothing (certbot is
automatic) but watching it, monitoring disk, and — the one that actually matters —
**owning the PostgreSQL restore**. An untested backup is not a backup. Deploys are
`git pull && docker compose up -d` behind a 20-line script, with no blue/green and a few
seconds of downtime, which is acceptable pre-revenue and would not be after.

**Blast radius.** The host is a single point of failure for the entire product. That is
already recorded as an accepted launch risk (`TECH-SPEC` §15) and it is true of the managed
single-instance options too — Option D's "managed" database is also one instance with no
HA on the cheap tiers. Option A does add correlated failure: losing the box loses web,
worker and database together rather than just one of them.

### Option B — Vercel for the web app plus a managed serverless PostgreSQL

The path of least resistance for Next.js: push to `main`, get previews, get a CDN.

| Line item | Estimate / month |
|---|---|
| Vercel Pro — **Hobby is non-commercial, so a paid SaaS needs Pro** ($20/seat) | ~£16 |
| Managed PostgreSQL (free tier, or ~$19 paid when the free tier's limits bite) | £0–£15 |
| **Somewhere to run the 10-minute worker** — not Vercel | £4–£7 |
| **Total** | **£20–£38, and we still run a VPS** |

Rejected, and the reason is structural rather than financial. The worker cannot live on
Vercel's functions, so we end up with Option A's VPS *plus* a platform bill *plus* two
deployment models *plus* a database connection story that has to be checked for
session-pinned transactions before it can be trusted with RLS. More money for more moving
parts. Worth naming precisely because it is the default choice everyone reaches for with
Next.js.

Note the portability consequence we already took: ADR-0002 confirmed Next.js *on the
condition that we use no Vercel-specific API*. That decision is what makes Option A
possible, and it is why rejecting Vercel here costs us nothing.

### Option C — Fly.io: two machines plus a managed PostgreSQL

Two small machines (web, worker) in `lhr`, plus a managed PostgreSQL. Roughly £8–£20/month
depending on sizing and whether the database is HA. Real deployment tooling, real health
checks, scale-to-zero for the worker, a sane path to a second region later.

Not rejected — **this is the named fallback.** It costs a little more than Option A and
buys away most of the host operations, and it keeps long-lived processes, which is the
property Option B lacks. If operating the VPS turns out to eat engineering time, this is
where we go, and the move is hours because nothing is provider-specific.

The reason it is not the recommendation: at launch we have no traffic and no revenue, and
paying a platform premium to avoid operating one box is the wrong trade while the
engineering bottleneck is the parser, not the host.

### Option D — Render, Railway or a similar PaaS

Web service plus background worker plus managed PostgreSQL, each billed separately:
roughly £5–£7 per always-on service and £6–£19 for the database, so **~£20–£35/month**.
Pleasant developer experience, straightforward private networking.

Rejected on cost against Option A for the same capability class as Option C, which is
better suited to a long-running worker. Re-evaluate at the same moment as Option C.

### Option E — AWS or GCP properly (ECS/Cloud Run plus RDS/Cloud SQL)

The thing a larger team would do.

Smallest honest RDS/Cloud SQL instance plus a load balancer plus NAT is **£40–£70/month
before any compute**, which breaks the envelope on its own. It also drags in IAM,
Terraform-for-ourselves, and a quantity of configuration that a six-agent team would pay
for every week. Rejected on cost and on **boring technology**: the interesting option here
is measurably worse at our size.

### Option F — Free tiers stitched together

A free-tier app host plus a free-tier database.

£0, and rejected anyway. Free tiers cold-start, suspend, cap connections, change terms
without notice, and — the disqualifying one — several reserve the right to limit commercial
use. Building a paid product on a free tier means the product dies when the terms change
and we do not control when that is. The £7 in Option A buys away a class of risk that is
much more expensive than £7.

## Decision (proposed)

**Recommend Option A: one small VPS in an EU/UK region running the whole stack from
Docker Compose, at roughly £7/month**, with **Option C (Fly.io) as the pre-agreed fallback**
if host operations become a drag. Formally:

1. **Production is one host.** `apps/web`, `apps/worker`, PostgreSQL 16 and a TLS-terminating
   reverse proxy, from a compose file that differs from the local one only in secrets,
   volumes and TLS.
2. **No provider-specific API anywhere in the codebase.** No platform storage SDK, no
   platform KV, no edge-runtime-only code paths. This is enforceable in review and is what
   keeps the fallback cheap. It is also already required by ADR-0002.
3. **Session-pinned transactions are a hosting acceptance criterion.** Before any hosting
   choice is confirmed, the RLS isolation suite (`TECH-SPEC` §13.3) must pass **against that
   host**, not just against a local container. Any database proxy that cannot guarantee a
   pinned session for a transaction is disqualified on tenancy grounds.
4. **Backups are part of the decision, not a follow-up.** Nightly `pg_dump` to off-host
   object storage, 7 daily plus 4 weekly copies, **plus a restore rehearsal with QA &
   Security's evidence attached before the first customer**. A backup nobody has restored
   is a line item, not a safeguard.
5. **EU/UK region, chosen before launch.** Customer data is limited to graph metadata,
   file paths and line numbers (ADR-0007), but tokens and account data are personal data
   and the region must be a deliberate, recorded choice — Product and QA & Security own the
   privacy wording; the CEO owns the commitment.
6. **Staging is the same compose file on the same host** under a separate database and a
   separate GitHub App, not a second paid environment — and like production it is a public
   URL, so it **needs CEO approval before it exists** (`TECH-SPEC` §12).
7. **Cost review at first revenue.** HA, a managed database, and a second region are all
   post-revenue decisions with their own ADR. None of them is an architecture change,
   because of rule 2.

## Cost

- **Money:** ~£7/month proposed, against a £60 envelope. ~£50 left for the Anthropic API,
  which is the point.
- **Engineering:** ~1 day to write the compose file, the deploy script and the restore
  runbook; ~0.5 day for the restore rehearsal. Both land in M4, not M1.
- **Operational:** host patching, disk monitoring, and ownership of the restore. Deploys
  have brief downtime.
- **Licence:** £0. Docker Engine (Apache-2.0), Caddy or nginx (Apache-2.0/BSD),
  PostgreSQL (PostgreSQL licence), Let's Encrypt. No new copyleft, nothing in the
  distributed client bundle.
- **What this makes harder:** zero-downtime deploys, horizontal scaling, surviving the loss
  of the host. All three are explicitly deferred.

## Consequences

- The cost constraint is met with ~£50/month of headroom, so the first expensive thing we
  do can be the thing customers pay for.
- Production looks like development. The same compose topology in both places removes the
  "works locally, fails in production" class of problem that a serverless split would
  introduce, and it keeps the no-cloud-account requirement for CI true.
- **Blast radius: the host is the product.** If it dies, everything is down and recovery is
  "restore the dump onto a new box", which is why the rehearsal is a launch gate and not a
  nice-to-have. The customer sees a maintenance page; `/api/v1/health` returns 503.
- We own operations we could have rented. That is a deliberate trade at £0 revenue and it
  is reviewed at first revenue, not never.
- Nothing here is legally or financially binding until the CEO acts. **No account, domain
  or instance may be created on the basis of this ADR alone.**

## Consequence of being wrong

| If wrong about | Failure mode | Cost to undo | Earliest signal |
|---|---|---|---|
| One box being enough | Parse jobs and web requests contend for 2 vCPU; the UI gets slow while a scan runs | Resize the instance (minutes), or split the worker onto a second box (hours) | Host CPU/memory correlated with scan activity; p95 API latency during scans |
| Host operations being cheap | Patching, monitoring and incidents eat engineering time that should go to the parser | Move to Option C — **hours**, because of rule 2 | Hours logged on host work in any two-week period |
| Backups being adequate | Data loss with an unusable backup | Unrecoverable in the worst case. This is why the rehearsal is a gate | A failed or unrehearsed restore — found in rehearsal, which is the only acceptable place to find it |
| A single point of failure being acceptable pre-revenue | An outage during a trial or a demo loses a prospect | Days to add HA, and real money | First unplanned outage; uptime monitor |
| £7 holding as we grow | The envelope is breached by scan volume or storage | Resize, then revisit with a cost ADR | Monthly spend tracked against £60 from day one |
| EU/UK region being sufficient for privacy commitments | A customer or regulator objects to the data location | Weeks if it means a migration | Raised in QA & Security's review or by the first enterprise prospect |

The deliberate asymmetry: every row except *backups* is recoverable in hours or days,
because the only expensive mistake in hosting is the one that loses data. That is where the
rehearsal requirement comes from.

## Open questions for the CEO

1. Approve ~£7/month for a VPS, a domain and off-host backups — or direct me to Option C at
   ~£8–£20/month for less operational load?
2. Which region, given UK-company and EU-customer expectations?
3. Does staging get its own URL before launch, or do we verify on a local instance and
   deploy production once? Staging is a public URL and therefore your call.
4. Domain name and registrar — both a purchase and a public identity, so yours to choose.
