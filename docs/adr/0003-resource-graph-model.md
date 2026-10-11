# ADR-0003: Resource-graph model — a configuration-address property graph with provenance on every value

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-11 |
| **Decider** | CTO |
| **Consulted** | Backend Engineer (AIS-4 spike), AI Engineer (AIS-6 grounding), QA & Security |
| **Affects** | `docs/TECH-SPEC.md` §4 (whole section), §5.6, §6.2, §7.4, §13.1–13.2 |
| **Reversibility** | **Expensive.** The graph is the wire format between parser, database, API, canvas and explanation engine. Changing it invalidates every golden fixture, every persisted snapshot and both test suites. This is the one decision in the set that deserves the most deliberation. |

## Context

The resource graph is the core asset of this product. Everything else is replaceable: the
canvas renderer, the web framework, the AI provider, even the parser implementation. The
graph model is what the parser produces, what the database stores, what the API serves,
what the canvas draws and what the explanation engine cites. It is the **single source of
truth** for "what is in the customer's infrastructure", and nothing else in the system may
hold a competing version of that list.

Two product promises constrain it absolutely:

1. **The diagram matches the source.** Every node and edge must be traceable to a file and
   a line range in the customer's repository, and that must be *assertable in CI* rather
   than claimed.
2. **Explanations are grounded.** The explanation engine can only cite what the model
   carries. If the model throws away *why* a value is what it is, no amount of prompt
   engineering recovers it — the information is gone before the AI is involved.

Two constraints come from elsewhere: raw customer IaC is not retained after parsing
(ADR-0007), so the model must be self-sufficient without the source files; and static
analysis of Terraform is **fundamentally incomplete** — `var.x` with no default,
`aws_vpc.main.id` before apply, `for_each` over a data source result, `dynamic` blocks.
A large fraction of real attribute values cannot be determined without running Terraform
against a real account, which we never do.

That last point is the heart of this ADR. The model's hardest job is not representing what
we know. It is representing what we *don't* know, honestly, in a way the UI and the AI can
both use — because a visualisation tool that quietly guesses is worse than no tool.

## Options considered

### Option A — Plain node/edge lists with resolved string attributes

The obvious model: `{id, type, name, attributes: Record<string, string>}` plus edges.
Each attribute holds a rendered string; unresolvable ones hold the raw expression text, or
are omitted.

**Cost:** cheapest to build, perhaps 2 days saved on the schema and the evaluator.

Rejected, and this is the most important rejection in the document. `Record<string,
string>` makes `"prod-web"` (a literal), `"${var.env}-web"` (partially known) and
`"prod-web"` (computed by us from a variable default) **indistinguishable at the type
level**. The consequences compound:

- The UI cannot mark uncertainty, so it must either show expressions raw to users who
  don't read HCL, or show computed guesses as if they were facts.
- The explanation engine receives a flat string and cannot tell whether it may assert
  "this instance is named prod-web" or must say "the name depends on `var.environment`".
  Grounding becomes a prompt instruction instead of a data property, and prompt
  instructions are not invariants.
- There is nowhere to record *which* variable default produced a computed value, so
  "where was this created?" — the product's actual question — is unanswerable.

This option fails promise 2 structurally. It is not a matter of degree.

### Option B — The `terraform plan` / `terraform graph` output as the model

Terraform already builds a dependency graph and `plan -json` already resolves values
accurately, including things static analysis cannot reach. Using it would make us *more*
accurate than any parser we could write.

**Cost:** £0 in licence terms for consuming customer-supplied JSON, and it removes the
entire evaluator and reference-extraction effort — easily 9 days saved.

Rejected as the primary model, for three independent reasons, any one of which is fatal:

- **No source positions.** Neither `plan -json` nor `terraform graph` emits file or line
  information. Grounded explanations with `path:line` citations — the product — become
  impossible. We would be building the tool we criticised in the vision document: a
  picture of boxes that teaches nobody anything.
