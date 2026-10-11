# Diagram Mapper — Technical Specification

| | |
|---|---|
| **Version** | 0.2 — pre-spike baseline, with the licence review's rulings folded in |
| **Status** | Draft for M0 sign-off. Will be revised once the three M0 spikes land (see §16). |
| **Owner** | CTO & Principal Architect |
| **Date** | 2026-10-12 |
| **Supersedes** | Nothing. First technical specification for this repository. |
| **Source requirements** | `PROMPT.md`, `First_Team_outcome.md`, `commercial launch ready product.md`, `pricinples and contraints.md` |
| **Decisions behind this document** | `docs/adr/0001` … `docs/adr/0011` |

## 0. How to read this document

This specification is written so that an engineer who has read none of the project
discussion can implement from it. Where a decision has alternatives, the reasoning lives
in an ADR under `docs/adr/` and is cited inline as `[ADR-nnnn]`. Where a number or a
behaviour is still open, it appears in §16 as an explicit open question with an owner —
not as a silent gap.

Two reading rules:

1. **MUST / MUST NOT / SHOULD** are normative. Everything else is context.
2. Anything described as a *seam* is an interface that exists because something behind it
   is expected to change. Do not collapse a seam into its current implementation.

---

## 1. Product in one paragraph

A customer installs a **read-only GitHub App** on a repository that contains Terraform.
Diagram Mapper downloads a snapshot of that repository, parses the HCL **statically**,
builds a **resource graph** of Terraform objects and the references between them,
discards the source files, and persists only the graph plus file-and-line references.
The web application renders that graph on an interactive canvas. Clicking a node opens a
detail panel showing the resource's attributes with their source locations. A movable,
resizable chat panel answers questions about the selected node, with every factual claim
cited back to a node or a `path:line` in the customer's repository. Access is sold as a
subscription; the free tier requires the customer's own Claude API key, paid tiers use a
platform key with a hard per-plan token cap.

### 1.1 Launch scope (what is in v1)

| In | Out of launch scope |
|---|---|
| Terraform / HCL (`.tf`, `.tf.json`) | CloudFormation, Pulumi, Bicep, Kubernetes manifests, Ansible |
| Optional `terraform plan` JSON uploaded by the customer, used for **structure only** | Running `terraform`/`tofu` against customer infrastructure |
| Local modules (`./modules/x`) followed inside the repository | Fetching remote module sources (registry, git, S3) |
| GitHub.com repositories via a GitHub App | GitHub Enterprise Server, GitLab, Bitbucket, Azure DevOps |
| Resource graph, interactive canvas, node detail, grounded chat | Jira / Confluence / incident / SOP enrichment (`PROMPT.md` §"Why is this here?"), learning paths, security-investigation mode |
| Single current snapshot per repository | Snapshot-to-snapshot diff view (the data model supports it — §4.8 — the UI is deferred) |

Feature priority and pricing are owned by Product & Market Research, not by this document.
This specification defines the **mechanism** for plans, caps and entitlements (§7.9, §9.6)
and leaves the numbers to Product.

---

## 2. Architecture overview

### 2.1 Design constraints that shaped it

- Six agents build and maintain this. **Conway's Law**: few modules with hard boundaries,
  each with one owner. Seven packages, not thirty.
- **Build the risky part first.** The Terraform parser and grounded explanations carry the
  product risk. Everything else is a solved problem.
- **Reversibility first.** Design effort is spent on the three decisions that are expensive
  to undo — the graph model (§4), the tenancy model (§6), the billing model (§9.6) — and
  deliberately not spent on the ones that are cheap to undo.
- **Running cost under GBP 60/month until the first paying customer.** This rules out
  managed queues, managed search, managed vector databases and per-seat platform tiers.
  See `[ADR-0009]`.
- **Boring technology.** One language (TypeScript), one database (PostgreSQL), one queue
  (PostgreSQL), one deployment artefact per process.

### 2.2 Components

```
                       ┌──────────────────────────── browser ────────────────────────────┐
                       │  apps/web client: canvas (React Flow) · node panel · chat panel │
                       └───────────────┬───────────────────────────┬─────────────────────┘
                                HTTPS  │ JSON (zod-validated)      │ SSE (explanation stream)
                       ┌───────────────▼───────────────────────────▼─────────────────────┐
                       │  apps/web server — Next.js route handlers (the only HTTP front) │
                       │  auth · tenancy context · entitlements · request validation     │
                       └───┬──────────────┬───────────────┬────────────────┬─────────────┘
                           │              │               │                │
              packages/db  │   packages/graph   packages/explain     Stripe / GitHub
              withTenant() │   (read models)    (context + prompt)   (webhooks, REST)
                           │              │               │
                    ┌──────▼──────────────▼───────────────▼──────┐        ┌──────────────┐
                    │          PostgreSQL 16 (RLS enforced)      │◀──────▶│ pg-boss queue│
                    │  tenants · graphs · conversations · usage  │        │ (same DB)    │
                    └──────▲─────────────────────────────────────┘        └──────▲───────┘
                           │                                                     │
                    ┌──────┴─────────────────────────────────────────────────────┴───────┐
                    │  apps/worker — ingestion pipeline (§5)                             │
                    │  packages/parser (HCL → ParseResult) · packages/graph (→ Graph)    │
                    │  ephemeral tmpfs scratch, destroyed per scan                       │
                    └────────────────────────────────────────────────────────────────────┘
                                   │ read-only                      │ HTTPS
                            api.github.com                   api.anthropic.com
                       (tarball + contents, installation token)   (explanations)
```

### 2.3 Module boundaries, owners and communication

| Module | Owner | May import | MUST NOT | Communication |
|---|---|---|---|---|
| `packages/graph` | CTO (schema) / Backend | `zod` only | Any I/O, any DB, any network, any Node built-in except `crypto` | Pure functions + types. The **single source of truth** for the graph wire format. |
| `packages/parser` | Backend | `packages/graph`, `@cdktf/hcl2json` | Network, DB, filesystem writes outside its scratch argument | `parse(files: FileInput[]) => ParseResult` |
| `packages/db` | Backend | `packages/graph`, `drizzle-orm`, `pg` | Business logic, HTTP, AI | `withTenant(tenantId, fn)` is the **only** exported way to obtain a query handle (§6.4) |
| `packages/explain` | AI Engineer | `packages/graph`, `packages/db` (read models only), `@anthropic-ai/sdk` | Writing graph rows, direct `pg` access | `assembleContext()`, `explain()`, `validateCitations()` |
| `packages/ui` | Frontend | `react`, `@xyflow/react`, Tailwind | `packages/db`, `packages/parser` | React components |
| `packages/config` | Backend | `zod` | Everything | `env` object, parsed and validated once at process start |
| `apps/web` | Frontend (client) / Backend (route handlers) | all packages | Reusing a DB handle across requests | HTTP/SSE to the browser; function calls into packages |
| `apps/worker` | Backend | `packages/{parser,graph,db,config}` | Serving HTTP | Consumes pg-boss jobs |

**Enforced in CI**, not by convention: a dependency-boundary test
(`pnpm test:boundaries`) asserts the `MUST NOT` column by reading each package's
`package.json` dependencies and its import graph. A violation fails the build.

### 2.4 Blast radius

For every component, what breaks and what the customer sees.

| Component fails | Consequence | Customer sees |
|---|---|---|
| PostgreSQL | Total outage. Nothing works. | Maintenance page; `/api/v1/health` returns 503. Single point of failure — accepted at launch, stated as a risk (§15). |
| pg-boss worker (`apps/worker`) | No new scans complete. Existing graphs still render and chat still works. | Scan sits in `queued`; UI shows "Analysis queued" with the queue age after 2 min, and a support reference after 15 min. |
| GitHub API unreachable / installation revoked | No new scans; source snippets cannot be re-fetched, so the source view and snippet-grounded chat degrade. | Node panel shows "Source temporarily unavailable — reconnect GitHub" with the `path:line` still displayed. Graph and attributes still render (they are persisted). |
| Anthropic API unreachable or tenant cap reached | Chat unavailable. Diagram, node panel and search unaffected. | Chat panel shows `AI_UNAVAILABLE` / `AI_CAP_REACHED` with the reset date; the rest of the product is usable. |
| Stripe unreachable | No new subscriptions or plan changes. Existing entitlements are read from our own `subscriptions` table, so paying customers are unaffected. | Billing page shows "Billing temporarily unavailable". |
| `apps/web` | Total outage for the UI. API down. | Browser error page. |
| Parser regression | A scan fails invariant validation (§5.8) and **no snapshot is published**; the previous snapshot stays current. | Previous diagram remains; new scan shows `GRAPH_INVARIANT_VIOLATION` with a support reference. Fail closed, never publish a wrong diagram. |

---

## 3. Technology stack

Confirmed with reasoning in `[ADR-0002]`. Declined options and their costs are recorded there.

| Concern | Choice | Version at launch | Licence | Recurring cost |
|---|---|---|---|---|
| Language | TypeScript, `strict`, `noUncheckedIndexedAccess` | 5.x | Apache-2.0 | £0 |
| Web framework | Next.js App Router | 15.x | MIT | £0 |
| UI | React 19, Tailwind CSS, shadcn/ui (copied in, not a dependency) | — | MIT | £0 |
| Canvas | `@xyflow/react` (React Flow 12) | 12.x | MIT | £0 — React Flow **Pro is not required** |
| Graph layout | `@dagrejs/dagre` (candidate) | 1.x | MIT | £0 — final choice is the Frontend spike's; `elkjs` (EPL-2.0) is permitted unmodified with shipped notices, per the licence review |
| Database | PostgreSQL | 16 | PostgreSQL licence | see `[ADR-0009]` |
| Data access | Drizzle ORM + `pg` | — | Apache-2.0 / MIT | £0 — `[ADR-0010]` |
| Queue | pg-boss on the same PostgreSQL | 10.x | MIT | £0 — `[ADR-0008]` |
| HCL parsing | `@cdktf/hcl2json` (WASM) + an in-house position index | — | MPL-2.0 — cleared, unmodified only | £0 — `[ADR-0005]` |
| Auth | Auth.js (`next-auth` v5), GitHub OAuth from the same GitHub App | 5.x | ISC | £0 |
| Payments | Stripe (Checkout + Billing Portal + webhooks) | — | MIT (SDK) | per-transaction only |
| AI | Anthropic Claude API via `@anthropic-ai/sdk` | — | MIT (SDK) | metered, capped — §9.6 |
| Validation | zod | 3.x/4.x | MIT | £0 |
| Tests | Vitest, Playwright | — | MIT / Apache-2.0 | £0 |
| Lint/format | Biome | 1.x/2.x | MIT ∪ Apache-2.0 | £0 |
| GitHub client | `octokit` | — | MIT | £0 |

