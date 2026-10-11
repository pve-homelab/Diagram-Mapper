# ADR-0002: Confirm the approved stack; REST over GraphQL

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-11 |
| **Decider** | CTO, confirming the product owner's approved stack |
| **Consulted** | CEO (approved the stack), QA & Security (licence gate) |
| **Affects** | `docs/TECH-SPEC.md` §3, §7, §11 |
| **Reversibility** | Mixed. Framework and ORM: moderate. PostgreSQL and the API style: expensive. Canvas library: cheap behind `packages/ui`. |

## Context

The product owner approved a stack before this specification existed: TypeScript end to
end, Next.js, PostgreSQL, React Flow for the canvas, Stripe for subscriptions, Claude API
for explanations. My brief is explicit that the stack is approved but not to be followed
blindly, and that disagreement must be written down with evidence rather than acted on
silently.

This ADR does two things: it confirms each approved component against the actual
constraints, and it decides the one significant thing the approval did not cover — the
API style between the browser and the server.

Binding constraints:

- Running cost under **GBP 60/month** until the first paying customer. This is the
  sharpest constraint and it eliminates most managed infrastructure.
- Six agents, one of each discipline. Every runtime, language and deployment artefact
  added is a thing all six must understand.
- Raw customer IaC is not retained; the GitHub install is read-only; tenant isolation is
  a schema property. These favour a database that can enforce authorisation itself.
- The risky parts are the Terraform parser and grounded explanations. Budget for novelty
  belongs there, not in the web tier.

## Options considered

I assessed the approved stack component by component against one serious alternative
each, and treated "confirm" as a decision requiring justification rather than a default.

### Language — TypeScript everywhere (approved) vs. Go or Rust for the parser

TypeScript end to end means one toolchain, one test runner, one type system, and the
graph schema defined **once** in `packages/graph` and shared by parser, API and browser.
That shared-schema property is load-bearing for the test strategy: the frontend builds
against golden fixtures validated by the same zod schemas the parser emits (`TECH-SPEC`
§14, M1/M2 overlap).

The alternative is real and worth naming: HashiCorp's own `hashicorp/hcl` parser is Go,
and a Go parser service would give exact source positions for free (see ADR-0005). The
cost is a second language, a second build and deployment artefact, a second dependency
and vulnerability surface, cross-process serialisation of the parse result, and a team of
six in which exactly one agent would own code nobody else can review. **Boring
technology** is about the team's total maintenance load, and a second runtime is the
single most expensive thing you can add to a small team.

**Cost of TypeScript:** we must build the position index ourselves (~5 days, ADR-0005).
**Cost of Go:** ~3 days saved on positions, paid back indefinitely in two-runtime
overhead. Confirmed: **TypeScript**, with the position-index cost accepted explicitly and
re-examined if spike AIS-4 shows it is materially worse than estimated.

### Web framework — Next.js App Router (approved) vs. Vite SPA plus a separate API

Next.js gives one deployment artefact serving the marketing pages, the authenticated app
and the API route handlers, with server components for the authenticated shell and
streaming (SSE) for explanations. One artefact matters at £60/month: a split SPA plus API
is two deployables, two logs, two CI jobs and usually a second hosting line item.

Against it: Next.js is a large framework with a fast release cadence and real upgrade
cost, and its server/client boundary is a recurring source of subtle bugs. A Vite SPA
with a plain Node API is simpler to reason about and cheaper to move between hosts.

The deciding factor is that the canvas and chat are a heavily client-side application
inside an otherwise ordinary SaaS shell, and the marketing and billing pages benefit from
server rendering. Both are served by one Next.js app. **Cost:** £0 licence (MIT), a
framework upgrade every few months, and vendor-shaped defaults that we deliberately do
not use (no Vercel-specific APIs; see ADR-0009 on portability). Confirmed: **Next.js 15,
App Router**, with the rule that no host-proprietary API may be used in application code.

### Database — PostgreSQL 16 (approved) vs. SQLite, vs. PostgreSQL plus a graph database

PostgreSQL is confirmed, and it is the strongest item in the approved stack for reasons
the approval probably did not consider: **row-level security** lets tenant isolation be a
schema property rather than a coding convention (ADR-0004), and `pg-boss` lets the job
queue live in the same database rather than being a paid service (ADR-0008). One
component does three jobs.