- **It requires the customer to run Terraform with credentials** against real
  infrastructure and hand us the output. Most prospects cannot or will not do that on
  first contact, and the launch promise is "connect a repository".
- Running it ourselves would mean the `terraform` binary, which is **BUSL-1.1** from
  v1.6 and excluded entirely (ADR-0005), plus executing customer code with cloud
  credentials — an operational and security posture we are not taking.

It is retained as an **optional enrichment** (`TECH-SPEC` §5.7): plan JSON confirms
`count`/`for_each` values and adds `plan_dependency` edges that static parsing missed,
marked `provenance: "plan_json"` and visually distinguished, and **no value from it is
persisted**. Structure only. That gives us most of the accuracy benefit with none of the
three problems.

### Option C — Instance-level nodes (one node per `aws_instance.web[0]`, `[1]`, `[2]`)

Model what will actually exist in the cloud, matching `terraform state` addressing.

**Cost:** similar build effort; much larger graphs.

Rejected. A 400-resource repository with modest `count`/`for_each` usage becomes a
4,000-box canvas, which fails the canvas performance budget before the Frontend has
written a line. Worse, it is **less true to the source**: the customer wrote one block,
and we are explaining their code, not their cloud account. And in the common case the
count is unresolvable, so we would have to invent an instance count to render at all —
a direct violation of "never invent". `multiplicity` on a single node expresses "three
of these, or an unknown number of these" without fabricating anything.

### Option D — A property graph in a graph database (Neo4j, Memgraph)

The data is a graph; use a graph database. Cypher traversals, path queries, graph
algorithms for free.

**Cost:** a new infrastructure component to run, learn, back up and secure. Neo4j
Community is GPL-3.0 (server) — a licence question we do not need; the managed tier is
well above the remaining headroom in a £60/month budget. Memgraph's licensing is
similarly constrained for commercial hosted use. Call it £0–40/month plus days of
operational learning, plus a second store to keep consistent with PostgreSQL.

Rejected on query requirements, not on taste. Our actual queries are: *all nodes and
edges in one snapshot* (the canvas) and *one node plus its 1-hop neighbourhood* (the
panel and the AI context). Both are served by two indexed PostgreSQL tables with a
single-column index. We have no multi-hop path queries, no shortest-path, no community
detection in the launch scope. Adding a database for traversals we do not perform fails
both the £60/month constraint and **boring technology**, and it would split the single
source of truth across two stores — the exact failure mode the specification forbids.
If a future feature genuinely needs deep traversal ("what breaks if this dies?" at
arbitrary depth), a recursive CTE in PostgreSQL is the next step, and a graph database
the one after that, each with its own ADR.

### Option E — A single JSONB blob per snapshot

Store the whole `Graph` as one document. Simple, one row, trivially cacheable.

**Cost:** cheapest storage layer, ~1 day saved.

Rejected as the **storage** model: the explanation engine needs to read one node and its
neighbours without deserialising a 10 MB document, and node search needs an index. It
*is* retained as a derived read cache for the canvas payload (`TECH-SPEC` §6.2), labelled
derived and regenerable, which is the right use of it.

### Option F — Tagged-union attribute values with provenance (chosen)

Nodes keyed by Terraform configuration address; a tagged union `AttributeValue` whose
variants are `literal`, `resolved`, `partial`, `unresolved`, `sensitive`, `omitted`,
`object`, `list`; a `SourceRef` on every node, edge and value; typed `Reference` objects;
`Provenance` chains on computed values; typed edge kinds with a fixed direction.

**Cost:** the most expensive model to build — the evaluator with provenance tracking is
~4 days and the graph builder with reference extraction ~5 days (`TECH-SPEC` §14) — and
the most expensive to consume, because every UI and prompt site must handle eight
variants rather than reading a string.

## Decision

Adopt Option F, exactly as specified in `TECH-SPEC` §4. The decisions that are expensive
to revisit, stated so an implementer cannot get them subtly wrong:

1. **Identity is the Terraform configuration address.** `module.network.aws_subnet.private`.
   Instance keys are excluded (`module.a.aws_instance.web`, never `...web[0]`). There is
   exactly **one** naming scheme in the entire system; no component invents a second.
2. **A node is a configuration block, not a cloud instance.** `count = 3` is one node with
   `multiplicity.kind = "count"`. `resolved`/`resolvedKeys` is populated only from a
   literal or from plan JSON, otherwise `null` with `resolution: "unresolved"`, and the UI
   renders `×?`.
3. **Ids are deterministic uuidv5**, not random: `id` from `snapshotId|address|kind`,
   `stableKey` from `repositoryId|address|kind`. Determinism is what makes golden fixtures
   byte-comparable, and `stableKey` is what makes cross-snapshot diffing possible later.
   The diff **UI** is deferred; the **key** is not, because retrofitting identity means
   rewriting history.
4. **Every value carries its certainty and its origin.** `literal` ≠ `resolved` ≠
   `partial` ≠ `unresolved`, and `resolved` carries a `Provenance[]` naming every input
   it used. This is what lets the panel say "`name` is `prod-web-01`, built from
   `var.environment` (default `prod`) at `variables.tf:4`" and lets the AI know when it
   must hedge.
5. **`partial` is a first-class variant.** `"${var.env}-web"` keeps its structure as
   alternating literal and reference parts, so the UI renders the known fragments and
   marks the unknown ones instead of collapsing everything to "unknown". This case is
   overwhelmingly the most common in real Terraform; treating it as a failure would make
   the product look blind.
6. **Unresolved values keep their expression and a typed reason.** An `unresolved` with no
   expression is an invariant violation that fails CI. The reason enum
   (`variable_no_default`, `resource_attribute`, `data_source`, `for_expression`, …) is
   what turns "we don't know" into a teachable explanation.
7. **`unknown_reference` nodes are first-class.** A reference to a remote module's output
   we did not fetch creates a node of that kind at that address. **Showing the hole is
   correct; hiding it is a lie**, and the hole is also the honest measure of our coverage —
   `stats.unresolvedAttributeCount` and `unknownReferenceCount` are surfaced in the product
   and are the metric the parser is improved against.
8. **Edge direction is fixed for all time: `from` depends on `to`.** The canvas may draw
   arrows either way visually; the stored direction never changes. Getting this backwards
   silently inverts every diagram in the product, so a fixture test asserts it.
9. **`contains` edges form a tree** rooted at the root module — exactly one parent per
   non-root node, no cycles. This is the structural hierarchy the canvas groups by, kept
   separate from dependency edges so that "what is inside this module" and "what does this
   depend on" are never confused.
10. **Edges carry `provenance` and `confidence`.** Every launch edge is
    `confidence: "exact"`; a CI assertion fails the build if any fixture produces a
    `heuristic` edge. The enum is a seam for future inferred edges and the CI gate keeps
    the promise honest until we deliberately change it.
11. **Parallel edges are allowed and meaningful** — two attributes referencing the same
    target are two edges with different `attributePath`s, each with its own source line.
    The UI collapses them visually with a count; the model does not lose them.
12. **Snapshots are immutable.** A re-scan produces a new snapshot; a published snapshot
    is never mutated. Derived data (layout, labels, caches) is labelled, carries the
    `parserVersion` that produced it, and can be discarded.
13. **The canonical definition is zod in `packages/graph/src/schema.ts`**, with TypeScript
    types *inferred* via `z.infer` and the fixture JSON Schema *generated* from the same
    source. The wire format, the runtime validator and the compile-time type cannot drift
    because there is only one of them. `packages/graph` may import nothing but `zod` — no
    I/O, no database, no network — enforced by the CI boundary test.

## Cost

- **Engineering:** ~12 of the 42 M1 days are the schema, the evaluator with provenance,
  and the graph builder with reference extraction. Option A would have cost ~3.
- **Consumer complexity, permanently:** every UI component and every prompt template must
  handle eight `AttributeValue` variants. This is a real, recurring tax on the Frontend
  and AI engineers, paid on every feature.