**Licence position.** Every dependency above is permissive (MIT / ISC / Apache-2.0 /
BSD / PostgreSQL) except where noted. The authoritative policy is QA & Security's
`docs/LICENCE-AND-DEPENDENCY-PLAN.md` (AIS-7), which has now ruled on the two items this
specification had left open:

1. **`@cdktf/hcl2json` is MPL-2.0** and embeds `hashicorp/hcl` (MPL-2.0). **Cleared** by
   the licence review: MPL-2.0 is file-level copyleft and combining it with proprietary
   code into a "Larger Work" is explicitly permitted by its §3.3. The clearance carries a
   **binding condition — never fork, vendor-patch or inline an MPL dependency; use it
   unmodified.** If a patch becomes unavoidable, we upstream it or publish the patched
   file. This is a review rule, and it constrains the position-index design: our index is
   built **beside** `hcl2json`'s output, never by editing its source. The fallback if the
   clearance is ever withdrawn remains in `[ADR-0005]` §Alternatives.
2. **Terraform ≥ 1.6 is BUSL-1.1 and is excluded entirely.** We do not ship, embed, call
   or vendor the `terraform` binary. See `[ADR-0005]`. BUSL is prohibited for a
   *dependency* and is unobjectionable for *our own* code — the asymmetry is deliberate.
3. **`elkjs` (EPL-2.0) is permitted** for the layout choice, unmodified and with its
   notice shipped, since it is client-bundled and therefore distributed. `@dagrejs/dagre`
   (MIT) remains preferred; EPL is a trade to take knowingly, not by accident
   (open question 4, §16).

All other licence identifiers in this table are my assertion from package metadata and
**must be verified in the automated licence gate** (§11), not trusted from this document.
The gate also generates `THIRD-PARTY-LICENCES.md` and an SBOM, which is what actually
discharges the attribution obligations above.

---

## 4. The resource-graph schema

This is the core asset. Everything else in this specification is replaceable; this is not.
Rationale and rejected models are in `[ADR-0003]`.

The canonical definition lives in code at `packages/graph/src/schema.ts` as zod schemas.
The TypeScript types are **inferred from the zod schemas** (`z.infer`), never declared
separately, so the wire format, the runtime validator and the compile-time type cannot
drift. The JSON Schema used by fixtures is generated from the same source.

### 4.1 Governing rules

These five rules are what make the diagram trustworthy. They are each enforced by a test
in §13.

1. **Never invent.** A value that static analysis cannot determine is represented as
   *unresolved with its source expression*, never guessed, never defaulted, never omitted
   silently.
2. **Everything is attributable.** Every node and every edge carries a `SourceRef` or an
   explicit non-source provenance. There is no third category.
3. **One identity scheme.** Node identity is the Terraform configuration address. There is
   no second naming scheme anywhere in the system.
4. **Snapshots are immutable.** A snapshot is never mutated after publication. A re-scan
   produces a new snapshot. This makes diffing, caching and incident forensics possible.
5. **Derived data is labelled and regenerable.** Layout caches, display labels and
   summaries are derived; they carry the `parserVersion` that produced them and can be
   thrown away.

### 4.2 `SourceRef`

```ts
const SourceRef = z.object({
  path:        z.string(),          // repo-relative POSIX path, e.g. "modules/network/main.tf"
  startLine:   z.number().int().positive(),   // 1-based, inclusive
  endLine:     z.number().int().positive(),   // 1-based, inclusive, >= startLine
  startColumn: z.number().int().positive().optional(),  // 1-based, UTF-16 code units
  endColumn:   z.number().int().positive().optional(),
  blobSha:     z.string().length(40),         // git blob sha of the file at scan time
});
```

- `path` is **repo-relative**. The repository owner and name are deliberately not part of
  a `SourceRef`, so a `SourceRef` can be sent to the AI provider without disclosing which
  repository it came from (§8.4).
- `blobSha` makes a reference verifiable later: if the file has changed, the re-fetch
  (§7.6) detects the mismatch and the UI says "this file has changed since analysis"
  rather than showing the wrong lines.
- There is **no `snippet` field.** Source text is not persisted. See §4.9 and `[ADR-0007]`.

### 4.3 `AttributeValue` — how unresolved and dynamic values are represented

A tagged union. This is the single most important type in the product, because it is what
stops the diagram and the explanations from lying.

```ts
type AttributeValue =
  | { v: "literal";    value: Json; source: SourceRef }
  | { v: "resolved";   value: Json; source: SourceRef; provenance: Provenance[] }
  | { v: "partial";    parts: Array<{ k: "lit"; text: string } | { k: "ref"; ref: Reference }>;
                       expression: string; source: SourceRef; refs: Reference[] }
  | { v: "unresolved"; expression: string; refs: Reference[]; reason: UnresolvedReason;
                       source: SourceRef }
  | { v: "sensitive";  source: SourceRef; why: "declared_sensitive" | "secret_pattern" }
  | { v: "omitted";    source: SourceRef; why: "too_large" | "policy" }
  | { v: "object";     entries: Record<string, AttributeValue>; source: SourceRef }
  | { v: "list";       items: AttributeValue[]; source: SourceRef };

type UnresolvedReason =
  | "variable_no_default"   // var.x with no default and no tfvars in the repo
  | "resource_attribute"    // depends on an apply-time value, e.g. aws_vpc.main.id
  | "data_source"           // depends on a data block result
  | "unsupported_function"  // function outside the evaluator allow-list
  | "for_expression" | "dynamic_block" | "conditional_unresolved"
  | "locals_cycle" | "parse_error" | "depth_limit";

type Provenance =
  | { from: "literal" }
  | { from: "variable_default"; nodeAddress: string; source: SourceRef }
  | { from: "tfvars"; path: string; source: SourceRef }
  | { from: "local"; nodeAddress: string; source: SourceRef }
  | { from: "function"; name: string }
  | { from: "plan_json" };            // structure only — never values, see §5.7
```

Normative rules:

- `literal` means the source text was a constant. `resolved` means the evaluator computed
  it and `provenance` lists every input it used — so the UI can say "`name` is
  `prod-web-01`, built from `var.environment` (default `prod`) at `variables.tf:4`".
- `partial` exists for the overwhelmingly common `"${var.env}-web"` case. Interpolation is
  preserved structurally so the UI can render the known parts and mark the unknown ones,
  rather than collapsing to "unknown".
- `expression` strings are **truncated to 512 characters** (with a trailing `…`) and
  **comments are stripped** before storage. Comments are never retained in any form.
- `unresolved` MUST always carry a non-empty `expression`. An `unresolved` with no
  expression is an invariant violation (§13.2).
- `sensitive` carries no value at all, not even a redacted length. Produced when the
  variable or output is declared `sensitive = true`, **or** when the secret-pattern set
  (§8.5) matches the literal. The pattern set is applied at persistence time, so a secret
  cannot reach the database even if it reached memory.
- Nesting depth is capped at **8**; deeper structures become `{v:"omitted", why:"too_large"}`.
  Serialized `attributes` per node is capped at **64 KB**; the overflow is dropped
  attribute-by-attribute in declaration order, each replaced by `omitted`, and a
  `NODE_ATTRIBUTES_TRUNCATED` diagnostic is emitted. Caps exist so one pathological
  repository cannot degrade the whole service.

### 4.4 `Reference` — a parsed Terraform traversal

```ts
const Reference = z.object({
  raw:          z.string(),        // "aws_vpc.main.cidr_block"
  kind:         z.enum(["resource","data","var","local","module","output",
                        "each","count","self","path","terraform","provider","unknown"]),
  targetAddress: z.string().nullable(),  // normalized config address, null if unresolvable
  attributePath: z.array(z.string()),    // ["cidr_block"]
  source:        SourceRef,
});
```

Reference extraction is **syntactic and total**: it walks expression text, finds
traversals, and classifies them. It never evaluates. An expression it cannot classify
yields `kind: "unknown"` and a `UNRESOLVED_REFERENCE` diagnostic — it never throws and
never silently drops the reference.

### 4.5 `GraphNode`

```ts
const GraphNode = z.object({
  id:           z.string().uuid(),          // uuidv5(NS, snapshotId + "|" + address + "|" + kind)
  stableKey:    z.string().uuid(),          // uuidv5(NS, repositoryId + "|" + address + "|" + kind)
  address:      z.string(),                 // "module.network.aws_subnet.private"
  kind:         z.enum(["managed_resource","data_resource","module_call","variable",
                        "local","output","provider","terraform_settings",
                        "unknown_reference"]),
  type:         z.string().nullable(),      // "aws_subnet"; null for var/local/output/module_call
  name:         z.string(),                 // "private"
  providerName: z.string().nullable(),      // "aws" — from `provider =` if set, else type prefix
  modulePath:   z.array(z.string()),        // [] at root; ["network"] inside module "network"
  multiplicity: Multiplicity,
  attributes:   z.record(AttributeValue),
  meta:         z.object({
    dependsOn:      z.array(Reference),
    hasProvisioner: z.boolean(),
    lifecycle:      z.record(AttributeValue).nullable(),
    moduleSource:   z.string().nullable(),   // module_call only
    moduleResolution: z.enum(["local_resolved","remote_unsupported","not_found"]).nullable(),
  }),
  display:      z.object({                  // derived, regenerable
    label:      z.string(),                 // "aws_subnet.private"
    sublabel:   z.string().nullable(),      // best-effort resolved Name tag, or null
    groupId:    z.string().nullable(),      // id of the containing module_call node
    iconKey:    z.string(),                 // "aws/subnet" | "generic/resource"
  }),
  source:       SourceRef,                  // the whole block, first line to closing brace
  diagnosticCodes: z.array(z.string()),     // diagnostics attached to this node
});

const Multiplicity = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("single") }),
  z.object({ kind: z.literal("count"),    expression: z.string(), refs: z.array(Reference),
             resolved: z.number().int().nullable(),
             resolution: z.enum(["literal","plan","unresolved"]) }),
  z.object({ kind: z.literal("for_each"), expression: z.string(), refs: z.array(Reference),
             resolvedKeys: z.array(z.string()).nullable(),
             resolution: z.enum(["literal","plan","unresolved"]) }),
]);
```

Identity decisions, stated explicitly because they are expensive to change later:

- **The node is the configuration object, not the instance.** `aws_instance.web` with
  `count = 3` is **one** node whose `multiplicity` says three. Rendering three boxes for
  one block makes a 400-resource repository into a 4,000-box canvas and makes the diagram
  less true to the source, not more. `resolved`/`resolvedKeys` is populated only when the
  count is a literal or confirmed by plan JSON; otherwise it is `null` with
  `resolution: "unresolved"`, and the UI shows `aws_instance.web ×?`.