SQLite (or a hosted SQLite service) would be cheaper still and is genuinely tempting at
this scale, but it has no row-level security and no equivalent of
`current_setting`-scoped policies, so isolation would fall back to application code —
exactly what the brief forbids. A graph database alongside PostgreSQL is assessed and
rejected in ADR-0003.

**Cost:** £0 licence (PostgreSQL licence, permissive); hosting cost is ADR-0009's
subject. Confirmed: **PostgreSQL 16, single instance at launch**, with the single point of
failure accepted and recorded as a risk (`TECH-SPEC` §15).

### Canvas — React Flow 12 / `@xyflow/react` (approved) vs. raw D3 or Cytoscape.js

React Flow 12 is MIT; the Pro tier is not required for anything in the launch scope, and
this ADR records that we must not depend on a Pro-only feature without a new ADR and CEO
approval of the cost. It gives pan, zoom, selection, custom nodes, grouping and edge
routing as React components, which suits a React-based detail panel and chat panel
sharing selection state.

Cytoscape.js (MIT) has better large-graph performance and built-in layouts, but its nodes
are canvas-drawn rather than DOM, so custom node chrome and accessibility are harder, and
our node panels and keyboard traversal requirement (`TECH-SPEC` §9.5) are DOM-shaped.
Raw D3 is maximum control at maximum cost.

The honest risk is performance above ~1,000 nodes, which is why Frontend spike AIS-5
exists. **Cost:** £0; a possible rework if AIS-5 shows React Flow cannot reach the node
counts we need. Mitigation is a seam: the canvas lives behind `packages/ui` and consumes
the graph wire format from `packages/graph`, so swapping the renderer does not touch the
API, the parser or the graph. Confirmed: **React Flow 12, spike-conditional**, with the
renderer behind a seam.

### Payments — Stripe (approved) vs. Paddle (merchant of record)

Stripe Checkout plus the Billing Portal plus webhooks means we never see a card number
and build no payment UI. Per-transaction cost only, no monthly fee — compatible with
£60/month.

Paddle acts as merchant of record and would handle sales-tax/VAT registration across
jurisdictions, which is a genuine advantage for a UK company selling internationally and
a real administrative cost Stripe pushes onto us (Stripe Tax is an extra per-transaction
charge). This is a commercial decision, not a technical one; I record it as a cost the
CEO should be aware of rather than overturning the approval. Entitlements are read from
our own `subscriptions` table, so Stripe is already behind a thin seam and a switch would
not touch product code.

**Cost:** per-transaction fees, plus VAT handling as our responsibility. Confirmed:
**Stripe**, test mode only until the CEO explicitly authorises live mode.

### AI — Anthropic Claude API (approved) vs. a provider-abstraction layer or self-hosted

Confirmed, with the seam and the egress boundary specified separately in ADR-0006.

### API style — REST plus zod (decided here) vs. GraphQL vs. tRPC

The approval did not cover this. GraphQL's value is many clients with divergent data
needs; we have exactly one client, built by one agent, consuming a graph payload whose
shape is already defined by `packages/graph`. GraphQL would add a schema language that
duplicates the zod schemas — two sources of truth for one contract — plus resolver
plumbing, query-depth limits and N+1 mitigation, all for a client that fetches "a
snapshot" and "a node's neighbourhood".

tRPC would give end-to-end types with no duplication and is a close second. It was
rejected because it couples the client to server function signatures, which makes the
contract harder to test independently and harder to expose publicly later, and because
plain HTTP responses validated by shared zod schemas already give us the CI `contracts`
gate (`TECH-SPEC` §11).

**Decision:** versioned REST under `/api/v1`, request and response schemas as zod in
`apps/web/lib/contracts/`, graph types imported from `packages/graph`, SSE for
explanation streaming. **Cost:** hand-written route handlers; a little boilerplate per
endpoint.

## Decision

