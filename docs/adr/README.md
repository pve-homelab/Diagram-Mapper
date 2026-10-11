# Architecture decision records

Numbered, immutable-once-accepted records of the decisions behind
[`docs/TECH-SPEC.md`](../TECH-SPEC.md). Every ADR states its context, at least two
options with their costs, the decision, the cost of the decision, and **the consequence
of being wrong** — because a decision record without that last section is just an
opinion with a number on it.

| # | Title | Status | Reversibility |
|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions in the repository | Accepted | Cheap |
| [0002](0002-confirm-the-approved-stack.md) | Confirm the approved stack; REST over GraphQL | Accepted | Mixed — see ADR |
| [0003](0003-resource-graph-model.md) | Resource-graph model: configuration-address property graph | Accepted | **Expensive** |
| [0004](0004-tenancy-model.md) | Tenancy: forced row-level security, non-bypassing role, composite keys | Accepted | **Expensive** |
| [0005](0005-hcl-parsing-approach.md) | HCL parsing: `hcl2json` WASM plus an in-house position index | Accepted (spike-conditional) | Moderate |
| [0006](0006-ai-provider-seam.md) | AI provider seam and the egress boundary | Accepted | Cheap (seam) |
| [0007](0007-source-retention-boundary.md) | Source retention boundary: graph plus references, source on demand | Accepted (one item needs CEO confirmation) | **Expensive** |
| [0008](0008-queue-on-postgresql.md) | Background jobs: pg-boss on the application database | Accepted | Cheap |
| [0009](0009-hosting-and-cost-envelope.md) | Hosting options inside GBP 60/month | Proposed — CEO decides | Cheap |
| [0010](0010-data-access-layer.md) | Data access: Drizzle plus `pg`, no ORM-managed pooling | Accepted | Moderate |
| [0011](0011-monorepo-and-tooling.md) | Single pnpm monorepo, enforced module boundaries | Accepted | Moderate |

## Status values

- **Proposed** — written, not yet agreed. Names who decides.
- **Accepted** — in force. Implement this.
- **Spike-conditional** — accepted as the plan of record, with a named spike that may
  overturn it and a stated fallback.
- **Superseded by NNNN** — kept in place, never edited or deleted. History is the point.

## Writing a new one

Copy [`TEMPLATE.md`](TEMPLATE.md), take the next free number, add a row above. Do not
renumber and do not rewrite an accepted ADR: supersede it with a new one that explains
what changed. Decisions touching `packages/graph` (ADR-0003), the tenancy model
(ADR-0004) or the retention boundary (ADR-0007) require CTO review and a QA & Security
read before implementation.