- `address` excludes instance keys, so `module.a.aws_instance.web`, never
  `module.a.aws_instance.web[0]`.
- `id` is a deterministic uuidv5, not a random uuid, so **golden fixtures are stable**
  and a re-parse of identical input produces an identical graph byte-for-byte after
  canonicalisation (§13.1).
- `stableKey` is snapshot-independent, so a node can be followed across snapshots. The
  diff UI is deferred; the key is not, because adding it later means rewriting history.
- `unknown_reference` nodes are first-class. When `aws_instance.web` references
  `module.vpc.outputs.id` and `module.vpc` is a remote module we did not fetch, we create
  a node of kind `unknown_reference` with that address. **Showing the hole is correct;
  hiding it is a lie.**

### 4.6 `GraphEdge`

```ts
const GraphEdge = z.object({
  id:            z.string().uuid(),   // uuidv5(NS, snapshotId+"|"+from+"|"+to+"|"+kind+"|"+attributePath)
  fromNodeId:    z.string().uuid(),   // the DEPENDENT
  toNodeId:      z.string().uuid(),   // the DEPENDENCY
  kind:          EdgeKind,
  provenance:    z.enum(["static_hcl","plan_json"]),
  confidence:    z.enum(["exact","heuristic"]),
  attributePath: z.array(z.string()), // where in `from` the reference appears: ["subnet_id"]
  source:        SourceRef.nullable(), // null ONLY for kind "contains" or provenance "plan_json"
  label:         z.string().nullable(),
});

const EdgeKind = z.enum([
  "reference",            // an expression in `from` references `to`         (most edges)
  "explicit_dependency",  // depends_on
  "contains",             // module_call (to) contains node (from) — structural hierarchy
  "module_input",         // module_call (from) supplies a variable (to) inside the module
  "module_output",        // consumer (from) reads an output (to) of a module
  "provider_assignment",  // node (from) uses provider config (to)
  "iteration",            // node (from) derives its count/for_each from (to)
  "plan_dependency",      // dependency asserted by plan JSON that static parse missed
]);
```

Normative rules:

- **Direction is fixed for all time: `from` depends on `to`.** The canvas may draw arrows
  in either visual direction, but the stored direction never changes. Getting this
  backwards silently inverts every diagram, so it is asserted in a fixture test.
- `contains` edges MUST form a **tree** rooted at the root module: every node except root
  module nodes has exactly one parent `contains` edge, and there are no cycles. This is
  what the canvas groups by.
- `confidence: "heuristic"` is permitted but **unused at launch**: every launch edge is
  `exact`. The enum exists as a seam for future inferred edges. A CI assertion fails the
  build if a `heuristic` edge is produced by any fixture, which keeps the promise honest
  until we deliberately change it.
- `provenance: "plan_json"` edges are kept distinct and are visually marked in the UI as
  "from your plan file", because they are not verifiable against a source line.
- **Parallel edges are allowed and meaningful.** If `aws_instance.web` references
  `aws_subnet.private` from two different attributes, that is two edges with different
  `attributePath`s, and the panel lists both source lines. The UI collapses them to one
  visual line with a count.
- There are no self-edges except `kind: "reference"` with `raw` starting `self.`, which is
  dropped. A node MUST NOT depend on itself.

### 4.7 `Graph` and `Snapshot`

```ts
const Graph = z.object({
  schemaVersion: z.literal(1),
  parserVersion: z.string(),        // semver of packages/parser; bumped on any output change
  nodes:         z.array(GraphNode),
  edges:         z.array(GraphEdge),
});

const Snapshot = z.object({
  id: z.string().uuid(), repositoryId: z.string().uuid(), scanId: z.string().uuid(),
  ref: z.string(), commitSha: z.string().length(40),
  parserVersion: z.string(), schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
  stats: z.object({
    nodeCount: z.number().int(), edgeCount: z.number().int(),
    filesDiscovered: z.number().int(), filesParsed: z.number().int(),
    resourceCount: z.number().int(), moduleCallCount: z.number().int(),
    unresolvedAttributeCount: z.number().int(),
    unknownReferenceCount: z.number().int(),
    planJsonApplied: z.boolean(),
  }),
  fileManifest: z.array(z.object({
    path: z.string(), sizeBytes: z.number().int(), lineCount: z.number().int(),
    sha256: z.string(), blobSha: z.string(), parsed: z.boolean(),
  })),
});
```

`fileManifest` is retained; file **content** is not. The manifest is what lets us validate
every `SourceRef` (path exists, `startLine ≤ endLine ≤ lineCount`) without the files — a
cheap, permanent integrity check (§13.2).

`stats.unresolvedAttributeCount` and `unknownReferenceCount` are deliberately surfaced in
the product: they are the honest measure of how much of the customer's infrastructure we
could determine, and they are the metric the parser is improved against.

### 4.8 Why this model and not the obvious alternatives

Recorded in full in `[ADR-0003]`. Summary of what was rejected:

- *A property graph in a graph database (Neo4j / Memgraph).* Rejected: new
  infrastructure component, licence and cost, and our queries are "one node plus its
  1-hop neighbourhood" and "all nodes in a snapshot" — both trivially served by two
  indexed PostgreSQL tables. Violates the £60/month constraint and the boring-technology
  lens for no query we actually have.
- *Store the `terraform plan`/`terraform graph` output as the model.* Rejected: no file or
  line references exist in either output, so grounded explanations become impossible —
  which is the product.
- *Instance-level nodes.* Rejected above (§4.5).
- *A single JSONB blob per snapshot.* Rejected for the storage layer (§6.2): the
  explanation engine needs per-node reads and search. It is retained as a derived cache.

### 4.9 Source text and the non-retention boundary

The approved constraint is "raw customer IaC is not retained after parsing — only the
graph plus file and line references". Implementing that honestly requires stating the
exact boundary, because the graph itself unavoidably contains derived fragments of the
customer's configuration.

**Not retained, ever:** repository tarballs, file contents, any contiguous source
snippet, comments, `terraform plan` JSON or any value from it, provider lock files beyond
version strings, `.tfvars` files (only the resolved values they produce), git history.
The scan scratch directory is destroyed in a `finally` block and its removal is asserted
(§5.9).

**Retained:** the graph as defined above, which includes resource addresses, types, names,
attribute **keys**, resolved and literal attribute **values**, and normalized
**expression strings** of ≤512 characters for unresolved values (e.g.
`"${var.environment}-web"`), plus the file manifest with paths and hashes.

Expression strings are fragments of the customer's configuration. They are retained
because without them an unresolved attribute is unexplainable, which removes the core
product value. This is a deliberate, narrow exception and it is the one thing in this
section that needs the product owner's explicit confirmation rather than my judgement —
raised as an open question in §16 and recorded in `[ADR-0007]`.

**Source text at read time** is re-fetched on demand from GitHub (§7.6), held in memory
for the request, cached for at most 15 minutes in-process, and never written to
PostgreSQL, to disk, or to any log.

---

## 5. Parser pipeline

Implemented in `apps/worker` driving `packages/parser` and `packages/graph`. Runs as one
pg-boss job per scan, `scan.ingest`, with a **10-minute wall-clock budget** and at most
**2 attempts** (the second attempt only for transient GitHub/network errors; a parse
failure is never retried, because it is deterministic).

Each stage below is a separate exported function with its own unit tests. Stages 2–8 are
**pure** — they take data and return data, touching neither network nor database — which
is what makes the golden-fixture tests in §13 possible.

### 5.1 Stage 1 — Acquire (network)

1. Mint a GitHub App **installation access token** for the repository's installation
   (1-hour lifetime, never persisted, never logged, redacted from error messages).
2. Resolve `ref` → `commitSha` via `GET /repos/{owner}/{repo}/commits/{ref}`.
   If a published snapshot already exists for this `(repositoryId, commitSha, parserVersion)`,
   finish immediately and reuse it. Re-parsing identical input is waste.
3. `GET /repos/{owner}/{repo}/tarball/{commitSha}`, streamed to a per-scan scratch
   directory under `${SCAN_SCRATCH_ROOT}/${scanId}` (tmpfs where available, `0700`).
   Not `git clone`: we need one tree, not history.
4. Extract with hard limits enforced **during** extraction, not after:
   compressed ≤ 50 MB, uncompressed ≤ 250 MB, ≤ 20,000 entries, path traversal and
   symlinks rejected outright, no entry written outside the scratch root.

Limits (launch): ≤ 500 parseable `.tf`/`.tf.json` files, ≤ 2 MB per file, ≤ 5,000 graph
nodes. Exceeding any limit produces a hard diagnostic (`REPO_TOO_LARGE`,
`TOO_MANY_FILES`, `GRAPH_TOO_LARGE`) and no snapshot. These numbers are first-pass and are
the Backend spike's to confirm (§16).

### 5.2 Stage 2 — Discover

Walk the extracted tree and build the file manifest.

- **Included:** `**/*.tf`, `**/*.tf.json`, `**/*.tfvars`, `**/*.tfvars.json`,
  `**/terraform.tfvars{,.json}`, `**/.terraform.lock.hcl` (provider version strings only).
- **Excluded:** `.terraform/`, `.git/`, `node_modules/`, `vendor/`, anything over the
  per-file cap, anything non-UTF-8 (`BINARY_SKIPPED`).
- Every discovered file gets a manifest row with `sizeBytes`, `lineCount`, `sha256`, and
  git `blobSha`. The manifest is the only record of the repository's contents that
  survives the scan.
- Zero parseable files → hard stop with `NO_TERRAFORM_FOUND`.

### 5.3 Stage 3 — Parse

Per file, independently and tolerantly:

1. `@cdktf/hcl2json` produces the block/attribute structure with unevaluated expressions
   preserved as interpolation strings.
2. The **position index** — our own bracket- and string-aware scanner — produces, for the
   same file, a map from `(blockPath, attributeKey)` to a line/column range. hcl2json does
   not emit source positions, and source positions are the product, so we compute them
   ourselves. `[ADR-0005]` records this and the alternatives.
3. The two are joined into `ParsedFile { blocks, diagnostics }`. A position that cannot be
   resolved falls back to the enclosing block's range and emits
   `POSITION_INDEX_FALLBACK` — degraded, never wrong: a reference always points to a range
   that **contains** the construct, even if wider than ideal.
4. A syntax error yields `FILE_PARSE_ERROR` with path and line for that file only. Other
   files continue. **Partial success is the normal outcome**, not an exception path.