The approved stack is **confirmed in full**: TypeScript (strict,
`noUncheckedIndexedAccess`), Next.js 15 App Router, React 19, PostgreSQL 16, React Flow
12, Stripe, Claude API. Supporting choices, each with its own ADR where the choice is not
obvious: Drizzle plus `pg` (ADR-0010), pg-boss (ADR-0008), `@cdktf/hcl2json` plus an
in-house position index (ADR-0005), Auth.js with GitHub OAuth, zod, Vitest and Playwright,
Biome, pnpm workspaces (ADR-0011). The API is versioned REST with zod contracts, not
GraphQL and not tRPC.

Three caveats are part of the decision, not footnotes:

1. **React Flow is spike-conditional** on AIS-5 and sits behind the `packages/ui` seam.
2. **No host-proprietary or Pro-tier API** may enter application code without a new ADR
   and, where it costs money, CEO approval.
3. **Licences in `TECH-SPEC` §3 are my assertion from package metadata, not a ruling.**
   The CI `licences` gate verifies them mechanically and QA & Security owns the
   authoritative review. Two items are flagged there: `@cdktf/hcl2json` is MPL-2.0
   (ADR-0005), and Terraform ≥ 1.6 is BUSL-1.1 and excluded entirely.

I am recording one disagreement-adjacent item for the CEO rather than deviating: **Paddle
versus Stripe is a tax-administration trade-off**, not a technical one. Stripe is the
right technical choice; if international VAT handling turns out to be a burden the CEO
does not want, raise it with Product and I will write the superseding ADR. Nothing in the
code needs to change to keep that option open.

## Cost

- **Recurring money at launch:** £0 in licences. Stripe per-transaction fees only.
  Anthropic API metered and capped (`TECH-SPEC` §8.6). Hosting is ADR-0009.
- **One-off engineering:** the position index (~5 days) is the price of staying
  single-language; hand-written REST handlers are perhaps 1–2 days more than tRPC across
  the whole API surface.
- **Ongoing:** Next.js and React major upgrades; one dependency tree to audit.
- **Licence obligations:** permissive throughout (MIT/ISC/Apache-2.0/BSD/PostgreSQL) with
  the MPL-2.0 exception in ADR-0005. No copyleft obligation on our own source.

## Consequences

- One language, one database, one queue, one deployment artefact per process. Any agent
  can read any part of the system, which is the property a six-agent team needs most.
- The graph wire format is defined once and shared by parser, API and canvas, which is
  what makes fixture-driven frontend development possible before the backend exists.
- Two seams exist deliberately: the AI provider (ADR-0006) and the canvas renderer. No
  seam exists for the database or the web framework, because nothing there varies.
- We own the HCL position-index problem. That is the single largest accepted risk from
  this ADR and it is tracked as spike AIS-4.
- GraphQL is foreclosed without a superseding ADR. If we later need a public API for
  third-party clients, REST under `/api/v1` is a reasonable starting point.

## Consequence of being wrong

| If wrong about | Failure mode | Cost to undo | Earliest signal |
|---|---|---|---|
| React Flow at scale | Canvas unusable on large repositories — the enterprise case | 1–2 weeks to swap the renderer behind `packages/ui`; the API and graph are untouched | Spike AIS-5, **before** M2 starts |
| TypeScript for the parser | Position accuracy is poor and the index keeps growing in cost | A Go sidecar is ~2 weeks plus permanent two-runtime overhead; the `parse()` interface and `ParseResult` shape survive | Spike AIS-4's measured line-reference accuracy |
| Next.js | Upgrade pain or an unwanted host coupling | Weeks to split into SPA plus API; mitigated by the no-proprietary-API rule | A major-version upgrade that breaks the app, or a host-lock-in pressure |
| PostgreSQL | Would be a serious error — RLS and pg-boss both depend on it | Months. Treat as irreversible | None expected; this is the most confident item here |
| REST over GraphQL | Over-fetching on the canvas payload, or awkward client queries | Days — add a purpose-built endpoint, which is what REST is for | Frontend reporting repeated multi-call round trips in M2 |
| Stripe over Paddle | We carry international VAT registration ourselves | Weeks of commercial work, little code change | First international sales volume; CEO's call |

The expensive mistakes in this ADR are PostgreSQL (confident) and the single-language
decision (spike-measured). Everything else is a decision we can afford to get wrong,
which is why I spent the deliberation on those two.