- **Storage:** provenance chains and expression strings roughly double the per-node
  payload versus flat strings. Mitigated by caps — 512-character expressions, depth 8,
  64 KB of attributes per node — which exist so one pathological repository cannot degrade
  the service.
- **Rigidity:** `schemaVersion: 1` is a literal. A breaking change forces regeneration of
  every golden fixture with a reviewed diff, and a re-scan of every customer snapshot.
- **Licence:** none. `zod` is MIT and the model is our own.

## Consequences

- Grounding is a **data property, not a prompt instruction**. The explanation engine
  cannot claim a value is known when the model says `unresolved`, because the certainty
  travels with the value. This is the single biggest reason for the model's cost, and the
  reason it is worth it.
- "The diagram matches the source" becomes checkable: every `SourceRef` can be validated
  against the retained file manifest (path exists, `startLine ≤ endLine ≤ lineCount`)
  **without** the source files, forever. **Make the invariant checkable** — satisfied.
- The model is self-sufficient after the files are discarded, which is what makes
  ADR-0007's non-retention boundary implementable at all.
- Deterministic ids make the parser a pure function of its input, which makes the golden
  corpus a real regression suite rather than a smoke test.
- Cross-snapshot diffing, instance-level expansion from plan data, and inferred edges are
  all reachable without a migration, because `stableKey`, `provenance` and `confidence`
  already exist. That is deliberate seam-building, not speculative generality: each is one
  field, not one subsystem.
- Deep multi-hop traversal is **not** served well. If the product later needs it,
  recursive CTEs first, a graph database only with a new ADR.

## Consequence of being wrong

The expensive failure modes, in order of severity:

| If wrong about | Failure mode | Cost to undo | Earliest signal |
|---|---|---|---|
| `AttributeValue` being a union at all | Explanations cannot express uncertainty; the product's core claim fails and we would be shipping confident guesses about customers' infrastructure | Rewriting the evaluator, the persistence layer, every fixture, every panel component and every prompt — **4–6 weeks**, and worse, by then customers have been shown wrong diagrams | AI Engineer's grounding-rate evaluation (AIS-6) would show the hedging rate is unachievable. **This is the decision I am most confident about and least able to reverse.** |
| Node identity (config address, no instance keys) | Addresses collide or cannot be matched across snapshots; diffing and `stableKey` break | Re-key every node and edge, regenerate all fixtures, re-scan all snapshots — ~2 weeks | A fixture where two distinct blocks produce the same address. Covered by a uniqueness invariant test in §13.2 |
| Edge direction | **Every diagram in the product is inverted.** Silent, plausible-looking, catastrophic for trust | Trivial to flip in code (hours), unbounded in reputational cost if it ships | A golden fixture asserts direction explicitly. This is why that test exists |
| Config-level rather than instance-level nodes | Customers with heavy `for_each` usage say the diagram does not reflect their real estate | Additive, not breaking: plan JSON already gives resolved keys, so instance expansion becomes a derived view over the same model — ~1 week | Customer feedback, or Product research. Low risk because the model keeps the information needed to expand later |
| Rejecting a graph database | Some future feature needs deep traversal and PostgreSQL is awkward | Recursive CTE first (days); a second store with its own ADR (weeks) | A feature request requiring arbitrary-depth paths. Cheap to detect, cheap to stage |
| Caps (512 chars, depth 8, 64 KB) | Large real-world modules get truncated and look incomplete | Raising a cap is a config change plus a fixture update — days | `NODE_ATTRIBUTES_TRUNCATED` diagnostic rates on the public-corpus nightly run |

The asymmetry is the whole argument. Being wrong about the graph database costs days and
we would find out from a feature request. Being wrong about provenance costs over a month
*and* means customers were shown fabricated facts about their own infrastructure in the
meantime. When one error is recoverable and the other is not, pay for the model that
cannot produce the unrecoverable one — **reversibility first**, applied to the one
decision here that genuinely is not reversible.