Both sub-parsers are fuzz-tested (§13.5): neither may throw, hang, or exceed memory on
arbitrary input. They are the only components that touch untrusted customer bytes.

### 5.4 Stage 4 — Resolve the module tree

- `module "x" { source = "./modules/x" }` with a relative path inside the repository is
  followed; its files are parsed and its nodes get `modulePath = [..., "x"]`.
- Any other `source` (registry, git, GitHub shorthand, S3, HTTP) is **not fetched**. The
  module call becomes a node with `moduleResolution: "remote_unsupported"` and a
  `MODULE_SOURCE_UNSUPPORTED` diagnostic. Its internals are absent and the UI says so
  explicitly. Fetching arbitrary URLs on behalf of customers is a supply-chain and SSRF
  exposure we are not taking at launch (§15).
- A relative source that does not exist → `MODULE_PATH_NOT_FOUND`, `moduleResolution: "not_found"`.
- Module nesting depth is capped at 8 (`depth_limit`); recursion through a cycle of local
  module paths is detected and reported, never followed.

### 5.5 Stage 5 — Evaluate (constant folding)

A **total, deterministic, side-effect-free** partial evaluator. It never throws; its
failure mode is `unresolved`.

Resolves:
- literals and literal collections;
- `var.x` where a default exists, or where a `*.tfvars` file in the repository sets it
  (provenance records which);
- `local.x`, evaluated in topological order; a cycle marks the whole cycle
  `unresolved: "locals_cycle"` and emits `LOCALS_CYCLE`;
- string interpolation, producing `partial` when any part is unknown;
- an **allow-list** of pure functions only: `join`, `format`, `lower`, `upper`, `trim`,
  `trimprefix`, `trimsuffix`, `replace`, `concat`, `merge`, `length`, `coalesce`,
  `try`, `tostring`, `tonumber`, `jsonencode`.
- conditionals where the predicate resolves to a literal boolean.

Everything else — `for` expressions, `dynamic` blocks, provider functions, `data` results,
resource attributes, `each`/`count` inside a value, unlisted functions — is `unresolved`
with the appropriate `reason`. The allow-list is deliberately short: each addition is a
new way to be subtly wrong about a customer's infrastructure, and being wrong is worse
than saying "unresolved". Additions require a fixture proving the semantics.

Evaluation is bounded: ≤ 10,000 evaluation steps and ≤ 8 levels of nesting per attribute,
then `depth_limit`.

### 5.6 Stage 6 — Build the graph

1. One node per block, with `address`, `kind`, `source`, folded `attributes`, `multiplicity`.
2. Extract every `Reference` from every expression (including `count`, `for_each`,
   `depends_on`, `provider`, and module arguments).
3. Resolve each reference to a node by address within the correct module scope. Unresolved
   addresses create an `unknown_reference` node (deduplicated by address).
4. Emit edges per §4.6: `reference`, `explicit_dependency`, `iteration`,
   `provider_assignment`, `module_input`, `module_output`, and the `contains` tree.
5. Compute `display` fields. `display.sublabel` uses a resolved `Name`/`name` tag **only
   if it is `literal`, `resolved` or `partial`** — never a guess.

### 5.7 Stage 7 — Enrich from plan JSON (optional)

If the customer uploaded `terraform show -json` output for this scan:

- We read **only** `configuration.root_module` (expression `references` arrays) and the
  instance **addresses** in `planned_values`.
- From those we take **structure only**: confirmed instance counts and `for_each` keys
  (→ `multiplicity.resolution = "plan"`), and `plan_dependency` edges for dependencies the
  static parse did not find.
- **No attribute value from plan JSON is ever written to the graph.** Plan JSON contains
  resolved attribute values, which routinely include credentials, connection strings and
  private keys. Taking structure and discarding values is the only safe use of this input.
- The upload is parsed in memory, never written to disk, and discarded when the job ends.
  It is never sent to the AI provider.
- A plan whose resource set disagrees with the static graph beyond a 20% symmetric
  difference emits `PLAN_JSON_MISMATCH` and is **not applied** — most likely the customer
  uploaded a plan from a different repository or workspace.

`plan_dependency` edges are the strongest accuracy signal we have, and §13.4 turns them
into a CI metric.

### 5.8 Stage 8 — Validate invariants

The graph is checked against every invariant in §13.2 **before** persistence. Any
violation aborts the scan with `GRAPH_INVARIANT_VIOLATION`; no snapshot is published and
the previous snapshot stays current. We fail closed rather than publish a diagram we
cannot vouch for.

### 5.9 Stage 9 — Persist, then destroy

In a single transaction, under the tenant GUC (§6.4):

1. Apply the secret-pattern pass (§8.5) over every `literal`/`resolved` string value,
   converting matches to `{v:"sensitive", why:"secret_pattern"}`. This runs at the
   persistence boundary so a matched secret cannot reach the database even if a bug let it
   reach memory.
2. Insert `snapshots`, `graph_nodes`, `graph_edges`, `file_manifest`, `diagnostics`.
3. Flip `repositories.current_snapshot_id` and set `scans.status = 'succeeded'`.

Then, in a `finally` that runs on every path including failure and timeout: recursively
remove the scratch directory and **assert it is gone**. Failure to remove it is a
`SCRATCH_CLEANUP_FAILED` alert, not a silent log line — it is the one failure that breaks
the non-retention promise.

### 5.10 What crosses the boundary — summary

| Data | Where it lives | Lifetime |
|---|---|---|
| Repository tarball, file contents | worker scratch dir, tmpfs | the scan, destroyed in `finally` |
| `terraform plan` JSON upload | worker memory | the scan |
| GitHub installation token | worker memory | ≤ 1 hour, never persisted or logged |
| Graph (nodes, edges, attributes, expressions ≤512 chars) | PostgreSQL | until the customer deletes the repository or tenant |
| File manifest (paths, sizes, hashes) | PostgreSQL | same |
| Source snippets for display/chat | process memory, ≤ 15 min cache | the request |

---

## 6. PostgreSQL schema and tenant isolation

### 6.1 The isolation mechanism, stated as a property

Tenant isolation is enforced by **three independent mechanisms**, so that a single mistake
in application code cannot leak data across tenants. Isolation enforced only in
application code eventually leaks; this pushes it into the schema and the connection.

1. **PostgreSQL Row-Level Security, forced.** Every tenant-scoped table has
   `tenant_id uuid NOT NULL` and:
   ```sql
   ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
   ALTER TABLE <t> FORCE ROW LEVEL SECURITY;   -- applies to the table owner too
   CREATE POLICY tenant_isolation ON <t>
     USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
     WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
   ```
   `FORCE` is not optional. Without it, the owning role bypasses the policy and the whole
   mechanism is decorative.
2. **A role that cannot bypass it.** Migrations run as `dm_migrator` (table owner).
   The application connects as `dm_app`: `NOSUPERUSER`, `NOBYPASSRLS`, not the owner of
   any table, with `SELECT/INSERT/UPDATE/DELETE` and nothing else. No `GRANT` to `PUBLIC`.
3. **Composite foreign keys carrying `tenant_id`.** Every parent table has
   `UNIQUE (tenant_id, id)` and every child references it as
   `FOREIGN KEY (tenant_id, <parent>_id) REFERENCES <parent> (tenant_id, id)`.
   A row therefore **cannot exist** pointing at a parent in another tenant. This holds
   even if a policy is dropped by mistake: cross-tenant data is unrepresentable, not
   merely unqueryable.

If `app.tenant_id` is not set, `current_setting('app.tenant_id', true)` returns `NULL`,
every policy predicate evaluates to `NULL`, and every query returns **zero rows** and
rejects every write. The default state is "no access". That is the fail-closed property
the design depends on, and §13.3 tests it on every table.

### 6.2 Tables

Non-tenant-scoped tables, exhaustively — any table not on this list MUST be tenant-scoped
and RLS-forced, and §13.3 fails the build otherwise:

- `users` — global identity. Protected by its own policy `id = current_setting('app.user_id', true)::uuid`.
- `plans` — product catalogue, world-readable to `dm_app`, writable only by `dm_migrator`.
- `pgboss.*` — the queue's own schema, owned by `dm_migrator`, accessed only by the worker
  role `dm_worker`. Job payloads carry `tenantId` but contain no customer data beyond ids.

Tenant-scoped tables:

```sql
tenants(id PK, name, slug UNIQUE, plan_id → plans, stripe_customer_id,
        created_at, deleted_at)                                  -- policy: id = app.tenant_id
tenant_members(tenant_id, user_id → users, role ENUM owner|admin|member,
        created_at, PK (tenant_id, user_id))
github_installations(id PK, tenant_id, installation_id BIGINT, account_login,
        account_type, suspended_at, created_at,
        UNIQUE (installation_id))
repositories(id PK, tenant_id, installation_id → github_installations,
        owner, name, default_ref, visibility,
        current_snapshot_id → snapshots NULL, created_at, archived_at,
        UNIQUE (tenant_id, id), UNIQUE (tenant_id, owner, name))
scans(id PK, tenant_id, repository_id, ref, commit_sha,
        status ENUM queued|running|succeeded|failed|cancelled,
        parser_version, requested_by_user_id, error_code,
        started_at, finished_at, stats JSONB, UNIQUE (tenant_id, id))
snapshots(id PK, tenant_id, repository_id, scan_id, commit_sha,
        parser_version, schema_version, node_count, edge_count, stats JSONB,
        created_at, UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, repository_id, commit_sha, parser_version))
file_manifest(id PK, tenant_id, snapshot_id, path, size_bytes, line_count,
        sha256, blob_sha, parsed BOOL,
        UNIQUE (tenant_id, snapshot_id, path))
graph_nodes(id PK, tenant_id, snapshot_id, stable_key, address, kind, type, name,
        provider_name, module_path TEXT[], multiplicity JSONB, attributes JSONB,
        meta JSONB, display JSONB, source_ref JSONB, diagnostic_codes TEXT[],
        UNIQUE (tenant_id, id), UNIQUE (tenant_id, snapshot_id, address, kind))
graph_edges(id PK, tenant_id, snapshot_id, from_node_id, to_node_id, kind,
        provenance, confidence, attribute_path TEXT[], source_ref JSONB, label,
        FOREIGN KEY (tenant_id, from_node_id) REFERENCES graph_nodes (tenant_id, id),
        FOREIGN KEY (tenant_id, to_node_id)   REFERENCES graph_nodes (tenant_id, id))
diagnostics(id PK, tenant_id, scan_id, snapshot_id NULL, severity, code,
        message, path NULL, line NULL, hint NULL, node_address NULL)
graph_layout_cache(tenant_id, snapshot_id, algorithm, layout_version,
        payload JSONB, created_at, PK (tenant_id, snapshot_id, algorithm, layout_version))
conversations(id PK, tenant_id, snapshot_id, user_id, title, created_at,
        UNIQUE (tenant_id, id))
messages(id PK, tenant_id, conversation_id, role ENUM user|assistant,
        content TEXT, citations JSONB, referenced_node_ids UUID[],
        grounding_status ENUM grounded|partial|rejected,
        model, input_tokens, output_tokens, created_at)
ai_usage(tenant_id, period_month DATE, input_tokens BIGINT, output_tokens BIGINT,
        request_count INT, reserved_tokens BIGINT, PK (tenant_id, period_month))
tenant_api_keys(tenant_id, provider, ciphertext BYTEA, iv BYTEA, auth_tag BYTEA,
        key_version INT, created_at, last_used_at, PK (tenant_id, provider))
subscriptions(id PK, tenant_id, stripe_subscription_id UNIQUE, plan_id → plans,
        status, current_period_end, cancel_at_period_end)
audit_log(id PK, tenant_id, actor_user_id, action, target_type, target_id,
        metadata JSONB, created_at)
```

Indexes that matter:

```sql
CREATE INDEX ON graph_nodes (tenant_id, snapshot_id);
CREATE INDEX ON graph_nodes (tenant_id, snapshot_id, kind);
CREATE INDEX ON graph_nodes USING gin (address gin_trgm_ops);     -- node search
CREATE INDEX ON graph_edges (tenant_id, snapshot_id, from_node_id);
CREATE INDEX ON graph_edges (tenant_id, snapshot_id, to_node_id);
CREATE INDEX ON diagnostics (tenant_id, scan_id, severity);
CREATE INDEX ON scans (tenant_id, repository_id, created_at DESC);
```

`graph_nodes.attributes` is JSONB rather than a normalized attribute table: attributes are
read as a whole per node, never queried across nodes at launch, and a normalized table
would multiply row count by ~15 for no query we have. If cross-node attribute search
becomes a feature, a GIN index on the JSONB is the next step, not a schema change.

`graph_layout_cache` is **derived and disposable**, keyed by `layout_version`; it is the
only place a second copy of graph structure exists, and it is regenerable from
`graph_nodes`/`graph_edges`. Nothing reads it as a source of truth.

### 6.3 Deletion and retention

- Deleting a repository deletes its scans, snapshots, nodes, edges, manifests and
  diagnostics by `ON DELETE CASCADE`, synchronously.
- Deleting a tenant cascades everything tenant-scoped and revokes the GitHub installation.
- Snapshot retention: the current snapshot plus the **3 most recent** per repository;
  older ones are deleted by a daily `retention.sweep` job. This bounds storage, which
  bounds cost.
- `audit_log` is retained 365 days and holds no customer configuration.
- Conversations are retained until deleted by the customer; a tenant owner can delete all
  conversations from the settings page.

### 6.4 The query layer property

`packages/db` exports exactly one way to reach the database:

```ts
export async function withTenant<T>(
  tenantId: string, userId: string | null,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T>
```

It checks out a connection, opens a transaction, runs
`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`
(`true` = transaction-local, so state cannot leak to the next user of a pooled
connection), and passes a handle into `fn`. The handle is invalidated when `fn` returns.

- There is **no exported pool, client, or `db` object.** Not as a convention — the module
  does not export one, and the boundary test (§2.3) fails the build if anything outside
  `packages/db` imports `pg` or `drizzle-orm`.
- The only other exported entry point is `withSystem()`, used by migrations, the Stripe
  webhook handler (which must look up a tenant *by Stripe customer id* before a tenant
  context exists) and the retention sweep. It connects as `dm_app` **with no tenant GUC**,
  so RLS still returns zero rows for tenant-scoped tables; it is granted explicit
  `SECURITY DEFINER` functions for the few lookups it legitimately needs
  (`resolve_tenant_by_stripe_customer`, `claim_expired_snapshots`). Those functions are
  individually reviewed and are the complete list of RLS-privileged code paths.
- Connection pooling: `pg.Pool` with explicit transactions. If PgBouncer is introduced
  later it MUST be in transaction-pooling mode or session state breaks — noted in
  `[ADR-0004]` as a constraint on future infrastructure.

Why `set_config` and not a per-tenant role or schema-per-tenant: `[ADR-0004]` compares
schema-per-tenant and database-per-tenant and records the cost of each.

---

## 7. API surface

One HTTP front: Next.js route handlers under `apps/web/app/api`. REST+JSON, not GraphQL
(`[ADR-0002]`: GraphQL's value is many clients with divergent needs; we have one client
and one AI consumer, and GraphQL would add a schema layer that duplicates the zod schemas
that already exist).

### 7.1 Conventions

- Base path `/api/v1`. Breaking changes mean `/api/v2`; the graph wire format carries its
  own `schemaVersion`.
- Auth: Auth.js session cookie (`HttpOnly`, `Secure`, `SameSite=Lax`). Every handler
  resolves `(userId, tenantId)` from the session plus the active-tenant cookie, verifies
  membership, and runs **all** database work inside one `withTenant` call.
- Request and response bodies are validated with the zod schemas exported from
  `packages/graph` and `apps/web/lib/contracts`. An invalid response fails in tests, not
  in production.
- Mutations require a `POST`/`DELETE` with Auth.js CSRF protection. Webhooks are exempt
  and are instead signature-verified.
- Rate limits, per tenant, enforced in PostgreSQL (no Redis at launch): scans 10/hour,
  explain requests 60/hour and the plan's token cap, source fetches 300/hour.

Error envelope — the only error shape in the system:

```json
{ "error": { "code": "SCAN_NOT_FOUND", "message": "Human-readable, safe to display.",
             "details": { }, "supportRef": "scan_01HX…", "retryable": false } }
```

`code` is from a closed enum shared with the client (`packages/graph/src/errors.ts`), so
the UI can map codes to copy and never has to parse `message`. `message` MUST be safe to
show a customer: no stack traces, no SQL, no internal identifiers, no tokens.
HTTP status: 400 validation, 401 unauthenticated, 403 wrong tenant or missing
entitlement, 404 not found *or not visible to this tenant* (the two are indistinguishable
by design), 409 conflict, 422 semantic, 429 rate limited, 500 with `supportRef`.

### 7.2 Repositories and installation

```
GET    /api/v1/github/app/install-url            → { url }
POST   /api/v1/github/app/callback               { installationId, state } → { installation }
GET    /api/v1/github/installations/:id/repositories  → repositories available to install
GET    /api/v1/repositories                      → [{ id, owner, name, defaultRef,
                                                      currentSnapshotId, lastScan }]
POST   /api/v1/repositories                      { installationId, owner, name, defaultRef }
DELETE /api/v1/repositories/:id                  → 204 (cascades, §6.3)
```

### 7.3 Scans

```
POST   /api/v1/repositories/:id/scans            { ref? } → 202 { scanId, status: "queued" }
GET    /api/v1/scans/:id                         → { status, stage, progress, stats,
                                                     snapshotId?, errorCode?,
                                                     diagnosticSummary }
GET    /api/v1/scans/:id/diagnostics?severity=   → paginated diagnostics
POST   /api/v1/scans/:id/plan-json               multipart, ≤ 20 MB → 202
DELETE /api/v1/scans/:id                         cancel a queued/running scan
```

`stage` is one of the §5 stage names, so the UI shows real progress
("Parsing 142 of 147 files") rather than a spinner. The client polls `GET /scans/:id`
every 2 s with backoff to 10 s; no websockets at launch.

### 7.4 Graph read

```
GET /api/v1/snapshots/:id                → Snapshot metadata + stats + fileManifest summary
GET /api/v1/snapshots/:id/graph          → { schemaVersion, parserVersion, nodes, edges }
GET /api/v1/snapshots/:id/nodes?q=&kind=&type=&module=&cursor=&limit=
                                         → paginated node summaries (no attributes)
GET /api/v1/nodes/:id                    → GraphNode + inbound/outbound edges with the
                                           peer node summary for each
GET /api/v1/snapshots/:id/layout?algorithm=dagre → cached layout or 202 while computing
```

`GET /snapshots/:id/graph` is the canvas's one bulk read. It returns the full node and
edge set with `display` fields and **without** `attributes` (attributes arrive per node
from `GET /nodes/:id`), gzip/brotli compressed, with a strong `ETag` of
`snapshotId + parserVersion` and `Cache-Control: private, max-age=0, must-revalidate`.
Snapshots are immutable, so the `ETag` is permanently valid. Above 2,000 nodes the
response is served as a cursor-paginated stream of node pages — the Frontend spike
(AIS-5) sets the exact threshold and whether `attributes`-free summaries are enough.

### 7.5 Explanations

```
POST /api/v1/explain       { snapshotId, nodeId?, question, conversationId? }
                           → text/event-stream
GET  /api/v1/conversations?snapshotId=    → list
GET  /api/v1/conversations/:id            → messages with citations
DELETE /api/v1/conversations/:id
GET  /api/v1/usage                        → { periodMonth, inputTokens, outputTokens,
                                              capTokens, keySource: "platform"|"tenant" }
```

SSE event types, in order: `context` (the node ids and `SourceRef`s that were put in the
prompt — sent **first**, so the UI can show what the answer is based on before any text
arrives), then `delta` tokens, then `citations`, then `done` with
`{ groundingStatus, inputTokens, outputTokens }`, or `error` with the standard envelope.

### 7.6 Source text on demand

```
GET /api/v1/nodes/:id/source?context=10        → { path, startLine, endLine, lines[],
                                                   blobSha, stale: boolean }
GET /api/v1/snapshots/:id/source?path=&from=&to=
```

Fetches the file from GitHub with the installation token, slices the requested range plus
context, and returns it. Never persisted (§4.9). If the file's current blob sha differs
from the `SourceRef`'s, `stale: true` and the UI warns that the file changed since
analysis. `from`/`to` MUST be validated against `file_manifest.line_count` and `path`
MUST exist in the manifest for that snapshot — this is the control that stops the endpoint
from becoming an arbitrary-file-read proxy into the customer's repository.

### 7.7 Billing

```
POST /api/v1/billing/checkout-session   { planId } → { url }       (Stripe Checkout)
POST /api/v1/billing/portal-session                → { url }       (Stripe Billing Portal)
GET  /api/v1/billing/subscription                  → { plan, status, currentPeriodEnd }
PUT  /api/v1/settings/api-key           { provider: "anthropic", key } → 204
DELETE /api/v1/settings/api-key/:provider
POST /api/webhooks/stripe               signature-verified, idempotent by event id
POST /api/webhooks/github               signature-verified (installation events)
```

Stripe Checkout and the Billing Portal are hosted by Stripe: no card data touches our
servers and PCI scope is minimised. Entitlements are read from **our** `subscriptions`
table, updated by webhook, so a Stripe outage cannot lock out a paying customer.

### 7.8 Health

```
GET /api/v1/health   → { status, db, queue, parserVersion, schemaVersion, commit }
```

### 7.9 Entitlements

One function, `assertEntitlement(tenantId, capability)`, called by every handler that
creates a scan, adds a repository or starts an explanation. Capabilities are read from
`plans` (`repo_limit`, `node_limit`, `monthly_token_cap`, `requires_own_api_key`). The
numbers are Product's (AIS-2); the mechanism is here and does not change when they do.

---

## 8. AI request and response flow

Detailed design is the AI Engineer's (AIS-6). This section fixes the **contract** —
what leaves our system, what the response must satisfy, and where the seams are.

### 8.1 Flow

```
POST /api/v1/explain
  1. authenticate → (userId, tenantId); assertEntitlement(tenantId, "explain")
  2. reserve tokens against ai_usage (§8.6) — refuse before spending, not after
  3. packages/explain: assembleContext(snapshotId, nodeId, question, history)
       - read the node, its 1-hop neighbourhood (≤25 peers, ordered by edge-kind
         priority: explicit_dependency > reference > module_* > contains), the
         containing module chain, diagnostics touching those nodes
       - re-fetch source snippets (§7.6) for the focus node and ≤5 highest-priority
         peers, ≤40 lines each
       - redact (§8.5); drop every `sensitive` and `omitted` value
       - count tokens; if > 12,000 input tokens, drop peers by lowest priority until
         it fits. The cap is enforced by measurement, not by hope.
  4. call Anthropic Messages API, streaming
  5. validateCitations() on the stream and on the final text (§8.3)
  6. persist the message, citations, grounding status and actual token counts
  7. reconcile the token reservation
```

### 8.2 The prompt contract

- A fixed system prompt, version-controlled at `packages/explain/prompts/<version>.md`, is
  the only instruction source. It states: answer only from the provided context; every
  factual claim about a resource must carry a citation; if the context does not contain
  the answer, say so; unresolved values must be described as unresolved, not guessed.
- The context is supplied as structured JSON, not prose, so there is exactly one
  serialisation to test against.
- The question text and prior turns of the conversation are included; prior turns are
  capped at 6 messages.

### 8.3 Citations and the grounding gate

The model must emit claims carrying `[[node:<id>]]` and `[[src:<path>:<line>]]` markers.
After generation, `validateCitations()` checks every marker against the context that was
actually sent:

- an unknown node id or a `path:line` that was not in the context is an **invalid
  citation**;
- a sentence making a factual assertion with no citation is an **uncited claim**.

Outcome is recorded as `grounding_status`:
`grounded` (no invalid citations, no uncited factual claims), `partial` (uncited claims
removed and replaced with a visible notice), `rejected` (invalid citations present → the
answer is **not shown**; the user sees "I could not answer that from your configuration"
with a retry). We would rather return nothing than return a confident invention.

This is the quality property the product is sold on, so it is a **test**, not a claim:
§13.6.

### 8.4 Exactly what customer data leaves our system

Destination: **`api.anthropic.com`** (Anthropic Claude API) over TLS. There is no other
third-party destination for customer configuration data. Sent:

| Sent | Not sent |
|---|---|
| Resource addresses, kinds, types, local names, module paths | Repository owner or name |
| Attribute keys, and non-sensitive literal/resolved values | Tenant id, user id, email, any account identifier |
| Normalized expression strings (≤512 chars) for unresolved values | Any value marked `sensitive` or matching a secret pattern |
| Edge list of the selected neighbourhood, with edge kinds | `terraform plan` JSON or any value derived from it |
| Repo-relative file paths and line numbers | GitHub tokens, API keys, Stripe data |
| Re-fetched source snippets, ≤40 lines each, ≤6 nodes per request | Whole files; comments are stripped from snippets before egress |
| The user's question and ≤6 prior turns | Other tenants' data of any kind — structurally impossible (§6) |

Source snippets **are** raw customer configuration leaving our system. That is inherent to
"explanations grounded in the real source files" and is the approved product. It is stated
here explicitly, named in `[ADR-0006]`, and is the specific item QA & Security must sign
off before the explanation engine ships.

Operational commitments: `anthropic-beta` data-retention options and Anthropic's
commercial terms (API inputs are not used for model training) are to be confirmed in
writing by QA & Security, not assumed from this document (§16). The free tier uses the
**customer's own key**, so for free-tier tenants the data leaves under their own API
agreement — which must be disclosed in the UI at the point they enter the key.

### 8.5 Redaction and the secret-pattern set

One module, `packages/explain/src/redact.ts`, shared by the persistence boundary (§5.9)
and the egress boundary, so there is one definition of "secret" in the system:

- values of variables/outputs declared `sensitive = true`;
- attribute keys matching `/(password|secret|token|private_key|credential|passwd|api[_-]?key)/i`;
- values matching high-signal patterns: AWS access key ids (`AKIA[0-9A-Z]{16}`), PEM
  blocks, GitHub tokens (`gh[pousr]_`), Slack tokens, JWTs, Stripe keys, long
  high-entropy base64/hex strings (≥32 chars, Shannon entropy ≥ 4.0);
- anything in the file manifest whose path matches `*.pem`, `*.key`, `*.p12`, `.env*`
  (these files are never parsed at all).

Every pattern has a unit test with a positive and a negative case. False positives cost a
displayed value; false negatives cost a leaked credential. The asymmetry is deliberate.

### 8.6 Cost control

- `ai_usage` holds `(tenant_id, period_month)` with input/output tokens and a
  `reserved_tokens` column. A request **reserves** its estimated input cost plus
  `max_tokens` before calling the API; the reservation is reconciled against actual usage
  on completion and released on failure. Reserve-then-reconcile, because a cap enforced
  after the fact is not a cap.
- Paid tenants use the platform key held in `ANTHROPIC_API_KEY` (server-side only, never
  sent to the browser). Reaching `monthly_token_cap` returns `AI_CAP_REACHED` with the
  reset date; the rest of the product keeps working.
- Free tenants MUST have a key in `tenant_api_keys`, AES-256-GCM encrypted with a random
  per-row IV and `tenant_id` as additional authenticated data, under
  `DATA_ENCRYPTION_KEY` with a `key_version` for rotation. Decrypted only in the request
  that uses it. Never logged, never returned by any endpoint (the UI shows only
  `last_used_at` and a masked suffix).
- Model choice, prompt caching and `max_tokens` are the AI Engineer's levers, bounded by
  this contract. The provider seam is `[ADR-0006]`.

---

## 9. Cross-cutting concerns

### 9.1 Authentication and authorisation

- Sign-in: GitHub OAuth through the **same GitHub App**, via Auth.js. No passwords, no
  password reset, no email verification to build or secure.
- A user may belong to several tenants; the active tenant is a cookie, validated against
  `tenant_members` on every request. Roles: `owner` (billing, delete tenant, manage
  members), `admin` (repositories, scans, settings), `member` (read, scan, chat).
- The GitHub App requests **`contents: read` and `metadata: read` only**. It never requests
  write, never requests workflow or secrets scopes, and personal access tokens are not
  accepted anywhere in the product.

### 9.2 Secrets and configuration

`packages/config` parses the environment through a zod schema **once at process start** and
the process exits if anything is missing or malformed. No `process.env` access anywhere
else (enforced by the boundary test). Required: `DATABASE_URL`, `DATA_ENCRYPTION_KEY`,
`AUTH_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `SCAN_SCRATCH_ROOT`.
No secret is ever committed; `.env.example` holds names only. A pre-commit secret scan and
a CI secret scan both run (§13.6).

### 9.3 Logging and observability

- Structured JSON logs with a **field allow-list**. Permitted: `tenantId`, `userId`,
  `scanId`, `snapshotId`, `nodeId`, `code`, `durationMs`, `path` (our route, not the
  customer's file). Forbidden and stripped by a serializer: attribute values, expression
  strings, file contents, tokens, keys, customer file paths.
- Every log line and error response carries the `supportRef` shown to the user.
- Metrics: scan duration by stage, scan outcome by `error_code`, nodes/edges per scan,
  `unresolvedAttributeCount` ratio, explanation `grounding_status` distribution, token
  spend per tenant, p95 canvas payload size. These are the numbers that tell us whether
  the product is accurate, not just alive.
- Error tracking and uptime monitoring: free tiers only at launch (`[ADR-0009]`); any paid
  tier is a CEO decision.

### 9.4 Error handling and what the user sees when parsing fails

Diagnostics are first-class data, not log output: `{ code, severity, message, path?,
line?, hint?, nodeAddress? }`, persisted per scan, exposed at
`GET /api/v1/scans/:id/diagnostics`, and rendered in a drawer the user can open from the
canvas.

**Partial success is the normal outcome.** If at least one resource node was built, the
snapshot is published and the canvas shows a banner: *"Analysed 142 of 147 files. 5 files
could not be read — see details."* The drawer lists each diagnostic with its `path:line`
and a one-line hint. Nodes with diagnostics are badged on the canvas, and the node panel
shows what we could not determine about that resource and why.

Hard failures — no snapshot published, previous snapshot stays current:

| Code | What the user sees |
|---|---|
| `NO_TERRAFORM_FOUND` | "We could not find any Terraform files in `owner/repo` at `ref`. Check the branch, or the subdirectory if your Terraform lives in one." |
| `GITHUB_ACCESS_DENIED` | "Diagram Mapper no longer has access to this repository." + reconnect button |
| `GITHUB_RATE_LIMITED` | "GitHub is rate-limiting us. We will retry automatically at HH:MM." (retryable) |
| `REPO_TOO_LARGE` / `TOO_MANY_FILES` / `GRAPH_TOO_LARGE` | The limit, the measured value, and "contact us" — these are the signals that tell us where the real ceiling is |
| `SCAN_TIMEOUT` | "Analysis took longer than 10 minutes and was stopped." + support ref |
| `GRAPH_INVARIANT_VIOLATION` | "We found an inconsistency in our own analysis and stopped rather than show you a diagram we cannot verify." + support ref. **Pages the on-call.** |
| `PLAN_JSON_INVALID` / `PLAN_JSON_MISMATCH` | Specific to the upload; the scan still succeeds without enrichment |
| `INTERNAL_ERROR` | Generic message + support ref. Never a stack trace, never an internal id beyond the support ref. |

Soft diagnostics that are shown but never fail a scan: `FILE_PARSE_ERROR`,
`MODULE_SOURCE_UNSUPPORTED`, `MODULE_PATH_NOT_FOUND`, `LOCALS_CYCLE`,
`UNRESOLVED_REFERENCE`, `FILE_TOO_LARGE`, `BINARY_SKIPPED`, `POSITION_INDEX_FALLBACK`,
`NODE_ATTRIBUTES_TRUNCATED`, `SENSITIVE_VALUE_REDACTED`.

The enum is closed and lives in `packages/graph/src/errors.ts`, shared by the worker, the
API and the client, so a new code cannot be shipped without client-side copy.

### 9.5 Accessibility and the UI contract

Owned by Frontend; constrained here because it affects the API. WCAG 2.2 AA is the target.
A node-link canvas is not keyboard-accessible by default, so the API must support an
equivalent **non-visual path**: `GET /snapshots/:id/nodes` (searchable, paginated list)
and `GET /nodes/:id` (detail with named inbound/outbound neighbours) are sufficient to
explore the whole graph with a keyboard and a screen reader. That is a requirement on the
API, not a UI nicety.

The chat/explanation panel is movable and resizable (a core requirement from `PROMPT.md`)
and its position persists per user per snapshot in client storage, not server-side.
Citations in an answer are clickable and select the referenced node on the canvas — this
is the "click a button on the popup and it will take you to it" requirement, implemented
as `[[node:<id>]]` → canvas selection.

### 9.6 Billing model

Stripe Checkout for acquisition, Billing Portal for self-service changes, webhooks as the
only writer of `subscriptions`. Webhook handling is **idempotent by Stripe event id**
(a `processed_stripe_events` table), because Stripe retries. Plan changes take effect from
the webhook, not from the client's claim. Price ids live in `plans`, so Product can change
pricing without a code change. Live mode is a CEO decision; everything up to launch runs
in Stripe test mode.

---

## 10. Repository layout

```
Diagram-Mapper/
├── apps/
│   ├── web/                     Next.js 15 App Router — UI + /api route handlers
│   │   ├── app/(marketing)/     landing, pricing
│   │   ├── app/(app)/           authenticated product
│   │   ├── app/api/v1/…         route handlers (§7)
│   │   └── lib/contracts/       zod request/response schemas
│   └── worker/                  pg-boss worker: scan.ingest, retention.sweep
├── packages/
│   ├── graph/                   ★ schema, types, invariants, errors, canonicalisation
│   ├── parser/                  HCL → ParseResult; hcl2json + position index + evaluator
│   ├── db/                      drizzle schema, SQL migrations, withTenant()
│   ├── explain/                 context assembly, prompts, provider client, citations
│   ├── ui/                      design system, canvas components
│   └── config/                  env schema
├── fixtures/terraform/          ★ golden corpus: <case>/{*.tf, expected.graph.json, plan.json?}
├── docs/
│   ├── TECH-SPEC.md             this document
│   ├── adr/                     0001…
│   └── runbooks/
├── scripts/                     fixtures:update, licence check, boundary check
├── .github/workflows/ci.yml
├── LICENSE                      proprietary — content set by the CEO (AIS-8)
├── pnpm-workspace.yaml
└── biome.json  tsconfig.base.json  vitest.workspace.ts
```

★ = the two directories that carry the product risk. Changes to either require CTO review.

Backend scaffolds this in AIS-8. `packages/graph` MUST be the first package implemented,
because every other package and both test suites depend on its types.

---

## 11. Build and CI

- **pnpm** workspaces, Node 22 LTS, TypeScript project references, `tsc --build`.
- `pnpm` lockfile committed; `--frozen-lockfile` in CI.
- Conventional commits; `main` is protected; every change arrives by pull request with CTO
  review (the engineers' work) and passes CI. Never bypassed.

CI pipeline (`.github/workflows/ci.yml`), on every pull request, all jobs required:

| Job | Gate |
|---|---|
| `typecheck` | `tsc --build` clean, `strict` + `noUncheckedIndexedAccess` |
| `lint` | Biome clean |
| `boundaries` | §2.3 module dependency rules |
| `unit` | Vitest across all packages; **coverage ≥ 85% on `packages/parser` and `packages/graph`**, no global threshold theatre |
| `fixtures` | golden graph comparison + line-reference verification + invariants (§13.1–13.4) |
| `db` | migrations up/down on a throwaway PostgreSQL 16 service; RLS coverage and cross-tenant probe tests (§13.3) |
| `contracts` | API responses validate against the published zod schemas |
| `e2e` | Playwright against a seeded instance, mocked GitHub and a recorded AI transcript — **no API keys in CI** |
| `licences` | allow-list check per `docs/LICENCE-AND-DEPENDENCY-PLAN.md`; fails on any licence outside the permissive set, on any AGPL/GPL/SSPL/BUSL/non-commercial dependency, and on any MPL/EPL dependency not recorded in `licence-exceptions.json`. Also fails on `UNKNOWN`/missing identifiers — unknown is not permissive. Emits `THIRD-PARTY-LICENCES.md` + SBOM |
| `secrets` | secret scan on the diff and on history |
| `audit` | `pnpm audit --audit-level=high` fails the build |

Nightly, non-blocking: the public-corpus regression harness (§13.5) and a fuzz run against
the parser.

---

## 12. Environments

| Environment | Purpose | Notes |
|---|---|---|
| Local | development | `docker compose` PostgreSQL 16, seeded fixtures, Stripe CLI, a fake GitHub server. Must work with **no** cloud account and no API keys. |
| CI | verification | ephemeral PostgreSQL service container; no secrets beyond repo-scoped CI tokens |
| Staging | pre-release verification | single instance, Stripe test mode, a dedicated GitHub App. **Needs CEO approval before it exists** (it is a public URL and a cost) |
| Production | customers | `[ADR-0009]` — options and recommendation only; CEO decides |

The local environment working without any cloud account or paid key is a hard
requirement: five agents must be able to build and test this without spend.

---

## 13. Test seams — how diagram accuracy becomes assertable

The claim "the diagram matches the source" is worthless unless CI can fail on it. These
are the seams that make it fail. §13.1–13.4 are the accuracy seams; the rest are the
supporting gates.

### 13.1 Golden fixture corpus — `fixtures/terraform/<case>/`

Each case holds real Terraform plus `expected.graph.json`. The test is
`canonicalise(buildGraph(parse(files))) === expected.graph.json`, byte for byte.

Canonicalisation (in `packages/graph`, tested itself): nodes sorted by `(address, kind)`,
edges by `(fromAddress, toAddress, kind, attributePath)`, object keys sorted, uuids
replaced by their derivation input (addresses), `parserVersion` elided. Determinism is why
node ids are uuidv5 of the address (§4.5) rather than random.

Minimum corpus at M1 — each case exists because it is a way the parser can be wrong:

| Case | What it pins down |
|---|---|
| `01-single-resource` | node fields, source range covers the whole block |
| `02-two-resources-reference` | edge direction (`from` depends on `to`), `attributePath` |
| `03-variables-and-defaults` | `resolved` with `variable_default` provenance |
| `04-variable-no-default` | `unresolved: variable_no_default`, expression preserved |
| `05-locals-chain` | topological evaluation, provenance chain |
| `06-locals-cycle` | `locals_cycle`, no hang, whole cycle marked |
| `07-interpolation-partial` | `partial` parts, `"${var.env}-web"` |
| `08-count-literal` / `09-count-dynamic` | `multiplicity` literal vs unresolved |
| `10-for-each-map` / `11-for-each-unresolved` | `resolvedKeys` vs null |
| `12-local-module` | `contains` tree, `module_input`, `module_output`, module path |
| `13-remote-module` | `remote_unsupported`, `unknown_reference` nodes for its outputs |
| `14-depends-on` | `explicit_dependency` edges |
| `15-data-source` | `data_resource` kind, `unresolved: data_source` |
| `16-multiple-providers-aliases` | `provider_assignment`, aliases |
| `17-dynamic-block` | `unresolved: dynamic_block`, no invented attributes |
| `18-sensitive-variable` | `{v:"sensitive"}`, value absent from the graph **and** from the serialized fixture |
| `19-secret-literal` | secret-pattern redaction at the persistence boundary |
| `20-syntax-error-one-file` | partial success: other files parse, diagnostic carries path+line |
| `21-tf-json` | `.tf.json` equivalence with the HCL form |
| `22-deeply-nested-modules` | depth limit, no stack overflow |
| `23-cross-module-reference` | module output → consumer edge across the boundary |
| `24-unicode-and-crlf` | line numbers correct with CRLF and multi-byte characters |

`pnpm fixtures:update` regenerates expectations; the diff must be reviewed in the pull
request. A fixture change without a reviewed diff is how a parser regression ships
silently, so the CI job also fails if `expected.graph.json` changed without a
`parserVersion` bump.

### 13.2 Graph invariants — property tests run on every fixture and every built graph

Implemented as `validateGraph(graph, manifest): Violation[]` in `packages/graph`, called
both in CI and in the pipeline (§5.8), so the same rule protects tests and production.

1. Every `edge.fromNodeId`/`toNodeId` exists in the node set.
2. Every node has a `SourceRef` whose `path` is in the file manifest and whose
   `1 ≤ startLine ≤ endLine ≤ manifest.lineCount`.
3. Every edge has `source != null` **unless** `kind === "contains"` or
   `provenance === "plan_json"`.
4. Every edge's `provenance` ∈ {`static_hcl`,`plan_json`}; at launch every edge's
   `confidence === "exact"`.
5. `contains` edges form a tree: no cycles, exactly one parent per non-root node.
6. `(address, kind)` is unique within a snapshot.
7. No `unresolved` attribute has an empty `expression`; no `expression` exceeds 512 chars.
8. No `literal`/`resolved` string value matches the secret-pattern set.
9. Every `unknown_reference` node has ≥ 1 inbound edge (no orphan placeholders).
10. No self-edges. No duplicate `(from, to, kind, attributePath)`.
11. Node and edge counts match `snapshot.stats`.
12. Every `diagnosticCodes` entry is in the closed error enum.

### 13.3 Tenant isolation tests

- **Coverage test:** query `pg_class`/`pg_policies` and assert that every table in the
  application schema is either on the §6.2 non-tenant allow-list or has
  `relrowsecurity AND relforcerowsecurity` and at least one policy with both `USING` and
  `WITH CHECK`. A new table without RLS fails the build — the test is on the schema, not
  on a reviewer's memory.
- **Cross-tenant probe:** seed tenants A and B with full graphs, then for every
  tenant-scoped table assert `withTenant(B)` sees zero rows of A's data, and that an
  `INSERT`/`UPDATE` of A's `tenant_id` from B's context raises.
- **No-context probe:** a connection with no `app.tenant_id` returns zero rows from every
  tenant-scoped table.
- **Role test:** assert `dm_app` is `NOSUPERUSER`, `NOBYPASSRLS`, and owns no table.
- **Composite-FK test:** attempt to insert a `graph_edges` row whose `from_node_id`
  belongs to another tenant; assert a foreign-key violation (not merely zero rows).

### 13.4 Accuracy against an independent oracle

Golden fixtures prove we are *consistent*. They cannot prove we are *right* — the
expectation was written by the same people who wrote the parser. The independent oracle is
`terraform plan` JSON, generated **offline** and committed for a subset of fixtures (no
credentials in CI, no Terraform binary in CI — only its committed JSON output):

- every resource address in the plan's `configuration` appears in our graph;
- every dependency in the plan's `references` arrays is present as an edge in our graph,
  or is listed in that fixture's `known-gaps.json` with a reason;
- the ratio of matched edges is recorded as **`static_edge_recall_vs_plan`** and CI fails
  if it drops below the committed baseline.

That metric is the honest, numeric answer to "is the diagram accurate" and it is the
number to quote to customers. It is also the number the Backend spike (AIS-4) must produce
a first reading of.

### 13.5 Robustness

- **Fuzzing:** nightly fuzz of `packages/parser` against mutated real Terraform. The
  parser may produce diagnostics; it may not throw, hang, or exceed 512 MB.
- **Public-corpus regression:** a pinned list of permissively licensed public Terraform
  repositories, parsed nightly. Assert zero crashes; record node/edge counts, parse time
  and the unresolved ratio; fail on >10% drift. Pinned commits only, licences checked
  before a repository joins the list.

### 13.6 Supporting gates

- **Explanation grounding** (AI Engineer, AIS-6): unit tests for `validateCitations`
  including adversarial cases (a plausible but absent resource name, a real path with a
  wrong line, a fabricated attribute); an offline eval set of question/context/expected
  pairs with recorded transcripts so CI needs no API key; assertions that `rejected`
  answers are never rendered.
- **Egress test:** a test harness intercepts the Anthropic client and asserts the outbound
  payload against an allow-list derived from §8.4 — no `sensitive` values, no repository
  owner/name, no tenant or user identifiers, no plan-JSON-derived values. This turns §8.4
  from a promise into an assertion.
- **Licence gate and secret scan:** §11.
- **Canvas tests** (Frontend): rendered node count equals the API node count; selecting a
  node opens the panel with the matching address; citation click selects the right node;
  keyboard-only traversal of the §9.5 non-visual path. No pixel snapshots of the canvas —
  they are brittle and test nothing we care about.

---

## 14. Sizing

Estimates are in **agent-days** of the owning engineer's work, derived from the task
breakdown below, not from a feeling. Calendar mapping depends on heartbeat throughput and
is the CEO's to set. Review and rework by the CTO runs in parallel and is included in the
"review and rework" line. Ranges are the 50th and 85th percentile.

### M1 — core parser and graph (Backend, with CTO on schema)

| Work | Days |
|---|---|
| Scaffolding, CI, licence gate, boundary test (AIS-8) | 2 |
| `packages/graph`: schemas, canonicalisation, `validateGraph`, error enum | 3 |
| Acquire + discover + manifest, with limits and scratch destruction | 2 |
| hcl2json integration + **position index** (the risk) | 5 |
| Evaluator / constant folding with provenance | 4 |
| Graph builder + reference extraction + module tree | 5 |
| Golden corpus (24 cases) + line-reference verification + invariant tests | 4 |
| Plan JSON enrichment + mismatch guard + recall metric | 3 |
| DB schema, roles, RLS, migrations, isolation test suite | 4 |
| pg-boss ingestion job, diagnostics, retention sweep | 3 |
| Read API (§7.2–7.4, 7.6, 7.8) + contract tests | 3 |
| Review and rework buffer | 4 |
| **Total** | **42 (36–50)** |

Position indexing and reference extraction are the two line items that can double. Both
are the subject of the Backend spike (AIS-4), which is why this estimate is explicitly
pre-spike.

### M2 — interactive canvas (Frontend, with CTO on the API contract)

| Work | Days |
|---|---|
| Design system, app shell, auth and repository-connect flows | 4 |
| Canvas: React Flow integration, module grouping, layout | 6 |
| Scale handling: virtualisation / level-of-detail for 1,000+ nodes | 5 |
| Node detail panel: attributes, provenance, on-demand source view | 4 |
| Movable, resizable chat panel + citation→node navigation | 4 |
| Search, filter, non-visual accessible traversal path | 4 |
| Scan progress, diagnostics drawer, empty and error states, onboarding | 4 |
| Accessibility pass + Playwright suite | 5 |
| Review and rework buffer | 4 |
| **Total** | **40 (34–48)** |

**M1 and M2 overlap by design.** `packages/graph`'s zod schemas plus the golden fixtures
let the Frontend build the whole canvas against a fixture-backed mock API before any
backend endpoint exists. That seam is worth about two weeks of serialised work, and it is
the main reason the contract lives in a shared package rather than in the API layer.

Not sized here: M3 explanation engine (AI Engineer, AIS-6), billing and account
management, landing page, deployment. Those need the spike outputs and Product's pricing
first.

---

## 15. Risks

| Risk | Impact | Mitigation | Owner |
|---|---|---|---|
| Position indexing on real-world HCL is harder than estimated; line references are wide or wrong | Core value proposition degrades | Fall back to block-level ranges (always a containing range, never a wrong one) + `POSITION_INDEX_FALLBACK` diagnostic; spike AIS-4 measures it | Backend |
| ~~MPL-2.0 on `@cdktf/hcl2json` judged unacceptable~~ — **closed**: cleared unmodified by the licence review | Would have been a parser rewrite, weeks | Residual risk is the condition, not the licence: a vendor-patch of `hcl2json` would breach it. Enforced by review and by the `licences` gate's exception file | CTO (review rule) |
| Remote modules unsupported → large real repositories look mostly empty | Product looks broken on exactly the repositories that most need it | `unknown_reference` nodes make the gap explicit; measure the unresolved ratio on the public corpus; remote module fetching is the first post-launch candidate | Product + Backend |
| Canvas unusable above ~1,000 nodes | Enterprise repositories unusable | Frontend spike AIS-5 before M2 commits to an approach | Frontend |
| Explanations are confidently wrong | Reputational and commercial; the product's core claim | Citation validator + `rejected` status + offline eval set; refusing to answer is an acceptable outcome | AI Engineer |
| Single PostgreSQL instance is a single point of failure with no HA | Total outage | Accepted at launch. Daily backups with a tested restore runbook; HA is a post-revenue cost decision | CEO |
| Source re-fetch depends on a live GitHub installation; uninstall breaks the source view | Degraded chat and source panel | Graph and attributes remain; UI degrades explicitly. The alternative — persisting snippets — contradicts the non-retention decision (§16, `[ADR-0007]`) | CTO |
| AI cost overrun | Budget | Reserve-then-reconcile caps; free tier on the customer's own key | CTO |
| Expression-string retention read as a breach of "no raw IaC retained" | Trust and the approved constraint | Explicit confirmation sought at the M0 gate (§16) | CEO |

---

## 16. Open questions and revision plan

This specification is version 0.1 and is **pre-spike by design**. Three spikes run in
parallel and are expected to change it; each open question names who closes it.

| # | Question | Closed by | Affects |
|---|---|---|---|
| 1 | Does `@cdktf/hcl2json` + an in-house position index give accurate line ranges on real repositories? What recall against plan JSON? | Backend spike AIS-4 | §5.3, §13.4, `[ADR-0005]`, M1 sizing |
| 2 | What are the real file/node ceilings and parse times? | AIS-4 | §5.1 limits |
| 3 | Can React Flow 12 render 1,000–5,000 nodes acceptably, and does the canvas need a paginated or summarised graph payload? | Frontend spike AIS-5 | §7.4, §13.6, M2 sizing |
| 4 | Which layout library? **Licence side closed**: `@dagrejs/dagre` (MIT) preferred, `d3-hierarchy` (ISC) fine, `elkjs` (EPL-2.0) permitted unmodified with notices. The quality choice remains the Frontend spike's | AIS-5 (quality); licence closed by AIS-7 | §3 |
| 5 | Is the `[[node:…]]` / `[[src:path:line]]` citation format sufficient, and what are the real grounding rates? | AI Engineer AIS-6 | §8.2, §8.3 |
| 6 | ~~Is MPL-2.0 acceptable for a dependency of a proprietary hosted service? Is EPL-2.0?~~ **Closed 2026-10-12** by `docs/LICENCE-AND-DEPENDENCY-PLAN.md` §3.3: both yes, unmodified only, notices shipped | Closed — QA & Security AIS-7 | §3, `[ADR-0005]` |
| 7 | Anthropic commercial terms: training on API inputs, retention, and whether zero-retention is available to us — confirmed in writing | QA & Security AIS-7 | §8.4 |
| 8 | **Does the product owner accept that normalized expression strings (≤512 chars) are retained, given "raw customer IaC is not retained"?** If not, unresolved attributes lose their explanation and §4.3 must change. | CEO, at the M0 gate | §4.3, §4.9, `[ADR-0007]` |
| 9 | Hosting target and monthly cost within GBP 60 | CEO, on `[ADR-0009]` | §12, §15 |
| 10 | Plan limits: repositories, nodes, monthly token caps | Product AIS-2 | §7.9, §8.6 |

Revision protocol: each spike's findings arrive as a comment on AIS-3; I update the
affected section, bump the version in the header, and add a row to the revision log below.
`parserVersion` and `schemaVersion` are bumped when a change alters parser output or the
wire format, which forces fixtures to be regenerated with a reviewed diff.

### Revision log

| Version | Date | Change |
|---|---|---|
| 0.1 | 2026-10-11 | First complete specification. Pre-spike baseline. |
| 0.2 | 2026-10-12 | ADRs 0009 (hosting and the £60 envelope), 0010 (data access) and 0011 (monorepo and tooling) written, so every `[ADR-NNNN]` reference in this document now resolves. §3 licence position rewritten around QA & Security's rulings: MPL-2.0 and EPL-2.0 cleared **unmodified only**, closing open question 6 and the licence half of open question 4; §11 `licences` gate tightened to match; §15 MPL risk row closed and replaced by the vendor-patch condition. No change to §4, §5, §6, §7 or §8 — the graph model, pipeline, schema, API and AI flow are untouched. |
